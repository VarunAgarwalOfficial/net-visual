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
  /** Distance vector (Bellman-Ford, as RIP) or link state (flooding and Dijkstra, as OSPF). */
  algorithm: "dv" | "ls"
  poison: boolean
  /** Simple split horizon: leave routes through a neighbour out of what it is sent. Poisoned reverse wins if both are on. */
  split_horizon: boolean
  infinity: number
  delay_us: number
  jitter_us: number
  seed: number
  /** Distance vector: send the whole vector this often; 0 for never. */
  period_us: number
  /** Distance vector: send when the vector changes. */
  triggered: boolean
  /** With a period: an entry not repeated for this long becomes unreachable; 0 for never. */
  timeout_us: number
  /** With a period: when the run stops; 0 for the last change plus the timeout plus four periods. */
  end_us: number
}

/** A link-state advertisement: a router's working links, as [neighbour, cost]. */
export interface Lsa {
  origin: number
  seq: number
  links: [number, number][]
}

export interface RMessage {
  id: number
  from: number
  to: number
  t_send: number
  t_arrive: number
  /** Empty for an LSA. */
  vector: number[]
  poisoned: number[]
  /** Left out by split horizon. */
  omitted: number[]
  /** Sent by the update timer. */
  periodic: boolean
  lsa: Lsa | null
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
  /** For a timeout (step T2): [neighbour, destination] of the entry that expired. */
  expired: [number, number] | null
  /** Messages sent so far: message m belongs to the first event whose count exceeds m. */
  sent: number
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
  totals: { messages: number; lost: number; last_change_us: number; converged: boolean; truncated: boolean; end_us: number }
}

export const runRouting = (sim: Netsim, p: RoutingParams) => sim.call<RoutingRun>("routing", "run", p)

/** The time the page shows: a little past the last event. */
export const runDuration = (run: RoutingRun, p: RoutingParams) =>
  periodic(p) ? run.totals.end_us : Math.max(run.events[run.events.length - 1].t, ...p.changes.map((c) => c.at_us)) + p.delay_us

/** RIP's update timer is on (distance vector only). */
export const periodic = (p: RoutingParams) => p.algorithm === "dv" && p.period_us > 0

export const epochAt = (run: RoutingRun, t: number): Epoch => {
  let e = run.epochs[0]
  for (const x of run.epochs) if (x.t <= t) e = x
  return e
}

/** The changes in the order the model applies them: one L1 event each. */
const ordered = (p: RoutingParams) => p.changes.map((c, k) => ({ c, k })).sort((a, b) => a.c.at_us - b.c.at_us || a.k - b.k)

/** What x holds from neighbour v: each entry, when it was last heard, and in which message. */
export interface Heard {
  vector: number[]
  at: number[]
  via: (RMessage | null)[]
  /** The latest message from v, which may have left some entries out. */
  last: RMessage | null
}

export interface State {
  /** Link costs, -1 where there is no link. */
  cost: number[][]
  /** heard[x][v]: what x holds from v, or null. */
  heard: (Heard | null)[][]
  /** db[x][o]: link state, the newest LSA x holds from o, or null. */
  db: (Lsa | null)[][]
}

/**
 * Replay the trace to event i and return what each router knows: the costs
 * of its links and the last vector heard from each neighbour, forgotten when
 * the link between them fails (as step L1 does in the model).
 */
export function stateAfter(run: RoutingRun, p: RoutingParams, i: number): State {
  const n = p.nodes.length
  const cost = Array.from({ length: n }, () => Array<number>(n).fill(-1))
  for (const l of p.links) {
    cost[l.a][l.b] = l.cost
    cost[l.b][l.a] = l.cost
  }
  const heard: (Heard | null)[][] = Array.from({ length: n }, () => Array<Heard | null>(n).fill(null))
  const db: (Lsa | null)[][] = Array.from({ length: n }, () => Array<Lsa | null>(n).fill(null))
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
      const h = (heard[m.to][m.from] ??= {
        vector: Array<number>(n).fill(p.infinity),
        at: Array<number>(n).fill(0),
        via: Array<RMessage | null>(n).fill(null),
        last: null,
      })
      h.last = m
      m.vector.forEach((d, y) => {
        if (m.omitted.includes(y)) return
        h.vector[y] = d
        h.at[y] = m.t_arrive
        h.via[y] = m
      })
    } else if (e.step === "T2" && e.expired) {
      const h = heard[e.node][e.expired[0]]
      if (h) h.vector[e.expired[1]] = p.infinity
    } else if (e.step === "F1" && e.node >= 0) {
      db[e.node][e.node] = { origin: e.node, seq: (db[e.node][e.node]?.seq ?? 0) + 1, links: linksOf(cost, e.node) }
    } else if (e.step === "F2" && e.message !== null) {
      const l = run.messages[e.message].lsa!
      db[run.messages[e.message].to][l.origin] = l
    }
  }
  return { cost, heard, db }
}

const linksOf = (cost: number[][], x: number): [number, number][] =>
  cost[x].flatMap((c, v) => (c >= 0 && v !== x ? [[v, c] as [number, number]] : []))

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

/** The largest cost any link has or is given; infinity must stay above it. */
export const maxCost = (p: RoutingParams) => Math.max(1, ...p.links.map((l) => l.cost), ...p.changes.map((c) => c.cost ?? 0))

/** Routers spaced round a circle, for networks that arrive without positions. */
export const circle = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [
    Math.round(50 + 40 * Math.sin((2 * Math.PI * i) / n)),
    Math.round(30 - 25 * Math.cos((2 * Math.PI * i) / n)),
  ])

/** Make parameters from a share link safe to draw: one position per router, inside the box. */
export function normalise(p: RoutingParams): RoutingParams {
  const ok =
    Array.isArray(p.pos) &&
    p.pos.length === p.nodes.length &&
    p.pos.every((q) => Array.isArray(q) && q[0] >= 0 && q[0] <= 100 && q[1] >= 0 && q[1] <= 60)
  return { ...DEFAULTS, ...p, pos: ok ? p.pos : circle(p.nodes.length), changes: p.changes ?? [] }
}

/** Rounds when messages all take one delay; seconds with RIP's timer on; otherwise milliseconds. */
export const clock = (t: number, p: RoutingParams) =>
  periodic(p)
    ? `${Number((t / 1e6).toFixed(3))} s`
    : p.jitter_us === 0
      ? `round ${Number((t / p.delay_us).toFixed(2))}`
      : `${Number((t / 1000).toFixed(2))} ms`

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

/** The options added after the first share links; older links get these. */
const DEFAULTS = {
  algorithm: "dv" as const,
  split_horizon: false,
  period_us: 0,
  triggered: true,
  timeout_us: 0,
  end_us: 0,
}

const base = {
  ...DEFAULTS,
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

/** a reaches d through b (1 + 1) rather than directly (3); then b–d fails. */
const MICRO: RoutingParams = {
  ...base,
  algorithm: "ls",
  nodes: ["a", "b", "d"],
  pos: [
    [14, 50],
    [50, 8],
    [86, 50],
  ],
  links: [
    { a: 0, b: 1, cost: 1 },
    { a: 1, b: 2, cost: 1 },
    { a: 0, b: 2, cost: 3 },
  ],
  changes: [{ at_us: 10 * MS, a: 1, b: 2, cost: null }],
}

const S = 1_000_000

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
    note: "At 4 ms the link x–y rises from 4 to 60. y does not know that z's route to x runs through y itself, so it takes z's 5 and adds 1. The two bounce the route between them, one of them adding 1 each round, until z's own link at 50 wins: 47 updates over 46 rounds.",
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
    source: "RFC 2453, Section 3.4.2",
    note: "a's only link fails. b hears c offer a at cost 2, not knowing c's route runs through b, and the two count up together until they reach RIP's infinity, 16.",
    params: CHAIN,
    dest: 0,
  },
  {
    id: "loop-of-three",
    title: "Poisoned reverse fails on a loop of three",
    source: "RFC 2453, Section 3.4.4",
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
  {
    id: "ls-six",
    title: "Link state on the six routers: flood, then Dijkstra",
    source: "Kurose and Ross, Section 5.2.1; RFC 2328, Section 13",
    note: "Each router floods one LSA listing its links. A router passes on an LSA it has not seen to every neighbour except the sender and drops copies it already holds, so each LSA crosses every link once each way bar the n − 1 links of its flooding tree: 2m − n + 1 = 15 messages on these ten links, 90 for all six. Once a router holds all six LSAs it runs Dijkstra and its routes match the table.",
    params: { ...SIX, algorithm: "ls" },
    dest: 5,
  },
  {
    id: "ls-microloop",
    title: "Link state loops too, while the maps differ",
    source: "RFC 5715, Section 1",
    note: "a reaches d through b, at 1 + 1. At 10 ms the link b–d fails. b sees it at once and now routes to d through a; a has not yet had b's new LSA, so it still routes through b. For one delay packets for d go a → b → a, until the LSA arrives and a's own Dijkstra puts it right.",
    params: MICRO,
    dest: 2,
  },
  {
    id: "rip-slow",
    title: "RIP's timer: counting to 16 takes minutes",
    source: "RFC 2453, Sections 3.4.2 and 3.8",
    note: "No triggered updates: each router sends its vector only when its 30-second timer fires. At 100 s a's link fails. b and c count up as before, but each step now waits for the other's next update, so b's route climbs by 2 every minute and reaches 16 at about 510 s, nearly seven minutes of packets sent round a loop.",
    params: {
      ...CHAIN,
      period_us: 30 * S,
      triggered: false,
      timeout_us: 180 * S,
      changes: [{ at_us: 100 * S, a: 0, b: 1, cost: null }],
      end_us: 560 * S,
    },
    dest: 0,
  },
  {
    id: "split-horizon",
    title: "Simple split horizon: the wrong route waits for the timeout",
    source: "RFC 2453, Section 3.4.3; Kurose and Ross, Fig. 5.7",
    note: "z routes to x through y, so it leaves x out of what it sends y; y still holds the 50 z offered at the start. At 100 s x–y rises to 60 and y takes z's stale 50 + 1, while z, told nothing new about x, keeps routing through y. The loop lasts until y's entry from z expires, 180 s after z last mentioned x. Compare the poison preset: an explicit infinity removes it at once.",
    params: {
      ...TRIANGLE,
      split_horizon: true,
      period_us: 30 * S,
      timeout_us: 180 * S,
      changes: [{ at_us: 100 * S, a: 0, b: 1, cost: 60 }],
    },
    dest: 0,
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
    text: "A link gets dearer. y's best offer now is z's, but z's route to x goes through y: they are offering each other their own stale route. Each takes the other's cost and adds 1, so the route climbs by 1 a round, y and z in turn. The chart shows the staircase.",
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
  {
    preset: "split-horizon",
    at: 120 * S,
    text: "Simple split horizon just leaves the route out instead of poisoning it. Silence carries no news, so y keeps the stale 50 that z offered long ago, and the loop y → z → y lasts until that entry times out at 180 s. RIP's timers are in seconds: this is three minutes of looping.",
  },
  {
    preset: "ls-six",
    at: 2 * MS,
    text: "Link state works the other way round: every router floods a description of its own links to everyone, and each runs Dijkstra on the full map. Flooding costs 2m − n + 1 messages per LSA, 90 in all here, but nothing is ever computed from a neighbour's opinion.",
  },
  {
    preset: "ls-microloop",
    at: 10 * MS,
    text: "Even so, link state can loop. b has seen its link to d fail and now routes through a; a has not yet heard, and still routes through b. The loop lasts exactly as long as the LSA takes to reach a: one delay, not a count to infinity.",
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
  {
    id: "no-microloop",
    difficulty: 2,
    title: "Make the microloop impossible",
    task: "In the link-state microloop, packets for d go a → b → a for one delay after b–d fails. Change the starting cost of exactly one link so that no router's next hops ever form a loop, with the failure left as it is and d still reachable from everyone afterwards.",
    hint: "The loop needs a to route through b before the failure and b to route through a after it. Which of those two can you prevent with one cost?",
    start: MICRO,
    check(p, run) {
      if (
        p.nodes.length !== MICRO.nodes.length ||
        p.links.length !== MICRO.links.length ||
        !same(p.changes, MICRO.changes) ||
        p.algorithm !== "ls"
      )
        return { ok: false, message: "Keep the three routers, the three links, link state and the failure of b–d." }
      const diff = p.links.filter((l, i) => l.a !== MICRO.links[i].a || l.b !== MICRO.links[i].b || l.cost !== MICRO.links[i].cost)
      if (diff.length !== 1) return { ok: false, message: `You have changed ${diff.length} links; change exactly one cost.` }
      if (!run.totals.converged) return { ok: false, message: "Some table ends wrong." }
      for (const e of run.events)
        for (let y = 0; y < p.nodes.length; y++) {
          const f = forwardingTo(e.hop, y)
          if (f.cycles.length > 0) {
            const c = f.cycles[0].map((v) => p.nodes[v]).join(" → ")
            return { ok: false, message: `At ${clock(e.t, p)} packets for ${p.nodes[y]} still go ${c} → ${p.nodes[f.cycles[0][0]]}.` }
          }
        }
      return {
        ok: true,
        message:
          "No loop at any moment. Before the failure a's best route to d no longer uses b, so when b turns to a there is nobody pointing back. Loop-free alternates (RFC 5286) choose backups by exactly this kind of inequality.",
      }
    },
  },
]
