// The link-layer scenarios, tour and lab checks, run through the same
// TypeScript API and WebAssembly module the page uses.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import {
  ALOHA_SWEEP,
  CA_EXPOSED,
  CA_HIDDEN,
  CA_NAV,
  CD_SHORT,
  CD_SWEEP,
  CD_TWO,
  CD_WORST,
  LABS,
  MODES,
  PRESETS,
  SWEEP_BYTES,
  SWEEP_GS,
  TOUR,
  alohaExact,
  alohaLimit,
  alohaPeak,
  bebMax,
  cdApprox,
  SOURCE,
  eventTimes,
  fmtTime,
  linkDuration,
  minFrameBytes,
  navFields,
  runCa,
  runCd,
  runLink,
  sweepAloha,
  sweepCd,
  tauNs,
  type LinkParams,
} from "../src/net-visual/core/link.ts"
import { asciiBits, blockOdds, polyText } from "../src/net-visual/core/coding.ts"
import { bid, bridgeId, lanPorts, recoveryMs, type SwitchParams } from "../src/net-visual/core/lan.ts"
import { createNetsim } from "../src/net-visual/core/netsim.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))

test("every scenario runs, has a known mode and a unique id", () => {
  for (const pr of PRESETS) {
    const r = runLink(sim, pr.params)
    assert.equal(r.mode, pr.mode, pr.id)
    assert.ok(MODES.some((m) => m.id === pr.mode))
    assert.ok(eventTimes(r).length > 0, pr.id)
    // An ALOHA frame begun before the end may finish up to a frame later.
    const slack = pr.params.mode === "aloha" ? pr.params.aloha.frame_us : 0
    assert.ok(
      eventTimes(r).every((t) => t <= linkDuration(pr.params, r) + slack),
      pr.id,
    )
  }
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length)
})

test("the page's ALOHA formulas agree with the model's", () => {
  for (const pr of PRESETS.filter((p) => p.params.mode === "aloha")) {
    if (pr.params.mode !== "aloha") continue
    const p = pr.params.aloha
    const s = runLink(sim, pr.params).run.stats as { theory: number; limit: number }
    assert.ok(Math.abs(s.theory - alohaExact(p.slotted, p.stations, p.g)) < 1e-12)
    assert.ok(Math.abs(s.limit - alohaLimit(p.slotted, p.g)) < 1e-12)
  }
  // Slotted ALOHA peaks at G = 1 for any number of stations; pure ALOHA's
  // peak tends to G = 1/2 from above, at 2 − √2 for two stations.
  for (const n of [2, 6, 50]) assert.ok(Math.abs(alohaPeak(true, n).g - 1) < 1e-6)
  assert.ok(Math.abs(alohaPeak(false, 2).g - (2 - Math.SQRT2)) < 1e-6)
  assert.ok(Math.abs(alohaPeak(false, 50).g - 0.5) < 0.01)
  assert.ok(Math.abs(alohaLimit(false, 0.5) - 1 / (2 * Math.E)) < 1e-12)
  assert.ok(Math.abs(alohaLimit(true, 1) - 1 / Math.E) < 1e-12)
})

test("the S against G sweep lands on the formulas", () => {
  // Fifty stations, 20,000 frame times per point, seed 1. Tolerances are
  // four standard deviations of S measured over seeds 1 to 20 (see the Rust
  // tests in link.rs): 0.016 slotted, 0.011 pure.
  for (const slotted of [true, false]) {
    const pts = sweepAloha(sim, { ...ALOHA_SWEEP, slotted }, SWEEP_GS)
    for (const pt of pts) {
      const want = alohaExact(slotted, ALOHA_SWEEP.stations, pt.g)
      assert.ok(Math.abs(pt.s - want) < (slotted ? 0.016 : 0.011), `${slotted} G ${pt.g}: ${pt.s} vs ${want}`)
    }
  }
})

test("CSMA/CD scenarios do what their notes say", () => {
  // Two stations 2 km apart: both send after the 9.6 µs gap and hear each
  // other 10 µs later.
  const two = runCd(sim, CD_TWO)
  for (const tx of two.txs.slice(0, 2)) {
    assert.equal(tx.start_ns, 9_600)
    assert.equal(tx.detect_ns, 19_600)
    assert.equal(tx.end_ns, 22_800)
  }
  assert.deepEqual(
    two.backoffs.slice(0, 2).map((b) => b.max),
    [1, 1],
  )
  assert.equal(two.stats.delivered, 2)

  // The worst case: A hears B 24.9 µs after starting, just under 2τ = 25 µs.
  const worst = runCd(sim, CD_WORST)
  assert.equal(worst.txs[0].detect_ns! - worst.txs[0].start_ns, 24_900)
  assert.equal(worst.stats.tau_ns, 12_500)
  assert.ok(worst.stats.max_detect_ns <= 2 * worst.stats.tau_ns)

  // 20-byte frames: A finishes at 25.6 µs, before B's signal returns.
  const short = runCd(sim, CD_SHORT)
  assert.equal(short.txs[0].end_ns, 25_600)
  assert.equal(short.txs[0].outcome, "undetected")
  assert.equal(minFrameBytes(CD_SHORT), 32)
  assert.equal(tauNs(CD_SHORT), 12_500)

  assert.deepEqual(
    [1, 2, 3, 10, 15].map((n) => bebMax(n)),
    [1, 3, 7, 1023, 1023],
  )
  assert.equal(bebMax(16), null)
})

test("Ethernet efficiency falls as a grows, above the 1/(1 + 5a) approximation", () => {
  const pts = sweepCd(sim, CD_SWEEP, SWEEP_BYTES)
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].a < pts[i - 1].a)
  // Saturated stations with binary exponential backoff capture the channel,
  // so the measured efficiency beats the approximation at every a.
  for (const pt of pts) assert.ok(pt.efficiency > cdApprox(pt.a), `${pt.frame_bytes}`)
  assert.ok(pts[pts.length - 1].efficiency > pts[0].efficiency)
})

test("CSMA/CA scenarios do what their notes say", () => {
  // NAV: D from the RTS, C from the CTS, both ending with the ACK.
  const nav = runCa(sim, CA_NAV)
  const f = navFields(CA_NAV)
  const kinds = (k: string) => nav.airs.filter((a) => a.kind === k)
  assert.equal(kinds("rts")[0].nav_us, f.rts)
  assert.equal(kinds("cts")[0].nav_us, f.cts)
  assert.equal(kinds("data")[0].nav_us, f.data)
  const ackEnd = kinds("ack")[0].end_us
  const navOf = (node: number, air: number) => nav.navs.find((n) => n.node === node && n.air === air)!
  assert.equal(navOf(0, kinds("rts")[0].id).until_us, ackEnd)
  assert.equal(navOf(3, kinds("cts")[0].id).until_us, ackEnd)
  assert.equal(nav.stats.flows[0].delivered, 2)

  // Hidden terminals lose most data frames; RTS/CTS keeps losses small and
  // moves the collisions to RTS frames.
  const plain = runCa(sim, CA_HIDDEN).stats
  const rts = runCa(sim, { ...CA_HIDDEN, rts: true }).stats
  assert.ok(plain.data_loss > 0.5, `${plain.data_loss}`)
  assert.ok(rts.data_loss < 0.05, `${rts.data_loss}`)
  assert.ok(rts.rts_loss > 0.05)

  // Exposed terminals: no losses, but long needless deferral.
  const exposed = runCa(sim, CA_EXPOSED).stats
  for (const fl of exposed.flows) {
    assert.equal(fl.data_lost, 0)
    assert.ok(fl.needless_us > 0.3 * CA_EXPOSED.duration_us)
  }
})

test("tour steps point at real scenarios and moments inside them", () => {
  for (const step of TOUR) {
    const pr = PRESETS.find((p) => p.id === step.preset)
    assert.ok(pr, step.preset)
    assert.ok(step.at > 0 && step.at <= linkDuration(pr.params, runLink(sim, pr.params)), step.preset)
  }
})

const solve = (id: string, edit: (p: LinkParams) => LinkParams) => {
  const lab = LABS.find((l) => l.id === id)!
  const p = edit(structuredClone(lab.start))
  return lab.check(p, runLink(sim, p))
}

test("no lab is solved by its starting point, and each has a solution", () => {
  for (const lab of LABS) assert.equal(lab.check(lab.start, runLink(sim, lab.start)).ok, false, lab.id)

  const g = (v: number) => (p: LinkParams) => (p.mode === "aloha" ? { ...p, aloha: { ...p.aloha, g: v } } : p)
  assert.ok(solve("find-the-peak", g(0.586)).ok)
  assert.equal(solve("find-the-peak", g(0.5)).ok, false)

  const bytes = (b: number) => (p: LinkParams) => (p.mode === "csmacd" ? { ...p, cd: { ...p.cd, frame_bytes: b } } : p)
  assert.ok(solve("min-frame", bytes(32)).ok)
  assert.equal(solve("min-frame", bytes(64)).ok, false)
  assert.equal(solve("min-frame", bytes(31)).ok, false)

  const ca = (o: object) => (p: LinkParams) => (p.mode === "csmaca" ? { ...p, ca: { ...p.ca, ...o } } : p)
  assert.ok(solve("cure-hidden", ca({ rts: true })).ok)
  assert.equal(solve("cure-hidden", ca({ range_m: 200 })).ok, false)

  // Spread the four out: B and C 110 m apart, each receiver 90 m beyond.
  const spread = ca({
    nodes: [
      { name: "A", x_m: -20, y_m: 0 },
      { name: "B", x_m: 70, y_m: 0 },
      { name: "C", x_m: 180, y_m: 0 },
      { name: "D", x_m: 270, y_m: 0 },
    ],
  })
  const r = solve("unexpose", spread)
  assert.ok(r.ok, r.message)

  // The storm: turn on the spanning tree, or cut the ring down to a path.
  const sw = (f: (s: SwitchParams) => SwitchParams) => (p: LinkParams) => (p.mode === "switch" ? { ...p, sw: f(p.sw) } : p)
  assert.ok(
    solve(
      "stop-the-storm",
      sw((s) => ({ ...s, stp: true })),
    ).ok,
  )
  const path = solve(
    "stop-the-storm",
    sw((s) => ({ ...s, links: s.links.filter((_, i) => i !== 3 && i !== 4 && i !== 5) })),
  )
  assert.ok(path.ok, path.message)
  assert.equal(
    solve(
      "stop-the-storm",
      sw((s) => ({ ...s, links: s.links.filter((_, i) => i !== 4) })),
    ).ok,
    false,
  )
  assert.equal(
    solve(
      "stop-the-storm",
      sw((s) => ({ ...s, stp: true, links: s.links.slice(0, 9) })),
    ).ok,
    false,
  )

  const prio = (i: number, pr: number) => (p: LinkParams) =>
    p.mode === "stp"
      ? { ...p, stp: { ...p.stp, bridges: p.stp.bridges.map((b, j) => (j === i ? { ...b, id: bid(pr, b.id % 65536) } : b)) } }
      : p
  assert.ok(solve("choose-the-root", prio(3, 4096)).ok)
  assert.equal(solve("choose-the-root", prio(2, 4096)).ok, false)
  assert.equal(solve("choose-the-root", (p) => (p.mode === "stp" ? { ...p, stp: { ...p.stp, hello_ms: 1000 } } : p)).ok, false)

  const flips = (f: number[]) => (p: LinkParams) =>
    p.mode === "crc" ? { ...p, crc: { ...p.crc, flips: f } } : p.mode === "hamming" ? { ...p, ham: { ...p.ham, flips: f } } : p
  assert.ok(solve("fool-the-crc", flips([3, 6, 7])).ok)
  assert.ok(solve("fool-the-crc", flips([9, 12, 13])).ok)
  assert.equal(solve("fool-the-crc", flips([2, 3])).ok, false)

  assert.ok(solve("fool-secded", flips([0, 1, 2, 3])).ok)
  assert.equal(solve("fool-secded", flips([1, 2])).ok, false, "two errors are detected")
  assert.equal(solve("fool-secded", flips([1, 2, 3])).ok, false, "three errors give a wrong correction, not a clean verdict")
})

const preset = (id: string) => {
  const pr = PRESETS.find((p) => p.id === id)!
  return { p: pr.params, r: runLink(sim, pr.params) }
}

test("switch scenarios flood, forward, filter and age as their notes say", () => {
  const learn = preset("learn")
  assert.ok(learn.r.mode === "switch" && learn.p.mode === "switch")
  const ev = learn.r.run.events
  const s1 = (f: number) => ev.find((e) => e.node === 0 && e.frame === f && ["flood", "forward", "filter"].includes(e.what))!
  // A to C: S1 knows nobody yet and floods on every port but A's.
  assert.equal(s1(0).what, "flood")
  assert.deepEqual(s1(0).out, [1, 3])
  // C to A: forwarded only on the port A was learned on.
  assert.equal(s1(1).what, "forward")
  assert.deepEqual(s1(1).out, [2])
  // A to D: nobody has heard from D.
  assert.equal(s1(3).what, "flood")
  assert.deepEqual(learn.r.run.delivered, [1, 1, 1, 1])

  const filter = preset("filter")
  assert.ok(filter.r.mode === "switch")
  const f = filter.r.run.events.find((e) => e.frame === 1 && e.node === 0 && e.what !== "learn")!
  assert.equal(f.what, "filter")

  const aging = preset("aging")
  assert.ok(aging.r.mode === "switch")
  const replies = aging.r.run.events.filter((e) => e.node === 1 && (e.what === "forward" || e.what === "flood"))
  assert.deepEqual(
    replies.map((e) => [e.frame, e.what]),
    [
      [0, "flood"],
      [1, "forward"],
      [2, "flood"],
    ],
  )
  assert.ok(aging.r.run.events.some((e) => e.what === "age" && e.t < 600))
})

test("a loop without the spanning tree storms; with it each host hears the broadcast once", () => {
  const storm = preset("storm")
  const tree = preset("storm-stp")
  assert.ok(storm.r.mode === "switch" && tree.r.mode === "switch")
  assert.equal(storm.r.run.capped, true)
  // Sends grow: each hop roughly doubles the copies in flight.
  const by = (t: number) => storm.r.run.events.filter((e) => e.t <= t).at(-1)!.sent
  assert.ok(by(20) < by(40) && by(40) < by(60) && by(60) < by(80))
  assert.ok(by(60) - by(40) > by(40) - by(20), "the storm accelerates")
  assert.ok(storm.r.run.delivered[0] > 3)
  assert.equal(tree.r.run.capped, false)
  assert.deepEqual(tree.r.run.delivered, [3, 1])
  assert.equal(tree.r.run.blocked.length, 3)
  assert.equal(tree.r.run.sent, 13)
})

test("spanning-tree scenarios converge to the directly computed tree", () => {
  for (const id of ["stp-converge", "stp-fail", "stp-silent", "stp-ties"]) {
    const { p, r } = preset(id)
    assert.ok(p.mode === "stp" && r.mode === "stp")
    const d = r.run.direct
    // A silent failure leaves both ends of the dead link up: each hears nothing and calls itself designated.
    const silent = p.stp.failure && !p.stp.failure.detected
    r.run.end.forEach((v, i) => {
      assert.equal(v.root, p.stp.bridges[d.root].id, `${id} ${i}`)
      assert.equal(v.root_port, d.root_port[i], `${id} ${i}`)
      assert.deepEqual(
        v.ports.map((x) => x.role),
        d.roles[i].map((role) => (silent && role === "disabled" ? "designated" : role)),
        `${id} ${i}`,
      )
      for (const x of v.ports)
        assert.equal(
          x.state,
          x.role === "disabled" ? "disabled" : x.role === "alternate" ? "blocking" : "forwarding",
          `${id} ${i} ${x.port}`,
        )
    })
    // One designated port per working link, and the forwarding links form a spanning tree.
    const up = p.stp.links.map((_, k) => !(p.stp.failure && p.stp.failure.link === k))
    const ports = lanPorts(p.stp.bridges.length, p.stp.links)
    const designated = p.stp.links.map(() => 0)
    const forwarding = p.stp.links.map(() => 0)
    d.roles.forEach((rs, i) =>
      rs.forEach((role, k) => {
        if (role === "designated") designated[ports[i][k].link]++
        if (role === "designated" || role === "root") forwarding[ports[i][k].link]++
      }),
    )
    up.forEach((u, k) => assert.equal(designated[k], u ? 1 : 0, `${id} link ${k}`))
    const tree = forwarding.map((n, k) => (n === 2 ? k : -1)).filter((k) => k >= 0)
    assert.equal(tree.length, p.stp.bridges.length - 1, id)
    const seen = new Set([d.root])
    for (let grow = true; grow;) {
      grow = false
      for (const k of tree) {
        const { a, b } = p.stp.links[k]
        if (seen.has(a) !== seen.has(b)) {
          seen.add(a)
          seen.add(b)
          grow = true
        }
      }
    }
    assert.equal(seen.size, p.stp.bridges.length, `${id}: the tree reaches every bridge`)
  }
  const five = preset("stp-converge").r
  assert.ok(five.mode === "stp")
  assert.equal(five.run.phases[0].settled_ms, 30_000)
  assert.ok(five.run.phases[0].roles_ms <= 60)
  const ties = preset("stp-ties").r
  assert.ok(ties.mode === "stp")
  assert.equal(ties.run.direct.root, 0)
  assert.equal(ties.run.direct.root_port[3], 2, "Z prefers Y's lower port")
})

test("a sensed failure recovers in two forward delays, a silent one after Max Age as well", () => {
  for (const [id, lo, hi] of [
    ["stp-fail", 30_000, 30_100],
    ["stp-silent", 44_000, 50_000],
  ] as const) {
    const { p, r } = preset(id)
    assert.ok(p.mode === "stp" && r.mode === "stp")
    const ph = r.run.phases[1]
    const took = ph.settled_ms - ph.from_ms
    assert.ok(took >= lo && took <= hi, `${id} took ${took}`)
    assert.ok(took <= recoveryMs(p.stp, p.stp.failure!.detected) + 100, id)
  }
})

test("CRC scenarios: the textbook remainder, a missed error, a caught burst, the check values", () => {
  const div = preset("crc-division").r
  assert.ok(div.mode === "crc")
  assert.equal(div.run.remainder, "1110")
  assert.equal(div.run.codeword, "11010110111110")
  assert.equal(div.run.detected, false)
  const missed = preset("crc-missed").r
  assert.ok(missed.mode === "crc")
  assert.notEqual(missed.run.received, missed.run.codeword)
  assert.equal(missed.run.detected, false)
  const b = preset("crc-burst").r
  assert.ok(b.mode === "crc")
  assert.equal(b.run.detected, true)
  // Every burst up to r is caught; a burst of r + 1 slips through with odds 2^-(r-1), longer ones 2^-r.
  const bs = b.run.props.bursts
  for (const s of bs.filter((s) => s.len <= 4)) assert.equal(s.undetected, 0)
  assert.equal(bs.find((s) => s.len === 5)!.undetected / bs.find((s) => s.len === 5)!.patterns, 1 / 8)
  assert.equal(bs.find((s) => s.len === 6)!.undetected / bs.find((s) => s.len === 6)!.patterns, 1 / 16)
  const c8 = preset("crc-8").r
  assert.ok(c8.mode === "crc")
  assert.equal(parseInt(c8.run.remainder, 2), 0xf4)
  assert.deepEqual(
    c8.run.standard.map((s) => s.value),
    [0xf4, 0x29b1, 0xcbf43926],
  )
  assert.equal(c8.run.props.plus_one, true)
  assert.equal(asciiBits("1"), "00110001")
  assert.equal(polyText("10011"), "x⁴ + x + 1")
})

test("Hamming scenarios: corrected, miscorrected, detected", () => {
  const verdict = (id: string) => {
    const r = preset(id).r
    assert.ok(r.mode === "hamming")
    return [r.run.verdict, r.run.syndrome, r.run.data_ok, r.run.min_distance]
  }
  assert.deepEqual(verdict("hamming-74"), ["corrected", 5, true, 3])
  assert.deepEqual(verdict("hamming-double"), ["corrected", 6, false, 3])
  assert.deepEqual(verdict("secded"), ["detected", 6, false, 4])
  assert.deepEqual(verdict("hamming-15"), ["corrected", 11, true, 3])
  const h = preset("hamming-74").r
  assert.ok(h.mode === "hamming")
  // The block-error estimate: uncoded is 1 - (1 - q)^4; coded is O(q^2).
  const q = 0.01
  const odds = blockOdds(h.run, false, q)
  assert.ok(Math.abs(odds.uncoded - (1 - 0.99 ** 4)) < 1e-12)
  assert.ok(odds.wrong < odds.uncoded / 10)
  assert.ok(odds.wrong > 20 * q * q * 0.9, "C(7,2) q² patterns are miscorrected")
})

test("time and duration helpers speak each mode's unit", () => {
  assert.equal(fmtTime(2500, "stp"), "2.5 s")
  assert.equal(fmtTime(3, "crc"), "step 4")
  assert.equal(fmtTime(40, "switch"), "40 µs")
  assert.equal(SOURCE.stp.tool, "stp")
  assert.equal(bridgeId(bid(32768, 0x0a1)), "32768.00a1")
})
