// The typed interface to the queueing model in crates/netsim/src/queue.rs,
// with the scenarios, the tour and the lab tasks. Erasable TypeScript only, so
// the Node tests can import it directly.
import type { Netsim } from "./netsim.ts"

export type Arrivals = "poisson" | "periodic" | "onoff"
export type Sizes = "fixed" | "exp"
export type Discipline = "fifo" | "priority" | "wfq"
export type ShaperKind = "none" | "token" | "leaky"

export interface Shaper {
  kind: ShaperKind
  rate_bps: number
  bucket_bytes: number
  /** Token bucket only: drop a packet that finds too few tokens instead of holding it. */
  police: boolean
}

export interface QFlow {
  name: string
  arrivals: Arrivals
  /** Packets per second: the mean for Poisson, the rate within a burst for on-off. */
  rate_pps: number
  on_us: number
  off_us: number
  sizes: Sizes
  /** The size, or the mean size for exponential sizes. */
  size_bytes: number
  weight: number
  /** Smaller is more urgent. */
  priority: number
  start_us: number
  packets: number
  shaper: Shaper
}

export interface QueueParams {
  flows: QFlow[]
  discipline: Discipline
  rate_bps: number
  proc_us: number
  distance_m: number
  speed_mps: number
  /** Packets that may wait, not counting the one being sent; 0 for no limit. */
  buffer_pkts: number
  seed: number
}

export interface QPacket {
  id: number
  flow: number
  size_bytes: number
  t_arrive: number
  t_shaped: number | null
  t_join: number | null
  t_start: number | null
  t_depart: number | null
  t_reach: number | null
  dropped: "policer" | "bucket" | "buffer" | null
  tag: number
  gps_finish: number
}

export interface QEvent {
  t: number
  step: string
  packet: number
  what: "" | "released" | "held" | "dropped" | "joined"
  waiting: number
  tokens: number | null
}

export interface FlowStats {
  sent: number
  served: number
  dropped: number
  bytes: number
  wait_us: number
  system_us: number
  shaper_us: number
  total_us: number
  max_wait_us: number
}

export interface QStats {
  served: number
  dropped: number
  wait_us: number
  system_us: number
  trans_us: number
  total_us: number
  lq: number
  l: number
  lambda_pps: number
  busy: number
  max_waiting: number
  prop_us: number
  end_us: number
  flows: FlowStats[]
}

export interface QueueRun {
  packets: QPacket[]
  events: QEvent[]
  stats: QStats
}

export interface SweepPoint {
  rho: number
  wait_us: number
  system_us: number
  l: number
  lq: number
}

export const runQueue = (sim: Netsim, p: QueueParams) => sim.call<QueueRun>("queue", "run", p)

export const sweepQueue = (sim: Netsim, base: QueueParams, rhos: number[], packets: number) =>
  sim.call<SweepPoint[]>("queue", "sweep", { base, rhos, packets })

/** Transmission time of `bytes` at `rate_bps`, rounded as the model rounds it. */
export const transUs = (bytes: number, rate_bps: number) => Math.max(1, Math.round((bytes * 8e6) / rate_bps))

export const propUs = (p: QueueParams) => Math.round((p.distance_m * 1e6) / p.speed_mps)

/** Offered load on the link: the mean bits per second the flows send, over R. */
export function offered(p: QueueParams): number {
  let bits = 0
  for (const f of p.flows) {
    const duty = f.arrivals === "onoff" && f.on_us + f.off_us > 0 ? onoffDuty(f) : 1
    bits += f.rate_pps * duty * f.size_bytes * 8
  }
  return bits / p.rate_bps
}

/** The fraction of time an on-off source sends, as the model counts its bursts. */
function onoffDuty(f: QFlow): number {
  const gap = 1e6 / f.rate_pps
  const perBurst = Math.max(1, Math.floor(f.on_us / gap))
  return (perBurst * gap) / (f.on_us + f.off_us)
}

/** The service rate mu of one flow alone: packets per second the link can send at the mean size. */
export const mu = (p: QueueParams, k = 0) => p.rate_bps / (8 * p.flows[k].size_bytes)

export interface Theory {
  rho: number
  lambda: number
  mu: number
  /** Mean waiting time, M/M/1 or M/D/1 as the sizes say; null at rho >= 1. */
  wq: number | null
  w: number | null
  l: number | null
  lq: number | null
  model: "M/M/1" | "M/D/1"
}

/**
 * The textbook prediction for a single Poisson flow, in microseconds:
 * M/M/1 for exponential sizes, M/D/1 (Pollaczek-Khinchine) for fixed ones.
 */
export function theory(p: QueueParams): Theory {
  const f = p.flows[0]
  const m = mu(p)
  const lambda = f.rate_pps
  const rho = lambda / m
  const model = f.sizes === "exp" ? "M/M/1" : "M/D/1"
  if (rho >= 1) return { rho, lambda, mu: m, wq: null, w: null, l: null, lq: null, model }
  const s = 1e6 / m
  const wq = model === "M/M/1" ? (rho / (1 - rho)) * s : (rho / (2 * (1 - rho))) * s
  const w = wq + s
  return { rho, lambda, mu: m, wq, w, l: (lambda * w) / 1e6, lq: (lambda * wq) / 1e6, model }
}

/** Whether the scenario is the textbook single queue the formulas describe. */
export const isSingleQueue = (p: QueueParams) =>
  p.flows.length === 1 && p.flows[0].arrivals === "poisson" && p.flows[0].shaper.kind === "none" && p.buffer_pkts === 0

/** The time the page shows: the last packet reaching the far end, or the last thing to happen. */
export function runDuration(run: QueueRun): number {
  let end = 1
  for (const q of run.packets) end = Math.max(end, q.t_reach ?? q.t_shaped ?? q.t_arrive)
  for (const e of run.events) end = Math.max(end, e.t)
  return end
}

/** The four delays of one packet, in microseconds, and the shaper's hold before them. */
export function delays(p: QueueParams, q: QPacket) {
  if (q.t_shaped === null || q.t_join === null || q.t_start === null || q.t_depart === null || q.t_reach === null) return null
  return {
    shaper: q.t_shaped - q.t_arrive,
    processing: q.t_join - q.t_shaped,
    queueing: q.t_start - q.t_join,
    transmission: q.t_depart - q.t_start,
    propagation: q.t_reach - q.t_depart,
    total: q.t_reach - q.t_arrive,
    expectedTrans: transUs(q.size_bytes, p.rate_bps),
    expectedProp: propUs(p),
  }
}

/** Number in the system (waiting or being sent) and number waiting, as step functions of time. */
export function occupancy(run: QueueRun): { t: number; n: number; q: number }[] {
  const ch: [number, number, number][] = []
  for (const p of run.packets) {
    if (p.t_join === null || p.t_start === null || p.t_depart === null) continue
    ch.push([p.t_join, 1, 1], [p.t_start, 0, -1], [p.t_depart, -1, 0])
  }
  ch.sort((a, b) => a[0] - b[0] || a[1] + a[2] - (b[1] + b[2]))
  const out = [{ t: 0, n: 0, q: 0 }]
  let n = 0
  let q = 0
  for (const [t, dn, dq] of ch) {
    n += dn
    q += dq
    if (out[out.length - 1].t === t) out[out.length - 1] = { t, n, q }
    else out.push({ t, n, q })
  }
  return out
}

/** Bytes released by flow k's shaper by each moment, and the source's own, as cumulative curves. */
export function cumulative(run: QueueRun, k: number) {
  const mine = run.packets.filter((q) => q.flow === k)
  const step = (pts: [number, number][]) => {
    pts.sort((a, b) => a[0] - b[0])
    const out: [number, number][] = [[0, 0]]
    let sum = 0
    for (const [t, b] of pts) {
      out.push([t, sum])
      sum += b
      out.push([t, sum])
    }
    return out
  }
  return {
    input: step(mine.map((q) => [q.t_arrive, q.size_bytes])),
    output: step(mine.filter((q) => q.t_shaped !== null && q.dropped !== "policer").map((q) => [q.t_shaped!, q.size_bytes])),
  }
}

/**
 * The tightest b for which the releases fit r t + b: the largest excess of
 * bytes released in any interval over what rate r allows, in bytes.
 */
export function envelopeExcess(points: [number, number][], rate_bps: number): number {
  // points: (time, size) of each release, sorted by time.
  let worst = 0
  for (let i = 0; i < points.length; i++) {
    let bytes = 0
    for (let j = i; j < points.length; j++) {
      bytes += points[j][1]
      worst = Math.max(worst, bytes - (rate_bps * (points[j][0] - points[i][0])) / 8e6)
    }
  }
  return worst
}

/** Releases of flow k's shaper as (time, size), in time order. */
export const releases = (run: QueueRun, k: number): [number, number][] =>
  run.packets
    .filter((q) => q.flow === k && q.dropped === null && q.t_shaped !== null)
    .map((q): [number, number] => [q.t_shaped!, q.size_bytes])
    .sort((a, b) => a[0] - b[0])

/**
 * Bytes each flow has had sent by the moment the first flow sends its last
 * packet, the share of the link each got up to then, and what the weights
 * promise. When every flow is backlogged throughout, that is the share the
 * scheduler gave them.
 */
export function shares(p: QueueParams, run: QueueRun) {
  const last = p.flows.map((_, k) => Math.max(0, ...run.packets.filter((q) => q.flow === k && q.t_depart !== null).map((q) => q.t_depart!)))
  const until = Math.min(...last)
  const bytes = p.flows.map(() => 0)
  for (const q of run.packets) if (q.t_depart !== null && q.t_depart <= until) bytes[q.flow] += q.size_bytes
  const total = bytes.reduce((a, b) => a + b, 0) || 1
  const weights = p.flows.reduce((a, f) => a + f.weight, 0)
  return { until, bytes, share: bytes.map((b) => b / total), fair: p.flows.map((f) => f.weight / weights) }
}

/** Formats microseconds with a unit that suits the size. */
export function us(t: number): string {
  if (!Number.isFinite(t)) return "∞"
  const a = Math.abs(t)
  if (a >= 1e6) return `${Number((t / 1e6).toPrecision(4))} s`
  if (a >= 1e3) return `${Number((t / 1e3).toPrecision(4))} ms`
  return `${Number(t.toPrecision(4))} µs`
}

export const bps = (r: number) =>
  r >= 1e9
    ? `${Number((r / 1e9).toPrecision(3))} Gb/s`
    : r >= 1e6
      ? `${Number((r / 1e6).toPrecision(3))} Mb/s`
      : `${Number((r / 1e3).toPrecision(3))} kb/s`

export type Mode = "delay" | "shaping" | "scheduling"

export const MODES: { id: Mode; title: string }[] = [
  { id: "delay", title: "Where the time goes" },
  { id: "shaping", title: "Smoothing bursts" },
  { id: "scheduling", title: "Who goes next" },
]

const NO_SHAPER: Shaper = { kind: "none", rate_bps: 1_000_000, bucket_bytes: 3000, police: false }

export const flow = (name: string, o: Partial<QFlow> = {}): QFlow => ({
  name,
  arrivals: "poisson",
  rate_pps: 700,
  on_us: 10_000,
  off_us: 40_000,
  sizes: "fixed",
  size_bytes: 1000,
  weight: 1,
  priority: 0,
  start_us: 0,
  packets: 400,
  shaper: NO_SHAPER,
  ...o,
})

const base: Omit<QueueParams, "flows"> = {
  discipline: "fifo",
  rate_bps: 8_000_000,
  proc_us: 0,
  distance_m: 0,
  speed_mps: 200_000_000,
  buffer_pkts: 0,
  seed: 1,
}

/** One flow of 1500-byte packets over 2000 km at 10 Mb/s, close enough together to queue. */
export const FOUR: QueueParams = {
  ...base,
  rate_bps: 10_000_000,
  proc_us: 20,
  distance_m: 2_000_000,
  flows: [flow("a", { arrivals: "periodic", rate_pps: 1e6 / 900, size_bytes: 1500, packets: 6 })],
}

/** M/M/1 at rho = 0.7: mean 1000 bytes at 8 Mb/s, so mu = 1000 a second. */
export const MM1: QueueParams = { ...base, flows: [flow("a", { sizes: "exp", rate_pps: 700, packets: 3000 })] }

export const MD1: QueueParams = { ...MM1, flows: [{ ...MM1.flows[0], sizes: "fixed" }] }

/** Bursts of 20 packets of 500 bytes at 8 Mb/s every 50 ms: 1.6 Mb/s on average. */
const BURSTY = flow("a", { arrivals: "onoff", rate_pps: 2000, on_us: 10_000, off_us: 40_000, size_bytes: 500, packets: 200 })

export const SHAPED: QueueParams = {
  ...base,
  rate_bps: 100_000_000,
  flows: [{ ...BURSTY, shaper: { kind: "token", rate_bps: 2_000_000, bucket_bytes: 3000, police: false } }],
}

/** An elephant of 1500-byte packets and a mouse of 100-byte ones sharing 8 Mb/s. */
export const MICE: QueueParams = {
  ...base,
  flows: [
    flow("bulk", { arrivals: "onoff", rate_pps: 1000, on_us: 40_000, off_us: 20_000, size_bytes: 1500, packets: 400, priority: 1 }),
    flow("voice", { arrivals: "periodic", rate_pps: 100, size_bytes: 100, packets: 60 }),
  ],
}

/** Three flows that never run dry, weights 1, 2 and 4, very different sizes. */
export const BACKLOGGED: QueueParams = {
  ...base,
  discipline: "wfq",
  flows: [
    flow("a", { arrivals: "periodic", rate_pps: 1e6, size_bytes: 1500, packets: 100, weight: 1 }),
    flow("b", { arrivals: "periodic", rate_pps: 1e6, size_bytes: 500, packets: 300, weight: 2 }),
    flow("c", { arrivals: "periodic", rate_pps: 1e6, size_bytes: 100, packets: 1500, weight: 4 }),
  ],
}

/** A well-behaved flow beside one that sends at twice the link's rate. */
export const GREEDY: QueueParams = {
  ...base,
  flows: [
    flow("polite", { arrivals: "periodic", rate_pps: 300, size_bytes: 1000, packets: 120 }),
    flow("greedy", { arrivals: "periodic", rate_pps: 2000, size_bytes: 1000, packets: 800 }),
  ],
}

export interface Preset {
  id: string
  mode: Mode
  title: string
  source: string
  note: string
  params: QueueParams
}

export const PRESETS: Preset[] = [
  {
    id: "four-delays",
    mode: "delay",
    title: "The four delays of one hop (one router and the link after it)",
    source: "Kurose and Ross, Section 1.4",
    note: "Six packets of 1500 bytes, one every 900 µs (microseconds), cross a link 2000 km long that sends 10 Mb/s (megabits per second). Each spends 20 µs being processed in the router, 1.2 ms being pushed onto the wire (its length divided by the link's rate) and 10 ms travelling along it (the distance divided by the signal's speed). The link needs 1.2 ms per packet but they come every 0.9 ms, so each waits in line 300 µs longer than the one before.",
    params: FOUR,
  },
  {
    id: "mm1",
    mode: "delay",
    title: "Random arrivals and sizes, link busy 70% of the time",
    source: "Kleinrock, Queueing Systems, Vol. 1, Section 3.2",
    note: "Packets arrive at random, 700 a second on average, with random sizes averaging 1000 bytes, on an 8 Mb/s link that can send 1000 such packets a second. So the link is busy 70% of the time: the load, written ρ (rho), is 0.7. Theory says a packet spends 3.33 ms in the router on average and 2.33 packets are there on average; this run of three thousand packets comes within a few per cent. Textbooks call this queue M/M/1: arrival times and sizes both random in the same memoryless way, and one link.",
    params: MM1,
  },
  {
    id: "md1",
    mode: "delay",
    title: "The same, but every packet the same size",
    source: "Pollaczek-Khinchine formula; Kleinrock, Section 5.6",
    note: "The same random arrivals, but every packet is 1000 bytes. Packets now wait in line 1.17 ms on average instead of 2.33 ms: the wait depends on how much the sizes vary (the Pollaczek-Khinchine formula), and with no variation it halves. Textbooks call this queue M/D/1, D for deterministic sizes.",
    params: MD1,
  },
  {
    id: "heavy",
    mode: "delay",
    title: "Link busy 95% of the time",
    source: "Kleinrock, Section 3.2",
    note: "With the link busy 95% of the time, theory says a packet waits in line 19 ms on average, 19 times as long as it takes to send one. The line does not sit near 19 packets: it climbs past sixty and drains to empty over stretches of seconds, so one packet's wait says a lot about the next, and a run must be far longer than at 70% to measure the average as well.",
    params: { ...MM1, flows: [{ ...MM1.flows[0], rate_pps: 950 }] },
  },
  {
    id: "overload",
    mode: "delay",
    title: "More arriving than the link can send",
    source: "Kurose and Ross, Section 1.4.3",
    note: "Packets arrive 20% faster than the link can send them, into a buffer that holds 50. With no limit the line would grow without end; here it fills, the link never rests again, and the excess is thrown away: on average one packet in six (0.2 of 1.2), 14% in this run. The wait levels off at 50 sending times, 50 ms: the buffer's size, not the load, now sets the delay.",
    params: { ...MD1, buffer_pkts: 50, flows: [{ ...MD1.flows[0], rate_pps: 1200, packets: 2000 }] },
  },
  {
    id: "token-shape",
    mode: "shaping",
    title: "Smoothing bursts with a token bucket",
    source: "Turner 1986; RFC 2697; Le Boudec and Thiran, Section 1.2",
    note: "The source sends bursts of 20 packets of 500 bytes, back to back at 8 Mb/s, every 50 ms. In front of the router sits a token bucket: a packet may pass only by spending tokens worth its size. The bucket holds 3000 bytes of tokens and refills at 2 Mb/s. The first seven packets of a burst pass at once on the stored tokens; the rest are held and leave one every 2 ms as tokens build. Whatever the source does, what leaves in any stretch of t seconds is at most 3000 bytes plus 2 Mb/s × t.",
    params: SHAPED,
  },
  {
    id: "token-police",
    mode: "shaping",
    title: "A token bucket that drops instead of holding",
    source: "RFC 2697; RFC 2475, Section 2.3.3.3",
    note: "The same bucket, but a packet that finds too few tokens is thrown away instead of held (policing). Nothing is delayed and what leaves keeps to the same limit, but only ten of each burst of twenty get through: seven on the stored tokens, then one in four.",
    params: { ...SHAPED, flows: [{ ...SHAPED.flows[0], shaper: { ...SHAPED.flows[0].shaper, police: true } }] },
  },
  {
    id: "leaky",
    mode: "shaping",
    title: "Leaky bucket: a constant drip",
    source: "Turner 1986; Tanenbaum and Wetherall, Section 5.4",
    note: "A leaky bucket holds up to 4000 bytes of waiting packets and lets them out at exactly 2 Mb/s, one 500-byte packet every 2 ms, however they came in. A burst bigger than the bucket spills and is lost. Unlike the token bucket it never lets a burst through, even after a long silence: here 12 of each 20 get through, every one delayed.",
    params: {
      ...SHAPED,
      flows: [{ ...SHAPED.flows[0], shaper: { kind: "leaky", rate_bps: 2_000_000, bucket_bytes: 4000, police: false } }],
    },
  },
  {
    id: "fifo-mice",
    mode: "scheduling",
    title: "First come, first served: voice stuck behind bulk",
    source: "Kurose and Ross, Section 4.2.6",
    note: "Two flows share an 8 Mb/s link. Bulk sends 1500-byte packets at 12 Mb/s in bursts of 40 ms; voice sends a 100-byte packet every 10 ms. The router sends packets in the order they arrived (first in, first out: FIFO), so a voice packet that lands during a burst waits behind every bulk packet already in line: 14 ms on average, up to 26 ms.",
    params: MICE,
  },
  {
    id: "priority",
    mode: "scheduling",
    title: "Voice first",
    source: "Kurose and Ross, Section 4.2.6; Cobham 1954",
    note: "The same packets, but the router always sends a waiting voice packet before any bulk one (strict priority). A voice packet now waits at most for the one bulk packet already on the wire, 1.5 ms, because a packet being sent is never interrupted. Bulk barely notices: voice is 1% of the load.",
    params: { ...MICE, discipline: "priority" },
  },
  {
    id: "wfq-shares",
    mode: "scheduling",
    title: "Sharing the link by weight",
    source: "Demers, Keshav and Shenker 1989; Parekh and Gallager 1993",
    note: "Three flows always have packets waiting: of 1500, 500 and 100 bytes, with weights 1, 2 and 4. The ideal splits the link's bytes 1/7, 2/7 and 4/7, as if it could send a sliver of every flow at once (generalised processor sharing, GPS). Weighted fair queueing (WFQ) sends whole packets in the order that ideal would finish them, so each flow keeps within one largest packet of its share, and no packet leaves more than 1.5 ms, the largest packet's sending time, after its ideal finish.",
    params: BACKLOGGED,
  },
  {
    id: "fifo-greedy",
    mode: "scheduling",
    title: "First come, first served: a greedy flow takes the link",
    source: "Nagle 1987; Demers, Keshav and Shenker 1989",
    note: "One flow sends at 2.4 Mb/s, another at 16 Mb/s, into an 8 Mb/s link. Sending packets in arrival order (FIFO) gives each flow a share in proportion to what it sends, so the polite flow's packets queue behind the greedy flow's ever-growing backlog.",
    params: GREEDY,
  },
  {
    id: "wfq-greedy",
    mode: "scheduling",
    title: "Sharing by weight: the greedy flow only hurts itself",
    source: "Demers, Keshav and Shenker 1989",
    note: "The same flows, now under weighted fair queueing (WFQ) with equal weights. Each is promised half the link, 4 Mb/s; the polite flow uses less than that, so its packets go almost straight through and the greedy flow queues alone.",
    params: { ...GREEDY, discipline: "wfq" },
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
    preset: "four-delays",
    at: 1_220,
    text: "One packet, four delays. It was processed for 20 µs and has just finished going onto the wire: 1500 bytes at 10 Mb/s take 1.2 ms, its length divided by the link's rate. Its first bit is already 240 km down the link: the signal's speed times 1.2 ms.",
  },
  {
    preset: "four-delays",
    at: 11_220,
    text: "The last bit arrives 10 ms after it left: 2000 km at 2 × 10⁸ m/s. Transmission depends on the packet and the link's rate; propagation on the distance alone. Meanwhile the second packet, which came 900 µs after the first, waited 300 µs for the link.",
  },
  {
    preset: "mm1",
    at: 300_000,
    text: "Random arrivals and random sizes: even with the link busy 70% of the time, the line keeps forming and draining. On the chart of packets in the router, under Go deeper, the dashed line is the average theory predicts, 2.33 packets, which the jagged line hovers around.",
  },
  {
    preset: "md1",
    at: 300_000,
    text: "The same arrivals with every packet the same size: the queue is visibly shorter. Half the randomness has gone, and with it half the wait.",
  },
  {
    preset: "heavy",
    at: 2_000_000,
    text: "With the link busy 95% of the time, the line is mostly long, and it stays long for long stretches. Delay grows as 1/(1 − ρ), where ρ is the share of time the link is busy: the last 5% costs as much waiting as the first 90%.",
  },
  {
    preset: "token-shape",
    at: 12_000,
    text: "A burst meets a token bucket. Seven packets went straight through on stored tokens; the rest are held, and leave one every 2 ms as tokens drip in. The token bucket view under Go deeper shows the bucket emptying.",
  },
  {
    preset: "fifo-mice",
    at: 45_000,
    text: "First come, first served: a 100-byte voice packet has joined behind a burst of 1500-byte bulk packets and must wait for all of them.",
  },
  {
    preset: "priority",
    at: 45_000,
    text: "Voice first: the voice packet goes next, once the bulk packet already on the wire is done.",
  },
  {
    preset: "wfq-shares",
    at: 20_000,
    text: "Sharing by weight, 1, 2 and 4. Small packets go more often, large ones less, so that bytes, not packets, are shared by weight. The scheduler view under Go deeper compares each packet's departure with its finish under the ideal split.",
  },
]

export interface LabTask {
  id: string
  difficulty: 1 | 2 | 3
  title: string
  task: string
  hint: string
  start: QueueParams
  check(p: QueueParams, run: QueueRun): { ok: boolean; message: string }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const LABS: LabTask[] = [
  {
    id: "match-delays",
    difficulty: 1,
    title: "Make the packet as long as the link",
    task: "In the four-delays scenario, change only the link's length so that a 1500-byte packet's propagation delay equals its transmission delay, to within 1%.",
    hint: "L/R is fixed at 1.2 ms. How far does a signal travel at 2 × 10⁸ m/s in that time?",
    start: FOUR,
    check(p, run) {
      if (!same({ ...p, distance_m: 0 }, { ...FOUR, distance_m: 0 })) return { ok: false, message: "Change only the link's length." }
      const trans = transUs(1500, p.rate_bps)
      const prop = run.stats.prop_us
      return Math.abs(prop - trans) <= trans / 100
        ? {
            ok: true,
            message: `${p.distance_m / 1000} km: d/s = ${us(prop)} = L/R. The packet now exactly fills the link: its first bit arrives as its last bit leaves. That length is the bandwidth-delay product, R × d/s = 12,000 bits.`,
          }
        : { ok: false, message: `d/s = ${us(prop)} against L/R = ${us(trans)}.` }
    },
  },
  {
    id: "buy-bandwidth",
    difficulty: 2,
    title: "Buy just enough bandwidth",
    task: "The M/M/1 scenario has a mean time in the system of about 3.3 ms. Raise only the link's rate so that theory puts W at no more than 2 ms, while spending as little as you can: the rate must be under 10 Mb/s.",
    hint: "W = 1/(μ − λ). λ stays 700 a second; what μ makes 1/(μ − λ) = 2 ms, and what rate gives that μ with 1000-byte packets?",
    start: MM1,
    check(p) {
      if (!same({ ...p, rate_bps: 0 }, { ...MM1, rate_bps: 0 })) return { ok: false, message: "Change only the link's rate." }
      const t = theory(p)
      if (t.w === null) return { ok: false, message: "The link is overloaded: ρ ≥ 1." }
      if (t.w > 2000) return { ok: false, message: `Theory gives W = ${us(t.w)} at ${bps(p.rate_bps)}; the target is 2 ms.` }
      if (p.rate_bps >= 10_000_000) return { ok: false, message: `W = ${us(t.w)}, but ${bps(p.rate_bps)} is more than you need.` }
      return {
        ok: true,
        message: `W = ${us(t.w)} at ${bps(p.rate_bps)}. μ − λ must be 500 a second, so μ = 1200 and R = 9.6 Mb/s: a 20% faster link cut the delay by 40%, because delay depends on the spare capacity μ − λ, not on μ.`,
      }
    },
  },
  {
    id: "size-the-bucket",
    difficulty: 2,
    title: "Size a token bucket",
    task: "Shape the bursty source with a token bucket of rate at most 2 Mb/s so that no packet is held in the shaper for more than 5 ms. Use the smallest bucket you can: at most 7000 bytes.",
    hint: "A burst is 10,000 bytes over 10 ms. By the time the last packet of a burst has waited 5 ms, how many bytes of tokens have arrived since the burst began, and how many must have been in the bucket at the start?",
    start: SHAPED,
    check(p, run) {
      const f = p.flows[0]
      if (p.flows.length !== 1 || !same({ ...f, shaper: null }, { ...SHAPED.flows[0], shaper: null }))
        return { ok: false, message: "Keep the source as it is; change only its shaper." }
      if (f.shaper.kind !== "token" || f.shaper.police) return { ok: false, message: "Use a shaping token bucket." }
      if (f.shaper.rate_bps > 2_000_000) return { ok: false, message: `The rate is ${bps(f.shaper.rate_bps)}; at most 2 Mb/s.` }
      const worst = Math.max(...run.packets.map((q) => (q.t_shaped ?? Infinity) - q.t_arrive))
      if (worst > 5000) return { ok: false, message: `A packet is held for ${us(worst)}.` }
      if (f.shaper.bucket_bytes > 7000)
        return { ok: false, message: `Held at most ${us(worst)}, but ${f.shaper.bucket_bytes} bytes is a large bucket.` }
      return {
        ok: true,
        message: `b = ${f.shaper.bucket_bytes} bytes, r = ${bps(f.shaper.rate_bps)}: held at most ${us(worst)}. The last packet of a burst comes at 9.5 ms and must go by 14.5 ms, when b + r × 14.5 ms must cover all 10,000 bytes.`,
      }
    },
  },
  {
    id: "rescue-voice",
    difficulty: 1,
    title: "Rescue the voice flow",
    task: "In the FIFO scenario voice packets wait tens of milliseconds behind bulk. Without changing either flow's traffic, get voice's mean wait under 1 ms. Find two different ways.",
    hint: "The scheduler decides who goes next. Which disciplines let a small flow overtake a big one, and what setting tells each that voice matters?",
    start: MICE,
    check(p, run) {
      const strip = (f: QFlow) => ({ ...f, weight: 0, priority: 0 })
      if (p.flows.length !== 2 || !same(p.flows.map(strip), MICE.flows.map(strip)) || p.rate_bps !== MICE.rate_bps)
        return { ok: false, message: "Keep both flows' traffic and the link as they are." }
      const v = run.stats.flows[1].wait_us
      if (v >= 1000) return { ok: false, message: `Voice waits ${us(v)} on average.` }
      return p.discipline === "priority"
        ? { ok: true, message: `Voice waits ${us(v)} under strict priority. Now try WFQ: what weights does it need?` }
        : {
            ok: true,
            message: `Voice waits ${us(v)} under ${p.discipline.toUpperCase()}. WFQ helps voice because it sends little; it is never made to wait for its turn behind a backlog.`,
          }
    },
  },
  {
    id: "set-weights",
    difficulty: 3,
    title: "Divide the link 50 : 30 : 20",
    task: "In the WFQ scenario, set the weights so that while all three flows are backlogged they get 50%, 30% and 20% of the bytes sent, each within one percentage point.",
    hint: "WFQ shares bytes, not packets, in proportion to weight; the packet sizes do not matter.",
    start: BACKLOGGED,
    check(p, run) {
      const strip = (f: QFlow) => ({ ...f, weight: 0 })
      if (p.discipline !== "wfq" || !same(p.flows.map(strip), BACKLOGGED.flows.map(strip)))
        return { ok: false, message: "Keep WFQ and the flows; change only the weights." }
      const s = shares(p, run)
      const want = [0.5, 0.3, 0.2]
      const got = s.share.map((x) => `${(100 * x).toFixed(1)}%`).join(", ")
      return s.share.every((x, k) => Math.abs(x - want[k]) <= 0.01)
        ? { ok: true, message: `Shares ${got}. Any weights in the ratio 5 : 3 : 2 do it.` }
        : { ok: false, message: `Shares ${got}.` }
    },
  },
]
