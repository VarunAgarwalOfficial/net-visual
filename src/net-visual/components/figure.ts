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
  /** Draw everything up to this time, in microseconds. */
  upTo: number
  caption: string
}

// The light theme's tokens, so an exported figure reads on white paper.
const INK = "#141a24"
const MUTED = "#4d5766"
const ALARM = "#b42318"
const PALETTE: Record<string, string> = { "var(--chart-1)": "#2a78d6", "var(--chart-2)": "#eb6834" }
const hex = (c: string) => PALETTE[c] ?? (c.startsWith("#") ? c : INK)

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
  const upTo = Math.max(1, fig.upTo)
  const segs: Seg[] = fig.flights.filter((f) => f.t_start <= upTo).map((f) => ({ f, from: f.from, reach: f.lost ? 0.5 : 1 }))
  const tick = niceStep(upTo / 8)
  const ticks = Array.from({ length: Math.floor(upTo / tick) + 1 }, (_, i) => i * tick)
  return { upTo, segs, ticks, marks: fig.marks.filter((m) => m.t <= upTo) }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

export function ladderSvg(fig: LadderFigure): string {
  const { upTo, segs, ticks, marks } = prepare(fig)
  const W = 560
  const H = 680
  const top = 40
  const xs = [130, W - 130]
  const y = (t: number) => top + (t / upTo) * H
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${top + H + 40}" viewBox="0 0 ${W} ${top + H + 40}" font-family="'CMU Sans Serif', 'Latin Modern Sans', Helvetica, Arial, sans-serif">`,
    `<title>${esc(fig.caption)}</title>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<defs><clipPath id="past"><rect x="0" y="0" width="${W}" height="${y(upTo)}"/></clipPath></defs>`,
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
const tex = (s: string) =>
  s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    // Function replacers: in a replacement string "$'" would mean "the rest of the input".
    .replace(/′/g, () => "$'$")
    .replace(/µ/g, () => "$\\mu$")
    .replace(/−/g, "--")

export function ladderTikz(fig: LadderFigure): string {
  const { upTo, segs, ticks, marks } = prepare(fig)
  const H = 14 // cm of paper for the whole time span
  const xs = [0, 7]
  const n = (v: number) => Number(v.toFixed(3))
  const y = (t: number) => n(-(t / upTo) * H)
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

/** Offer text to the reader as a file download. */
export function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
