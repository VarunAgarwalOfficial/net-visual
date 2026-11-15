// The naming scenarios, tour and lab checks, run through the same TypeScript
// API and WebAssembly module the page uses.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import {
  LABS,
  PER_POINT,
  PRESETS,
  SWEEP_LT,
  TOUR,
  ZONES,
  eventAt,
  hitRatio,
  hopSum,
  negativeTtl,
  runDns,
  streamTtl,
  sweepHits,
  type DnsParams,
  type WebParams,
} from "../src/net-visual/core/dns.ts"
import { createNetsim } from "../src/net-visual/core/netsim.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))
const MS = 1000
const S = 1_000_000
const preset = (id: string) => PRESETS.find((p) => p.id === id)!.params
const run = (id: string, patch: Partial<DnsParams> = {}) => runDns(sim, { ...preset(id).dns, ...patch })
const ms = (id: string, patch: Partial<DnsParams> = {}) => run(id, patch).resolutions.map((r) => (r.done_us - r.at_us) / MS)

test("every resolution takes exactly the round trips of the hops it used, in both modes", () => {
  for (const pr of PRESETS)
    for (const mode of ["iterative", "recursive"] as const) {
      const p = { ...pr.params.dns, mode }
      const r = runDns(sim, p)
      assert.ok(r.resolutions.length > 0, pr.id)
      for (const x of r.resolutions)
        if (x.outcome !== "joined") assert.equal(x.done_us - x.at_us, hopSum(p, x), `${pr.id} ${mode} ${x.name}`)
    }
})

test("the resolution notes' numbers", () => {
  assert.deepEqual(ms("cold-warm"), [100, 24, 30])
  assert.deepEqual(ms("chain"), [100, 24, 100])
  assert.equal(run("cold-warm").stats.server_queries[0], 1)
  assert.equal(run("chain").stats.server_queries[0], 2)
  assert.deepEqual(ms("cname"), [178, 10, 22])
  const c = run("cname").resolutions[0]
  assert.deepEqual(c.servers, [0, 1, 2, 0, 3, 4])
  assert.deepEqual(c.answer, ["203.0.113.77"])

  const st = run("stub")
  assert.deepEqual(
    st.resolutions.map((r) => r.outcome),
    ["resolved", "stub", "cache", "resolved"],
  )
  assert.equal(st.resolutions[1].done_us, st.resolutions[1].at_us)
  assert.equal((st.resolutions[3].done_us - st.resolutions[3].at_us) / MS, 30)
  const resolverCopy = st.entries.find((e) => e.cache === st.resolver && e.kind === "A" && e.name === "www.example.com.")!
  const phoneCopy = st.entries.find((e) => e.cache === 1)!
  assert.equal(phoneCopy.expires_us - resolverCopy.expires_us, 12 * MS)

  const nx = run("nxdomain")
  assert.deepEqual(
    nx.resolutions.map((r) => [r.outcome, r.negative]),
    [
      ["resolved", true],
      ["cache", true],
      ["resolved", true],
    ],
  )
  assert.equal(nx.entries.find((e) => e.kind === "NXDOMAIN")!.ttl_us, 300 * S)
  assert.deepEqual(ms("nxdomain"), [100, 24, 30])
})

test("cache entries expire at exactly arrival plus TTL, and the trace says so then", () => {
  for (const id of ["cold-warm", "stub", "nxdomain", "ttl-change"]) {
    const r = run(id)
    for (const e of r.entries) assert.equal(e.expires_us, e.from_us + e.ttl_us)
    for (const ev of r.events.filter((x) => x.step === "E1")) assert.equal(ev.t, r.entries[ev.entry!].expires_us, id)
  }
  // A lookup one microsecond before expiry hits; one at expiry misses.
  const exp = 95 * MS + 300 * S
  const r = run("cold-warm", {
    queries: [
      { at_us: 0, client: 0, name: "www.example.com." },
      { at_us: exp - 5 * MS - 1, client: 0, name: "www.example.com." },
      { at_us: exp - 5 * MS, client: 0, name: "www.example.com." },
    ],
  })
  assert.deepEqual(
    r.resolutions.map((x) => x.outcome),
    ["resolved", "cache", "resolved"],
  )
})

test("negative answers are cached for min(SOA TTL, MINIMUM), RFC 2308 Section 5", () => {
  for (const [soa_ttl_s, soa_minimum_s] of [
    [3600, 300],
    [60, 900],
    [120, 120],
  ]) {
    const zones = ZONES.map((z) => (z.origin === "example.com." ? { ...z, soa_ttl_s, soa_minimum_s } : z))
    const r = run("nxdomain", { zones })
    const want = negativeTtl(zones[2])
    assert.equal(want, Math.min(soa_ttl_s, soa_minimum_s))
    assert.equal(r.entries.find((e) => e.kind === "NXDOMAIN")!.ttl_us, want * S)
  }
})

test("iterative and recursive resolution agree on every answer", () => {
  for (const pr of PRESETS) {
    const a = runDns(sim, { ...pr.params.dns, mode: "iterative" })
    const b = runDns(sim, { ...pr.params.dns, mode: "recursive" })
    assert.equal(a.resolutions.length, b.resolutions.length)
    a.resolutions.forEach((x, i) => {
      const y = b.resolutions[i]
      assert.deepEqual([x.name, x.answer, x.negative], [y.name, y.answer, y.negative], pr.id)
    })
  }
})

// 5000 queries a point; the resolver's hits are a renewal process with about
// 1 + λT queries a cycle, and the hit ratio's standard deviation over seeds
// (crates/netsim dns tests) stays below 0.001 at 200,000 queries, so below
// 0.0065 at 5000. Four of those is 0.026; the check allows 0.03.
test("the shared cache's hit ratio follows λT / (1 + λL + λT) across the sweep", () => {
  const p = preset("hit-ratio").dns
  const T = streamTtl(p)
  assert.equal(T, 60)
  const pts = sweepHits(
    sim,
    p,
    SWEEP_LT.map((lt) => lt / T),
    PER_POINT,
  )
  for (const pt of pts) {
    const want = hitRatio(pt.rate_per_s, T, pt.mean_miss_us / S)
    assert.ok(Math.abs(pt.hit_ratio - want) < 0.03, `λT ${pt.rate_per_s * T}: ${pt.hit_ratio} against ${want}`)
  }
  assert.equal(hitRatio(0.05, 60), 0.75)
})

test("the shared-cache and TTL notes' numbers", () => {
  const it = run("root-load")
  const rc = run("root-load", { mode: "recursive" })
  assert.equal(it.stats.server_queries[0], 2)
  assert.equal(rc.stats.server_queries[0], 15)

  const b = run("burst")
  assert.equal(
    b.stats.server_queries.reduce((s, x) => s + x, 0),
    3,
  )
  assert.equal(b.stats.joined, 7)

  const t = run("ttl-change")
  const stale = t.resolutions.filter((r) => r.stale).map((r) => r.at_us / S)
  assert.deepEqual(stale, [120, 150, 180, 210, 240, 270, 300])
  assert.equal(
    t.entries.find((e) => e.cache === t.resolver && e.name === "www.example.com." && e.kind === "A")!.expires_us,
    300 * S + 95 * MS,
  )
  assert.equal(run("lower-first").stats.stale, 1)
})

test("each tour stop lands on the event it describes", () => {
  for (const s of TOUR) {
    const r = runDns(sim, preset(s.preset).dns)
    const ev = r.events[eventAt(r, s.at)]
    assert.equal(ev.step, s.step, `${s.preset} at ${s.at}`)
  }
})

const solve = (id: string, p: WebParams): WebParams => {
  const d = p.dns
  switch (id) {
    case "warm-mail":
      return { ...p, dns: { ...d, queries: [{ at_us: S, client: 0, name: "www.example.com." }, ...d.queries] } }
    case "half-hits":
      return {
        ...p,
        dns: {
          ...d,
          zones: d.zones.map((z) => ({ ...z, records: z.records.map((r) => (r.name === "www.example.com." ? { ...r, ttl_s: 20 } : r)) })),
        },
      }
    case "typo-minute":
      return { ...p, dns: { ...d, zones: d.zones.map((z) => (z.origin === "example.com." ? { ...z, soa_minimum_s: 60 } : z)) } }
    case "lower-in-time":
      return { ...p, dns: { ...d, changes: [{ ...d.changes[0], at_us: 50 * S }, d.changes[1]] } }
  }
  throw new Error(id)
}

test("every lab starts unsolved and has a solution", () => {
  for (const lab of LABS) {
    const before = lab.check(lab.start, runDns(sim, lab.start.dns))
    assert.equal(before.ok, false, `${lab.id}: ${before.message}`)
    const p = solve(lab.id, lab.start)
    const after = lab.check(p, runDns(sim, p.dns))
    assert.equal(after.ok, true, `${lab.id}: ${after.message}`)
  }
})
