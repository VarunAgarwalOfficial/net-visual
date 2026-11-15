// Types and helpers for error detection and correction
// (crates/netsim/src/coding.rs): CRCs by GF(2) long division and Hamming
// codes. Erasable TypeScript only, so Node can run it in tests.
import type { Netsim } from "./netsim.ts"

// --- CRC -------------------------------------------------------------------

export interface CrcParams {
  /** Bits, most significant first. */
  message: string
  /** Bits from x^r down to x^0. */
  generator: string
  /** Codeword positions flipped in transit, counted from 0 at the left. */
  flips: number[]
  /** Text whose standard CRCs are listed. */
  text: string
}

export interface CrcEvent {
  t: number
  step: string
  phase: "send" | "check"
  pos: number | null
  bits: string
  quotient: string
  what: "pad" | "xor" | "send" | "receive" | "accept" | "reject"
}

export interface BurstStat {
  len: number
  patterns: number
  undetected: number
}

export interface CrcRun {
  events: CrcEvent[]
  remainder: string
  codeword: string
  error: string
  received: string
  syndrome: string
  detected: boolean
  props: { r: number; n: number; weight: BurstStat[]; plus_one: boolean; bursts: BurstStat[] }
  standard: { name: string; width: number; value: number; check: number }[]
}

export const runCrc = (sim: Netsim, p: CrcParams) => sim.call<CrcRun>("link", "crc", p)

/** Generators the page offers, as bit strings from x^r down. */
export const GENERATORS: { id: string; name: string; bits: string }[] = [
  { id: "x3", name: "x³ + x + 1", bits: "1011" },
  { id: "x4", name: "x⁴ + x + 1", bits: "10011" },
  { id: "x4p", name: "x⁴ + x³ + x² + 1 = (x + 1)(x³ + x + 1)", bits: "11101" },
  { id: "crc8", name: "CRC-8: x⁸ + x² + x + 1", bits: "100000111" },
  { id: "crc16", name: "CRC-16-CCITT: x¹⁶ + x¹² + x⁵ + 1", bits: "10001000000100001" },
  { id: "crc32", name: "CRC-32 (IEEE 802.3)", bits: "100000100110000010001110110110111" },
]

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹"
const sup = (k: number) => [...String(k)].map((d) => SUP[+d]).join("")

/** A bit string as a polynomial in x, highest power first. */
export function polyText(bits: string, tex = false): string {
  const n = bits.length
  const terms: string[] = []
  for (let i = 0; i < n; i++) {
    if (bits[i] !== "1") continue
    const k = n - 1 - i
    terms.push(k === 0 ? "1" : k === 1 ? "x" : tex ? `x^{${k}}` : `x${sup(k)}`)
  }
  return terms.length ? terms.join(" + ") : "0"
}

/** The bits of an ASCII string, eight per character. */
export const asciiBits = (s: string) => [...s].map((c) => (c.charCodeAt(0) & 0xff).toString(2).padStart(8, "0")).join("")

/** Positions of the 1s in an error pattern, or a burst of `len` ones starting at `at`. */
export const burst = (at: number, len: number) => Array.from({ length: len }, (_, i) => at + i)

export const hex = (v: number, width: number) =>
  `0x${v
    .toString(16)
    .toUpperCase()
    .padStart(Math.ceil(width / 4), "0")}`

// --- Hamming ---------------------------------------------------------------

export interface HammingParams {
  r: number
  secded: boolean
  data: string
  flips: number[]
}

export interface HammingEvent {
  t: number
  step: string
  what: string
  pos: number | null
  value: number
  covers: number[]
}

export interface WeightStat {
  w: number
  patterns: number
  right: number
  detected: number
  wrong: number
}

export interface HammingRun {
  n: number
  k: number
  codeword: number[]
  received: number[]
  syndrome: number
  overall: number
  verdict: "clean" | "corrected" | "detected"
  corrected: number[]
  decoded: number[]
  data_ok: boolean
  events: HammingEvent[]
  by_weight: WeightStat[]
  min_distance: number | null
}

export const runHamming = (sim: Netsim, p: HammingParams) => sim.call<HammingRun>("link", "hamming", p)

export const hammingN = (r: number) => 2 ** r - 1
export const hammingK = (r: number) => 2 ** r - 1 - r
export const isParity = (j: number) => j > 0 && (j & (j - 1)) === 0

const choose = (n: number, k: number) => {
  let c = 1
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1)
  return c
}

/**
 * Chances, for independent bit errors with probability q, that a block's
 * data is decoded wrong without warning, or reported. Weights above four were
 * not enumerated; their whole probability is counted as wrong, so `wrong` is
 * an upper bound.
 */
export function blockOdds(run: HammingRun, secded: boolean, q: number): { wrong: number; detected: number; uncoded: number } {
  const m = run.n + (secded ? 1 : 0)
  let wrong = 0
  let detected = 0
  let seen = 0
  for (const s of run.by_weight) {
    const pw = q ** s.w * (1 - q) ** (m - s.w)
    wrong += s.wrong * pw
    detected += s.detected * pw
    seen += choose(m, s.w) * pw
  }
  return { wrong: wrong + Math.max(0, 1 - seen), detected, uncoded: 1 - (1 - q) ** run.k }
}
