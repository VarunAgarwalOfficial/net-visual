// The two coding pictures at one step, as plain shapes: a CRC worked as long
// division over GF(2), and a Hamming codeword with the parity groups that
// check it. Pure TypeScript, so the Node tests can check it.
import { isParity, type CrcEvent, type CrcParams, type CrcRun, type HammingParams, type HammingRun } from "../../core/coding.ts"
import type { Ink, Shape, ShapeFigure } from "./shapes.ts"

const SUP: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "-": "⁻",
}
/** A number as Unicode superscript, for exponents in plain-text labels. */
export const sup = (n: number) => [...String(n)].map((c) => SUP[c] ?? c).join("")

const text = (x: number, y: number, s: string, o: Partial<Extract<Shape, { kind: "text" }>> = {}): Shape => ({
  kind: "text",
  x,
  y,
  text: s,
  size: 11,
  anchor: "start",
  fill: "muted",
  ...o,
})

// --- CRC -------------------------------------------------------------------

export interface CrcFigure extends ShapeFigure {
  rows: number
}

/** The most subtractions shown at once; earlier ones are elided. */
const KEEP = 6

/** The division so far: dividend, each subtraction of the generator and what it leaves, and the quotient on top. */
export function crcFigure(p: CrcParams, run: CrcRun, index: number, w: number): CrcFigure {
  const g = p.generator
  const r = g.length - 1
  const n = run.codeword.length
  const ev = run.events
  const e = ev[Math.min(index, ev.length - 1)]
  const labels = w >= 480
  const labelW = labels ? 84 : 14
  const cw = Math.min(16, (w - labelW - 10) / n)
  const size = Math.min(14, Math.max(6.5, cw * 1.45))
  const lh = Math.max(11, size * 1.4)
  const most = Math.min(
    KEEP,
    Math.max(...(["send", "check"] as const).map((ph) => ev.filter((x) => x.phase === ph && x.what === "xor").length)),
  )
  const rowsMax = 6 + 2 * most + 1
  const h = Math.round(rowsMax * lh + 14)
  const shapes: Shape[] = []
  const colX = (j: number) => labelW + cw * (j + 0.5)
  let y = lh

  const label = (s: string, ink: Ink = "muted") => {
    if (labels) shapes.push(text(4, y, s, { size: 10.5, fill: ink }))
  }
  const bits = (s: string, from: number, ink: (j: number, b: string) => Ink, bold?: (j: number) => boolean) => {
    for (let k = 0; k < s.length; k++) {
      const j = from + k
      shapes.push({ kind: "text", x: colX(j), y, text: s[k], size, anchor: "middle", fill: ink(j, s[k]), mono: true, bold: bold?.(j) })
    }
  }
  const rule = (from: number, to: number) =>
    shapes.push({
      kind: "line",
      x1: colX(from) - cw / 2,
      y1: y + lh * 0.3,
      x2: colX(to) + cw / 2,
      y2: y + lh * 0.3,
      stroke: "muted",
      width: 0.8,
    })

  const phase = e.phase
  const inPhase = ev.slice(0, index + 1).filter((x) => x.phase === phase)
  const xors = inPhase.filter((x) => x.what === "xor")
  const error = run.error

  // The heading line, then the quotient above the dividend, aligned so each quotient bit sits over the last column it subtracted from.
  shapes.push(
    text(4, y, phase === "send" ? `Sender: divide M(x)·x${sup(r)} by G(x) = ${g}` : `Receiver: divide what arrived by G(x) = ${g}`, {
      size: 11,
      fill: "ink",
      bold: true,
    }),
  )
  y += lh
  if (phase === "check") {
    label("sent")
    bits(run.codeword, 0, (j) => (j >= n - r ? "ok" : "muted"))
    y += lh
    label("error E", "alarm")
    bits(error, 0, (_, b) => (b === "1" ? "alarm" : "muted"))
    y += lh
  }
  const q = [...inPhase].reverse().find((x) => x.quotient)?.quotient ?? ""
  label("quotient", "ink")
  bits(q, r, () => "ink")
  y += lh
  const dividend = phase === "send" ? ev[0].bits : ev.find((x) => x.what === "receive")!.bits
  label(phase === "send" ? `M · x${sup(r)}` : "received")
  bits(
    dividend,
    0,
    (j) => (phase === "send" ? (j >= n - r ? "muted" : "ink") : error[j] === "1" ? "alarm" : "ink"),
    (j) => phase === "check" && error[j] === "1",
  )

  const shown = xors.slice(-most)
  if (xors.length > shown.length) {
    y += lh
    shapes.push(
      text(colX(0), y, `⋮ ${xors.length - shown.length} earlier subtraction${xors.length - shown.length === 1 ? "" : "s"}`, { size: 10 }),
    )
  }
  shown.forEach((x: CrcEvent) => {
    const at = x.pos!
    const current = x === e
    y += lh
    label("⊕ G", "ink")
    bits(
      g,
      at,
      () => "ink",
      () => current,
    )
    rule(at, at + r)
    y += lh
    // What remains: bits before the next leading 1 are dimmed, they are done with.
    const lead = x.bits.indexOf("1")
    const live = lead < 0 ? n - r : Math.min(lead, n - r)
    bits(
      x.bits.slice(at),
      at,
      (j) => (j < live ? "muted" : "ink"),
      () => current,
    )
  })

  y += lh
  if (e.what === "send") {
    label("codeword", "ok")
    bits(
      run.codeword,
      0,
      (j) => (j >= n - r ? "ok" : "ink"),
      (j) => j >= n - r,
    )
  } else if (e.what === "accept" || e.what === "reject") {
    label("remainder", e.what === "accept" ? "ok" : "alarm")
    bits(
      e.bits,
      n - r,
      () => (e.what === "accept" ? "ok" : "alarm"),
      () => true,
    )
    shapes.push(
      text(colX(n - r) - cw, y, e.what === "accept" ? "zero: accept" : "non-zero: reject", {
        anchor: "end",
        size: 10.5,
        fill: e.what === "accept" ? "ok" : "alarm",
      }),
    )
  } else if (e.what === "pad" || e.what === "receive") {
    shapes.push(
      text(colX(0), y, e.what === "pad" ? `${r} zeros appended: room for the remainder` : "The receiver divides the frame as it arrived", {
        size: 10.5,
      }),
    )
  }
  return { w, h, shapes, caption: "", rows: rowsMax }
}

// --- Hamming ---------------------------------------------------------------

export interface HammingFigure extends ShapeFigure {
  flipped: number[]
}

/** The codeword as boxes, the received word with its flips, each parity group's positions and verdict, and the decoder's output. */
export function hammingFigure(p: HammingParams, run: HammingRun, index: number, w: number): HammingFigure {
  const n = run.n
  const r = p.r
  const cols = p.secded ? Array.from({ length: n + 1 }, (_, j) => j) : Array.from({ length: n }, (_, j) => j + 1)
  const labelW = w >= 480 ? 78 : 50
  const bw = Math.min(34, (w - labelW - 8) / cols.length)
  const bh = Math.min(26, Math.max(14, bw))
  const fs = Math.min(13, Math.max(7.5, bw * 0.55))
  const showBinary = bw >= 15
  const x0 = (j: number) => labelW + cols.indexOf(j) * bw
  const ev = run.events.slice(0, index + 1)
  const e = run.events[Math.min(index, run.events.length - 1)]
  const groups = Array.from({ length: r }, (_, i) => 1 << i)
  const rowH = bh + 8
  const groupH = Math.max(12, Math.min(18, bw * 0.7))
  const h = Math.round(18 + (showBinary ? 14 : 0) + 3 * rowH + (r + (p.secded ? 1 : 0)) * groupH + 34)
  const shapes: Shape[] = []
  let y = 14

  const label = (s: string, yy: number, ink: Ink = "muted") => shapes.push(text(4, yy, s, { size: w >= 480 ? 10.5 : 9.5, fill: ink }))

  // Position numbers, and their binary spellings, which say which groups cover each position.
  for (const j of cols) {
    const cx = x0(j) + bw / 2
    shapes.push(
      text(cx, y, String(j), {
        anchor: "middle",
        size: Math.min(10.5, fs),
        fill: j === 0 || isParity(j) ? "ink" : "muted",
        bold: j === 0 || isParity(j),
      }),
    )
    if (showBinary && j > 0)
      shapes.push(text(cx, y + 12, j.toString(2).padStart(r, "0"), { anchor: "middle", size: Math.min(8.5, fs * 0.75), mono: true }))
  }
  label("position", y)
  y += showBinary ? 20 : 8

  const covered = e && (e.what === "parity" || e.what === "recheck" || e.what === "overall") ? new Set(e.covers) : new Set<number>()
  const flips = new Set<number>()
  for (const x of ev) {
    if (x.what !== "flip" || x.pos === null) continue
    if (flips.has(x.pos)) flips.delete(x.pos)
    else flips.add(x.pos)
  }
  const received = run.codeword.map((b, j) => (flips.has(j) ? 1 - b : b))
  const done = ev.some((x) => x.step === "H7")
  const shownSent = new Set(ev.filter((x) => x.what === "parity" || x.what === "overall").map((x) => x.pos))

  const row = (
    name: string,
    word: (number | null)[],
    ink: (j: number) => { fill?: Ink; stroke: Ink; opacity?: number },
    nameInk: Ink = "muted",
  ) => {
    label(name, y + bh * 0.68, nameInk)
    for (const j of cols) {
      const k = ink(j)
      shapes.push({ kind: "rect", x: x0(j) + 1, y, w: bw - 2, h: bh, fill: k.fill, stroke: k.stroke, opacity: k.opacity })
      const v = word[j]
      if (v !== null) shapes.push(text(x0(j) + bw / 2, y + bh * 0.68, String(v), { anchor: "middle", size: fs, fill: "ink", mono: true }))
    }
    y += rowH
  }
  const parityBox = (j: number) => j === 0 || isParity(j)
  const tint = (j: number, base: { fill?: Ink; stroke: Ink; opacity?: number }) =>
    covered.has(j) ? { fill: "mark" as Ink, stroke: "ink" as Ink } : base

  // Parity bits appear as each is computed; data bits are there from the start.
  row(
    "sent",
    run.codeword.map((b, j) => (parityBox(j) && !shownSent.has(j) && index < 1 + r + (p.secded ? 1 : 0) ? null : b)),
    (j) => tint(j, parityBox(j) ? { fill: "ground", stroke: "muted" } : { stroke: "muted" }),
  )
  const arrived = ev.some((x) => x.step === "H4" || x.step === "H5")
  row(
    "received",
    arrived ? received : run.codeword.map(() => null),
    (j) => (flips.has(j) ? { fill: "surface", stroke: "alarm" } : tint(j, { stroke: "muted" })),
    flips.size ? "alarm" : "muted",
  )
  const fixed = run.verdict === "corrected" ? run.syndrome : null
  row(
    run.verdict === "detected" && done ? "reported" : "decoded",
    done && run.verdict !== "detected" ? run.corrected : run.codeword.map(() => null),
    (j) =>
      done && j === fixed && run.verdict === "corrected"
        ? { fill: "surface", stroke: run.data_ok ? "ok" : "alarm" }
        : { stroke: done && run.verdict === "detected" ? "alarm" : "muted" },
  )

  // The parity groups: a dot under each position a check covers; its verdict once rechecked.
  y += 4
  const rechecked = new Map(ev.filter((x) => x.what === "recheck").map((x) => [x.pos, x.value]))
  const rows: { name: string; pos: number; covers: (j: number) => boolean }[] = groups.map((g) => ({
    name: `p${g}`,
    pos: g,
    covers: (j: number) => (j & g) !== 0,
  }))
  if (p.secded) rows.push({ name: "all", pos: 0, covers: (j: number) => j > 0 })
  for (const gr of rows) {
    const v = rechecked.get(gr.pos)
    const active = e && e.pos === gr.pos && (e.what === "parity" || e.what === "recheck" || e.what === "overall")
    const verdict = v === undefined ? "" : v === 0 ? " ✓" : " ✗"
    label(`${gr.name}${verdict}`, y + groupH * 0.7, v === 1 ? "alarm" : active ? "ink" : "muted")
    for (const j of cols)
      if (gr.covers(j) || j === gr.pos)
        shapes.push({
          kind: "circle",
          cx: x0(j) + bw / 2,
          cy: y + groupH * 0.45,
          r: Math.min(4, bw * 0.18),
          fill: j === gr.pos || active ? "ink" : "muted",
        })
    y += groupH
  }

  // The syndrome, once read.
  const syn = ev.find((x) => x.step === "H6")
  if (syn) {
    const bitsS = run.syndrome.toString(2).padStart(r, "0")
    const said =
      run.syndrome === 0
        ? "syndrome 0: every group checks"
        : `syndrome ${bitsS} = ${run.syndrome}${p.secded ? `, overall parity ${run.overall ? "odd: one error" : "even: two errors"}` : ""}`
    shapes.push(text(4, y + 16, said, { size: 11, fill: run.syndrome ? "alarm" : "ok", bold: true }))
    if (run.syndrome > 0 && run.syndrome <= n && cols.includes(run.syndrome))
      shapes.push({
        kind: "line",
        x1: x0(run.syndrome) + bw / 2,
        y1: y + 4,
        x2: x0(run.syndrome) + bw / 2,
        y2: 14 + (showBinary ? 20 : 8) + rowH + bh + 2,
        stroke: "alarm",
        dashed: true,
        arrow: true,
      })
  }
  return { w, h, shapes, caption: "", flipped: [...flips] }
}
