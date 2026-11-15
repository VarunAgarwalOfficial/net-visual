// The queueing scenarios, tour and lab checks, run through the same TypeScript
// API and WebAssembly module the page uses.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { createNetsim } from "../src/net-visual/core/netsim.ts"
import {
  BACKLOGGED,
  FOUR,
  LABS,
  MICE,
  MM1,
  PRESETS,
  SHAPED,
  TOUR,
  delays,
  envelopeExcess,
  occupancy,
  releases,
  runDuration,
  runQueue,
  shares,
  sweepQueue,
  theory,
  type QueueParams,
} from "../src/net-visual/core/queue.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))
const preset = (id: string) => PRESETS.find((p) => p.id === id)!.params
const rel = (a: number, b: number) => Math.abs(a - b) / b

test("every scenario runs within the model's bounds and has a mode", () => {
  for (const pr of PRESETS) {
    const run = runQueue(sim, pr.params)
    assert.ok(run.stats.served > 0, pr.id)
    assert.ok(["delay", "shaping", "scheduling"].includes(pr.mode), pr.id)
    assert.ok(runDuration(run) > 0)
  }
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length)
})

test("scenarios do what their notes say", () => {
  // Four delays: 20 µs + 1.2 ms + 10 ms, and each packet waits 300 µs more than the last.
  const four = runQueue(sim, FOUR)
  const d = four.packets.map((q) => delays(FOUR, q)!)
  assert.deepEqual(
    d.map((x) => x.queueing),
    [0, 300, 600, 900, 1200, 1500],
  )
  for (const x of d) {
    assert.equal(x.processing, 20)
    assert.equal(x.transmission, 1200)
    assert.equal(x.propagation, 10_000)
  }

  // M/M/1 and M/D/1 at 0.7 land near theory, and M/D/1 waits about half as long.
  const mm1 = runQueue(sim, MM1).stats
  const md1 = runQueue(sim, preset("md1")).stats
  assert.ok(rel(theory(MM1).w!, 10_000 / 3) < 1e-9)
  assert.ok(rel(mm1.system_us, theory(MM1).w!) < 0.05, `${mm1.system_us}`)
  assert.ok(rel(md1.wait_us, theory(preset("md1")).wq!) < 0.05, `${md1.wait_us}`)
  assert.ok(rel(md1.wait_us / mm1.wait_us, 0.5) < 0.1)
  // Little's law on each run: L = λW exactly, from the model's own sweep.
  for (const s of [mm1, md1]) assert.ok(rel(s.l, (s.lambda_pps * s.system_us) / 1e6) < 1e-9)
  // The page's own occupancy curve gives the same time average.
  const occ = occupancy(runQueue(sim, MM1))
  let area = 0
  for (let i = 1; i < occ.length; i++) area += occ[i - 1].n * (occ[i].t - occ[i - 1].t)
  assert.ok(rel(area / occ[occ.length - 1].t, mm1.l) < 1e-9)

  // At 95% the queue climbs into the sixties.
  assert.ok(runQueue(sim, preset("heavy")).stats.max_waiting >= 60)

  // Overload: the buffer caps the wait at 50 service times, and once it is
  // full about one packet in six is dropped.
  const over = runQueue(sim, preset("overload"))
  assert.equal(over.stats.max_waiting, 50)
  assert.ok(Math.max(...over.packets.map((q) => (q.t_start ?? 0) - (q.t_join ?? 0))) <= 50_000)
  const firstDrop = over.packets.findIndex((q) => q.dropped)
  const after = over.packets.slice(firstDrop)
  // About 1700 Poisson arrivals after the first drop: their count has a
  // standard deviation near 41, 2.4% of them, which the drops inherit since
  // the link sends at a fixed rate. Two deviations: 0.05.
  const share = after.filter((q) => q.dropped).length / after.length
  assert.ok(Math.abs(share - 1 / 6) < 0.05 && Math.round(share * 100) === 14, `${share}`)
  assert.ok(over.stats.busy > 0.99)

  // Token bucket: seven at once, then one every 2 ms; the output fits b = 3000 exactly.
  const shaped = runQueue(sim, SHAPED)
  const out = releases(shaped, 0)
  assert.deepEqual(
    out.slice(0, 10).map((x) => x[0]),
    [0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000],
  )
  assert.ok(envelopeExcess(out, 2_000_000) <= 3000 + 1e-9)
  assert.ok(
    envelopeExcess(
      shaped.packets.map((q) => [q.t_arrive, q.size_bytes]),
      2_000_000,
    ) > 3000,
  )
  // Policing: ten of each twenty kept, none delayed.
  const police = runQueue(sim, preset("token-police"))
  assert.equal(police.stats.dropped, 100)
  assert.ok(police.packets.every((q) => q.dropped || q.t_shaped === q.t_arrive))
  // Leaky bucket: twelve of twenty, 2 ms apart.
  const leaky = runQueue(sim, preset("leaky"))
  assert.equal(leaky.stats.served, 120)
  const lo = releases(leaky, 0)
  for (let i = 1; i < lo.length; i++) assert.ok(lo[i][0] - lo[i - 1][0] >= 2000)

  // FIFO keeps voice waiting about 14 ms, up to 26; priority at most one bulk packet, 1.5 ms.
  const fifo = runQueue(sim, MICE).stats.flows[1]
  assert.ok(fifo.wait_us > 13_000 && fifo.max_wait_us > 25_000)
  const prio = runQueue(sim, preset("priority")).stats
  assert.ok(prio.flows[1].max_wait_us <= 1500)
  assert.ok(rel(prio.flows[0].wait_us, runQueue(sim, MICE).stats.flows[0].wait_us) < 0.05)

  // WFQ: shares 1/7, 2/7, 4/7 while all are backlogged, and no packet more than 1.5 ms behind GPS.
  const wfq = runQueue(sim, BACKLOGGED)
  const s = shares(BACKLOGGED, wfq)
  s.share.forEach((x, k) => assert.ok(Math.abs(x - s.fair[k]) < 0.01))
  assert.ok(wfq.packets.every((q) => q.t_depart! - q.gps_finish <= 1500 + 1e-6))

  // A greedy flow: FIFO shares by demand, WFQ protects the polite flow.
  const greedy = runQueue(sim, preset("fifo-greedy")).stats.flows[0]
  const fair = runQueue(sim, preset("wfq-greedy")).stats.flows[0]
  assert.ok(greedy.wait_us > 100_000)
  assert.ok(fair.max_wait_us <= 1000)
})

test("the sweep follows M/D/1 and M/M/1", () => {
  const pts = sweepQueue(sim, preset("md1"), [0.5, 0.8], 50_000)
  assert.ok(rel(pts[0].wait_us, theory({ ...preset("md1"), flows: [{ ...preset("md1").flows[0], rate_pps: 500 }] }).wq!) < 0.06)
  const exp = sweepQueue(sim, MM1, [0.5], 50_000)
  assert.ok(rel(exp[0].system_us, 2000) < 0.06)
  assert.throws(() => sweepQueue(sim, MM1, [0.99], 1000))
})

test("tour stops point at scenarios and moments inside them", () => {
  for (const t of TOUR) {
    const pr = PRESETS.find((p) => p.id === t.preset)
    assert.ok(pr, t.preset)
    assert.ok(t.at <= runDuration(runQueue(sim, pr.params)), `${t.preset} at ${t.at}`)
  }
  // The first stop is the instant the packet's last bit leaves.
  assert.equal(runQueue(sim, FOUR).packets[0].t_depart, TOUR[0].at)
  assert.equal(runQueue(sim, FOUR).packets[0].t_reach, TOUR[1].at)
})

test("labs reject their starting point and accept a solution", () => {
  const solutions: Record<string, (p: QueueParams) => QueueParams> = {
    "match-delays": (p) => ({ ...p, distance_m: 240_000 }),
    "buy-bandwidth": (p) => ({ ...p, rate_bps: 9_600_000 }),
    "size-the-bucket": (p) => ({ ...p, flows: [{ ...p.flows[0], shaper: { ...p.flows[0].shaper, bucket_bytes: 6500 } }] }),
    "rescue-voice": (p) => ({ ...p, discipline: "priority" }),
    "set-weights": (p) => ({ ...p, flows: p.flows.map((f, k) => ({ ...f, weight: [5, 3, 2][k] })) }),
  }
  assert.deepEqual(Object.keys(solutions).sort(), LABS.map((l) => l.id).sort())
  for (const lab of LABS) {
    assert.equal(lab.check(lab.start, runQueue(sim, lab.start)).ok, false, lab.id)
    const p = solutions[lab.id](lab.start)
    const r = lab.check(p, runQueue(sim, p))
    assert.ok(r.ok, `${lab.id}: ${r.message}`)
  }
  // Voice is rescued by WFQ too.
  const wfq = { ...MICE, discipline: "wfq" as const }
  assert.ok(LABS.find((l) => l.id === "rescue-voice")!.check(wfq, runQueue(sim, wfq)).ok)
  // A bucket too small holds packets too long.
  const lab = LABS.find((l) => l.id === "size-the-bucket")!
  const small = { ...SHAPED, flows: [{ ...SHAPED.flows[0], shaper: { ...SHAPED.flows[0].shaper, bucket_bytes: 5000 } }] }
  assert.equal(lab.check(small, runQueue(sim, small)).ok, false)
})
