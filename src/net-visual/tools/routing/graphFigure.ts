// The network at one moment, as data the page draws and as a figure for
// export (SVG or TikZ). Pure TypeScript, so the Node tests can check it.
import { ALARM, INK, MUTED, esc, hex, tex } from "../../components/figure.ts"
import { forwardingTo, showDist, stateAfter, type RoutingParams, type RoutingRun } from "../../core/routing.ts"

/** The drawing box: router positions are given in a 100 by 60 box and scaled by S. */
export const S = 6.4
export const W = 100 * S
export const H = 60 * S
export const R = 17

export interface GLink {
  a: number
  b: number
  /** null when the link has failed. */
  cost: number | null
}

export interface GArrow {
  from: number
  to: number
  loop: boolean
}

export interface GraphFigure {
  nodes: string[]
  pos: [number, number][]
  links: GLink[]
  /** Each router's next hop towards the destination. */
  tree: GArrow[]
  /** The line under each router, such as its cost to the destination. */
  labels: string[]
  dest: number | null
  caption: string
}

/** Every pair that is ever a link in this scenario, in a stable order. */
export function allPairs(p: RoutingParams): [number, number][] {
  const seen = new Set<string>()
  const out: [number, number][] = []
  for (const { a, b } of [...p.links, ...p.changes]) {
    const [x, y] = a < b ? [a, b] : [b, a]
    const k = `${x}-${y}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push([x, y])
    }
  }
  return out
}

/** The network after event i, with the forwarding tree towards dest. */
export function graphAt(run: RoutingRun, p: RoutingParams, i: number, dest: number): GraphFigure {
  const s = stateAfter(run, p, i)
  const e = run.events[i]
  const f = forwardingTo(e.hop, dest)
  const tree: GArrow[] = []
  e.hop.forEach((row, x) => {
    if (x !== dest && row[dest] >= 0) tree.push({ from: x, to: row[dest], loop: f.looping.has(x) && f.looping.has(row[dest]) })
  })
  return {
    nodes: p.nodes,
    pos: p.pos,
    links: allPairs(p).map(([a, b]) => ({ a, b, cost: s.cost[a][b] >= 0 ? s.cost[a][b] : null })),
    tree,
    labels: p.nodes.map((_, x) => (x === dest ? "destination" : `cost ${showDist(e.dist[x][dest], p.infinity)}`)),
    dest,
    caption: "",
  }
}

export const px = (q: [number, number]): [number, number] => [q[0] * S, q[1] * S]

/** A segment from a to b, shortened by r at both ends and moved sideways by off (to the right of a to b). */
export function segment(a: [number, number], b: [number, number], r: number, off = 0) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const nx = -uy * off
  const ny = ux * off
  return {
    x1: a[0] + ux * r + nx,
    y1: a[1] + uy * r + ny,
    x2: b[0] - ux * r + nx,
    y2: b[1] - uy * r + ny,
    ux,
    uy,
    len,
  }
}

/**
 * Whether a router's label goes above it rather than below: above when most
 * of its links leave downwards, so that the label does not sit on a link.
 */
export function labelAbove(fig: Pick<GraphFigure, "links" | "pos">, i: number): boolean {
  let sy = 0
  for (const l of fig.links) {
    const j = l.a === i ? l.b : l.b === i ? l.a : -1
    if (j < 0) continue
    const dx = fig.pos[j][0] - fig.pos[i][0]
    const dy = fig.pos[j][1] - fig.pos[i][1]
    sy += dy / (Math.hypot(dx, dy) || 1)
  }
  return sy > 0.3
}

/** The baseline of a router's label, for a router of radius r drawn at y, with text scaled by k. */
export const labelY = (fig: Pick<GraphFigure, "links" | "pos">, i: number, y: number, r = R, k = 1) =>
  labelAbove(fig, i) ? y - r - 6 * k : y + r + 14 * k

const n1 = (v: number) => v.toFixed(1)

export function graphSvg(fig: GraphFigure): string {
  const TREE = hex("var(--nv-busy)")
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 40}" height="${H + 64}" viewBox="-20 -20 ${W + 40} ${H + 64}" font-family="Newsreader, Georgia, serif">`,
    `<title>${esc(fig.caption)}</title>`,
    `<rect x="-20" y="-20" width="100%" height="100%" fill="#fffbf0"/>`,
    `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>`,
  ]
  for (const l of fig.links) {
    const s = segment(px(fig.pos[l.a]), px(fig.pos[l.b]), 0)
    out.push(
      `<line x1="${n1(s.x1)}" y1="${n1(s.y1)}" x2="${n1(s.x2)}" y2="${n1(s.y2)}" stroke="${MUTED}" stroke-width="1.5"${l.cost === null ? ' stroke-dasharray="5 4"' : ""}/>`,
    )
  }
  for (const t of fig.tree) {
    const s = segment(px(fig.pos[t.from]), px(fig.pos[t.to]), R + 3, 5)
    const c = t.loop ? ALARM : TREE
    out.push(
      `<line x1="${n1(s.x1)}" y1="${n1(s.y1)}" x2="${n1(s.x2)}" y2="${n1(s.y2)}" stroke="${c}" stroke-width="2.5" marker-end="url(#a)"/>`,
    )
  }
  for (const l of fig.links) {
    const [ax, ay] = px(fig.pos[l.a])
    const [bx, by] = px(fig.pos[l.b])
    const text = l.cost === null ? "×" : String(l.cost)
    out.push(
      `<text x="${n1((ax + bx) / 2)}" y="${n1((ay + by) / 2)}" dy="0.35em" text-anchor="middle" font-size="13" fill="${l.cost === null ? ALARM : INK}" stroke="#fffbf0" stroke-width="4" paint-order="stroke">${text}</text>`,
    )
  }
  fig.nodes.forEach((name, i) => {
    const [x, y] = px(fig.pos[i])
    out.push(
      `<circle cx="${n1(x)}" cy="${n1(y)}" r="${R}" fill="#fffbf0" stroke="${INK}" stroke-width="${i === fig.dest ? 3 : 1.5}"/>`,
      `<text x="${n1(x)}" y="${n1(y)}" dy="0.35em" text-anchor="middle" font-size="15" fill="${INK}">${esc(name)}</text>`,
      `<text x="${n1(x)}" y="${n1(labelY(fig, i, y))}" text-anchor="middle" font-size="11" fill="${MUTED}" stroke="#fffbf0" stroke-width="4" paint-order="stroke">${esc(fig.labels[i] ?? "")}</text>`,
    )
  })
  out.push(`<text x="${W / 2}" y="${H + 36}" text-anchor="middle" font-size="12" fill="${INK}">${esc(fig.caption)}</text>`, `</svg>`)
  return out.join("\n")
}

export function graphTikz(fig: GraphFigure): string {
  // TikZ's y axis points up; 1 cm per 10 units of the 100 by 60 box.
  const at = (i: number) => `(${(fig.pos[i][0] / 10).toFixed(2)},${(-fig.pos[i][1] / 10).toFixed(2)})`
  const L: string[] = [
    "% Exported from net-visual. Compile with pdflatex.",
    "\\documentclass[tikz,border=6pt]{standalone}",
    `\\definecolor{nvtree}{HTML}{${hex("var(--nv-busy)").slice(1).toUpperCase()}}`,
    `\\definecolor{nvalarm}{HTML}{${ALARM.slice(1).toUpperCase()}}`,
    "\\usetikzlibrary{arrows.meta}",
    "\\begin{document}",
    "\\begin{tikzpicture}[font=\\sffamily\\small, router/.style={circle, draw, fill=white, minimum size=8mm, inner sep=0pt}]",
  ]
  fig.nodes.forEach((name, i) => L.push(`  \\node[router${i === fig.dest ? ", very thick" : ""}] (n${i}) at ${at(i)} {${tex(name)}};`))
  for (const l of fig.links) {
    const label = l.cost === null ? "\\(\\times\\)" : String(l.cost)
    L.push(
      `  \\draw[black!60${l.cost === null ? ", dashed" : ""}] (n${l.a}) -- node[fill=white, inner sep=1pt, font=\\sffamily\\footnotesize${l.cost === null ? ", text=nvalarm" : ""}] {${label}} (n${l.b});`,
    )
  }
  for (const t of fig.tree)
    L.push(
      `  \\draw[${t.loop ? "nvalarm" : "nvtree"}, line width=1.2pt, -{Stealth[length=2.5mm]}] (n${t.from}) to[bend right=12] (n${t.to});`,
    )
  fig.nodes.forEach((_, i) => {
    const [x, y] = fig.pos[i]
    const above = labelAbove(fig, i)
    const ly = (-y / 10 + (above ? 0.5 : -0.5)).toFixed(2)
    L.push(
      `  \\node[anchor=${above ? "south" : "north"}, fill=white, inner sep=1pt, black!65, font=\\sffamily\\scriptsize] at (${(x / 10).toFixed(2)},${ly}) {${tex(fig.labels[i] ?? "")}};`,
    )
  })
  L.push(`  \\node[anchor=north, font=\\sffamily\\small] at (5,-6.9) {${tex(fig.caption)}};`)
  L.push("\\end{tikzpicture}", "\\end{document}", "")
  return L.join("\n")
}
