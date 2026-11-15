import type { LadderFlight, LadderMark } from "./Ladder"
import { formatTime } from "./timeline.ts"

/**
 * Export a sequence diagram as a figure for slides, notes or a paper: a
 * standalone SVG with concrete colours, or a TikZ picture that compiles with
 * `pdflatex`. Both are drawn from the run itself, not copied from the screen,
 * so the whole diagram up to the current moment is included.
 */
export interface LadderFigure {
  lanes: [string, string]
  flights: LadderFlight[]
  marks: LadderMark[]
  /** Draw everything from this time (default 0) up to `upTo`, in microseconds. */
  from?: number
  upTo: number
  caption: string
}

// The light theme's tokens, so an exported figure reads on white paper.
export const INK = "#141a24"
export const MUTED = "#4d5766"
export const ALARM = "#b42318"
const PALETTE: Record<string, string> = {
  "var(--chart-1)": "#2a78d6",
  "var(--chart-2)": "#eb6834",
  "var(--chart-3)": "#1baf7a",
  "var(--chart-4)": "#eda100",
  "var(--chart-5)": "#e87ba4",
  "var(--chart-6)": "#008300",
  "var(--foreground)": INK,
  "var(--muted-foreground)": MUTED,
}
export const hex = (c: string) => PALETTE[c] ?? (c.startsWith("#") ? c : INK)

interface Seg {
  f: LadderFlight
  from: 0 | 1
  /** Fractions of the way across where the first bit is drawn to (1, or 0.5 if lost). */
  reach: number
}

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
}

function prepare(fig: LadderFigure) {
  const from = fig.from ?? 0
  const upTo = Math.max(from + 1, fig.upTo)
  const segs: Seg[] = fig.flights
    .filter((f) => f.t_start <= upTo && f.t_start >= from)
    .map((f) => ({ f, from: f.from, reach: f.lost ? 0.5 : 1 }))
  const tick = niceStep((upTo - from) / 8)
  const ticks = Array.from({ length: Math.floor((upTo - from) / tick) + 2 }, (_, i) => (Math.ceil(from / tick) + i) * tick).filter(
    (v) => v <= upTo,
  )
  return { start: from, upTo, segs, ticks, marks: fig.marks.filter((m) => m.t <= upTo && m.t >= from) }
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

export function ladderSvg(fig: LadderFigure): string {
  const { start, upTo, segs, ticks, marks } = prepare(fig)
  const W = 560
  const H = 680
  const top = 40
  const xs = [130, W - 130]
  const y = (t: number) => top + ((t - start) / (upTo - start)) * H
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${top + H + 40}" viewBox="0 0 ${W} ${top + H + 40}" font-family="'CMU Sans Serif', 'Latin Modern Sans', Helvetica, Arial, sans-serif">`,
    `<title>${esc(fig.caption)}</title>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<defs><clipPath id="past"><rect x="0" y="${top - 8}" width="${W}" height="${y(upTo) - top + 8}"/></clipPath></defs>`,
  )
  for (const v of ticks) {
    out.push(`<line x1="${xs[0]}" x2="${xs[1]}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e7ec"/>`)
    out.push(`<text x="8" y="${y(v)}" dy="0.32em" font-size="10" fill="${MUTED}">${esc(formatTime(v))}</text>`)
  }
  fig.lanes.forEach((name, i) => {
    out.push(`<text x="${xs[i]}" y="20" text-anchor="middle" font-size="13" fill="${INK}">${esc(name)}</text>`)
    out.push(`<line x1="${xs[i]}" x2="${xs[i]}" y1="${top - 8}" y2="${y(upTo)}" stroke="${INK}" stroke-opacity="0.5"/>`)
  })
  out.push(`<g clip-path="url(#past)">`)
  for (const { f, from, reach } of segs) {
    const a = xs[from]
    const b = xs[1 - from]
    const c = hex(f.color)
    const bx = a + (b - a) * reach
    const delay = f.t_arrive - f.t_sent
    const lead = y(f.t_start + delay * reach)
    const tail = y(f.t_sent + delay * reach)
    out.push(
      `<polygon points="${a},${y(f.t_start)} ${a},${y(f.t_sent)} ${bx},${tail} ${bx},${lead}" fill="${c}" fill-opacity="${f.lost ? 0.12 : 0.2}"/>`,
      `<line x1="${a}" y1="${y(f.t_start)}" x2="${bx}" y2="${lead}" stroke="${c}" stroke-width="1.75"/>`,
      `<text x="${a + (from === 0 ? 6 : -6)}" y="${y(f.t_start) - 3}" text-anchor="${from === 0 ? "start" : "end"}" font-size="11" fill="${INK}">${esc(f.label)}</text>`,
    )
    if (f.lost) {
      out.push(
        `<g stroke="${ALARM}" stroke-width="2.25" stroke-linecap="round"><line x1="${bx - 5}" y1="${lead - 5}" x2="${bx + 5}" y2="${lead + 5}"/><line x1="${bx - 5}" y1="${lead + 5}" x2="${bx + 5}" y2="${lead - 5}"/></g>`,
      )
    } else if (f.t_arrive <= upTo) {
      out.push(
        `<text x="${b + (from === 0 ? 6 : -6)}" y="${y(f.t_arrive)}" dy="0.32em" text-anchor="${from === 0 ? "start" : "end"}" font-size="10.5" fill="${f.alarm ? ALARM : MUTED}">${esc(f.fate)}</text>`,
      )
    }
  }
  for (const m of marks) {
    const x = xs[m.lane]
    out.push(
      `<rect x="${x - 4}" y="${y(m.t) - 4}" width="8" height="8" fill="#ffffff" stroke="${INK}" transform="rotate(45 ${x} ${y(m.t)})"/>`,
      `<text x="${x + (m.lane === 0 ? -8 : 8)}" y="${y(m.t)}" dy="0.32em" text-anchor="${m.lane === 0 ? "end" : "start"}" font-size="10.5" fill="${INK}">${esc(m.text)}</text>`,
    )
  }
  out.push(`</g>`)
  out.push(`<text x="${W / 2}" y="${top + H + 28}" text-anchor="middle" font-size="12" fill="${INK}">${esc(fig.caption)}</text>`)
  out.push(`</svg>`)
  return out.join("\n")
}

/** TeX-safe text: escapes the special characters and turns the prime into math. */
export const tex = (s: string) =>
  s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    // Function replacers: in a replacement string "$'" would mean "the rest of the input".
    .replace(/′/g, () => "$'$")
    .replace(/µ/g, () => "$\\mu$")
    .replace(/−/g, "--")
    .replace(/–/g, "--")
    .replace(/∞/g, () => "$\\infty$")
    .replace(/→/g, () => "$\\to$")

export function ladderTikz(fig: LadderFigure): string {
  const { start, upTo, segs, ticks, marks } = prepare(fig)
  const H = 14 // cm of paper for the whole time span
  const xs = [0, 7]
  const n = (v: number) => Number(v.toFixed(3))
  const y = (t: number) => n(-((t - start) / (upTo - start)) * H)
  const colours = [...new Set(segs.map((s) => hex(s.f.color)))]
  const name = (c: string) => `nv${colours.indexOf(c)}`
  const L: string[] = [
    "% Exported from net-visual. Compile with pdflatex.",
    "\\documentclass[tikz,border=6pt]{standalone}",
    "\\usetikzlibrary{arrows.meta, shapes.geometric}",
    ...colours.map((c) => `\\definecolor{${name(c)}}{HTML}{${c.slice(1).toUpperCase()}}`),
    `\\definecolor{nvalarm}{HTML}{${ALARM.slice(1)}}`,
    "\\begin{document}",
    "\\begin{tikzpicture}[font=\\sffamily\\scriptsize]",
  ]
  for (const v of ticks) {
    L.push(`  \\draw[black!12] (${xs[0]},${y(v)}) -- (${xs[1]},${y(v)});`)
    L.push(`  \\node[anchor=east, black!60] at (-1.6,${y(v)}) {${tex(formatTime(v))}};`)
  }
  fig.lanes.forEach((lane, i) => {
    L.push(`  \\node[anchor=south, font=\\sffamily\\small] at (${xs[i]},0.25) {${tex(lane)}};`)
    L.push(`  \\draw[black!50] (${xs[i]},0.2) -- (${xs[i]},${y(upTo)});`)
  })
  L.push(`  \\begin{scope}`, `  \\clip (-4,0.6) rectangle (${xs[1] + 4},${y(upTo)});`)
  for (const { f, from, reach } of segs) {
    const a = xs[from]
    const b = xs[1 - from]
    const bx = n(a + (b - a) * reach)
    const delay = f.t_arrive - f.t_sent
    const c = name(hex(f.color))
    const lead = y(f.t_start + delay * reach)
    const tail = y(f.t_sent + delay * reach)
    L.push(
      `  \\fill[${c}, opacity=${f.lost ? 0.12 : 0.2}] (${a},${y(f.t_start)}) -- (${a},${y(f.t_sent)}) -- (${bx},${tail}) -- (${bx},${lead}) -- cycle;`,
    )
    const arrow = f.lost ? "" : ", -{Stealth[length=4pt]}"
    L.push(`  \\draw[${c}, line width=0.8pt${arrow}] (${a},${y(f.t_start)}) -- (${bx},${lead});`)
    L.push(`  \\node[anchor=south ${from === 0 ? "west" : "east"}, inner sep=1pt] at (${a},${y(f.t_start)}) {${tex(f.label)}};`)
    if (f.lost) L.push(`  \\node[nvalarm, font=\\bfseries\\Large] at (${bx},${lead}) {$\\times$};`)
    else if (f.t_arrive <= upTo)
      L.push(
        `  \\node[anchor=${from === 0 ? "west" : "east"}, ${f.alarm ? "nvalarm" : "black!60"}] at (${b},${y(f.t_arrive)}) {${tex(f.fate)}};`,
      )
  }
  for (const m of marks) {
    const x = xs[m.lane]
    L.push(`  \\node[draw, fill=white, diamond, inner sep=1.4pt] at (${x},${y(m.t)}) {};`)
    L.push(`  \\node[anchor=${m.lane === 0 ? "east" : "west"}] at (${x + (m.lane === 0 ? -0.15 : 0.15)},${y(m.t)}) {${tex(m.text)}};`)
  }
  L.push("  \\end{scope}")
  L.push(`  \\node[anchor=north, font=\\sffamily\\small] at (${(xs[0] + xs[1]) / 2},${n(y(upTo) - 0.4)}) {${tex(fig.caption)}};`)
  L.push("\\end{tikzpicture}", "\\end{document}", "")
  return L.join("\n")
}

/**
 * A line chart as a figure: series in data coordinates, optional horizontal
 * reference lines (a bandwidth-delay product, a buffer size), axis labels
 * and a caption.
 */
export interface ChartFigure {
  xLabel: string
  yLabel: string
  xFormat(x: number): string
  yFormat(y: number): string
  xDomain: [number, number]
  yDomain: [number, number]
  series: { label: string; color: string; points: [number, number][]; dashed?: boolean; step?: boolean }[]
  refs: { y: number; label: string }[]
  caption: string
}

/** At most n points, evenly spaced through the series, keeping the last. */
function thin(points: [number, number][], n: number): [number, number][] {
  if (points.length <= n) return points
  const step = points.length / n
  const out = Array.from({ length: n }, (_, i) => points[Math.floor(i * step)])
  out.push(points[points.length - 1])
  return out
}

function chartTicks(lo: number, hi: number, count: number): number[] {
  const step = niceStep((hi - lo) / count)
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

/** The polyline of a series, clipped to the y range, with steps if asked. */
function trace(points: [number, number][], step: boolean, x: (v: number) => number, y: (v: number) => number, lo: number, hi: number) {
  const out: [number, number][] = []
  for (const [px, py] of thin(points, 2000)) {
    const Y = y(Math.min(Math.max(py, lo), hi))
    if (step && out.length) out.push([x(px), out[out.length - 1][1]])
    out.push([x(px), Y])
  }
  return out
}

export function chartSvg(fig: ChartFigure): string {
  const W = 720
  const H = 320
  const m = { l: 64, r: 120, t: 36, b: 52 }
  const [x0, x1] = fig.xDomain
  const [y0, y1] = fig.yDomain
  const x = (v: number) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r)
  const y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b)
  const n = (v: number) => v.toFixed(1)
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 24}" viewBox="0 0 ${W} ${H + 24}" font-family="'CMU Sans Serif', 'Latin Modern Sans', Helvetica, Arial, sans-serif">`,
    `<title>${esc(fig.caption)}</title>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ]
  for (const v of chartTicks(y0, y1, 5)) {
    out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${n(y(v))}" y2="${n(y(v))}" stroke="#e3e7ec"/>`)
    out.push(
      `<text x="${m.l - 6}" y="${n(y(v))}" dy="0.32em" text-anchor="end" font-size="11" fill="${MUTED}">${esc(fig.yFormat(v))}</text>`,
    )
  }
  for (const v of chartTicks(x0, x1, 7))
    out.push(`<text x="${n(x(v))}" y="${H - m.b + 16}" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(fig.xFormat(v))}</text>`)
  out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="${INK}" stroke-opacity="0.5"/>`)
  out.push(`<text x="${(m.l + W - m.r) / 2}" y="${H - 12}" text-anchor="middle" font-size="12" fill="${INK}">${esc(fig.xLabel)}</text>`)
  out.push(
    `<text transform="translate(14 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="${INK}">${esc(fig.yLabel)}</text>`,
  )
  for (const r of fig.refs.filter((r) => r.y >= y0 && r.y <= y1)) {
    out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${n(y(r.y))}" y2="${n(y(r.y))}" stroke="${MUTED}" stroke-dasharray="2 3"/>`)
    out.push(`<text x="${W - m.r + 6}" y="${n(y(r.y))}" dy="0.32em" font-size="11" fill="${MUTED}">${esc(r.label)}</text>`)
  }
  fig.series.forEach((s, i) => {
    const pts = trace(s.points, !!s.step, x, y, y0, y1)
    out.push(
      `<polyline points="${pts.map(([a, b]) => `${n(a)},${n(b)}`).join(" ")}" fill="none" stroke="${hex(s.color)}" stroke-width="1.75" stroke-linejoin="round"${s.dashed ? ' stroke-dasharray="5 4"' : ""}/>`,
    )
    const lx = m.l + (i % 4) * 150
    const ly = 10 + Math.floor(i / 4) * 14
    out.push(
      `<line x1="${lx}" x2="${lx + 18}" y1="${ly}" y2="${ly}" stroke="${hex(s.color)}" stroke-width="2"${s.dashed ? ' stroke-dasharray="4 3"' : ""}/>`,
      `<text x="${lx + 22}" y="${ly}" dy="0.32em" font-size="11" fill="${INK}">${esc(s.label)}</text>`,
    )
  })
  out.push(`<text x="${W / 2}" y="${H + 12}" text-anchor="middle" font-size="12" fill="${INK}">${esc(fig.caption)}</text>`, `</svg>`)
  return out.join("\n")
}

export function chartTikz(fig: ChartFigure): string {
  const Wcm = 12
  const Hcm = 6
  const [x0, x1] = fig.xDomain
  const [y0, y1] = fig.yDomain
  const n = (v: number) => Number(v.toFixed(3))
  const x = (v: number) => n(((v - x0) / (x1 - x0 || 1)) * Wcm)
  const y = (v: number) => n(((v - y0) / (y1 - y0 || 1)) * Hcm)
  const colours = [...new Set(fig.series.map((s) => hex(s.color)))]
  const name = (c: string) => `nv${colours.indexOf(c)}`
  const L: string[] = [
    "% Exported from net-visual. Compile with pdflatex.",
    "\\documentclass[tikz,border=6pt]{standalone}",
    ...colours.map((c) => `\\definecolor{${name(c)}}{HTML}{${c.slice(1).toUpperCase()}}`),
    "\\begin{document}",
    "\\begin{tikzpicture}[font=\\sffamily\\scriptsize]",
  ]
  for (const v of chartTicks(y0, y1, 5)) {
    L.push(`  \\draw[black!12] (0,${y(v)}) -- (${Wcm},${y(v)});`)
    L.push(`  \\node[anchor=east, black!60] at (-0.1,${y(v)}) {${tex(fig.yFormat(v))}};`)
  }
  for (const v of chartTicks(x0, x1, 7)) L.push(`  \\node[anchor=north, black!60] at (${x(v)},-0.1) {${tex(fig.xFormat(v))}};`)
  L.push(`  \\draw[black!50] (0,0) -- (${Wcm},0);`)
  L.push(`  \\node[anchor=north] at (${Wcm / 2},-0.6) {${tex(fig.xLabel)}};`)
  L.push(`  \\node[anchor=south, rotate=90] at (-1.2,${Hcm / 2}) {${tex(fig.yLabel)}};`)
  for (const r of fig.refs.filter((r) => r.y >= y0 && r.y <= y1)) {
    L.push(`  \\draw[black!55, dash pattern=on 1.5pt off 2pt] (0,${y(r.y)}) -- (${Wcm},${y(r.y)});`)
    L.push(`  \\node[anchor=west, black!60] at (${Wcm + 0.1},${y(r.y)}) {${tex(r.label)}};`)
  }
  fig.series.forEach((s, i) => {
    const pts = trace(s.points, !!s.step, x, y, y0, y1)
    const style = `${name(hex(s.color))}, line width=0.8pt, line join=round${s.dashed ? ", dash pattern=on 3pt off 2pt" : ""}`
    L.push(`  \\draw[${style}] ${pts.map(([a, b]) => `(${n(a)},${n(b)})`).join(" -- ")};`)
    L.push(
      `  \\draw[${style}] (${n((i % 4) * 3)},${n(Hcm + 0.8 - Math.floor(i / 4) * 0.4)}) -- ++(0.5,0) node[anchor=west, black] {${tex(s.label)}};`,
    )
  })
  L.push(`  \\node[anchor=north, font=\\sffamily\\small] at (${Wcm / 2},-1.1) {${tex(fig.caption)}};`)
  L.push("\\end{tikzpicture}", "\\end{document}", "")
  return L.join("\n")
}

/** Lazy SVG and TikZ exports of a sequence diagram, for ToolActions. */
export const ladderExports = (fig: LadderFigure) => ({ svg: () => ladderSvg(fig), tikz: () => ladderTikz(fig) })

/** Lazy SVG and TikZ exports of a chart, for ToolActions. */
export const chartExports = (fig: () => ChartFigure) => ({ svg: () => chartSvg(fig()), tikz: () => chartTikz(fig()) })

/** Offer text to the reader as a file download. */
export function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
