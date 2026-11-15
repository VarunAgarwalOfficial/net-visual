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
  eventTimes,
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
      eventTimes(r).every((t) => t <= linkDuration(pr.params) + slack),
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
    assert.ok(step.at > 0 && step.at <= linkDuration(pr.params), step.preset)
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
})
