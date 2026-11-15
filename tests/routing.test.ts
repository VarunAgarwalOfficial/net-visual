// The routing scenarios, tour and lab checks, run through the same TypeScript
// API and WebAssembly module the page uses.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { createNetsim } from "../src/net-visual/core/netsim.ts"
import {
  LABS,
  PRESETS,
  SIX,
  TOUR,
  bellmanTerms,
  forwardingTo,
  pathTo,
  runDuration,
  runRouting,
  stateAfter,
  updatesAfter,
  type RoutingParams,
} from "../src/net-visual/core/routing.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))
const preset = (id: string) => PRESETS.find((p) => p.id === id)!.params
const MS = 1000

test("every scenario runs, ends correct and fits the page", () => {
  for (const pr of PRESETS) {
    const run = runRouting(sim, pr.params)
    assert.ok(run.totals.converged, pr.id)
    assert.equal(pr.params.pos.length, pr.params.nodes.length, pr.id)
    for (const [x, y] of pr.params.pos) assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 60, pr.id)
    assert.ok(pr.dest < pr.params.nodes.length)
  }
})

test("scenarios do what their notes say", () => {
  // Six routers: Dijkstra from u adds x, then v and y, then w, then z.
  const six = runRouting(sim, SIX).epochs[0].dijkstra[0]
  assert.deepEqual(
    six.map((s) => s.added),
    [0, 3, 1, 4, 2, 5],
  )
  assert.deepEqual(six[six.length - 1].d, [0, 2, 3, 1, 2, 4])

  // Three routers: x thinks z costs 7, then 3 one round later.
  const three = runRouting(sim, preset("three"))
  assert.equal(three.events[0].dist[0][2], 7)
  const round1 = three.events.filter((e) => e.t === MS)
  assert.equal(round1[round1.length - 1].dist[0][2], 3)
  // and every table ends as the figure's last column.
  assert.deepEqual(three.events[three.events.length - 1].dist, [
    [0, 2, 3],
    [2, 0, 1],
    [3, 1, 0],
  ])

  // Good news: right within one round of the change.
  const good = runRouting(sim, preset("good-news"))
  assert.ok(good.totals.last_change_us <= 5 * MS)

  // Bad news: 47 updates to y's and z's routes to x; poisoned reverse needs at most 3.
  const cells: [number, number][] = [
    [1, 0],
    [2, 0],
  ]
  const bad = runRouting(sim, preset("bad-news"))
  assert.equal(updatesAfter(bad, 4 * MS, cells), 47)
  assert.equal(bad.totals.last_change_us, 50 * MS)
  // One of y and z climbs by 1 each round.
  const route = bad.events.filter((e) => e.t > 4 * MS).map((e) => Math.max(e.dist[1][0], e.dist[2][0]))
  for (let i = 1; i < route.length; i++) assert.ok(route[i] - route[i - 1] <= 1)
  assert.ok(updatesAfter(runRouting(sim, preset("poison")), 4 * MS, cells) <= 3)

  // Cut off: b takes c's offer of 2 and adds 1, and they count up to 16.
  const cut = runRouting(sim, preset("cut-off"))
  assert.deepEqual([...new Set(cut.events.map((e) => e.dist[1][0]))], [1, 3, 5, 7, 9, 11, 13, 15, 16])

  // Loop of three: c's route to a passes 3, 6, ..., 15 even with poisoned reverse.
  const loop = runRouting(sim, preset("loop-of-three"))
  const c = new Set(loop.events.map((e) => e.dist[2][0]))
  for (const d of [3, 6, 9, 12, 15, 16]) assert.ok(c.has(d), `c's route to a reaches ${d}`)

  // Six routers with failure and repair: some moment has a forwarding loop,
  // and after the repair every table is back where it started.
  const fail = runRouting(sim, preset("six-failure"))
  assert.equal(fail.epochs.length, 3)
  assert.ok(fail.events.some((e) => SIX.nodes.some((_, y) => forwardingTo(e.hop, y).cycles.length > 0)))
  const calm = runRouting(sim, SIX)
  assert.deepEqual(fail.events[fail.events.length - 1].dist, calm.events[calm.events.length - 1].dist)
})

test("the Bellman-Ford terms the page shows reproduce every router's table", () => {
  for (const id of ["six", "bad-news", "poison", "loop-of-three", "six-failure", "async"]) {
    const p = preset(id)
    const run = runRouting(sim, p)
    const n = p.nodes.length
    for (let i = 0; i < run.events.length; i += Math.max(1, Math.floor(run.events.length / 40))) {
      const s = stateAfter(run, p, i)
      for (let x = 0; x < n; x++)
        for (let y = 0; y < n; y++) {
          if (x === y) continue
          const terms = bellmanTerms(s, p, x, y)
          const best = Math.min(p.infinity, ...terms.map((t) => t.total))
          assert.equal(best, run.events[i].dist[x][y], `${id} event ${i}: D_${p.nodes[x]}(${p.nodes[y]})`)
        }
    }
  }
})

test("a change at time zero comes after the cold start", () => {
  const p = { ...preset("three"), changes: [{ at_us: 0, a: 0, b: 1, cost: 5 }] }
  const run = runRouting(sim, p)
  assert.equal(stateAfter(run, p, 0).cost[0][1], 2)
  const l1 = run.events.findIndex((e) => e.step === "L1")
  assert.equal(stateAfter(run, p, l1).cost[0][1], 5)
  for (let i = 0; i < run.events.length; i++) {
    const best = Math.min(p.infinity, ...bellmanTerms(stateAfter(run, p, i), p, 0, 2).map((t) => t.total))
    assert.equal(best, run.events[i].dist[0][2])
  }
})

test("forwarding loops are found, and only real ones", () => {
  // y and z pointing at each other for x is the count-to-infinity loop.
  const hop = [
    [0, 1, 2],
    [2, 1, 2],
    [1, 1, 2],
  ]
  const f = forwardingTo(hop, 0)
  assert.deepEqual(f.cycles, [[1, 2]])
  assert.deepEqual([...f.looping].sort(), [1, 2])
  assert.equal(forwardingTo(hop, 2).cycles.length, 0)

  const bad = runRouting(sim, preset("bad-news"))
  assert.ok(bad.events.some((e) => forwardingTo(e.hop, 0).cycles.length > 0))
  const last = bad.events[bad.events.length - 1]
  for (let y = 0; y < 3; y++) assert.equal(forwardingTo(last.hop, y).cycles.length, 0)

  assert.deepEqual(pathTo([-1, 0, 4, 0, 3, 4], 0, 5), [0, 3, 4, 5])
  assert.equal(pathTo([-1, -1], 0, 1), null)
})

test("tour steps name real scenarios and moments inside them", () => {
  for (const s of TOUR) {
    const p = preset(s.preset)
    assert.ok(p, s.preset)
    assert.ok(s.at <= runDuration(runRouting(sim, p), p), `${s.preset} at ${s.at}`)
  }
})

const lab = (id: string) => LABS.find((l) => l.id === id)!
const check = (id: string, p: RoutingParams) => lab(id).check(p, runRouting(sim, p))

test("labs fail at the start and pass when solved", () => {
  for (const l of LABS) assert.equal(l.check(l.start, runRouting(sim, l.start)).ok, false, l.id)

  const viaW = { ...SIX, links: SIX.links.map((l) => (l.a === 3 && l.b === 4 ? { ...l, cost: 10 } : l)) }
  assert.ok(check("via-w", viaW).ok, check("via-w", viaW).message)
  const twoLinks = { ...viaW, links: viaW.links.map((l) => (l.a === 0 && l.b === 1 ? { ...l, cost: 9 } : l)) }
  assert.equal(check("via-w", twoLinks).ok, false)

  const stop = { ...lab("stop-count").start, poison: true }
  assert.ok(check("stop-count", stop).ok, check("stop-count", stop).message)

  const small = { ...lab("small-infinity").start, infinity: 3 }
  assert.ok(check("small-infinity", small).ok, check("small-infinity", small).message)
  const tooSmall = { ...small, infinity: 2 }
  assert.equal(check("small-infinity", tooSmall).ok, false)

  const loop = { ...SIX, jitter_us: 2 * MS, seed: 3, changes: [{ at_us: 10 * MS, a: 3, b: 4, cost: null }] }
  const made = check("make-loop", loop)
  assert.ok(made.ok, made.message)
})
