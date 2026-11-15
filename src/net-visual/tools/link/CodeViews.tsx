// Words, numbers, charts, tables and settings for the two coding modes: CRCs
// by long division and Hamming codes.
import { memo, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ParamSlider, ParamSwitch } from "../../components/Controls"
import type { Series } from "../../components/LineChart"
import { Tex } from "../../components/Tex"
import {
  GENERATORS,
  asciiBits,
  blockOdds,
  hammingK,
  hammingN,
  hex,
  isParity,
  polyText,
  type CrcParams,
  type CrcRun,
  type HammingParams,
  type HammingRun,
} from "../../core/coding"
import { Card, Group, Row, TH, type LinkChart } from "./LinkViews"

const list = (xs: (string | number)[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)
const genName = (bits: string) => GENERATORS.find((g) => g.bits === bits)?.name ?? polyText(bits)

// --- CRC -------------------------------------------------------------------

export function crcText(p: CrcParams, run: CrcRun, i: number): string {
  const e = run.events[i]
  const r = p.generator.length - 1
  const ones = [...run.error].flatMap((b, j) => (b === "1" ? [j] : []))
  switch (e.what) {
    case "pad":
      return `The message has ${p.message.length} bits. The sender appends r = ${r} zeros, one for each bit of the remainder to come: this multiplies M(x) by x^${r}.`
    case "xor": {
      const left = e.bits.slice(e.pos!, e.pos! + r + 1)
      return `The leftmost 1 still standing is in column ${e.pos! + 1}. Write 1 in the quotient there and subtract G = ${p.generator} under it. Subtraction in GF(2) is XOR, with no borrows, so those ${r + 1} bits become ${left}.`
    }
    case "send":
      return `Fewer than ${r + 1} bits are left after the last 1, so the division stops. The remainder is ${run.remainder}. It replaces the zeros, and the sender transmits ${run.codeword}, which G divides exactly.`
    case "receive":
      return ones.length
        ? `${ones.length} bit${ones.length > 1 ? "s" : ""} flip in transit, in column${ones.length > 1 ? "s" : ""} ${list(ones.map((j) => j + 1))}. What arrives is the codeword plus the error pattern E(x) = ${polyText(run.error)}.`
        : "Nothing flips in transit: the receiver gets exactly what was sent."
    case "accept":
      return ones.length
        ? `The remainder is zero, so the receiver accepts the frame. But it was damaged: E(x) = ${polyText(run.error)} is itself a multiple of G(x), and adding a multiple of G changes nothing mod G. This error is invisible to this CRC.`
        : "The remainder is zero, so the receiver accepts the frame. G divided the codeword exactly, and nothing was added to it."
    case "reject":
      return `The remainder is ${e.bits}, not zero. The receiver knows the frame was damaged, though not where, and discards it. Recovery is left to retransmission.`
  }
}

export const crcWho = (_p: CrcParams, run: CrcRun, i: number) => (run.events[i].phase === "send" ? "the sender" : "the receiver")

export const CrcTotals = memo(function CrcTotals({ p, run }: { p: CrcParams; run: CrcRun }) {
  const w = [...run.error].filter((b) => b === "1").length
  const span = w ? run.error.lastIndexOf("1") - run.error.indexOf("1") + 1 : 0
  return (
    <>
      <Row k="message, check bits" v={`${p.message.length} + ${run.props.r} bits`} />
      <Row k="remainder (the CRC)" v={run.remainder} />
      <Row k="bits flipped" v={w ? `${w}, spanning ${span}` : "none"} bad={w > 0} />
      <Row k="receiver's remainder" v={run.syndrome} bad={run.syndrome.includes("1")} />
      <Row k="verdict" v={!w ? "accepted, correctly" : run.detected ? "error detected" : "error missed"} bad={w > 0 && !run.detected} />
      <Row k="G has the factor x + 1" v={run.props.plus_one ? "yes: every odd error caught" : "no"} />
    </>
  )
})

export function CrcEquations({ p, run, index }: { p: CrcParams; run: CrcRun; index: number }) {
  const r = run.props.r
  const e = run.events[Math.min(index, run.events.length - 1)]
  const q = run.events.find((x) => x.what === "send")!.quotient
  const short = p.message.length + r <= 40
  const err = run.error.includes("1")
  return (
    <Card title="A CRC is the remainder of a polynomial division over GF(2)">
      <Tex display>{`G(x) = ${polyText(p.generator, true)},\\quad r = ${r}`}</Tex>
      {short ? (
        <Tex
          display
        >{`\\underbrace{${polyText(p.message + "0".repeat(r), true)}}_{M(x)\\,x^{${r}}} = \\underbrace{(${polyText(q, true)})}_{Q(x)}\\,G(x) + \\underbrace{${polyText(run.remainder, true)}}_{R(x)}`}</Tex>
      ) : (
        <Tex
          display
        >{`M(x)\\,x^{${r}} = Q(x)\\,G(x) + R(x),\\quad R = ${run.remainder.length > 16 ? `\\texttt{${hex(parseInt(run.remainder, 2), r)}}` : `\\texttt{${run.remainder}}`}`}</Tex>
      )}
      <Tex display>{`T(x) = M(x)\\,x^{${r}} + R(x) \\equiv 0 \\pmod{G(x)}`}</Tex>
      {e.phase === "check" && (
        <Tex
          display
        >{`\\big(T(x) + E(x)\\big) \\bmod G(x) = E(x) \\bmod G(x) = ${err ? (run.detected ? `\\texttt{${run.syndrome}} \\ne 0` : "0") : "0"}${err && short ? `,\\quad E(x) = ${polyText(run.error, true)}` : ""}`}</Tex>
      )}
      <p className="font-sans text-xs text-muted-foreground">
        Addition and subtraction are the same operation, XOR, so there are no carries or borrows. An error goes unseen exactly when its
        polynomial is a multiple of G. Any G with r check bits and a constant term catches every burst of length r or less.
      </p>
    </Card>
  )
}

/** Fraction of bursts of each length that this generator misses, from the model's exhaustive count. */
export function crcChart(run: CrcRun): LinkChart {
  const r = run.props.r
  const pts = run.props.bursts.map((b): [number, number] => [b.len, b.undetected / b.patterns])
  const top = Math.max(2 ** -(r - 1), ...pts.map(([, y]) => y))
  return {
    title: "Bursts this generator misses, by burst length",
    series: [{ id: "b", label: `fraction undetected (${run.props.n}-bit codeword)`, color: "var(--chart-1)", kind: "dots", points: pts }],
    xLabel: "burst length (first to last flipped bit)",
    yLabel: "fraction missed",
    xFormat: (v) => String(Math.round(v)),
    yFormat: (v) => (v === 0 ? "0" : v >= 0.01 ? v.toFixed(3) : v.toExponential(0)),
    xDomain: [0.5, Math.max(...pts.map(([x]) => x)) + 0.5],
    yDomain: [0, top * 1.25],
    refs: [
      { y: 2 ** -(r - 1), label: `2^−(r−1) = 1/${2 ** (r - 1)}, length r + 1` },
      { y: 2 ** -r, label: `2^−r = 1/${2 ** r}, longer` },
    ],
    timed: false,
  }
}

export function CrcProps({ p, run }: { p: CrcParams; run: CrcRun }) {
  const r = run.props.r
  return (
    <div className="space-y-4 overflow-x-auto">
      <table className="w-full font-sans text-sm tabular-nums lining">
        <caption className="pb-1 text-left text-xs text-muted-foreground">
          Every error pattern on this {run.props.n}-bit codeword, counted by the model: how many go unseen.
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="text-right">
            <th className={cn(TH, "text-left")}>errors of</th>
            <th className={TH}>patterns</th>
            <th className={TH}>missed</th>
            <th className="font-normal">fraction</th>
          </tr>
        </thead>
        <tbody>
          {run.props.weight.map((b) => (
            <tr key={`w${b.len}`} className="text-right">
              <td className="pr-2 text-left">weight {b.len}</td>
              <td className="pr-2">{b.patterns}</td>
              <td className={cn("pr-2", b.undetected > 0 && "text-destructive")}>{b.undetected}</td>
              <td>{(b.undetected / b.patterns).toFixed(4)}</td>
            </tr>
          ))}
          {run.props.bursts.map((b) => (
            <tr key={`b${b.len}`} className="text-right">
              <td className="pr-2 text-left">burst length {b.len}</td>
              <td className="pr-2">{b.patterns}</td>
              <td className={cn("pr-2", b.undetected > 0 && "text-destructive")}>{b.undetected}</td>
              <td>{(b.undetected / b.patterns).toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="font-sans text-xs text-muted-foreground">
        Bursts of length r = {r} or less are always caught. Of the bursts of length r + 1, those that are x^i·G(x) itself are missed: 1 in
        2^(r−1). Of longer ones, about 1 in 2^r.{" "}
        {run.props.plus_one
          ? "G has x + 1 as a factor, so every error with an odd number of flipped bits is caught."
          : "G lacks the factor x + 1, so some errors of odd weight can slip through."}
      </p>
      <table className="w-full font-sans text-sm tabular-nums lining">
        <caption className="pb-1 text-left text-xs text-muted-foreground">
          The standard CRCs of "{p.text}" ({asciiBits(p.text).length} bits), with each standard's start value, bit order and final XOR. The
          check values are those published for "123456789".
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="text-right">
            <th className={cn(TH, "text-left")}>CRC</th>
            <th className={TH}>value</th>
            <th className="font-normal">check value</th>
          </tr>
        </thead>
        <tbody>
          {run.standard.map((s) => (
            <tr key={s.name} className="text-right">
              <td className="pr-2 text-left">{s.name}</td>
              <td className="pr-2 font-mono">{hex(s.value, s.width)}</td>
              <td className={cn("font-mono", p.text === "123456789" && s.value === s.check && "text-[var(--chart-2)]")}>
                {hex(s.check, s.width)}
                {p.text === "123456789" ? (s.value === s.check ? " ✓" : " ✗") : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const bitsOnly = (s: string) => s.replace(/[^01]/g, "")
const input = "rounded-sm border border-input bg-background px-1.5 py-1 font-mono text-sm"

/** Click a bit to flip it in transit. */
function FlipBits({
  word,
  flips,
  set,
  offset = 0,
  mark,
}: {
  word: (string | number)[]
  flips: number[]
  set(f: number[]): void
  offset?: number
  mark?(j: number): boolean
}) {
  const on = new Set(flips)
  return (
    <div className="flex flex-wrap gap-0.5" role="group" aria-label="Bits; press one to flip it in transit">
      {word.map((b, k) => {
        const j = k + offset
        return (
          <button
            key={j}
            type="button"
            aria-pressed={on.has(j)}
            aria-label={`bit ${j}${on.has(j) ? ", flipped" : ""}`}
            onClick={() => set(on.has(j) ? flips.filter((x) => x !== j) : [...flips, j].sort((a, c) => a - c))}
            className={cn(
              "h-7 w-6 rounded-sm border font-mono text-sm",
              on.has(j)
                ? "border-destructive bg-destructive/15 text-destructive"
                : mark?.(j)
                  ? "border-[var(--chart-1)]/60 bg-[var(--chart-1)]/10"
                  : "border-border",
            )}
          >
            {on.has(j) ? 1 - Number(b) : b}
          </button>
        )
      })}
    </div>
  )
}

export function CrcSetup({ p, run, set }: { p: CrcParams; run: CrcRun; set(p: CrcParams): void }) {
  const [msg, setMsg] = useState(p.message)
  const [text, setText] = useState(p.text)
  const [seen, setSeen] = useState(p)
  if (seen !== p) {
    setSeen(p)
    setMsg(p.message)
    setText(p.text)
  }
  const r = p.generator.length - 1
  const fits = (f: number[], n: number) => f.filter((j) => j < n)
  return (
    <div className="space-y-5">
      <Group legend="The message">
        <label className="block font-sans text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Bits, most significant first (1 to 96)</span>
          <input
            className={cn(input, "w-full")}
            value={msg}
            onChange={(e) => {
              const v = bitsOnly(e.target.value).slice(0, 96)
              setMsg(v)
              if (v.length) set({ ...p, message: v, flips: fits(p.flips, v.length + r) })
            }}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => set({ ...p, message: asciiBits("123456789").slice(0, 96), flips: [] })}>
            "123456789" (first 96 bits)
          </Button>
          <Button size="sm" variant="outline" onClick={() => set({ ...p, message: "1101011011", flips: [] })}>
            The short example
          </Button>
        </div>
      </Group>
      <Group legend="The generator">
        <select
          aria-label="Generator polynomial"
          className={cn(input, "w-full font-sans")}
          value={p.generator}
          onChange={(e) => set({ ...p, generator: e.target.value, flips: fits(p.flips, p.message.length + e.target.value.length - 1) })}
        >
          {GENERATORS.map((g) => (
            <option key={g.id} value={g.bits}>
              {g.name}
            </option>
          ))}
        </select>
        <p className="font-sans text-xs text-muted-foreground">
          {genName(p.generator)}: {p.generator.length} bits, so r = {r} check bits.
        </p>
      </Group>
      <Group legend="Errors in transit">
        <p className="font-sans text-xs text-muted-foreground">The codeword as sent, check bits shaded. Press a bit to flip it.</p>
        <FlipBits
          word={[...run.codeword]}
          flips={p.flips}
          set={(f) => set({ ...p, flips: f })}
          mark={(j) => j >= run.codeword.length - r}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!p.flips.length} onClick={() => set({ ...p, flips: [] })}>
            No errors
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => set({ ...p, flips: [...p.generator].flatMap((b, k) => (b === "1" ? [k] : [])) })}
          >
            Flip G's pattern at the left
          </Button>
        </div>
      </Group>
      <Group legend="Standard CRCs of a text">
        <input
          aria-label="Text whose standard CRCs are listed"
          className={cn(input, "w-full font-sans")}
          value={text}
          maxLength={64}
          onChange={(e) => {
            setText(e.target.value)
            set({ ...p, text: e.target.value })
          }}
        />
      </Group>
    </div>
  )
}

// --- Hamming ---------------------------------------------------------------

export function hammingText(p: HammingParams, run: HammingRun, i: number): string {
  const e = run.events[i]
  const n = run.n
  switch (e.what) {
    case "place": {
      const par = Array.from({ length: p.r }, (_, k) => 2 ** k)
      return `Number the positions 1 to ${n}. The powers of two, ${list(par)}, are kept for parity, and the ${run.k} data bits ${p.data} fill the other positions in order.${p.secded ? " Position 0 will hold an overall parity bit." : ""}`
    }
    case "parity":
      return `Parity bit ${e.pos} covers the positions whose binary number has the ${e.pos} bit set: ${list(e.covers)}. It is set to ${e.value} so that those positions hold an even number of 1s.`
    case "overall":
      return `The overall parity bit at position 0 is set to ${e.value}, which makes the number of 1s in the whole word even. It lets the receiver tell one error from two.`
    case "flip":
      return `Bit ${e.pos} flips in transit and arrives as ${e.value}.`
    case "recheck":
      return e.value
        ? `The receiver counts the 1s in positions ${list(e.covers)}: odd. Check ${e.pos} fails, so an odd number of errors lies among those positions, and the syndrome gets ${e.pos} added.`
        : `The receiver counts the 1s in positions ${list(e.covers)}: even, so check ${e.pos} passes.`
    case "syndrome": {
      const s = e.pos!
      const b = s.toString(2).padStart(p.r, "0")
      const sum = Array.from({ length: p.r }, (_, k) => 2 ** k).filter((v) => s & v)
      const base = s
        ? `The failed checks add up to ${sum.join(" + ")} = ${s}, binary ${b}: the syndrome.`
        : "No check failed: the syndrome is 0."
      if (!p.secded) return s ? `${base} With a single error, that is the position of the bad bit.` : base
      return `${base} The overall parity of what arrived is ${e.value ? "odd" : "even"}. ${
        s && !e.value
          ? "A nonzero syndrome with even overall parity can only mean two errors (or a larger even number)."
          : s
            ? "Odd parity: one error, at the syndrome's position."
            : e.value
              ? "Odd parity with a zero syndrome: the overall bit itself flipped."
              : ""
      }`
    }
    case "clean":
      return run.data_ok
        ? "Nothing to fix: the data bits are read straight out of their positions."
        : `Every check passes, so the decoder sees a valid codeword, but it is the wrong one. The flips turned one codeword into another, at least ${run.min_distance ?? 3} bits away, and no code can see that.`
    case "corrected":
      return run.data_ok
        ? `The decoder flips bit ${e.pos} back and reads the data: ${run.decoded.join("")}, as sent.`
        : `The decoder assumes a single error and flips bit ${e.pos}. But there were more errors, so it has now added a third: the data comes out as ${run.decoded.join("")}, and nothing warns the layer above.`
    case "detected":
      return "SECDED reports an uncorrectable error and does not guess. The layer above learns the block is bad, which is far better than wrong data delivered silently."
  }
  return ""
}

export const hammingWho = (_p: HammingParams, run: HammingRun, i: number) => {
  const e = run.events[i]
  return e.step <= "H3" ? "the encoder" : e.step === "H4" ? "the channel" : "the decoder"
}

export const HammingTotals = memo(function HammingTotals({ p, run }: { p: HammingParams; run: HammingRun }) {
  const n = run.n + (p.secded ? 1 : 0)
  return (
    <>
      <Row k="code" v={`(${n}, ${run.k})${p.secded ? " SECDED" : ""}`} />
      <Row k="rate k / n" v={(run.k / n).toFixed(3)} />
      <Row k="minimum distance" v={`${run.min_distance ?? "?"}`} />
      <Row k="bits flipped" v={p.flips.length ? list(p.flips) : "none"} bad={p.flips.length > 0} />
      <Row k="syndrome" v={`${run.syndrome}${p.secded ? `, overall ${run.overall ? "odd" : "even"}` : ""}`} />
      <Row
        k="outcome"
        v={`${run.verdict}${run.verdict !== "detected" ? (run.data_ok ? ", data right" : ", data wrong") : ""}`}
        bad={!run.data_ok && run.verdict !== "detected"}
      />
    </>
  )
})

export function HammingEquations({ p, run }: { p: HammingParams; run: HammingRun }) {
  const n = run.n
  const r = p.r
  const fails = Array.from({ length: r }, (_, k) => 2 ** k).filter((v) => run.syndrome & v)
  return (
    <Card title="Hamming codes: parity checks whose failures spell out a position">
      <Tex display>{`n = 2^r - 1 = 2^{${r}} - 1 = ${n},\\quad k = n - r = ${run.k},\\quad d_{\\min} = ${p.secded ? "4" : "3"}`}</Tex>
      <Tex
        display
      >{`p_{2^i} = \\bigoplus_{j\\,:\\, j \\,\\&\\, 2^i \\ne 0} c_j,\\qquad s = \\sum_{\\text{failed } i} 2^i = ${fails.length ? fails.join(" + ") : "0"} = ${run.syndrome}`}</Tex>
      <Tex
        display
      >{`d_{\\min} = 2t + 1 \\Rightarrow t = 1\\ \\text{error corrected};\\quad d_{\\min} = 2t + 2 \\Rightarrow \\text{also detect } t + 1 = 2`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        A single error at position j fails exactly the checks of j's binary digits, so the syndrome is j. Two errors at i and j give i ⊕ j,
        another position, and the decoder &quot;corrects&quot; the wrong bit unless the overall parity (SECDED) shows the count of errors is
        even.
      </p>
    </Card>
  )
}

/** Chance a block's data is wrong without warning, against the bit error rate, on log scales. */
export function hammingChart(p: HammingParams, run: HammingRun): LinkChart {
  const xs = Array.from({ length: 61 }, (_, i) => -5 + (i * 4.5) / 60)
  const floor = -14
  const lg = (v: number) => Math.max(floor, Math.log10(Math.max(v, 1e-300)))
  const odds = xs.map((x) => ({ x, ...blockOdds(run, p.secded, 10 ** x) }))
  const series: Series[] = [
    {
      id: "raw",
      label: `no code: ${run.k} bits sent bare`,
      color: "var(--chart-6)",
      kind: "line",
      dashed: true,
      points: odds.map((o) => [o.x, lg(o.uncoded)]),
    },
    {
      id: "wrong",
      label: "coded, data wrong without warning",
      color: "var(--chart-1)",
      kind: "line",
      points: odds.map((o) => [o.x, lg(o.wrong)]),
    },
  ]
  if (p.secded)
    series.push({
      id: "det",
      label: "coded, error reported",
      color: "var(--chart-2)",
      kind: "line",
      points: odds.map((o) => [o.x, lg(o.detected)]),
    })
  return {
    title: "Block errors against the bit error rate",
    series,
    xLabel: "bit error rate q (log scale)",
    yLabel: "chance per block (log)",
    xFormat: (v) => `1e${Math.round(v)}`,
    yFormat: (v) => `1e${Math.round(v)}`,
    xDomain: [-5, -0.5],
    yDomain: [floor, 0],
    refs: [],
    timed: false,
  }
}

export function HammingSyndrome({ p, run }: { p: HammingParams; run: HammingRun }) {
  const n = run.n
  const show = n <= 15
  return (
    <div className="space-y-4 overflow-x-auto">
      {show && (
        <table className="w-full font-sans text-sm tabular-nums lining">
          <caption className="pb-1 text-left text-xs text-muted-foreground">
            The syndrome of a single flipped bit at each position: its own number in binary.
          </caption>
          <thead className="text-xs text-muted-foreground">
            <tr className="text-right">
              <th className={cn(TH, "text-left")}>flipped bit</th>
              {Array.from({ length: n }, (_, j) => (
                <th key={j} className={cn(TH, isParity(j + 1) && "text-[var(--chart-1)]")}>
                  {j + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="text-right">
              <td className="pr-2 text-left text-muted-foreground">syndrome</td>
              {Array.from({ length: n }, (_, j) => (
                <td key={j} className={cn("pr-2 font-mono text-xs", run.syndrome === j + 1 && "font-semibold text-destructive")}>
                  {(j + 1).toString(2).padStart(p.r, "0")}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
      <table className="w-full font-sans text-sm tabular-nums lining">
        <caption className="pb-1 text-left text-xs text-muted-foreground">
          Every error pattern of up to four bits on this codeword, decoded: right, reported, or wrong without warning.
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="text-right">
            <th className={cn(TH, "text-left")}>errors</th>
            <th className={TH}>patterns</th>
            <th className={TH}>right</th>
            <th className={TH}>reported</th>
            <th className="font-normal">wrong</th>
          </tr>
        </thead>
        <tbody>
          {run.by_weight.map((s) => (
            <tr key={s.w} className={cn("text-right", p.flips.length === s.w && "bg-muted/60")}>
              <td className="pr-2 text-left">{s.w}</td>
              <td className="pr-2">{s.patterns}</td>
              <td className="pr-2">{s.right}</td>
              <td className="pr-2">{s.detected}</td>
              <td className={cn(s.wrong > 0 && "text-destructive")}>{s.wrong}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="font-sans text-xs text-muted-foreground">
        Minimum distance {run.min_distance ?? "?"}:{" "}
        {p.secded
          ? "every single error corrected and every double reported"
          : "every single error corrected, but every double turned into a wrong correction"}
        . A (2^r − 1, 2^r − 1 − r) Hamming code needs only r check bits for 2^r − 1 − r data bits, so the rate approaches 1 as r grows,
        while it still handles one error per block.
      </p>
    </div>
  )
}

export function HammingSetup({ p, run, set }: { p: HammingParams; run: HammingRun; set(p: HammingParams): void }) {
  const k = hammingK(p.r)
  const [data, setData] = useState(p.data)
  const [seen, setSeen] = useState(p)
  if (seen !== p) {
    setSeen(p)
    setData(p.data)
  }
  const fill = (d: string, len: number) => (d + "1011".repeat(8)).slice(0, len)
  return (
    <div className="space-y-5">
      <Group legend="The code">
        <ParamSlider
          label="Check bits r"
          value={p.r}
          min={2}
          max={5}
          format={(v) => `${v}: (${hammingN(v)}, ${hammingK(v)})`}
          onChange={(v) => set({ ...p, r: v, data: fill(p.data, hammingK(v)), flips: p.flips.filter((j) => j <= hammingN(v)) })}
        />
        <ParamSwitch
          label="SECDED"
          name="Add an overall parity bit"
          checked={p.secded}
          onChange={(v) => set({ ...p, secded: v, flips: v ? p.flips : p.flips.filter((j) => j > 0) })}
          on="Single error correction, double error detection"
          off="Single error correction only"
        />
      </Group>
      <Group legend="The data">
        <label className="block font-sans text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">{k} data bits</span>
          <input
            className={cn(input, "w-full")}
            value={data}
            onChange={(e) => {
              const v = bitsOnly(e.target.value).slice(0, k)
              setData(v)
              if (v.length === k) set({ ...p, data: v })
            }}
          />
        </label>
      </Group>
      <Group legend="Errors in transit">
        <p className="font-sans text-xs text-muted-foreground">
          The codeword by position{p.secded ? ", from 0" : ", from 1"}; parity positions shaded. Press a bit to flip it.
        </p>
        <FlipBits
          word={p.secded ? run.codeword : run.codeword.slice(1)}
          offset={p.secded ? 0 : 1}
          flips={p.flips}
          set={(f) => set({ ...p, flips: f })}
          mark={(j) => j === 0 || isParity(j)}
        />
        <Button size="sm" variant="outline" disabled={!p.flips.length} onClick={() => set({ ...p, flips: [] })}>
          No errors
        </Button>
      </Group>
    </div>
  )
}
