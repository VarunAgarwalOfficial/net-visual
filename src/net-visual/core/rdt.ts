// Typed API for the reliable-data-transfer model (crates/netsim/src/rdt.rs),
// with the presets, the guided tour and the lab checks that use it.
import type { Netsim } from "./netsim"

export type AckMode = "cumulative" | "individual"
export type TimerMode = "single" | "each"
export type Resend = "all" | "one"
export interface Rules {
  buffer: boolean
  ack: AckMode
  timer: TimerMode
  resend: Resend
}
export type Kind = "data" | "ack"
export interface Intervention {
  kind: Kind
  number: number
  occurrence: number
  action: "drop" | "keep" | "delay"
  delay_us: number
}
export interface RdtParams {
  rules: Rules
  window: number
  seq_bits: number
  messages: number
  data_bytes: number
  ack_bytes: number
  rate_bps: number
  prop_us: number
  jitter_us: number
  timeout_us: number
  loss_data: number
  loss_ack: number
  seed: number
  interventions: Intervention[]
}
export interface Flight {
  id: number
  kind: Kind
  wire: number
  number: number
  occurrence: number
  t_start: number
  t_sent: number
  t_arrive: number
  lost: boolean
  fate: string
}
export interface Snapshot {
  sender: string
  receiver: string
  base: number
  next: number
  rcv_base: number
  timers: [number, number][]
}
export interface RdtEvent {
  t: number
  who: "S" | "R"
  step: string
  text: string
  flight: number | null
  state: Snapshot
}
export interface Totals {
  completion_us: number
  transmissions: number
  retransmissions: number
  timeouts: number
  delivered: number
  misdelivered: number
  correct: boolean
  finished: boolean
  utilisation: number
  goodput_bps: number
}
export interface Theory {
  t_data_us: number
  t_ack_us: number
  rtt_us: number
  slot_us: number
  q_success: number
  link_bound: number
  window_bound: number
  bound: number
  stallings_sw: number
  stallings_gbn: number
  stallings_sr: number
  window_to_fill: number
  seq_space: number
  safe_window: number
}
export interface RdtRun {
  flights: Flight[]
  events: RdtEvent[]
  totals: Totals
  theory: Theory
}

export const GO_BACK_N: Rules = { buffer: false, ack: "cumulative", timer: "single", resend: "all" }
export const SELECTIVE_REPEAT: Rules = { buffer: true, ack: "individual", timer: "each", resend: "one" }

export function protocolName(p: Pick<RdtParams, "rules" | "window">): string {
  const r = p.rules
  const same = (a: Rules) => a.buffer === r.buffer && a.ack === r.ack && a.timer === r.timer && a.resend === r.resend
  if (same(GO_BACK_N)) return p.window === 1 ? "Stop-and-wait" : "Go-Back-N"
  if (same(SELECTIVE_REPEAT)) return p.window === 1 ? "Stop-and-wait" : "Selective Repeat"
  return "Custom rules"
}

export const runRdt = (sim: Netsim, p: RdtParams) => sim.call<RdtRun>("rdt", "run", p)
export const sweepRdt = (sim: Netsim, base: RdtParams, losses: number[]) =>
  sim.call<[number, number, number, number][]>("rdt", "sweep", { base, losses })

const drop = (kind: Kind, number: number, occurrence = 1): Intervention => ({
  kind,
  number,
  occurrence,
  action: "drop",
  delay_us: 0,
})

/** A readable ladder: 1 Mb/s, 1000-byte packets (8 ms), 15 ms each way. */
export const BASE: RdtParams = {
  rules: GO_BACK_N,
  window: 1,
  seq_bits: 1,
  messages: 4,
  data_bytes: 1000,
  ack_bytes: 40,
  rate_bps: 1_000_000,
  prop_us: 15_000,
  jitter_us: 0,
  timeout_us: 50_000,
  loss_data: 0,
  loss_ack: 0,
  seed: 1,
  interventions: [],
}

export interface Preset {
  id: string
  title: string
  source: string
  note: string
  params: RdtParams
}

const pipe = { ...BASE, messages: 12, seq_bits: 3, window: 4 }

export const PRESETS: Preset[] = [
  {
    id: "sw-clean",
    title: "Stop-and-wait, no loss",
    source: "Kurose and Ross, Fig. 3.16(a)",
    note: "One packet, one ACK, one round trip each. The alternating bit (sequence numbers 0 and 1) is enough.",
    params: { ...BASE },
  },
  {
    id: "sw-lost-packet",
    title: "Stop-and-wait, lost packet",
    source: "Kurose and Ross, Fig. 3.16(b)",
    note: "Packet 1 is lost. Only the timer tells the sender; it resends after the timeout.",
    params: { ...BASE, interventions: [drop("data", 1)] },
  },
  {
    id: "sw-lost-ack",
    title: "Stop-and-wait, lost ACK",
    source: "Kurose and Ross, Fig. 3.16(c)",
    note: "The ACK for packet 1 is lost. The receiver gets a duplicate, recognises the sequence number, and acknowledges again.",
    params: { ...BASE, interventions: [drop("ack", 1)] },
  },
  {
    id: "sw-premature",
    title: "Stop-and-wait, premature timeout",
    source: "Kurose and Ross, Fig. 3.16(d)",
    note: "The ACK for packet 1 is delayed past the timeout. The sender resends; the late ACK and the duplicate ACK both arrive, and the duplicate is ignored.",
    params: {
      ...BASE,
      interventions: [{ kind: "ack", number: 1, occurrence: 1, action: "delay", delay_us: 25_000 }],
    },
  },
  {
    id: "sw-continent",
    title: "Stop-and-wait across a continent",
    source: "Kurose and Ross, Section 3.4.2",
    note: "1 Gb/s, 1000-byte packets, 30 ms round trip: the link is busy 8 microseconds out of every 30 milliseconds, U = 0.00027.",
    params: {
      ...BASE,
      rate_bps: 1_000_000_000,
      ack_bytes: 0,
      timeout_us: 40_000,
      messages: 6,
    },
  },
  {
    id: "gbn",
    title: "Go-Back-N in operation",
    source: "Kurose and Ross, Fig. 3.22",
    note: "Window 4, packet 2 lost. The receiver discards 3, 4 and 5 because they are out of order; the timeout resends the whole window.",
    params: { ...pipe, interventions: [drop("data", 2)] },
  },
  {
    id: "sr",
    title: "Selective Repeat in operation",
    source: "Kurose and Ross, Fig. 3.26",
    note: "Window 4, packet 2 lost. The receiver buffers 3, 4 and 5; only packet 2 is resent.",
    params: { ...pipe, rules: SELECTIVE_REPEAT, interventions: [drop("data", 2)] },
  },
  {
    id: "sr-dilemma",
    title: "Selective Repeat with too large a window",
    source: "Kurose and Ross, Fig. 3.27",
    note: "Sequence numbers 0 to 3 and a window of 3. All three ACKs are lost; the resent packet 0 falls inside the receiver's new window and is accepted as message 4.",
    params: {
      ...pipe,
      rules: SELECTIVE_REPEAT,
      seq_bits: 2,
      window: 3,
      messages: 6,
      interventions: [drop("ack", 0), drop("ack", 1), drop("ack", 2)],
    },
  },
  {
    id: "reorder",
    title: "A reordering channel",
    source: "Jitter larger than the packet spacing",
    note: "Each packet takes 15 to 35 ms. Packets overtake each other; Go-Back-N throws the early ones away, so try switching to Selective Repeat.",
    params: { ...pipe, messages: 16, jitter_us: 20_000, timeout_us: 90_000, seed: 3 },
  },
  {
    id: "lossy-pipe",
    title: "Long lossy pipe: Go-Back-N against Selective Repeat",
    source: "Stallings, Data and Computer Communications, Section 7.3",
    note: "10 Mb/s, window 16, 10% loss. Compare the utilisation with the two formulas, then switch protocol.",
    params: {
      ...BASE,
      rate_bps: 10_000_000,
      window: 16,
      seq_bits: 8,
      messages: 300,
      loss_data: 0.1,
      timeout_us: 40_000,
      seed: 7,
    },
  },
]

export interface TourStep {
  preset: string
  /** Fraction of the run's duration to show. */
  at: number
  text: string
}

export const TOUR: TourStep[] = [
  {
    preset: "sw-clean",
    at: 0.12,
    text: "A sender and a receiver, 15 ms of wire apart. The sender puts packet 0 on the wire (8 ms at 1 Mb/s) and then can only wait.",
  },
  {
    preset: "sw-clean",
    at: 0.3,
    text: "The receiver delivers the data and returns an ACK. One packet per round trip: that is stop-and-wait.",
  },
  {
    preset: "sw-lost-packet",
    at: 0.5,
    text: "Now the channel loses packet 1. Nothing arrives, so nothing tells the sender. Watch the timer bar above packet 1 run out.",
  },
  {
    preset: "sw-lost-ack",
    at: 0.62,
    text: "Here the ACK is lost instead. The resent packet is a duplicate; its sequence number lets the receiver see that, drop it, and acknowledge again.",
  },
  {
    preset: "sw-continent",
    at: 0.2,
    text: "Correct, but slow. Across a continent at 1 Gb/s a packet takes 8 microseconds to send and 30 ms to be acknowledged. The thin bar at the top of each round trip is all the work done.",
  },
  {
    preset: "gbn",
    at: 0.35,
    text: "Pipelining: allow N packets in flight. With Go-Back-N the receiver only takes packets in order, so one loss costs the whole window.",
  },
  {
    preset: "sr",
    at: 0.35,
    text: "Selective Repeat keeps the good packets and resends only the lost one, at the price of a buffer and a timer per packet.",
  },
  {
    preset: "sr-dilemma",
    at: 0.75,
    text: "Sequence numbers are finite. With numbers 0 to 3 and a window of 3, the receiver cannot tell a resent old packet 0 from a new one. The red box is data delivered as the wrong message.",
  },
]

export interface LabTask {
  id: string
  difficulty: 1 | 2 | 3
  title: string
  task: string
  hint: string
  start: RdtParams
  check(p: RdtParams, run: RdtRun, sim: Netsim): { ok: boolean; message: string }
}

const sameExcept = (a: RdtParams, b: RdtParams, keys: (keyof RdtParams)[]) =>
  (Object.keys(a) as (keyof RdtParams)[]).every(
    (k) => keys.includes(k) || JSON.stringify(a[k]) === JSON.stringify(b[k]),
  )

const fillStart: RdtParams = {
  ...BASE,
  rules: SELECTIVE_REPEAT,
  rate_bps: 10_000_000,
  data_bytes: 1250,
  prop_us: 10_000,
  timeout_us: 40_000,
  seq_bits: 8,
  window: 1,
  messages: 400,
}
const divergeStart: RdtParams = {
  ...BASE,
  rate_bps: 10_000_000,
  window: 32,
  seq_bits: 8,
  messages: 600,
  timeout_us: 40_000,
  seed: 11,
}

export const LABS: LabTask[] = [
  {
    id: "fill",
    difficulty: 1,
    title: "Fill the pipe",
    task: "Selective Repeat on a 10 Mb/s link, 1250-byte packets, 10 ms each way, no loss. Choose the smallest window that keeps the link at least 90% busy in theory. Change only the window.",
    hint: "A window is used up for t + RTT + t_ack. How many transmission times t fit in that?",
    start: fillStart,
    check(p, run) {
      if (!sameExcept(p, fillStart, ["window", "seed"])) return { ok: false, message: "Change only the window." }
      const need = Math.ceil(0.9 * run.theory.window_to_fill - 1e-9)
      if (p.window === need)
        return {
          ok: true,
          message: `Right: N = ${need}. Bound ${fmt(run.theory.bound)}, measured ${fmt(run.totals.utilisation)}; the measured value is lower because the last window is not full.`,
        }
      return {
        ok: false,
        message: p.window < need ? "Not yet 90% in theory." : "That works, but a smaller window does too.",
      }
    },
  },
  {
    id: "diverge",
    difficulty: 2,
    title: "When does Go-Back-N fall to half?",
    task: "Window 32 on a 10 Mb/s link. Find a data loss rate at which Selective Repeat's measured utilisation is twice Go-Back-N's (within 10%). Change only the loss rate; the check runs both protocols.",
    hint: "With a full window Stallings gives U_SR / U_GBN = 1 + 2ap. What is a here? Then try nearby values: one run is noisy.",
    start: divergeStart,
    check(p, _run, sim) {
      if (!sameExcept(p, divergeStart, ["loss_data", "rules"]))
        return { ok: false, message: "Change only the loss rate." }
      const gbn = runRdt(sim, { ...p, rules: GO_BACK_N }).totals.utilisation
      const sr = runRdt(sim, { ...p, rules: SELECTIVE_REPEAT }).totals.utilisation
      const ratio = sr / gbn
      const ok = ratio >= 1.8 && ratio <= 2.2
      return {
        ok,
        message: `At p = ${p.loss_data}: Selective Repeat ${fmt(sr)}, Go-Back-N ${fmt(gbn)}, ratio ${ratio.toFixed(2)}.${ok ? "" : " Aim for 2."}`,
      }
    },
  },
  {
    id: "wrong-data",
    difficulty: 2,
    title: "Make Selective Repeat deliver the wrong data",
    task: "Starting from Selective Repeat with a 2-bit sequence number, choose a window and drop packets (click a packet in the diagram, then press D) until the receiver delivers a packet as the wrong message.",
    hint: "The receiver's window after a full window is received, and the sender's window if no ACK gets back: can they share a sequence number?",
    start: { ...pipe, rules: SELECTIVE_REPEAT, seq_bits: 2, window: 2, messages: 8 },
    check(p, run) {
      if (p.rules.buffer !== true || p.seq_bits !== 2)
        return { ok: false, message: "Keep Selective Repeat and 2-bit sequence numbers." }
      return run.totals.misdelivered > 0
        ? { ok: true, message: `Done: window ${p.window} > 2^(k-1) = 2, ${run.totals.misdelivered} message(s) delivered wrongly.` }
        : { ok: false, message: "Every message arrived as itself." }
    },
  },
  {
    id: "gbn-wrong",
    difficulty: 3,
    title: "Break Go-Back-N too",
    task: "Go-Back-N with 2-bit sequence numbers is safe for windows up to 3. Show that a window of 4 is not: make the receiver accept an old packet as new.",
    hint: "Go-Back-N's receiver window is 1, so it confuses packets that are exactly 2^k apart.",
    start: { ...pipe, seq_bits: 2, window: 3, messages: 8 },
    check(p, run) {
      if (p.rules.buffer || p.seq_bits !== 2) return { ok: false, message: "Keep Go-Back-N and 2-bit sequence numbers." }
      return run.totals.misdelivered > 0
        ? { ok: true, message: `Done: with N = ${p.window} >= 2^k the receiver cannot tell rounds apart.` }
        : { ok: false, message: "Every message arrived as itself." }
    },
  },
  {
    id: "timeout",
    difficulty: 3,
    title: "The smallest safe timeout",
    task: "Stop-and-wait, no loss, but each trip takes 15 to 25 ms. Find the smallest timeout (to within 1 ms) that never retransmits for any delay in that range.",
    hint: "The worst case is the longest data trip plus the longest ACK trip, plus both transmission times. Check it with several seeds.",
    start: { ...BASE, messages: 40, seq_bits: 1, jitter_us: 10_000, timeout_us: 30_000 },
    check(p, run) {
      if (p.jitter_us !== 10_000 || p.prop_us !== 15_000 || p.loss_data > 0 || p.loss_ack > 0)
        return { ok: false, message: "Keep the delay range and no loss." }
      const worst = run.theory.t_data_us + run.theory.t_ack_us + 2 * (p.prop_us + p.jitter_us)
      if (p.timeout_us < worst)
        return {
          ok: false,
          message: `${run.totals.retransmissions} retransmissions in this run${run.totals.retransmissions === 0 ? ", but an unlucky seed would cause one" : ""}.`,
        }
      return p.timeout_us - worst <= 1000
        ? { ok: true, message: `Right: T >= t + t_ack + 2(d + J) = ${(worst / 1000).toFixed(2)} ms.` }
        : { ok: false, message: "Safe, but it can be smaller." }
    },
  },
]

export const fmt = (x: number) => (x >= 0.01 || x === 0 ? x.toFixed(3) : x.toExponential(2))
