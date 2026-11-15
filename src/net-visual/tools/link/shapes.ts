// Plain shapes that the page draws in theme colours and the exports draw as
// SVG or TikZ, so the three link-layer figures share one renderer. Pure
// TypeScript, so the Node tests can check it.
import { ALARM, INK, MUTED, esc, tex } from "../../components/figure.ts"

/**
 * Colours by role. Besides ink, quieter ink and the page: the four meaning
 * colours (ok got there, busy under way, again, alarm lost or wrong), the
 * highlighter (mark: changed or current) and the code ground (a grey
 * band). Stations are told apart by their row, place or name, not colour.
 */
export type Ink = "ink" | "muted" | "alarm" | "surface" | "ok" | "busy" | "again" | "mark" | "ground"

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill?: Ink; stroke?: Ink; opacity?: number; dashed?: boolean }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: Ink; width?: number; dashed?: boolean; arrow?: boolean }
  | {
      kind: "text"
      x: number
      y: number
      text: string
      size: number
      anchor: "start" | "middle" | "end"
      fill: Ink
      bold?: boolean
      mono?: boolean
    }
  | { kind: "poly"; points: [number, number][]; fill?: Ink; stroke?: Ink; opacity?: number; dashed?: boolean }
  | { kind: "circle"; cx: number; cy: number; r: number; fill?: Ink; stroke?: Ink; opacity?: number; dashed?: boolean }

export interface ShapeFigure {
  w: number
  h: number
  shapes: Shape[]
  caption: string
}

export const CSS: Record<Ink, string> = {
  ink: "var(--foreground)",
  muted: "var(--muted-foreground)",
  alarm: "var(--nv-bad)",
  surface: "var(--background)",
  ok: "var(--nv-ok)",
  busy: "var(--nv-busy)",
  again: "var(--nv-again)",
  mark: "var(--nv-mark)",
  ground: "var(--muted)",
}

/** The light theme, so exports read on white paper. */
export const PAPER: Record<Ink, string> = {
  ink: INK,
  muted: MUTED,
  alarm: ALARM,
  surface: "#f6f5f2",
  ok: "#3d6f48",
  busy: "#6b5592",
  again: "#8a6417",
  mark: "#ebe1bd",
  ground: "#ecebe6",
}

/** Clips a polygon to the band lo ≤ y ≤ hi (Sutherland and Hodgman, one edge at a time). */
export function clipY(points: [number, number][], lo: number, hi: number): [number, number][] {
  const edge = (pts: [number, number][], inside: (p: [number, number]) => boolean, y: number) => {
    const out: [number, number][] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const cross = (): [number, number] => [a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y]
      if (inside(a)) {
        out.push(a)
        if (!inside(b)) out.push(cross())
      } else if (inside(b)) out.push(cross())
    }
    return out
  }
  return edge(
    edge(points, (p) => p[1] >= lo, lo),
    (p) => p[1] <= hi,
    hi,
  )
}

const n1 = (v: number) => Number(v.toFixed(1))

export function figSvg(fig: ShapeFigure): string {
  const P = PAPER
  const fill = (i?: Ink) => (i ? P[i] : "none")
  const common = (s: { fill?: Ink; stroke?: Ink; opacity?: number; dashed?: boolean }) =>
    `fill="${fill(s.fill)}"${s.opacity !== undefined ? ` fill-opacity="${s.opacity}"` : ""} stroke="${fill(s.stroke)}"${s.dashed ? ' stroke-dasharray="3 3"' : ""}`
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fig.w + 20}" height="${fig.h + 40}" viewBox="-10 -10 ${fig.w + 20} ${fig.h + 40}" font-family="Newsreader, Georgia, serif">`,
    `<title>${esc(fig.caption)}</title>`,
    `<rect x="-10" y="-10" width="100%" height="100%" fill="#f6f5f2"/>`,
    `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${MUTED}"/></marker></defs>`,
  ]
  for (const s of fig.shapes) {
    if (s.kind === "rect") out.push(`<rect x="${n1(s.x)}" y="${n1(s.y)}" width="${n1(s.w)}" height="${n1(s.h)}" ${common(s)}/>`)
    else if (s.kind === "poly") out.push(`<polygon points="${s.points.map(([x, y]) => `${n1(x)},${n1(y)}`).join(" ")}" ${common(s)}/>`)
    else if (s.kind === "circle") out.push(`<circle cx="${n1(s.cx)}" cy="${n1(s.cy)}" r="${n1(s.r)}" ${common(s)}/>`)
    else if (s.kind === "line")
      out.push(
        `<line x1="${n1(s.x1)}" y1="${n1(s.y1)}" x2="${n1(s.x2)}" y2="${n1(s.y2)}" stroke="${P[s.stroke]}" stroke-width="${s.width ?? 1.2}"${s.dashed ? ' stroke-dasharray="3 3"' : ""}${s.arrow ? ' marker-end="url(#a)"' : ""}/>`,
      )
    else
      out.push(
        `<text x="${n1(s.x)}" y="${n1(s.y)}" text-anchor="${s.anchor}" font-size="${s.size}" fill="${P[s.fill]}"${s.bold ? ' font-weight="bold"' : ""}${s.mono ? ` font-family="'IBM Plex Mono', Menlo, monospace"` : ""}>${esc(s.text)}</text>`,
      )
  }
  out.push(
    `<text x="${fig.w / 2}" y="${fig.h + 22}" text-anchor="middle" font-size="12" fill="${INK}">${esc(fig.caption)}</text>`,
    `</svg>`,
  )
  return out.join("\n")
}

export function figTikz(fig: ShapeFigure): string {
  // 1 cm per 40 units; TikZ's y axis points up.
  const c = (x: number, y: number) => `(${(x / 40).toFixed(2)},${(-y / 40).toFixed(2)})`
  const col = (i: Ink) => (i === "surface" ? "white" : `nv${i}`)
  const opts = (s: { fill?: Ink; stroke?: Ink; opacity?: number; dashed?: boolean }) =>
    [
      s.fill ? `fill=${col(s.fill)}` : "",
      s.fill && s.opacity !== undefined ? `fill opacity=${s.opacity}` : "",
      s.stroke ? `draw=${col(s.stroke)}` : "",
      s.dashed ? "dashed" : "",
    ]
      .filter(Boolean)
      .join(", ")
  const L = [
    "% Exported from net-visual. Compile with pdflatex.",
    "\\documentclass[tikz,border=6pt]{standalone}",
    ...(Object.keys(PAPER) as Ink[])
      .filter((i) => i !== "surface")
      .map((i) => `\\definecolor{nv${i}}{HTML}{${PAPER[i].slice(1).toUpperCase()}}`),
    "\\usetikzlibrary{arrows.meta}",
    "\\begin{document}",
    "\\begin{tikzpicture}[font=\\sffamily]",
  ]
  for (const s of fig.shapes) {
    if (s.kind === "rect") L.push(`  \\path[${opts(s)}] ${c(s.x, s.y)} rectangle ${c(s.x + s.w, s.y + s.h)};`)
    else if (s.kind === "poly") {
      if (s.points.length > 2) L.push(`  \\path[${opts(s)}] ${s.points.map(([x, y]) => c(x, y)).join(" -- ")} -- cycle;`)
    } else if (s.kind === "circle") L.push(`  \\path[${opts(s)}] ${c(s.cx, s.cy)} circle (${(s.r / 40).toFixed(2)});`)
    else if (s.kind === "line")
      L.push(
        `  \\draw[${[col(s.stroke), `line width=${((s.width ?? 1.2) * 0.4).toFixed(2)}pt`, s.dashed ? "dashed" : "", s.arrow ? "-{Stealth[length=4pt]}" : ""].filter(Boolean).join(", ")}] ${c(s.x1, s.y1)} -- ${c(s.x2, s.y2)};`,
      )
    else {
      const anchor = s.anchor === "start" ? "anchor=base west" : s.anchor === "end" ? "anchor=base east" : "anchor=base"
      const size = s.size <= 10 ? "\\scriptsize" : s.size <= 12 ? "\\footnotesize" : "\\small"
      L.push(
        `  \\node[${anchor}, text=${col(s.fill)}, inner sep=0pt] at ${c(s.x, s.y)} {${size}${s.bold ? "\\bfseries" : ""}${s.mono ? "\\ttfamily" : ""} ${tex(s.text)}};`,
      )
    }
  }
  L.push(`  \\node[anchor=north] at ${c(fig.w / 2, fig.h + 8)} {\\small ${tex(fig.caption)}};`, "\\end{tikzpicture}", "\\end{document}", "")
  return L.join("\n")
}
