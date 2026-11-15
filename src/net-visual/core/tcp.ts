// The typed interface to the TCP model in crates/netsim/src/tcp.rs, with the
// scenarios, the tour and the lab tasks. Erasable TypeScript only, so the
// Node tests can import it directly.
import type { Netsim } from "./netsim.ts"

export type Algo = "tahoe" | "reno" | "newreno" | "cubic"

export interface Flow {
  algo: Algo
  /** Propagation round trip, without transmission or queueing. */
  rtt_us: number
  start_us: number
}

export interface ScriptedDrop {
  flow: number
  seg: number
  occurrence: number
}

export interface TcpParams {
  flows: Flow[]
  rate_bps: number
  mss_bytes: number
  /** Packets that may wait at the bottleneck, besides the one being sent. */
  buffer_pkts: number
  loss: number
  drop_every: number
  jitter_us: number
  duration_us: number
  iw: number
  init_ssthresh: number
  max_window: number
  min_rto_us: number
  fast_convergence: boolean
  seed: number
  drops: ScriptedDrop[]
  detail?: [number, number]
}

export interface Flight {
  id: number
  ack: boolean
  /** Segment number for data, the next expected segment for an ACK. */
  seg: number
  retx: boolean
  occurrence: number
  t_start: number
  t_sent: number
  t_arrive: number
  lost: boolean
  fate: string
}

export type Phase = "S" | "A" | "R"

export interface State {
  cwnd: number
  ssthresh: number
  una: number
  nxt: number
  max: number
  dupacks: number
  phase: Phase
  recover: number
  srtt_us: number
  rttvar_us: number
  rto_us: number
  timer_at: number | null
  queue: number
  /** CUBIC's region: F Reno-friendly, C concave, X convex; - otherwise. */
  region: "F" | "C" | "X" | "-"
  w_max: number
  k: number
}

export interface TcpEvent {
  t: number
  step: string
  text: string
  flight: number | null
  state: State
}

export interface Mark {
  t: number
  kind: "drop" | "fast" | "partial" | "timeout"
  seg: number
}

export interface FlowSeries {
  cwnd: [number, number][]
  ssthresh: [number, number][]
  srtt: [number, number][]
  rto: [number, number][]
  marks: Mark[]
}

export interface Grid {
  dt_us: number
  t: number[]
  cwnd: number[][]
  /** Goodput per flow over the interval ending at each grid time, bit/s. */
  rate: number[][]
  queue: number[]
}

export interface FlowTotals {
  delivered: number
  sent: number
  retransmissions: number
  fast_retransmits: number
  timeouts: number
  drops: number
  goodput_bps: number
  loss_rate: number
  mean_rtt_us: number
}

export interface Totals {
  flows: FlowTotals[]
  utilisation: number
  mean_queue: number
  max_queue: number
  jain: number
}

export interface Theory {
  tx_us: number
  bdp_pkts: number
  pipe_pkts: number
  reno_utilisation: number
  mathis_bps: number
  pftk_bps: number
  cubic_k_s: number
}

export interface TcpRun {
  series: FlowSeries[]
  queue: [number, number][]
  grid: Grid
  flights: Flight[]
  events: TcpEvent[]
  totals: Totals
  theory: Theory
  duration_us: number
  /** The trace is complete from the start of the detail window to here. */
  trace_end: number
}

export const ALGOS: { id: Algo; name: string; rfc: string }[] = [
  { id: "tahoe", name: "Tahoe", rfc: "Jacobson 1988" },
  { id: "reno", name: "Reno", rfc: "RFC 5681" },
  { id: "newreno", name: "NewReno", rfc: "RFC 6582" },
  { id: "cubic", name: "CUBIC", rfc: "RFC 9438" },
]
export const algoName = (a: Algo) => ALGOS.find((x) => x.id === a)!.name

/** The whole run without the event trace: curves, totals and theory. */
export const runOverview = (sim: Netsim, p: TcpParams): TcpRun =>
  sim.call<TcpRun>("tcp", "run", { ...p, detail: [p.duration_us + 1, p.duration_us + 1] })

/**
 * The trace of flow 0 is long (several events per packet), so the page asks
 * for it a window at a time. A window starts `lead` before the moment it is
 * for, so that packets already in flight then are drawn, and the run stops
 * shortly after the window ends. The model's test checks that a window gives
 * exactly the events of the full run.
 */
export interface Window {
  /** The window is meant to show [from, to]; the run traces from from - lead. */
  from: number
  to: number
  lead: number
}

/** Packets per second through the bottleneck. */
export const packetRate = (p: TcpParams) => p.rate_bps / (8 * p.mss_bytes)

export function windowSpan(p: TcpParams): { span: number; lead: number } {
  const tx = (8 * p.mss_bytes * 1e6) / p.rate_bps
  const rtt = Math.max(...p.flows.map((f) => f.rtt_us)) + tx
  // At most about two packets of trace (one data, one ACK) per packet time,
  // and the model keeps 4000: 1000 packet times leaves room for bursts.
  const span = Math.max(2 * rtt, Math.min(p.duration_us, (1000 / packetRate(p)) * 1e6))
  const lead = Math.min(p.duration_us, rtt + (p.buffer_pkts + 2) * tx + p.jitter_us)
  return { span, lead }
}

/** The window for time t: aligned to quarter spans so nearby times share one. */
export function windowFor(p: TcpParams, t: number): Window {
  const { span, lead } = windowSpan(p)
  const q = span / 4
  const from = Math.max(0, Math.floor(t / q) * q)
  return { from, to: Math.min(p.duration_us, from + span), lead: from === 0 ? 0 : lead }
}

export function runWindow(sim: Netsim, p: TcpParams, w: Window): TcpRun {
  const start = Math.round(Math.max(0, w.from - w.lead))
  const end = Math.round(w.to)
  const { lead } = windowSpan(p)
  const stop = Math.min(p.duration_us, end + 2 * lead + 4 * p.min_rto_us)
  return sim.call<TcpRun>("tcp", "run", { ...p, duration_us: Math.max(stop, end + 1), detail: [start, end] })
}

/** The last value of a change-based series at or before t. */
export function valueAt(points: [number, number][], t: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid][0] <= t) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? points[lo - 1][1] : (points[0]?.[1] ?? 0)
}

export const mbps = (bps: number) => (bps >= 1e9 ? `${(bps / 1e9).toFixed(2)} Gb/s` : `${(bps / 1e6).toFixed(bps < 1e7 ? 2 : 1)} Mb/s`)

/** 10 Mb/s, 1500-byte segments (1.2 ms each), 100 ms round trip: a BDP of 84 packets. */
export const BASE: TcpParams = {
  flows: [{ algo: "reno", rtt_us: 100_000, start_us: 0 }],
  rate_bps: 10_000_000,
  mss_bytes: 1500,
  buffer_pkts: 1000,
  loss: 0,
  drop_every: 0,
  jitter_us: 0,
  duration_us: 5_000_000,
  iw: 1,
  init_ssthresh: 40,
  max_window: 1_000_000,
  min_rto_us: 1_000_000,
  fast_convergence: false,
  seed: 1,
  drops: [],
}

const drops = (...segs: number[]): ScriptedDrop[] => segs.map((seg) => ({ flow: 0, seg, occurrence: 1 }))
const flow = (algo: Algo, rtt_ms = 100, start_s = 0): Flow => ({ algo, rtt_us: rtt_ms * 1000, start_us: start_s * 1e6 })

export interface Preset {
  id: string
  title: string
  source: string
  note: string
  params: TcpParams
  /** Draw flow 0 under this algorithm too, dashed, for comparison. */
  compare?: Algo
}

export const PRESETS: Preset[] = [
  {
    id: "kr",
    title: "Tahoe and Reno after one loss",
    source: "Kurose and Ross, Section 3.7, the figure comparing Tahoe and Reno",
    note: "Slow start doubles the window each round trip until ssthresh = 8, then congestion avoidance adds one segment per round trip. Segment 50 is lost when the window is about 12. Three duplicate ACKs follow: both set ssthresh to 6; Reno continues from 6 (after a brief inflation during fast recovery), while Tahoe, dashed, starts again from 1.",
    params: { ...BASE, init_ssthresh: 8, duration_us: 3_000_000, drops: drops(50) },
    compare: "tahoe",
  },
  {
    id: "fall-floyd",
    title: "Three losses in one window",
    source: "Fall and Floyd (1996), the three-drop case",
    note: "Segments 30, 32 and 34 are lost from one window. Reno repairs the first by fast retransmit, then halves the window again for the second and runs out of duplicate ACKs: it waits for the timer. NewReno, dashed, treats the later losses as one episode and resends one segment per round trip without a timeout.",
    params: { ...BASE, drops: drops(30, 32, 34) },
    compare: "newreno",
  },
  {
    id: "sawtooth",
    title: "The sawtooth and the buffer",
    source: "Villamizar and Song (1994); Appenzeller, Keslassy and McKeown (2004)",
    note: "One Reno flow and a 20-packet buffer on a path whose bandwidth-delay product is 84 packets. The window climbs to BDP + B + 1, a packet is dropped, the window halves. Below the BDP line the link idles; above it the queue fills. Compare the measured utilisation with the formula in the Analysis section.",
    params: { ...BASE, buffer_pkts: 20, duration_us: 30_000_000 },
  },
  {
    id: "bufferbloat",
    title: "Bufferbloat on a slow uplink",
    source: "Gettys and Nichols (2012)",
    note: "A 1 Mb/s link with a 200-packet buffer: 2.4 seconds of queue. Reno fills it, because loss is its only signal, so the link stays busy and every packet waits more than a second. Set the buffer to 20 and the link is just as busy with a tenth of the delay.",
    params: { ...BASE, rate_bps: 1_000_000, buffer_pkts: 200, init_ssthresh: 1e9, iw: 10, duration_us: 60_000_000 },
  },
  {
    id: "no-buffer",
    title: "No buffer at all (a hard case)",
    source: "the fluid model's 3/4 law, and why it fails here",
    note: "With B = 0 the fluid model predicts 3/4 utilisation. The real flow collapses: an ACK that raises the window past a whole number releases two segments at once, the second finds the link busy and is dropped, and with a small window there are rarely three duplicate ACKs, so the timer must recover. The model and the formula disagree, and the ladder shows why.",
    params: { ...BASE, buffer_pkts: 0, duration_us: 10_000_000 },
  },
  {
    id: "square-root",
    title: "The square-root law",
    source: "Mathis, Semke, Mahdavi and Ott (1997)",
    note: "Every 1000th packet is dropped, the periodic loss the law assumes. The rate settles near (MSS/RTT) sqrt(3/(2p)); the Analysis section compares the two and explains the gap.",
    params: { ...BASE, drop_every: 1000, duration_us: 60_000_000 },
  },
  {
    id: "two-flows",
    title: "Two flows converge to a fair share",
    source: "Chiu and Jain (1989)",
    note: "A second Reno flow joins at 5 seconds. Additive increase moves both flows along a 45-degree line in the phase plane; multiplicative decrease moves them towards the origin. Each cycle brings them closer to the fairness line.",
    params: { ...BASE, buffer_pkts: 40, duration_us: 40_000_000, flows: [flow("reno"), flow("reno", 100, 5)] },
  },
  {
    id: "rtt-unfair",
    title: "A longer round trip gets less",
    source: "Lakshman and Madhow (1997)",
    note: "Two Reno flows, 50 ms and 150 ms of propagation. Each adds one segment per round trip, so the short flow grows three times as fast. The queue adds the same delay to both, which narrows the gap: compare the ratio of their rates with the ratio of their measured round trips.",
    params: { ...BASE, buffer_pkts: 100, jitter_us: 3000, duration_us: 60_000_000, flows: [flow("reno", 50), flow("reno", 150)] },
  },
  {
    id: "phase",
    title: "Phase effects: the short flow starves (a hard case)",
    source: "Floyd and Jacobson (1992)",
    note: "The same two flows with a 20-packet buffer and no randomness at all. The short-RTT flow's packets keep arriving just as the queue is full, and it gets far less than the long one: the opposite of the textbook rule. Add a few milliseconds of jitter in the setup and the bias returns to normal.",
    params: { ...BASE, buffer_pkts: 20, duration_us: 60_000_000, flows: [flow("reno", 50), flow("reno", 150)] },
  },
  {
    id: "cubic",
    title: "CUBIC on a long fat pipe",
    source: "RFC 9438; Ha, Rhee and Xu (2008)",
    note: "50 Mb/s and 100 ms: a BDP of 418 packets, with one packet in 40,000 lost. Reno, dashed, regains one segment per round trip and spends most of the time below the BDP line. CUBIC returns to its last maximum along a cubic curve, flattens near it, then probes beyond it.",
    params: {
      ...BASE,
      rate_bps: 50_000_000,
      buffer_pkts: 417,
      drop_every: 40_000,
      init_ssthresh: 200,
      iw: 10,
      duration_us: 60_000_000,
      flows: [flow("cubic")],
    },
    compare: "reno",
  },
]

export interface TourStep {
  preset: string
  /** Fraction of the run. */
  at: number
  text: string
}

export const TOUR: TourStep[] = [
  {
    preset: "kr",
    at: 0.07,
    text: "One flow, 10 Mb/s, 100 ms. The window (top chart, in segments) starts at 1 and doubles every round trip: each ACK lets two new segments out. This is slow start. The ladder below shows the bursts leaving the sender.",
  },
  {
    preset: "kr",
    at: 0.31,
    text: "Segment 50 has just been lost. Every later segment produces a duplicate ACK for 50. On the third, the sender resends 50 at once (fast retransmit) without waiting for the timer. The congestion state diagram lights up fast recovery.",
  },
  {
    preset: "kr",
    at: 0.5,
    text: "Reno continued from half the window; Tahoe, the dashed line, went back to one segment and slow start. Both set ssthresh to 6, half of what was in flight.",
  },
  {
    preset: "fall-floyd",
    at: 0.42,
    text: "Three losses in one window. Reno's second halving left too few segments in flight to make three more duplicate ACKs, so it sat idle until the retransmission timer fired. NewReno, dashed, did not stall.",
  },
  {
    preset: "sawtooth",
    at: 0.6,
    text: "In steady state the window is a sawtooth between (P + B)/2 and P + B, where P is the BDP. The bottleneck queue (the chart below the ladder) is empty while the window is below P and the link idles then; the utilisation is the area argument in the Analysis section.",
  },
  {
    preset: "bufferbloat",
    at: 0.7,
    text: "The same sawtooth with a buffer ten times too big. The link is never idle, but the round-trip time (the round-trip chart below the ladder) is over a second. Loss-based congestion control fills whatever buffer it is given.",
  },
  {
    preset: "two-flows",
    at: 0.9,
    text: "Two flows. In the phase plane each axis is one flow's rate. Increase moves the point up and to the right at 45 degrees; a halving moves it towards the origin. The point has worked its way to the line where the two rates are equal.",
  },
  {
    preset: "cubic",
    at: 0.55,
    text: "CUBIC's window after a loss: a fast concave rise, a plateau near the window where the last loss happened, then a convex probe beyond it. The dashed Reno line is still climbing one segment per round trip.",
  },
]

export interface LabTask {
  id: string
  difficulty: 1 | 2 | 3
  title: string
  task: string
  hint: string
  start: TcpParams
  check(p: TcpParams, run: TcpRun, sim: Netsim): { ok: boolean; message: string }
}

const sameExcept = (a: TcpParams, b: TcpParams, keys: (keyof TcpParams)[]) =>
  (Object.keys(b) as (keyof TcpParams)[]).every((k) => keys.includes(k) || JSON.stringify(a[k]) === JSON.stringify(b[k]))

export const withAlgo = (p: TcpParams, algo: Algo): TcpParams => ({ ...p, flows: p.flows.map((f, i) => (i === 0 ? { ...f, algo } : f)) })

const bufferStart: TcpParams = { ...BASE, buffer_pkts: 5, duration_us: 30_000_000 }
const ssthreshStart: TcpParams = { ...BASE, init_ssthresh: 8, duration_us: 6_000_000 }
const dropsStart: TcpParams = { ...BASE }
const mathisStart: TcpParams = { ...BASE, drop_every: 1000, duration_us: 60_000_000 }

export const LABS: LabTask[] = [
  {
    id: "ssthresh",
    difficulty: 1,
    title: "Make ssthresh fall to 10",
    task: "Reno, ssthresh starting at 8. Drop one segment (click a data packet in the ladder and press D, or add it in the setup) so that the fast retransmit sets ssthresh to exactly 10.",
    hint: "At the third duplicate ACK ssthresh becomes half of what is in flight. After slow start ends at 8, the window grows by one segment per round trip. When is about 20 in flight?",
    start: ssthreshStart,
    check(p, run) {
      if (!sameExcept(p, ssthreshStart, ["drops"])) return { ok: false, message: "Change only which segments are dropped." }
      const s = run.series[0]
      const fast = s.marks.find((m) => m.kind === "fast")
      if (!fast) return { ok: false, message: "No fast retransmit happened. Drop a segment." }
      const ss = valueAt(s.ssthresh, fast.t)
      return ss === 10
        ? { ok: true, message: `ssthresh = 10 at ${(fast.t / 1e6).toFixed(2)} s: 20 segments were in flight.` }
        : { ok: false, message: `The first fast retransmit set ssthresh to ${ss}, so ${2 * ss} were in flight.` }
    },
  },
  {
    id: "buffer",
    difficulty: 2,
    title: "The smallest buffer for 95%",
    task: "One Reno flow on 10 Mb/s with a 100 ms round trip. Find the smallest buffer (to within 3 packets) that keeps the link at least 95% busy. Change only the buffer.",
    hint: "The window swings between (P + B)/2 and P + B. The link is idle only while the window is below P. Use the formula in the Analysis section, then check it here.",
    start: bufferStart,
    check(p, run, sim) {
      if (!sameExcept(p, bufferStart, ["buffer_pkts"])) return { ok: false, message: "Change only the buffer." }
      const u = run.totals.utilisation
      if (u < 0.95) return { ok: false, message: `With B = ${p.buffer_pkts} the link is busy ${(100 * u).toFixed(1)}% of the time.` }
      if (p.buffer_pkts >= 4) {
        const smaller = runOverview(sim, { ...p, buffer_pkts: p.buffer_pkts - 4 }).totals.utilisation
        if (smaller >= 0.95)
          return { ok: false, message: `Enough, but B = ${p.buffer_pkts - 4} also reaches ${(100 * smaller).toFixed(1)}%.` }
      }
      return {
        ok: true,
        message: `B = ${p.buffer_pkts}: ${(100 * u).toFixed(1)}% measured, ${(100 * run.theory.reno_utilisation).toFixed(1)}% by the formula, against a BDP of ${run.theory.bdp_pkts.toFixed(0)} packets.`,
      }
    },
  },
  {
    id: "mathis",
    difficulty: 2,
    title: "Choose the loss rate for 2 Mb/s",
    task: "One Reno flow, 100 ms round trip, 1500-byte segments, a large buffer. Set 'drop every n-th packet' so that the long-run rate is 2 Mb/s, within 10%.",
    hint: "Start from the square-root law, rate = (MSS/RTT) sqrt(3/(2p)), with p = 1/n. The measured rate falls a little short of the law; the Analysis section explains why.",
    start: mathisStart,
    check(p, run) {
      if (!sameExcept(p, mathisStart, ["drop_every"])) return { ok: false, message: "Change only how often a packet is dropped." }
      const r = run.totals.flows[0].goodput_bps
      const ok = Math.abs(r / 2e6 - 1) <= 0.1
      return {
        ok,
        message: `With n = ${p.drop_every}: ${mbps(r)} measured, ${mbps(run.theory.mathis_bps)} by the square-root law.${ok ? "" : " Aim for 2 Mb/s."}`,
      }
    },
  },
  {
    id: "reno-stalls",
    difficulty: 3,
    title: "Losses that stall Reno but not NewReno",
    task: "Script drops (click data packets in the ladder and press D) so that Reno has at least one timeout and NewReno, with the same drops, has none. The check runs both.",
    hint: "Reno leaves fast recovery on the first new ACK. If another segment of the same window is missing, how many duplicate ACKs can still arrive?",
    start: dropsStart,
    check(p, _run, sim) {
      if (!sameExcept(p, dropsStart, ["drops", "flows"]) || p.flows.length !== 1)
        return { ok: false, message: "Change only the drops (the algorithm is switched by the check)." }
      if (p.drops.length === 0) return { ok: false, message: "Drop some segments first." }
      const reno = runOverview(sim, withAlgo(p, "reno")).totals.flows[0]
      const newreno = runOverview(sim, withAlgo(p, "newreno")).totals.flows[0]
      const ok = reno.timeouts > 0 && newreno.timeouts === 0
      return {
        ok,
        message: `Reno: ${reno.timeouts} timeout(s), ${reno.fast_retransmits} fast retransmit(s). NewReno: ${newreno.timeouts} timeout(s), ${newreno.fast_retransmits} fast retransmit(s).`,
      }
    },
  },
  {
    id: "tahoe-wins",
    difficulty: 3,
    title: "Make Tahoe beat Reno",
    task: "Tahoe throws its window away after every loss; Reno only halves it. Find drops for which Tahoe delivers more than Reno in the same five seconds. The check runs both.",
    hint: "Tahoe resends everything after a loss in slow start, so several holes cost it one restart. What does Reno do with several holes in one window?",
    start: dropsStart,
    check(p, _run, sim) {
      if (!sameExcept(p, dropsStart, ["drops", "flows"]) || p.flows.length !== 1)
        return { ok: false, message: "Change only the drops (the algorithm is switched by the check)." }
      if (p.drops.length === 0) return { ok: false, message: "Drop some segments first." }
      const tahoe = runOverview(sim, withAlgo(p, "tahoe")).totals.flows[0]
      const reno = runOverview(sim, withAlgo(p, "reno")).totals.flows[0]
      const ok = tahoe.delivered > reno.delivered
      return {
        ok,
        message: `Tahoe delivered ${tahoe.delivered} segments, Reno ${reno.delivered} (Reno: ${reno.timeouts} timeout(s)).`,
      }
    },
  },
]

/** The marks on the window chart, thinned to at most `max` of each kind. */
export function thinMarks(marks: Mark[], kind: Mark["kind"], max: number): Mark[] {
  const all = marks.filter((m) => m.kind === kind)
  if (all.length <= max) return all
  const step = all.length / max
  return Array.from({ length: max }, (_, i) => all[Math.floor(i * step)])
}

/** Smooth a regularly sampled series with a centred moving average about w samples wide. */
export function smooth(values: number[], w: number): number[] {
  const half = Math.floor(w / 2)
  if (half < 1) return values
  const prefix = [0]
  for (const v of values) prefix.push(prefix[prefix.length - 1] + v)
  return values.map((_, i) => {
    const a = Math.max(0, i - half)
    const b = Math.min(values.length, i + half + 1)
    return (prefix[b] - prefix[a]) / (b - a)
  })
}

/** RFC 1071: the ones' complement of the ones' complement sum of 16-bit words. */
export function internetChecksum(words: Iterable<number>): number {
  let sum = 0
  for (const w of words) {
    sum += w & 0xffff
    sum = (sum & 0xffff) + (sum >>> 16)
  }
  return ~sum & 0xffff
}

// Documentation addresses (RFC 5737) and ports for the two hosts.
const SENDER = [192, 0, 2, 1]
const RECEIVER = [198, 51, 100, 7]
const SENDER_PORT = 50000
const RECEIVER_PORT = 80
export const WINDOW = 65535

export function* words(bytes: number[]) {
  for (let i = 0; i < bytes.length; i += 2) yield (bytes[i] << 8) | (bytes[i + 1] ?? 0)
}

/**
 * The TCP header of one segment as RFC 9293 (Section 3.1) lays it out, with
 * relative sequence numbers (the initial sequence number is 0, as Wireshark
 * shows them) and the checksum computed over the pseudo-header, the header
 * and a stand-in payload.
 */
export function tcpHeader(f: Flight, p: TcpParams) {
  const payload = f.ack ? 0 : Math.max(0, p.mss_bytes - 40)
  const per = Math.max(1, p.mss_bytes - 40)
  const seq = f.ack ? 1 : 1 + f.seg * per
  const ack = f.ack ? 1 + f.seg * per : 1
  const [src, dst] = f.ack ? [RECEIVER, SENDER] : [SENDER, RECEIVER]
  const [sport, dport] = f.ack ? [RECEIVER_PORT, SENDER_PORT] : [SENDER_PORT, RECEIVER_PORT]
  const len = 20 + payload
  const flags = 0x10 | (f.ack ? 0 : 0x08) // ACK, and PSH on data
  const header = [
    sport >> 8,
    sport & 255,
    dport >> 8,
    dport & 255,
    ...[24, 16, 8, 0].map((s) => (seq >>> s) & 255),
    ...[24, 16, 8, 0].map((s) => (ack >>> s) & 255),
    5 << 4,
    flags,
    WINDOW >> 8,
    WINDOW & 255,
    0,
    0, // checksum, zero while it is computed
    0,
    0,
  ]
  const pseudo = [...src, ...dst, 0, 6, len >> 8, len & 255]
  const data = Array.from({ length: payload }, (_, i) => (f.seg * 7 + i) & 255)
  const checksum = internetChecksum(words([...pseudo, ...header, ...data]))
  header[16] = checksum >> 8
  header[17] = checksum & 255
  return { seq, ack, flags, len, payload, checksum, src, dst, sport, dport, pseudo, bytes: [...header, ...data] }
}
