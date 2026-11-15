// The HTTP scenarios, tour and lab checks, run through the same TypeScript
// API and WebAssembly module the page uses.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { MODES } from "../src/net-visual/core/dns.ts"
import {
  HTTP_BASE,
  HTTP_LABS,
  HTTP_PRESETS,
  HTTP_TOUR,
  MS,
  SWEEP_LOSS,
  SWEEP_SEEDS,
  eventAtNs,
  fitsWindow,
  isHttpMode,
  nonPersistentFormula,
  persistentFormula,
  progressAt,
  runHttp,
  sweepHttp,
  ttfbFormula,
  type HttpWeb,
} from "../src/net-visual/core/http.ts"
import { createNetsim } from "../src/net-visual/core/netsim.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))
const preset = (id: string) => HTTP_PRESETS.find((p) => p.id === id)!.params
const run = (id: string) => runHttp(sim, preset(id).http)
const tweak = (w: HttpWeb, o: Partial<HttpWeb["http"]>): HttpWeb => ({ ...w, http: { ...w.http, ...o } })

test("every preset runs, belongs to an HTTP mode and conserves bytes", () => {
  const ids = new Set<string>()
  for (const pr of HTTP_PRESETS) {
    assert.ok(!ids.has(pr.id), pr.id)
    ids.add(pr.id)
    assert.ok(isHttpMode(pr.mode) && MODES.some((m) => m.id === pr.mode && m.group === "http"))
    assert.equal(pr.params.mode, pr.mode)
    const r = runHttp(sim, pr.params.http)
    const delivered = r.objects.map(() => 0)
    for (const q of r.packets) if (q.delivered_ns !== null) delivered[q.obj] += q.len
    assert.deepEqual(
      delivered,
      r.objects.map((o) => o.bytes),
      pr.id,
    )
    assert.equal(r.stats.ttfb_ns, r.objects[0].first_byte_ns)
  }
  for (const m of MODES.filter((x) => x.group === "http"))
    assert.ok(
      HTTP_PRESETS.some((p) => p.mode === m.id),
      m.id,
    )
})

test("the textbook formulas give the connections presets to the nanosecond", () => {
  const serial = preset("h10-serial").http
  assert.ok(fitsWindow(serial))
  assert.equal(run("h10-serial").stats.plt_ns, nonPersistentFormula(serial))
  assert.equal(run("h10-serial").stats.plt_ns, 952.8 * MS)
  assert.equal(run("h11-persistent").stats.plt_ns, persistentFormula(preset("h11-persistent").http))
  assert.equal(run("h11-persistent").stats.plt_ns, 552.8 * MS)
  assert.equal(run("h10-parallel").stats.plt_ns, 252.8 * MS)
  assert.equal(run("h11-six").stats.plt_ns, 340 * MS)
  assert.equal(run("h2-page").stats.plt_ns, 285.888 * MS)
})

test("time to first byte counts the handshake's round trips", () => {
  const expect: Record<string, number> = { "tls-tcp": 151.168, "tls-0rtt": 101.168, "quic-1rtt": 101.168, "quic-0rtt": 51.168 }
  for (const [id, ms] of Object.entries(expect)) {
    assert.equal(run(id).stats.ttfb_ns, ms * MS, id)
    assert.equal(ttfbFormula(preset(id).http), ms * MS, id)
  }
})

test("the head-of-line presets show what their notes say", () => {
  const pipe = run("pipeline-hol")
  assert.equal(pipe.objects[2].done_ns, 452.688 * MS)
  assert.ok(pipe.objects[2].done_ns > pipe.objects[1].done_ns)
  const h2 = run("h2-interleave")
  assert.equal(h2.objects[2].done_ns, 153.568 * MS)
  assert.equal(h2.objects[3].done_ns, 158.304 * MS)
  assert.equal(h2.objects[1].done_ns, 456.56 * MS)

  const a = run("h2-loss")
  const b = run("h3-loss")
  assert.deepEqual([a.stats.lost, b.stats.lost], [1, 1])
  assert.deepEqual([a.stats.held_objects, b.stats.held_objects], [4, 1])
  assert.equal(a.stats.held_ns, 553.68 * MS)
  assert.equal(b.stats.held_ns, 118.912 * MS)
  assert.deepEqual([a.stats.plt_ns, b.stats.plt_ns], [538.336 * MS, 488.336 * MS])
  // Just before the repair, HTTP/2 has delivered no more of any image than reached it before the hole; HTTP/3 lags only on a.jpg.
  const fix = a.packets.find((q) => q.retx_of === 12)!.arrive_ns!
  const before = progressAt(a, fix - 1)
  for (let o = 1; o <= 4; o++) assert.ok(before.arrived[o] > before.delivered[o], `HTTP/2 stream ${o} is frozen`)
  const fix3 = b.packets.find((q) => q.retx_of === 12)!.arrive_ns!
  const before3 = progressAt(b, fix3 - 1)
  assert.ok(before3.arrived[1] > before3.delivered[1])
  for (let o = 2; o <= 4; o++) assert.equal(before3.arrived[o], before3.delivered[o])

  const h2l = run("lossy-h2")
  const h3l = run("lossy-h3")
  assert.equal(h2l.stats.lost, 3)
  assert.deepEqual([h2l.stats.held_objects, h3l.stats.held_objects], [11, 2])
  assert.deepEqual([h2l.stats.plt_ns, h3l.stats.plt_ns], [593.536 * MS, 543.536 * MS])
})

test("every tour stop lands on the step it describes", () => {
  for (const s of HTTP_TOUR) {
    assert.ok(
      HTTP_PRESETS.some((p) => p.id === s.preset),
      s.preset,
    )
    const r = run(s.preset)
    const e = r.events[eventAtNs(r, s.at * 1000)]
    assert.equal(e.step, s.step, `${s.preset} at ${s.at} µs`)
  }
})

test("each lab fails at its start and passes with a solution", () => {
  const solve: Record<string, Partial<HttpWeb["http"]>[]> = {
    "h10-parallel": [{ parallel: 4 }],
    "first-byte": [{ protocol: "h3", zero_rtt: true }],
    "free-icon": [{ protocol: "h2" }, { parallel: 2 }],
    "tcp-isolate": [
      { protocol: "h11", parallel: 4 },
      { protocol: "h10", parallel: 4 },
    ],
  }
  const wrong: Record<string, Partial<HttpWeb["http"]>> = {
    "h10-parallel": { parallel: 3 },
    "first-byte": { protocol: "h3" },
    "free-icon": { pipelining: false },
    "tcp-isolate": { protocol: "h11", parallel: 1 },
  }
  for (const lab of HTTP_LABS) {
    assert.equal(lab.check(lab.start, runHttp(sim, lab.start.http)).ok, false, lab.id)
    const w = tweak(lab.start, wrong[lab.id])
    assert.equal(lab.check(w, runHttp(sim, w.http)).ok, false, `${lab.id} wrong answer`)
    for (const s of solve[lab.id]) {
      const v = tweak(lab.start, s)
      const res = lab.check(v, runHttp(sim, v.http))
      assert.ok(res.ok, `${lab.id} ${JSON.stringify(s)}: ${res.message}`)
    }
  }
})

test("the sweep is deterministic and agrees with single runs", () => {
  const base = { ...preset("lossy-h2").http, trace: false }
  const v = [{ protocol: "h2" as const, parallel: 1, pipelining: false, tls: true, zero_rtt: false }]
  const a = sweepHttp(sim, base, v, "loss", SWEEP_LOSS, SWEEP_SEEDS)
  assert.deepEqual(a, sweepHttp(sim, base, v, "loss", SWEEP_LOSS, SWEEP_SEEDS))
  // With no loss every seed gives the same run, so the mean is that run's time, up to rounding in the sum.
  assert.ok(Math.abs(a[0][0] - runHttp(sim, { ...base, loss: 0, seed: 1 }).stats.plt_ns / MS) < 1e-9)
  assert.ok(a[0][SWEEP_LOSS.length - 1] > a[0][0])
  assert.throws(() => runHttp(sim, { ...HTTP_BASE, rtt_us: 0 }))
  assert.throws(() => runHttp(sim, { ...HTTP_BASE, parallel: 9 }))
})
