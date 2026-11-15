// Types and helpers for the link-layer models (crates/netsim/src/link.rs):
// ALOHA, CSMA/CD and 802.11 CSMA/CA. Erasable TypeScript only, so Node can
// run it in tests.
import type { Netsim } from "./netsim.ts"

// --- ALOHA ---------------------------------------------------------------

export interface AlohaParams {
  slotted: boolean
  stations: number
  g: number
  frame_us: number
  /** In frame times. */
  length: number
  seed: number
  trace?: boolean
}

export interface AlohaFrame {
  id: number
  station: number
  attempt: number
  start_us: number
  end_us: number
  ok: boolean
  hit: number | null
}

export interface AlohaEvent {
  t: number
  step: string
  frame: number
  what: "clear" | "collides" | "delivered" | "garbled"
}

export interface AlohaStats {
  attempts: number
  delivered: number
  g: number
  s: number
  theory: number
  limit: number
  per_station: number[]
}

export interface AlohaRun {
  frames: AlohaFrame[]
  events: AlohaEvent[]
  stats: AlohaStats
}

export interface AlohaPoint {
  g: number
  measured_g: number
  s: number
}

// --- CSMA/CD -------------------------------------------------------------

export interface CdStation {
  name: string
  pos_m: number
  start_ns?: number
  frames?: number
}

export interface CdParams {
  stations: CdStation[]
  rate_bps: number
  frame_bytes: number
  slot_bits: number
  jam_bits: number
  ifg_bits: number
  speed_mps: number
  attempt_limit: number
  backoff_cap: number
  duration_ns: number
  seed: number
  trace?: boolean
}

export type CdOutcome = "delivered" | "collided" | "undetected" | "aborted" | "unfinished"

export interface CdTx {
  id: number
  station: number
  frame: number
  attempt: number
  start_ns: number
  end_ns: number
  detect_ns: number | null
  outcome: CdOutcome
}

export interface CdBackoff {
  station: number
  t_ns: number
  collisions: number
  k: number
  max: number
}

export interface CdEvent {
  t: number
  step: string
  station: number
  tx: number | null
  what: string
}

export interface CdStats {
  delivered: number
  collided: number
  aborted: number
  undetected: number
  efficiency: number
  frame_ns: number
  slot_ns: number
  jam_ns: number
  ifg_ns: number
  tau_ns: number
  a: number
  max_detect_ns: number
  per_station: number[]
}

export interface CdRun {
  txs: CdTx[]
  backoffs: CdBackoff[]
  events: CdEvent[]
  stats: CdStats
}

export interface CdPoint {
  frame_bytes: number
  a: number
  efficiency: number
}

// --- CSMA/CA -------------------------------------------------------------

export interface CaNode {
  name: string
  x_m: number
  y_m: number
}

export interface CaFlow {
  from: number
  to: number
  frames?: number
  start_us?: number
}

export interface CaParams {
  nodes: CaNode[]
  range_m: number
  flows: CaFlow[]
  rts: boolean
  rate_bps: number
  payload_bytes: number
  slot_us: number
  sifs_us: number
  cw_min: number
  cw_max: number
  attempt_limit: number
  preamble_us: number
  duration_us: number
  seed: number
  trace?: boolean
}

export type AirKind = "rts" | "cts" | "data" | "ack"

export interface Air {
  id: number
  from: number
  to: number
  kind: AirKind
  flow: number
  start_us: number
  end_us: number
  nav_us: number
  heard_by: number[]
  lost_at: number[]
  ok: boolean
}

export interface CaNav {
  node: number
  air: number
  from_us: number
  until_us: number
}

export interface CaEvent {
  t: number
  step: string
  node: number
  air: number | null
  what: string
  backoff: number
  cw: number
}

export interface CaFlowStats {
  delivered: number
  data_sent: number
  data_lost: number
  rts_sent: number
  rts_lost: number
  dropped: number
  throughput_bps: number
  needless_us: number
}

export interface CaStats {
  flows: CaFlowStats[]
  difs_us: number
  data_us: number
  ack_us: number
  rts_us: number
  cts_us: number
  data_loss: number
  rts_loss: number
}

export interface CaRun {
  airs: Air[]
  navs: CaNav[]
  events: CaEvent[]
  stats: CaStats
}

// --- One page, three models ---------------------------------------------

export type Mode = "aloha" | "csmacd" | "csmaca"

export const MODES: { id: Mode; title: string }[] = [
  { id: "aloha", title: "ALOHA" },
  { id: "csmacd", title: "CSMA/CD" },
  { id: "csmaca", title: "CSMA/CA" },
]

export type LinkParams = { mode: "aloha"; aloha: AlohaParams } | { mode: "csmacd"; cd: CdParams } | { mode: "csmaca"; ca: CaParams }

export type LinkRun = { mode: "aloha"; run: AlohaRun } | { mode: "csmacd"; run: CdRun } | { mode: "csmaca"; run: CaRun }

export const runAloha = (sim: Netsim, p: AlohaParams) => sim.call<AlohaRun>("link", "aloha", p)
export const sweepAloha = (sim: Netsim, base: AlohaParams, gs: number[]) => sim.call<AlohaPoint[]>("link", "aloha_sweep", { base, gs })
export const runCd = (sim: Netsim, p: CdParams) => sim.call<CdRun>("link", "csmacd", p)
export const sweepCd = (sim: Netsim, base: CdParams, frame_bytes: number[]) =>
  sim.call<CdPoint[]>("link", "csmacd_sweep", { base, frame_bytes })
export const runCa = (sim: Netsim, p: CaParams) => sim.call<CaRun>("link", "csmaca", p)

export function runLink(sim: Netsim, p: LinkParams): LinkRun {
  switch (p.mode) {
    case "aloha":
      return { mode: "aloha", run: runAloha(sim, p.aloha) }
    case "csmacd":
      return { mode: "csmacd", run: runCd(sim, p.cd) }
    case "csmaca":
      return { mode: "csmaca", run: runCa(sim, p.ca) }
  }
}

/** The run's length, in the model's own unit (µs for ALOHA and CSMA/CA, ns for CSMA/CD). */
export function linkDuration(p: LinkParams): number {
  switch (p.mode) {
    case "aloha":
      return p.aloha.length * p.aloha.frame_us
    case "csmacd":
      return p.cd.duration_ns
    case "csmaca":
      return p.ca.duration_us
  }
}

/** Event times of a run, in the model's own unit. */
export function eventTimes(r: LinkRun): number[] {
  return r.run.events.map((e) => e.t)
}

/** Formats a time in the model's unit: CSMA/CD counts nanoseconds, the others microseconds. */
export function fmtTime(t: number, mode: Mode): string {
  const u = mode === "csmacd" ? t / 1000 : t
  if (!Number.isFinite(u)) return "∞"
  const a = Math.abs(u)
  if (a >= 1e6) return `${Number((u / 1e6).toPrecision(4))} s`
  if (a >= 1e3) return `${Number((u / 1e3).toPrecision(4))} ms`
  return `${Number(u.toPrecision(4))} µs`
}

export const bps = (r: number) =>
  r >= 1e9
    ? `${Number((r / 1e9).toPrecision(3))} Gb/s`
    : r >= 1e6
      ? `${Number((r / 1e6).toPrecision(3))} Mb/s`
      : `${Number((r / 1e3).toPrecision(3))} kb/s`

// --- Theory --------------------------------------------------------------

/** Throughput per frame time with infinitely many stations (Poisson arrivals). */
export const alohaLimit = (slotted: boolean, g: number) => (slotted ? g * Math.exp(-g) : g * Math.exp(-2 * g))

/** Throughput per frame time with n stations, exactly as the model works (see aloha_theory in link.rs). */
export function alohaExact(slotted: boolean, n: number, g: number): number {
  const q = g / n
  if (slotted) return g * Math.pow(1 - q, n - 1)
  if (q >= 1) return n === 1 ? 1 : 0
  return g * Math.pow((1 - q) * Math.exp(-q / (1 - q)), n - 1)
}

/** The load that maximises alohaExact, by golden-section search. */
export function alohaPeak(slotted: boolean, n: number): { g: number; s: number } {
  let lo = 0
  let hi = slotted ? Math.min(n, 3) : Math.min(n * 0.999, 2)
  const r = (Math.sqrt(5) - 1) / 2
  for (let i = 0; i < 100; i++) {
    const a = hi - r * (hi - lo)
    const b = lo + r * (hi - lo)
    if (alohaExact(slotted, n, a) < alohaExact(slotted, n, b)) lo = a
    else hi = b
  }
  const g = (lo + hi) / 2
  return { g, s: alohaExact(slotted, n, g) }
}

/** The textbook approximation for Ethernet's efficiency, 1/(1 + 5a). */
export const cdApprox = (a: number) => 1 / (1 + 5 * a)

/**
 * Metcalfe and Boggs (1976): N stations always ready, each sending in a
 * contention slot with probability 1/N, so a slot is won with probability
 * A = (1 − 1/N)^(N−1) and a frame waits (1 − A)/A wasted slots on average.
 */
export function metcalfeBoggs(n: number, frame_ns: number, slot_ns: number): number {
  const A = Math.pow(1 - 1 / n, n - 1)
  return frame_ns / (frame_ns + ((1 - A) / A) * slot_ns)
}

export const frameNs = (p: CdParams) => Math.round((p.frame_bytes * 8 * 1e9) / p.rate_bps)
export const bitNs = (p: CdParams, bits: number) => Math.round((bits * 1e9) / p.rate_bps)
export const propNs = (p: CdParams, i: number, j: number) =>
  Math.round((Math.abs(p.stations[i].pos_m - p.stations[j].pos_m) * 1e9) / p.speed_mps)
export const tauNs = (p: CdParams) => Math.max(0, ...p.stations.flatMap((_, i) => p.stations.map((_, j) => propNs(p, i, j))))

/** The shortest frame, in bytes, that lasts at least a round trip across this bus. */
export const minFrameBytes = (p: CdParams) => Math.ceil((2 * tauNs(p) * p.rate_bps) / 8e9)

/** The largest backoff, in slots, after a frame's nth collision; null once it is dropped. */
export const bebMax = (n: number, cap = 10, limit = 16) => (n < limit ? 2 ** Math.min(n, cap) - 1 : null)

export const caNear = (p: CaParams, a: number, b: number) =>
  a !== b && Math.hypot(p.nodes[a].x_m - p.nodes[b].x_m, p.nodes[a].y_m - p.nodes[b].y_m) <= p.range_m

export const airUs = (p: CaParams, bytes: number) => p.preamble_us + Math.ceil((bytes * 8e6) / p.rate_bps)

export const DATA_HEADER = 28
export const RTS_BYTES = 20
export const CTS_BYTES = 14
export const ACK_BYTES = 14

/** The duration fields of an RTS/CTS exchange, as in IEEE 802.11 (Section 10.3.2.1 in the 2020 edition). */
export function navFields(p: CaParams) {
  const cts = airUs(p, CTS_BYTES)
  const data = airUs(p, p.payload_bytes + DATA_HEADER)
  const ack = airUs(p, ACK_BYTES)
  const rts = 3 * p.sifs_us + cts + data + ack
  return { rts, cts: rts - p.sifs_us - cts, data: p.sifs_us + ack, ack: 0 }
}

/** The state each node is in at time t, read from the trace: who is sending, and whose NAV is set. */
export function caAt(run: CaRun, t: number) {
  const onAir = run.airs.filter((a) => a.start_us <= t && t < a.end_us)
  const nav = run.navs.filter((n) => n.from_us <= t && t < n.until_us)
  return { onAir, nav }
}

/** The latest backoff counter of each node at or before t. */
export function backoffsAt(run: CaRun, nodes: number, t: number): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: nodes }, () => null)
  for (const e of run.events) {
    if (e.t > t) break
    out[e.node] = e.backoff
  }
  return out
}

// --- Scenarios -----------------------------------------------------------

export const ALOHA_BASE: AlohaParams = {
  slotted: false,
  stations: 6,
  g: 0.5,
  frame_us: 1000,
  length: 40,
  seed: 1,
}

/** The sweep runs fifty stations over 20,000 frame times per point. */
export const ALOHA_SWEEP: AlohaParams = { ...ALOHA_BASE, stations: 50, length: 20_000, trace: false }
export const SWEEP_GS = [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]

const station = (name: string, pos_m: number, o: Partial<CdStation> = {}): CdStation => ({
  name,
  pos_m,
  start_ns: 0,
  frames: 1,
  ...o,
})

const CD_BASE: Omit<CdParams, "stations"> = {
  rate_bps: 10_000_000,
  frame_bytes: 64,
  slot_bits: 512,
  jam_bits: 32,
  ifg_bits: 96,
  speed_mps: 200_000_000,
  attempt_limit: 16,
  backoff_cap: 10,
  duration_ns: 1_000_000,
  seed: 1,
}

/** Two stations 2 km apart with a frame each at the same moment. */
export const CD_TWO: CdParams = {
  ...CD_BASE,
  stations: [station("A", 0), station("B", 2000)],
}

/**
 * The worst case for detection: B, at the far end, starts just before A's
 * signal reaches it, so A hears B almost a full round trip after starting.
 */
export const CD_WORST: CdParams = {
  ...CD_BASE,
  stations: [station("A", 0), station("B", 2500, { start_ns: 12_400 })],
}

export const CD_SHORT: CdParams = { ...CD_WORST, frame_bytes: 20 }

export const CD_BUSY: CdParams = {
  ...CD_BASE,
  stations: ["A", "B", "C", "D", "E", "F"].map((n, i) => station(n, i * 500, { frames: 0 })),
  duration_ns: 2_000_000,
}

/** The sweep's bus: ten stations always ready, on 2500 m, 200 ms per point. */
export const CD_SWEEP: CdParams = {
  ...CD_BASE,
  stations: Array.from({ length: 10 }, (_, i) => station(`S${i}`, Math.round((i * 2500) / 9), { frames: 0 })),
  duration_ns: 200_000_000,
  trace: false,
}
export const SWEEP_BYTES = [32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1518]

const node = (name: string, x_m: number, y_m = 0): CaNode => ({ name, x_m, y_m })

const CA_BASE: Omit<CaParams, "nodes" | "flows"> = {
  range_m: 100,
  rts: false,
  rate_bps: 6_000_000,
  payload_bytes: 1000,
  slot_us: 9,
  sifs_us: 16,
  cw_min: 15,
  cw_max: 1023,
  attempt_limit: 7,
  preamble_us: 20,
  duration_us: 30_000,
  seed: 1,
}

/** Two stations that hear each other, sending to an access point. */
export const CA_SHARE: CaParams = {
  ...CA_BASE,
  nodes: [node("A", 0, 40), node("AP", 50, 0), node("C", 100, 40)],
  flows: [
    { from: 0, to: 1, frames: 4 },
    { from: 2, to: 1, frames: 4, start_us: 300 },
  ],
}

/** A and C each reach B but not each other. */
export const CA_HIDDEN: CaParams = {
  ...CA_BASE,
  nodes: [node("A", 0), node("B", 90), node("C", 180)],
  flows: [
    { from: 0, to: 1 },
    { from: 2, to: 1 },
  ],
  duration_us: 100_000,
}

export const CA_HIDDEN_RTS: CaParams = { ...CA_HIDDEN, rts: true }

/** B sends to A and C to D; B and C hear each other, but neither's receiver hears the other sender. */
export const CA_EXPOSED: CaParams = {
  ...CA_BASE,
  nodes: [node("A", 0), node("B", 90), node("C", 180), node("D", 270)],
  flows: [
    { from: 1, to: 0 },
    { from: 2, to: 3 },
  ],
  duration_us: 100_000,
}

/** One RTS/CTS exchange watched by D, who hears only the sender, and C, who hears only the receiver. */
export const CA_NAV: CaParams = {
  ...CA_BASE,
  rts: true,
  nodes: [node("D", -90), node("A", 0), node("B", 90), node("C", 180)],
  flows: [{ from: 1, to: 2, frames: 2 }],
  duration_us: 8_000,
}

export interface Preset {
  id: string
  mode: Mode
  title: string
  source: string
  note: string
  params: LinkParams
}

const aloha = (p: Partial<AlohaParams>): LinkParams => ({ mode: "aloha", aloha: { ...ALOHA_BASE, ...p } })
const cd = (p: CdParams): LinkParams => ({ mode: "csmacd", cd: p })
const ca = (p: CaParams): LinkParams => ({ mode: "csmaca", ca: p })

export const PRESETS: Preset[] = [
  {
    id: "pure",
    mode: "aloha",
    title: "Pure ALOHA at G = 0.5",
    source: "Abramson 1970; Kurose and Ross, Section 6.3.2",
    note: "Six stations send 1 ms frames whenever they like, half a frame per frame time between them. A frame is lost if any other starts within one frame time either side of it, a window of two frame times, so S = G e^(−2G) = 0.184 with many stations. Forty frame times is a small sample; the S against G tab runs 20,000 per point.",
    params: aloha({}),
  },
  {
    id: "slotted",
    mode: "aloha",
    title: "Slotted ALOHA at G = 1",
    source: "Roberts 1972; Kurose and Ross, Section 6.3.2",
    note: "The same stations, but frames may start only on slot boundaries. Two frames now collide only if they pick the same slot, so the vulnerable window halves to one frame time and S = G e^(−G), at most 1/e = 0.368 at G = 1. Watch for empty slots and collided ones: at the peak, about 37% of slots carry a frame, 37% are empty and 26% are wasted on collisions.",
    params: aloha({ slotted: true, g: 1 }),
  },
  {
    id: "overload",
    mode: "aloha",
    title: "Pure ALOHA overloaded, G = 2",
    source: "Abramson 1970",
    note: "Twice as many attempts as frame times. Nearly every frame overlaps another and S falls to G e^(−4) = 0.037: offering more load past the peak delivers less. A real ALOHA network with retransmissions can slide into this state and stay there unless stations back off.",
    params: aloha({ g: 2 }),
  },
  {
    id: "cd-two",
    mode: "csmacd",
    title: "Two stations collide and back off",
    source: "IEEE 802.3, Clause 4.2; Metcalfe and Boggs 1976",
    note: "A and B are 2 km apart, 10 µs at 2 × 10⁸ m/s, and both have a 64-byte frame at time 0. Both hear silence, wait the 9.6 µs gap and send; each hears the other 10 µs later, stops, and sends 32 bits of jam. After this first collision each picks K from {0, 1} and waits K × 51.2 µs.",
    params: cd(CD_TWO),
  },
  {
    id: "cd-worst",
    mode: "csmacd",
    title: "The worst case: detection takes a round trip",
    source: "IEEE 802.3, Clause 4.2.3.2.3; Tanenbaum and Wetherall, Section 4.2.2",
    note: "A, at one end of 2.5 km of cable, starts at 9.6 µs. B, at the other end, has a frame just before A's first bit arrives (τ = 12.5 µs later), so it too hears silence and sends. B hears A almost at once, but B's signal needs another τ to come back: A learns of the collision 24.9 µs after it started, just under 2τ. Its frame must still be on the wire then, or it would never know.",
    params: cd(CD_WORST),
  },
  {
    id: "cd-short",
    mode: "csmacd",
    title: "A frame too short to notice its collision",
    source: "IEEE 802.3, Clause 4.4.2 (minFrameSize)",
    note: "The same timing with 20-byte frames, 16 µs long. A finishes at 25.6 µs, before B's signal returns at 34.5 µs, so A hears nothing while sending and believes its frame got through, although it was garbled at B. This is why 10 Mb/s Ethernet requires frames of at least 64 bytes (512 bits): one slot time, longer than the worst round trip of a maximum-size network.",
    params: cd(CD_SHORT),
  },
  {
    id: "cd-busy",
    mode: "csmacd",
    title: "Six busy stations",
    source: "Metcalfe and Boggs 1976; IEEE 802.3, Clause 4.2.3.2.5",
    note: "Six stations on 2.5 km always have a 64-byte frame. Each success is followed by a scramble: every waiting station sends the moment the gap ends, they collide, and backoff sorts them out. The station that just won starts its next frame with a fresh range of {0, 1} while the losers' ranges have doubled, so winners tend to win again: the capture effect.",
    params: cd(CD_BUSY),
  },
  {
    id: "ca-share",
    mode: "csmaca",
    title: "Two stations share the air",
    source: "IEEE 802.11-2020, Section 10.3; Bianchi 2000",
    note: "A and C hear each other and both send to the access point. Every data frame is acknowledged a SIFS (16 µs) after it ends. A station that finds the medium busy draws a backoff of 0 to 15 slots of 9 µs and counts it down only while the medium is idle, after a DIFS (34 µs) of silence; when someone else starts, it freezes the count and keeps what is left.",
    params: ca(CA_SHARE),
  },
  {
    id: "ca-hidden",
    mode: "csmaca",
    title: "Hidden terminals",
    source: "Tobagi and Kleinrock 1975; Kurose and Ross, Section 7.3.1",
    note: "A and C are 180 m apart with a range of 100 m: each reaches B but cannot hear the other. Carrier sense tells them nothing, so they send over each other at B and most data frames are lost. Each loss costs a whole 1.4 ms frame and doubles the sender's window.",
    params: ca(CA_HIDDEN),
  },
  {
    id: "ca-hidden-rts",
    mode: "csmaca",
    title: "Hidden terminals with RTS/CTS",
    source: "Karn 1990 (MACA); Bharghavan et al. 1994 (MACAW); IEEE 802.11-2020, Section 10.3.2.4",
    note: "The same nodes, with every data frame preceded by a 20-byte RTS and answered by a 14-byte CTS from B. C cannot hear A's RTS but does hear B's CTS, and its duration field keeps C quiet until the ACK is over. Collisions now hit the short RTS frames instead of the data. A few data frames are still lost: C may be sending its own RTS while B's CTS is on the air, so it misses the CTS and later talks over A's data. Over these 100 ms A wins almost every exchange: once C has lost a few RTS frames its window is wide, and its counter, frozen through each of A's exchanges, drains only in the short gaps between them. Over a second the two share more evenly.",
    params: ca(CA_HIDDEN_RTS),
  },
  {
    id: "ca-exposed",
    mode: "csmaca",
    title: "Exposed terminals",
    source: "Bharghavan et al. 1994 (MACAW); Kurose and Ross, Section 7.3.1",
    note: "B sends to A and C sends to D. B and C hear each other, so each defers while the other sends, yet B's signal never reaches D and C's never reaches A: both could have sent at once. The needless-deferral figure counts the time each spent waiting for a frame it could have talked over. (Not entirely harmless: the ACKs coming back from A would collide with C's data at B, which is one reason 802.11 keeps carrier sense this cautious.)",
    params: ca(CA_EXPOSED),
  },
  {
    id: "ca-nav",
    mode: "csmaca",
    title: "Virtual carrier sense: the NAV",
    source: "IEEE 802.11-2020, Sections 10.3.2.4 and 10.3.1.2.1",
    note: "A sends two frames to B with RTS/CTS. D hears only A; C hears only B. Each frame carries a duration field: how much longer the exchange will hold the medium. D sets its NAV from A's RTS, C from B's CTS, and both NAVs end exactly as the ACK does, although neither can hear the whole exchange.",
    params: ca(CA_NAV),
  },
]

export interface TourStep {
  preset: string
  /** The moment to show, in the model's unit. */
  at: number
  text: string
}

export const TOUR: TourStep[] = [
  {
    preset: "pure",
    at: 12_000,
    text: "Pure ALOHA: stations send whenever they have a frame. Red frames overlapped another, even by a microsecond, and both are lost. The shaded band around the selected frame is its vulnerable window: two frame times wide.",
  },
  {
    preset: "slotted",
    at: 12_000,
    text: "Slotted ALOHA: frames start only on slot boundaries, so they either coincide exactly or not at all. The vulnerable window is one slot, and the peak throughput doubles, to 1/e.",
  },
  {
    preset: "cd-two",
    at: 19_600,
    text: "CSMA/CD: both stations heard silence and sent. Each signal spreads along the cable at 2 × 10⁸ m/s; 10 µs later each station hears the other, stops, and jams. In the space-time diagram time runs down the page and each transmission is a band widening as it travels.",
  },
  {
    preset: "cd-worst",
    at: 34_500,
    text: "The worst case. B started just before A's signal arrived; B's signal takes another τ to come back. A hears the collision 2τ after starting, which is why a frame must last at least a round trip.",
  },
  {
    preset: "cd-short",
    at: 34_500,
    text: "With 20-byte frames A had already finished when the collision reached it. It counts the frame as sent; at B it was garbled. Nothing at the link layer will ever retransmit it.",
  },
  {
    preset: "ca-share",
    at: 3_500,
    text: "CSMA/CA: no station can hear a collision while it is sending, so every data frame is acknowledged instead. The waiting station's backoff counter freezes while the medium is busy and resumes after a DIFS of silence.",
  },
  {
    preset: "ca-hidden",
    at: 3_000,
    text: "Hidden terminals: A and C cannot hear each other, so carrier sense never stops them. Their frames overlap at B and both are lost.",
  },
  {
    preset: "ca-hidden-rts",
    at: 3_000,
    text: "With RTS/CTS, B's CTS reaches C too. Its duration field sets C's NAV, the striped bar, and C stays quiet until the ACK. Collisions still happen, but between 20-byte RTS frames, not 1028-byte data frames.",
  },
  {
    preset: "ca-exposed",
    at: 3_000,
    text: "Exposed terminals: C defers to B although C's receiver, D, cannot hear B at all. The fix for hidden terminals, listen harder, makes this worse.",
  },
]

export interface LabTask {
  id: string
  difficulty: 1 | 2 | 3
  title: string
  task: string
  hint: string
  start: LinkParams
  check(p: LinkParams, run: LinkRun): { ok: boolean; message: string }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const LABS: LabTask[] = [
  {
    id: "find-the-peak",
    difficulty: 2,
    title: "Find the best load for two stations",
    task: "With only two stations, pure ALOHA does not peak at G = 0.5. Change only G so that this model's exact throughput for two stations is within 0.2% of its maximum.",
    hint: "The equation card shows the exact S for this many stations beside the Poisson limit. Try values either side of 0.5 and close in. Which side is the peak on, and why might fewer rivals move it?",
    start: aloha({ stations: 2 }),
    check(p) {
      if (p.mode !== "aloha" || !same({ ...p.aloha, g: 0 }, { ...ALOHA_BASE, stations: 2, g: 0 }))
        return { ok: false, message: "Stay with pure ALOHA and two stations; change only G." }
      const peak = alohaPeak(false, 2)
      const s = alohaExact(false, 2, p.aloha.g)
      return s >= peak.s * 0.998
        ? {
            ok: true,
            message: `G = ${p.aloha.g}: S = ${s.toFixed(4)}, against the best ${peak.s.toFixed(4)} at G = 2 − √2 ≈ ${peak.g.toFixed(3)}. Each station must be silent between its own frames, so with few stations the traffic is more regular than Poisson: a frame has fewer rivals, the peak moves right and rises above 1/(2e) ≈ 0.184. Slotted ALOHA, by contrast, peaks at exactly G = 1 for any number of stations.`,
          }
        : { ok: false, message: `S = ${s.toFixed(4)}; the maximum is higher.` }
    },
  },
  {
    id: "min-frame",
    difficulty: 2,
    title: "Make every collision audible",
    task: "In the short-frame scenario A never learns its frame collided. Change only the frame size to the smallest whole number of bytes that guarantees, for any timing on this bus, that a sender is still transmitting when a collision reaches it.",
    hint: "The worst case takes a full round trip, 2τ. How long is the bus in time, and how many bits does 10 Mb/s send in that long?",
    start: cd(CD_SHORT),
    check(p, run) {
      if (p.mode !== "csmacd" || run.mode !== "csmacd" || !same({ ...p.cd, frame_bytes: 0 }, { ...CD_SHORT, frame_bytes: 0 }))
        return { ok: false, message: "Keep the bus and its stations; change only the frame size." }
      const need = minFrameBytes(p.cd)
      const s = run.run.stats
      if (p.cd.frame_bytes < need)
        return {
          ok: false,
          message: `${p.cd.frame_bytes} bytes last ${fmtTime(s.frame_ns, "csmacd")}, shorter than the round trip 2τ = ${fmtTime(2 * s.tau_ns, "csmacd")}.`,
        }
      if (p.cd.frame_bytes > need) return { ok: false, message: `${p.cd.frame_bytes} bytes are enough, but not the smallest.` }
      return {
        ok: true,
        message: `${need} bytes = ${need * 8} bits = ${fmtTime(s.frame_ns, "csmacd")} ≥ 2τ = ${fmtTime(2 * s.tau_ns, "csmacd")}, and A now hears the collision while still sending. Real Ethernet uses 64 bytes because its maximum network, with repeaters, has a round trip of up to 512 bit times.`,
      }
    },
  },
  {
    id: "cure-hidden",
    difficulty: 1,
    title: "Cure the hidden terminals",
    task: "In the hidden-terminal scenario most data frames are lost. Without moving any node or changing the radio's range, get the data-frame loss below 5%.",
    hint: "A and C cannot hear each other, so neither can tell when the other is sending. Who can hear both of them, and how could that node speak for them?",
    start: ca(CA_HIDDEN),
    check(p, run) {
      if (p.mode !== "csmaca" || run.mode !== "csmaca") return { ok: false, message: "Stay with CSMA/CA." }
      const keep = (c: CaParams) => ({ ...c, rts: false })
      if (!same(keep(p.ca), keep(CA_HIDDEN))) return { ok: false, message: "Keep the nodes, their range and the flows as they are." }
      const loss = run.run.stats.data_loss
      if (loss >= 0.05) return { ok: false, message: `${(100 * loss).toFixed(1)}% of data frames are lost.` }
      return {
        ok: true,
        message: `Data loss ${(100 * loss).toFixed(1)}% with RTS/CTS. B's CTS tells C how long to stay quiet. (Enlarging the range so that A and C hear each other also ends the hidden-terminal collisions, but leaves the ones between stations that pick the same slot, and each of those costs a whole data frame: with RTS/CTS it costs only an RTS.)`,
      }
    },
  },
  {
    id: "unexpose",
    difficulty: 3,
    title: "Set the exposed terminals free",
    task: "In the exposed-terminal scenario, move nodes (but keep every receiver within range of its sender) so that both flows deliver at least 40 frames each and neither sender spends more than 5% of the run deferring needlessly.",
    hint: "Each sender defers because it hears the other sender. What is the least distance B and C must be apart, and where must A and D then be?",
    start: ca(CA_EXPOSED),
    check(p, run) {
      if (p.mode !== "csmaca" || run.mode !== "csmaca") return { ok: false, message: "Stay with CSMA/CA." }
      const keep = (c: CaParams) => ({ ...c, nodes: c.nodes.map((v) => v.name) })
      if (!same(keep(p.ca), keep(CA_EXPOSED))) return { ok: false, message: "Only move nodes." }
      if (!p.ca.flows.every((f) => caNear(p.ca, f.from, f.to))) return { ok: false, message: "A receiver is out of its sender's range." }
      const fl = run.run.stats.flows
      const worst = Math.max(...fl.map((f) => f.needless_us)) / p.ca.duration_us
      if (fl.some((f) => f.delivered < 40)) return { ok: false, message: `Delivered ${fl.map((f) => f.delivered).join(" and ")} frames.` }
      if (worst > 0.05) return { ok: false, message: `A sender defers needlessly for ${(100 * worst).toFixed(0)}% of the run.` }
      return {
        ok: true,
        message: `Delivered ${fl.map((f) => f.delivered).join(" and ")} frames. With B and C out of each other's range both send at once, and neither receiver hears the other sender, so nothing collides.`,
      }
    },
  },
]

/** The preset a scenario id names, or the first preset of the mode. */
export const presetFor = (id: string) => PRESETS.find((p) => p.id === id)
