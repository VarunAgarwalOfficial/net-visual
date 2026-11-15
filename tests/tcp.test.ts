// The TCP scenarios, tour and lab checks, run through the same TypeScript API
// and WebAssembly module the page uses.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { createNetsim } from "../src/net-visual/core/netsim.ts"
import {
  LABS,
  PRESETS,
  TOUR,
  internetChecksum,
  runOverview,
  runWindow,
  tcpHeader,
  valueAt,
  windowFor,
  words,
  type TcpParams,
} from "../src/net-visual/core/tcp.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))
const preset = (id: string) => PRESETS.find((p) => p.id === id)!
const withAlgo = (p: TcpParams, algo: TcpParams["flows"][number]["algo"]): TcpParams => ({
  ...p,
  flows: p.flows.map((f, i) => (i === 0 ? { ...f, algo } : f)),
})

test("scenarios do what their notes say", () => {
  // Kurose and Ross: ssthresh 8, a loss near cwnd 12, ssthresh 6; Reno at 6 after recovery, Tahoe at 1.
  const kr = preset("kr").params
  const reno = runOverview(sim, kr).series[0]
  const fast = reno.marks.find((m) => m.kind === "fast")!
  assert.equal(valueAt(reno.ssthresh, fast.t), 6)
  assert.ok(Math.abs(valueAt(reno.cwnd, fast.t - 1) - 12) < 0.5)
  const after = reno.cwnd.filter(([t]) => t > fast.t && t < fast.t + 300_000).map(([, c]) => c)
  assert.equal(Math.min(...after), 6)
  assert.equal(valueAt(runOverview(sim, withAlgo(kr, "tahoe")).series[0].cwnd, fast.t + 1), 1)

  // Fall and Floyd: Reno times out, NewReno does not.
  const ff = preset("fall-floyd").params
  assert.ok(runOverview(sim, ff).totals.flows[0].timeouts >= 1)
  assert.equal(runOverview(sim, withAlgo(ff, "newreno")).totals.flows[0].timeouts, 0)

  // The sawtooth follows its closed form.
  const saw = runOverview(sim, preset("sawtooth").params)
  assert.ok(Math.abs(saw.totals.utilisation - saw.theory.reno_utilisation) < 0.02)

  // Bufferbloat: busy link, round trip over a second; a tenth of the buffer keeps it busy.
  const bloat = runOverview(sim, preset("bufferbloat").params)
  assert.ok(bloat.totals.utilisation > 0.99 && bloat.totals.flows[0].mean_rtt_us > 1e6)
  const small = runOverview(sim, { ...preset("bufferbloat").params, buffer_pkts: 20 })
  assert.ok(small.totals.utilisation > 0.99 && small.totals.flows[0].mean_rtt_us < 0.3e6)

  // No buffer: far below the fluid model's 3/4, and the timer does the work.
  const none = runOverview(sim, preset("no-buffer").params)
  assert.ok(none.theory.reno_utilisation > 0.74 && none.totals.utilisation < 0.2)
  assert.ok(none.totals.flows[0].timeouts > none.totals.flows[0].fast_retransmits)

  // Two equal flows share; the 50 ms flow beats the 150 ms flow, unless phase effects starve it.
  assert.ok(runOverview(sim, preset("two-flows").params).totals.jain > 0.99)
  const [short, long] = runOverview(sim, preset("rtt-unfair").params).totals.flows
  assert.ok(short.goodput_bps > 1.4 * long.goodput_bps)
  const [starved, fed] = runOverview(sim, preset("phase").params).totals.flows
  assert.ok(starved.goodput_bps < 0.5 * fed.goodput_bps)

  // CUBIC fills the long fat pipe; Reno at the same loss rate does not.
  const cubic = preset("cubic").params
  assert.ok(runOverview(sim, cubic).totals.utilisation > 0.95)
  assert.ok(runOverview(sim, withAlgo(cubic, "reno")).totals.utilisation < 0.7)
})

test("a window of the trace matches the run around it", () => {
  const p = preset("sawtooth").params
  const t = 12_000_000
  const w = windowFor(p, t)
  assert.ok(w.from <= t && t <= w.to)
  const run = runWindow(sim, p, w)
  assert.ok(run.trace_end >= t, "the window should reach the moment it is for")
  const overview = runOverview(sim, p)
  const last = run.events.filter((e) => e.t <= t).at(-1)!
  // The overview's curve is thinned to 3000 points, so allow a fraction of a segment.
  assert.ok(Math.abs(last.state.cwnd - valueAt(overview.series[0].cwnd, t)) < 0.5)
})

test("lab checks reject the starting state and accept a solution", () => {
  for (const lab of LABS) assert.equal(lab.check(lab.start, runOverview(sim, lab.start), sim).ok, false, lab.id)
  const solve = (id: string, change: Partial<TcpParams>) => {
    const lab = LABS.find((l) => l.id === id)!
    const p = { ...lab.start, ...change }
    const result = lab.check(p, runOverview(sim, p), sim)
    assert.equal(result.ok, true, `${id}: ${result.message}`)
  }
  solve("ssthresh", { drops: [{ flow: 0, seg: 180, occurrence: 1 }] })
  solve("buffer", { buffer_pkts: 39 })
  solve("mathis", { drop_every: 250 })
  solve("reno-stalls", { drops: [30, 32, 34].map((seg) => ({ flow: 0, seg, occurrence: 1 })) })
  solve("tahoe-wins", { drops: [30, 32, 34].map((seg) => ({ flow: 0, seg, occurrence: 1 })) })
})

test("the tour stops where its text says", () => {
  const at = (i: number) => {
    const p = preset(TOUR[i].preset).params
    const t = TOUR[i].at * p.duration_us
    return { p, t, run: runOverview(sim, p) }
  }
  // Slow start: the window is still growing towards ssthresh 8.
  const ss = at(0)
  assert.ok(valueAt(ss.run.series[0].cwnd, ss.t) < 8)
  // Just after the fast retransmit of segment 50, inside fast recovery.
  const fr = at(1)
  const fast = fr.run.series[0].marks.find((m) => m.kind === "fast")!
  assert.ok(fast.t <= fr.t && fr.t < fast.t + 100_000)
  // After recovery: Reno in avoidance above Tahoe.
  const after = at(2)
  const tahoe = runOverview(sim, withAlgo(after.p, "tahoe")).series[0]
  assert.ok(valueAt(after.run.series[0].cwnd, after.t) > valueAt(tahoe.cwnd, after.t))
  // Reno's timeout has happened by this point.
  const ff = at(3)
  const timeout = ff.run.series[0].marks.find((m) => m.kind === "timeout")!
  assert.ok(timeout.t <= ff.t)
  // The two flows are close to fair by the end.
  assert.ok(at(6).run.totals.jain > 0.99)
})

test("the TCP header's checksum verifies as RFC 9293 and RFC 1071 say", () => {
  const p = preset("kr").params
  const run = runWindow(sim, p, windowFor(p, 0))
  for (const f of [run.flights.find((x) => !x.ack)!, run.flights.find((x) => x.ack)!]) {
    const h = tcpHeader(f, p)
    assert.equal(h.bytes.length, h.len)
    // The receiver's check: the sum over pseudo-header and segment, checksum included, is all ones.
    assert.equal(internetChecksum(words([...h.pseudo, ...h.bytes])), 0)
    assert.equal(h.bytes[12] >> 4, 5)
  }
  // RFC 1071's own example: words 0001 f203 f4f5 f6f7 sum to ddf2, so the checksum is 220d.
  assert.equal(internetChecksum([0x0001, 0xf203, 0xf4f5, 0xf6f7]), 0x220d)
})
