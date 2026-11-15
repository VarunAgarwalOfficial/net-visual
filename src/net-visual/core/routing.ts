// The typed interface to the routing model in crates/netsim/src/routing.rs,
// with the scenarios, the tour and the lab tasks. Erasable TypeScript only, so
// the Node tests can import it directly.
import type { Netsim } from "./netsim.ts"

export interface RLink {
  a: number
  b: number
  cost: number
}

/** At `at_us` the link a-b gets `cost`; null takes it down. */
export interface RChange {
  at_us: number
  a: number
  b: number
  cost: number | null
}

export interface RoutingParams {
  nodes: string[]
  /** Where each router is drawn, in a 100 by 60 box. The model ignores it. */
  pos: [number, number][]
  links: RLink[]
  changes: RChange[]
  poison: boolean
  infinity: number
  delay_us: number
  jitter_us: number
  seed: number
}

export interface RMessage {
  id: number
  from: number
  to: number
  t_send: number
  t_arrive: number
  vector: number[]
  poisoned: number[]
  lost: boolean
}

export interface REvent {
  t: number
  node: number
  step: string
  text: string
  message: number | null
  dist: number[][]
  hop: number[][]
  changed: [number, number][]
}

export interface DijkstraStep {
  added: number
  d: number[]
  p: number[]
}

export interface Epoch {
  t: number
  cost: number[][]
  dijkstra: DijkstraStep[][]
  shortest: number[][]
}

export interface RoutingRun {
  events: REvent[]
  messages: RMessage[]
  epochs: Epoch[]
  totals: { messages: number; lost: number; last_change_us: number; converged: boolean; truncated: boolean }
}

export const runRouting = (sim: Netsim, p: RoutingParams) => sim.call<RoutingRun>("routing", "run", p)

/** The time the page shows: a little past the last event. */
export const runDuration = (run: RoutingRun, p: RoutingParams) =>
  Math.max(run.events[run.events.length - 1].t, ...p.changes.map((c) => c.at_us)) + p.delay_us

export const epochAt = (run: RoutingRun, t: number): Epoch => {
  let e = run.epochs[0]
  for (const x of run.epochs) if (x.t <= t) e = x
  return e
}

/** The changes in the order the model applies them: one L1 event each. */
const ordered = (p: RoutingParams) => p.changes.map((c, k) => ({ c, k })).sort((a, b) => a.c.at_us - b.c.at_us || a.k - b.k)

export interface State {
  /** Link costs, -1 where there is no link. */
  cost: number[][]
  /** heard[x][v]: the last message x kept from v, or null. */
  heard: (RMessage | null)[][]
}

/**
 * Replay the trace to event i and return what each router knows: the costs
 * of its links and the last vector heard from each neighbour, forgotten when
 * the link between them fails (as step L1 does in the model).
 */
export function stateAfter(run: RoutingRun, p: RoutingParams, i: number): State {
  const n = p.nodes.length
  const cost = run.epochs[0].cost.map((row) => [...row])
  const heard: (RMessage | null)[][] = Array.from({ length: n }, () => Array<RMessage | null>(n).fill(null))
  const changes = ordered(p)
  let next = 0
  for (let j = 0; j <= i && j < run.events.length; j++) {
    const e = run.events[j]
    if (e.step === "L1") {
      const { c } = changes[next++]
      const k = c.cost ?? -1
      cost[c.a][c.b] = k
      cost[c.b][c.a] = k
      if (c.cost === null) {
        heard[c.a][c.b] = null
        heard[c.b][c.a] = null
      }
    } else if ((e.step === "D1" || e.step === "D2") && e.message !== null) {
      const m = run.messages[e.message]
      heard[m.to][m.from] = m
    }
  }
  return { cost, heard }
}

export interface Term {
  v: number
  c: number
  dv: number
  total: number
}

/** The terms of the Bellman-Ford equation D_x(y) = min_v c(x,v) + D_v(y), as x sees them in state s. */
export function bellmanTerms(s: State, p: RoutingParams, x: number, y: number): Term[] {
  const out: Term[] = []
  s.cost[x].forEach((c, v) => {
    if (c < 0 || v === x) return
    const dv = v === y ? 0 : (s.heard[x][v]?.vector[y] ?? p.infinity)
    out.push({ v, c, dv, total: Math.min(p.infinity, c + dv) })
  })
  return out
}

export interface Forwarding {
  /** Routers whose packets for the destination go round a loop. */
  looping: Set<number>
  /** The loops themselves, each as a list of routers. */
  cycles: number[][]
}

/** Follow next hops towards y from every router and find the loops. */
export function forwardingTo(hop: number[][], y: number): Forwarding {
  const n = hop.length
  const looping = new Set<number>()
  const cycles: number[][] = []
  const seen = new Set<string>()
  for (let s = 0; s < n; s++) {
    const path: number[] = []
    let at = s
    while (at !== y && at >= 0 && !path.includes(at)) {
      path.push(at)
      at = hop[at][y]
    }
    if (at >= 0 && at !== y) {
      const cycle = path.slice(path.indexOf(at))
      for (const v of path) looping.add(v)
      const key = [...cycle].sort((a, b) => a - b).join(",")
      if (!seen.has(key)) {
        seen.add(key)
        cycles.push(cycle)
      }
    }
  }
  return { looping, cycles }
}

/** The path Dijkstra's predecessors give from the source to v, or null. */
export function pathTo(p: number[], s: number, v: number): number[] | null {
  const path = [v]
  while (path[0] !== s) {
    const prev = p[path[0]]
    if (prev < 0 || path.length > p.length) return null
    path.unshift(prev)
  }
  return path
}

export const showDist = (d: number, inf: number) => (d >= inf ? "∞" : String(d))

/** Rounds when messages all take one delay; otherwise milliseconds. */
export const clock = (t: number, p: RoutingParams) =>
  p.jitter_us === 0 ? `round ${Number((t / p.delay_us).toFixed(2))}` : `${Number((t / 1000).toFixed(2))} ms`

/** Cost changes from event i onwards, for counting updates after a change. */
export function updatesAfter(run: RoutingRun, t: number, cells?: [number, number][]): number {
  let n = 0
  for (const e of run.events) {
    if (e.t < t) continue
    n += cells ? e.changed.filter(([a, b]) => cells.some(([x, y]) => x === a && y === b)).length : e.changed.length
  }
  return n
}

const MS = 1000

const base = {
  changes: [],
  poison: false,
  infinity: 100,
  delay_us: MS,
  jitter_us: 0,
  seed: 1,
}

/** Kurose and Ross, Figure 5.3. */
export const SIX: RoutingParams = {
  ...base,
  nodes: ["u", "v", "w", "x", "y", "z"],
  pos: [
    [8, 30],
    [33, 6],
    [67, 6],
    [33, 54],
    [67, 54],
    [92, 30],
  ],
  links: [
    { a: 0, b: 1, cost: 2 },
    { a: 0, b: 3, cost: 1 },
    { a: 0, b: 2, cost: 5 },
    { a: 1, b: 3, cost: 2 },
    { a: 1, b: 2, cost: 3 },
    { a: 3, b: 2, cost: 3 },
    { a: 3, b: 4, cost: 1 },
    { a: 2, b: 4, cost: 1 },
    { a: 2, b: 5, cost: 5 },
    { a: 4, b: 5, cost: 2 },
  ],
}

/** Kurose and Ross, Figure 5.6. */
const THREE: RoutingParams = {
  ...base,
  nodes: ["x", "y", "z"],
  pos: [
    [14, 50],
    [50, 8],
    [86, 50],
  ],
  links: [
    { a: 0, b: 1, cost: 2 },
    { a: 1, b: 2, cost: 1 },
    { a: 0, b: 2, cost: 7 },
  ],
}

/** Kurose and Ross, Figure 5.7. */
const TRIANGLE: RoutingParams = {
  ...THREE,
  links: [
    { a: 0, b: 1, cost: 4 },
    { a: 1, b: 2, cost: 1 },
    { a: 0, b: 2, cost: 50 },
  ],
}

/** a hangs off b; b, c and d form a loop of three. */
const LOOP: RoutingParams = {
  ...base,
  infinity: 16,
  poison: true,
  nodes: ["a", "b", "c", "d"],
  pos: [
    [8, 30],
    [38, 30],
    [80, 6],
    [80, 54],
  ],
  links: [
    { a: 0, b: 1, cost: 1 },
    { a: 1, b: 2, cost: 1 },
    { a: 1, b: 3, cost: 1 },
    { a: 2, b: 3, cost: 1 },
  ],
  changes: [{ at_us: 6 * MS, a: 0, b: 1, cost: null }],
}

const CHAIN: RoutingParams = {
  ...base,
  infinity: 16,
  nodes: ["a", "b", "c"],
  pos: [
    [10, 30],
    [50, 30],
    [90, 30],
  ],
  links: [
    { a: 0, b: 1, cost: 1 },
    { a: 1, b: 2, cost: 1 },
  ],
  changes: [{ at_us: 4 * MS, a: 0, b: 1, cost: null }],
}

export interface Preset {
  id: string
  title: string
  source: string
  note: string
  params: RoutingParams
  /** The destination the page shows first. */
  dest: number
}

export const PRESETS: Preset[] = [
  {
    id: "six",
    title: "Six routers: link state and distance vector agree",
    source: "Kurose and Ross, Fig. 5.3 and Table 5.1",
    note: "Dijkstra from u adds x first (cost 1), then v and y (2), then w (3) and z (4). Distance vector, started cold, reaches the same costs after a few rounds of exchange, with no router ever seeing the whole map.",
    params: SIX,
    dest: 5,
  },
  {
    id: "three",
    title: "Three routers from a cold start",
    source: "Kurose and Ross, Fig. 5.6",
    note: "At first x knows only its links, so it thinks z costs 7. One exchange later it hears that y can reach z for 1, and 2 + 1 = 3 beats 7.",
    params: THREE,
    dest: 2,
  },
  {
    id: "async",
    title: "The same, with messages that take different times",
    source: "Kurose and Ross, Section 5.2.2",
    note: "Each message takes 1 to 4 ms. Routers act on whatever has arrived, in any order, and the tables still end correct: distance vector needs no clock.",
    params: { ...THREE, delay_us: MS, jitter_us: 3 * MS, seed: 4 },
    dest: 2,
  },
  {
    id: "good-news",
    title: "Good news travels fast",
    source: "Kurose and Ross, Fig. 5.7(a)",
    note: "At 4 ms the link x–y falls from 4 to 1. y sees it at once, tells z, and every table is right within one round.",
    params: { ...TRIANGLE, changes: [{ at_us: 4 * MS, a: 0, b: 1, cost: 1 }] },
    dest: 0,
  },
  {
    id: "bad-news",
    title: "Bad news travels slowly: count to infinity",
    source: "Kurose and Ross, Fig. 5.7(b)",
    note: "At 4 ms the link x–y rises from 4 to 60. y does not know that z's route to x runs through y itself, so it takes z's 5 and adds 1. The two bounce the route between them, adding 2 each round, until z's own link at 50 wins: 47 updates.",
    params: { ...TRIANGLE, changes: [{ at_us: 4 * MS, a: 0, b: 1, cost: 60 }] },
    dest: 0,
  },
  {
    id: "poison",
    title: "Poisoned reverse stops the two-router loop",
    source: "Kurose and Ross, Section 5.2.2",
    note: "z routes to x through y, so it tells y its cost to x is infinite. When the link rises, y has no false offer to take, and three updates settle it.",
    params: { ...TRIANGLE, poison: true, changes: [{ at_us: 4 * MS, a: 0, b: 1, cost: 60 }] },
    dest: 0,
  },
  {
    id: "cut-off",
    title: "Counting to infinity when a router is cut off",
    source: "RFC 2453, Section 3.4",
    note: "a's only link fails. b hears c offer a at cost 2, not knowing c's route runs through b, and the two count up together until they reach RIP's infinity, 16.",
    params: CHAIN,
    dest: 0,
  },
  {
    id: "loop-of-three",
    title: "Poisoned reverse fails on a loop of three",
    source: "RFC 2453, Section 3.4.3",
    note: "Poisoned reverse is on, but when a is cut off c and d each offer the other a route through b, and neither routes through the one it tells. They count to 16 three at a time.",
    params: LOOP,
    dest: 0,
  },
  {
    id: "six-failure",
    title: "A failure in the six-router network, then repair",
    source: "a scenario for this tool",
    note: "At 10 ms the link x–y fails; at 40 ms it comes back. Messages take 1 to 3 ms, so routers learn the news in different orders. Watch the forwarding tree to z re-form, and look for moments when some router's table is wrong.",
    params: {
      ...SIX,
      jitter_us: 2 * MS,
      seed: 3,
      changes: [
        { at_us: 10 * MS, a: 3, b: 4, cost: null },
        { at_us: 40 * MS, a: 3, b: 4, cost: 1 },
      ],
    },
    dest: 5,
  },
]

export interface TourStep {
  preset: string
  /** The moment to show, in microseconds. */
  at: number
  text: string
}

export const TOUR: TourStep[] = [
  {
    preset: "three",
    at: 0,
    text: "Three routers, and each knows only the cost of its own links. x's table says z costs 7, because the only path x can see is its direct link.",
  },
  {
    preset: "three",
    at: MS,
    text: "One round later every router has heard its neighbours' tables. x does the sum c(x,y) + D_y(z) = 2 + 1 = 3, which beats 7, so x now forwards to z through y. That sum is the Bellman-Ford equation, and it is the whole algorithm.",
  },
  {
    preset: "six",
    at: 2 * MS,
    text: "On six routers the same rule spreads knowledge one link per round. The tree drawn in the graph is every router's next hop towards z.",
  },
  {
    preset: "good-news",
    at: 5 * MS,
    text: "A link gets cheaper. The router at its end improves its own route at once and the good news spreads one link per round.",
  },
  {
    preset: "bad-news",
    at: 8 * MS,
    text: "A link gets dearer. y's best offer now is z's, but z's route to x goes through y: they are offering each other their own stale route. Each round adds 2. The chart shows the staircase.",
  },
  {
    preset: "poison",
    at: 7 * MS,
    text: "Poisoned reverse: z tells y its route to x is infinite, because it runs through y. The loop never forms.",
  },
  {
    preset: "loop-of-three",
    at: 10 * MS,
    text: "But poisoned reverse only sees loops of two. Here c and d route to a through b; each offers the other a route, and they count to 16 three at a time.",
  },
]

export interface LabTask {
  id: string
  difficulty: 1 | 2 | 3
  title: string
  task: string
  hint: string
  start: RoutingParams
  check(p: RoutingParams, run: RoutingRun): { ok: boolean; message: string }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const byId = (id: string) => PRESETS.find((x) => x.id === id)!.params

export const LABS: LabTask[] = [
  {
    id: "via-w",
    difficulty: 2,
    title: "Send u's traffic for z through w",
    task: "On the six-router network, u's cheapest path to z is u, x, y, z. Change the cost of exactly one link so that u's cheapest path to z passes through w. Leave every other link alone.",
    hint: "Look at Dijkstra's table from u. Which link would have to get dearer, or cheaper, for the path through w to win? Ties go to the lower-numbered router, so aim to win outright.",
    start: SIX,
    check(p, run) {
      if (p.nodes.length !== SIX.nodes.length || p.links.length !== SIX.links.length || p.changes.length > 0)
        return { ok: false, message: "Keep the same routers and links, with no scripted changes; change one link's cost." }
      const diff = p.links.filter((l, i) => l.a !== SIX.links[i].a || l.b !== SIX.links[i].b || l.cost !== SIX.links[i].cost)
      if (diff.length !== 1) return { ok: false, message: `You have changed ${diff.length} links; change exactly one.` }
      const steps = run.epochs[0].dijkstra[0]
      const path = pathTo(steps[steps.length - 1].p, 0, 5)
      if (!path) return { ok: false, message: "z is no longer reachable from u." }
      const names = path.map((v) => p.nodes[v]).join(", ")
      return path.includes(2)
        ? { ok: true, message: `u now reaches z by ${names}. Check that the distance-vector tables agree once they settle.` }
        : { ok: false, message: `u still reaches z by ${names}.` }
    },
  },
  {
    id: "stop-count",
    difficulty: 2,
    title: "Stop the count",
    task: "When the link x–y rises to 60, y and z take 47 updates to agree on their routes to x. Without changing any link or the change itself, make them settle in at most 5 updates, with every table still correct at the end.",
    hint: "The trouble is that z offers y a route to x that runs through y. Is there a way for z to withhold that offer?",
    start: byId("bad-news"),
    check(p, run) {
      const start = byId("bad-news")
      if (!same(p.links, start.links) || !same(p.changes, start.changes))
        return { ok: false, message: "Keep the links and the change to x–y as they are." }
      if (!run.totals.converged) return { ok: false, message: "The tables do not end correct." }
      const n = updatesAfter(run, start.changes[0].at_us, [
        [1, 0],
        [2, 0],
      ])
      return n <= 5
        ? { ok: true, message: `${n} updates. z now tells y the truth about routes that run through y.` }
        : { ok: false, message: `${n} updates to y's and z's routes to x; the target is 5.` }
    },
  },
  {
    id: "small-infinity",
    difficulty: 3,
    title: "A smaller infinity",
    task: "In the loop of three, c and d count to 16 even with poisoned reverse. Without touching the links, the failure or poisoned reverse, make every table settle within 4 rounds of the failure, and correct.",
    hint: "Counting ends when the count reaches infinity. What is the longest real route here, and how low can infinity go without cutting it off?",
    start: LOOP,
    check(p, run) {
      if (!same(p.links, LOOP.links) || !same(p.changes, LOOP.changes) || !p.poison)
        return { ok: false, message: "Keep the links, the failure and poisoned reverse." }
      if (run.epochs[0].shortest.some((row) => row.some((d) => d >= p.infinity)))
        return { ok: false, message: "Before the failure some router cannot reach another: infinity is now no longer than a real route." }
      if (!run.totals.converged) return { ok: false, message: "Some table ends wrong." }
      const rounds = (run.totals.last_change_us - LOOP.changes[0].at_us) / p.delay_us
      return rounds <= 4
        ? {
            ok: true,
            message: `Settled ${rounds} rounds after the failure with infinity ${p.infinity}. That works because no real route here is longer than 2; RIP's 16 limits networks to 15 hops for the same reason.`,
          }
        : { ok: false, message: `Settled ${rounds} rounds after the failure; the target is 4.` }
    },
  },
  {
    id: "make-loop",
    difficulty: 3,
    title: "Catch a forwarding loop",
    task: "Start from the six-router network with no changes. Script one link failure or cost rise (click a link in the graph, then choose the change) so that at some moment packets for some destination would go round a loop.",
    hint: "A loop forms when one router has heard the news and its neighbour has not. Fail a link that many routes use, and give the messages some jitter so that routers hear it at different times.",
    start: SIX,
    check(p, run) {
      if (p.changes.length === 0) return { ok: false, message: "Script a change first: click a link in the graph." }
      for (const e of run.events) {
        for (let y = 0; y < p.nodes.length; y++) {
          const f = forwardingTo(e.hop, y)
          if (f.cycles.length > 0) {
            const c = f.cycles[0].map((v) => p.nodes[v]).join(" → ")
            return { ok: true, message: `At ${clock(e.t, p)} packets for ${p.nodes[y]} would go ${c} → ${p.nodes[f.cycles[0][0]]}.` }
          }
        }
      }
      return { ok: false, message: "No router's next hops ever form a loop in this run." }
    },
  },
]
