// The path at one moment, sources to receiver, as a list of plain shapes that
// the page draws in theme colours and the exports draw as SVG or TikZ. Pure
// TypeScript, so the Node tests can check it.
import { ALARM, INK, MUTED, esc, hex, tex } from "../../components/figure.ts"
import { bps, propUs, us, type QueueParams, type QueueRun } from "../../core/queue.ts"

export const W = 640
export const H = 236

/*
 * Sources are told apart without colour, which is kept for meaning: the
 * first two in ink and quieter ink, the next two the same as outlines
 * (rings in a dot chart, dashed in a line chart). Names say which is which.
 */
export const FLOW_COLORS = ["var(--foreground)", "var(--muted-foreground)", "var(--foreground)", "var(--muted-foreground)"]
export const FLOW_DASH = [undefined, undefined, "7 3", "2 3"]
export const FLOW_HOLLOW = [false, false, true, true]

/** Colours by role, so each renderer can map them to its own palette. */
export type Ink = "ink" | "muted" | "alarm" | "surface" | "flow0" | "flow1" | "flow2" | "flow3"

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill?: Ink; stroke?: Ink; opacity?: number; dashed?: boolean }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: Ink; width?: number; dashed?: boolean; arrow?: boolean }
  | { kind: "text"; x: number; y: number; text: string; size: number; anchor: "start" | "middle" | "end"; fill: Ink; bold?: boolean }

export interface PathFigure {
  flows: {
    name: string
    shaper: null | { kind: "token" | "leaky"; level: number; held: number; label: string }
  }[]
  /** Flows of the packets being processed. */
  processing: number[]
  /** Waiting packets in the order the discipline will send them. */
  waiting: { flow: number; id: number }[]
  sending: { flow: number; id: number; frac: number } | null
  /** Packets on the wire: the fractions of the way along of their last and first bits. */
  wire: { flow: number; id: number; tail: number; head: number }[]
  delivered: number
  dropped: number
  /** A drop in the last moment, to flash where it happened. */
  flash: null | { flow: number; where: "shaper" | "buffer" }
  /** The link's rate, how the router chooses, and its room, as lines (wide figures join all but the first). */
  link: string[]
  caption: string
  selected: number | null
}

/** Where everything is at time t. */
export function pathAt(p: QueueParams, run: QueueRun, t: number, selected: number | null = null): PathFigure {
  const prop = propUs(p)
  const meanTrans = (8e6 * p.flows.reduce((a, f) => a + f.size_bytes, 0)) / p.flows.length / p.rate_bps
  const flows: PathFigure["flows"] = p.flows.map((f, k) => {
    if (f.shaper.kind === "none") return { name: f.name, shaper: null }
    const held = run.packets.filter((q) => q.flow === k && q.t_arrive <= t && q.t_shaped !== null && q.t_shaped > t && q.dropped === null)
    if (f.shaper.kind === "token") {
      const tokens = tokensAt(p, run, k, t)
      return {
        name: f.name,
        shaper: { kind: "token", level: tokens / f.shaper.bucket_bytes, held: held.length, label: `${Math.floor(tokens)} B` },
      }
    }
    const bytes = held.reduce((a, q) => a + q.size_bytes, 0)
    return {
      name: f.name,
      shaper: { kind: "leaky", level: Math.min(1, bytes / Math.max(1, f.shaper.bucket_bytes)), held: held.length, label: `${bytes} B` },
    }
  })
  const processing: number[] = []
  const waiting: { flow: number; id: number; key: number; key2: number }[] = []
  let sending: PathFigure["sending"] = null
  const wire: PathFigure["wire"] = []
  let delivered = 0
  let dropped = 0
  let flash: PathFigure["flash"] = null
  for (const q of run.packets) {
    if (q.dropped) {
      const at = q.dropped === "buffer" ? q.t_join! : q.t_arrive
      if (at <= t) {
        dropped++
        if (t - at < Math.max(meanTrans, 1)) flash = { flow: q.flow, where: q.dropped === "buffer" ? "buffer" : "shaper" }
      }
      continue
    }
    if (q.t_shaped === null || q.t_join === null || q.t_start === null || q.t_depart === null || q.t_reach === null) continue
    if (q.t_shaped <= t && t < q.t_join) processing.push(q.flow)
    else if (q.t_join <= t && t < q.t_start) {
      const key = p.discipline === "fifo" ? 0 : p.discipline === "priority" ? p.flows[q.flow].priority : q.tag
      waiting.push({ flow: q.flow, id: q.id, key, key2: q.id })
    } else if (q.t_start <= t && t < q.t_depart) sending = { flow: q.flow, id: q.id, frac: (t - q.t_start) / (q.t_depart - q.t_start) }
    if (prop > 0 && q.t_start <= t && t < q.t_reach) {
      const head = Math.min(1, (t - q.t_start) / prop)
      const tail = t < q.t_depart ? 0 : Math.min(1, (t - q.t_depart) / prop)
      if (head > tail) wire.push({ flow: q.flow, id: q.id, tail, head })
    }
    if (q.t_reach <= t) delivered++
  }
  waiting.sort((a, b) => a.key - b.key || a.key2 - b.key2)
  const name = {
    fifo: "first come, first served: in arrival order",
    priority: "urgent packets sent first",
    wfq: "the link shared by weight",
  }[p.discipline]
  const rate = bps(p.rate_bps)
  const per = rate.endsWith("Gb/s") ? "billion" : rate.endsWith("Mb/s") ? "million" : "thousand"
  return {
    flows,
    processing,
    waiting: waiting.map(({ flow, id }) => ({ flow, id })),
    sending,
    wire,
    delivered,
    dropped,
    flash,
    link: [`link: ${rate} (${per} bits a second)`, name, ...(p.buffer_pkts ? [`room for ${p.buffer_pkts} waiting`] : [])],
    caption: "",
    selected,
  }
}

/**
 * Tokens in flow k's bucket at time t: the value the model recorded at its
 * last token-bucket step (B1, which brings the bucket up to date first),
 * refilled since, capped at the bucket.
 */
export function tokensAt(p: QueueParams, run: QueueRun, k: number, t: number): number {
  const s = p.flows[k].shaper
  let level = s.bucket_bytes
  let at = 0
  for (const e of run.events) {
    if (e.t > t) break
    if (e.step === "B1" && e.tokens !== null && run.packets[e.packet].flow === k) {
      level = e.tokens
      at = e.t
    }
  }
  return Math.min(s.bucket_bytes, level + (s.rate_bps * (t - at)) / 8e6)
}

const flowInk = (k: number) => `flow${k % 4}` as Ink
/** A packet's block: filled for the first two sources, an outline for the next two. */
const block = (k: number, stroke?: Ink): { fill: Ink; stroke?: Ink } =>
  FLOW_HOLLOW[k % 4] ? { fill: "surface", stroke: stroke ?? flowInk(k) } : { fill: flowInk(k), stroke }

/** The vertical centre of flow k's row. */
const rowY = (k: number, n: number) => 118 + (k - (n - 1) / 2) * Math.min(46, 168 / Math.max(1, n))

export const SLOTS = 13

/** The part of the box a figure uses: one flow needs only a band around the router. */
export const pathBox = (fig: PathFigure, narrow = false, k = 1) => {
  const w = geometry(fig, narrow, k).W
  // Packed, the line's label takes a row of its own below the router.
  const extra = narrow ? Math.round(15 * k) : 0
  return fig.flows.length === 1 ? { y0: 26, h: 192 + extra, w } : { y0: 0, h: H + 18 + extra, w }
}

/**
 * Where the parts go. The wide layout fills 640 units; the narrow one, for
 * phones, packs the same parts into about 400 so that, scaled to a phone's
 * width, the text stays legible.
 */
function geometry(fig: PathFigure, narrow: boolean, k = 1) {
  if (!narrow) return { W, RX: 176, RX2: 452, WIRE0: 470, WIRE1: 588, bx: 100, below: false }
  const n = fig.flows.length
  const anyShaper = fig.flows.some((f) => f.shaper)
  const below = n === 1
  const nameEnd = below ? 30 : 30 + Math.max(...fig.flows.map((f) => f.name.length)) * 6.6 * k + 4
  const bx = nameEnd + 6
  const RX = Math.round(anyShaper ? bx + 34 + 18 : below ? Math.max(56, 12 + 34 * k) : nameEnd + 20)
  const RX2 = RX + 234
  const WIRE0 = RX2 + 8
  const WIRE1 = WIRE0 + 52
  return { W: Math.round(WIRE1 + Math.max(48, 28 + 21 * k)), RX, RX2, WIRE0, WIRE1, bx, below }
}

/** The figure as shapes. `k` enlarges text for narrow screens; `narrow` packs the parts closer. */
export function pathShapes(fig: PathFigure, k = 1, narrow = false): Shape[] {
  const out: Shape[] = []
  const n = fig.flows.length
  const fs = (s: number) => s * k
  const { RX, RX2, WIRE0, WIRE1, bx, below } = geometry(fig, narrow, k)
  const MID = 118
  const anyShaper = fig.flows.some((f) => f.shaper)

  // Sources and shapers.
  fig.flows.forEach((f, i) => {
    const y = rowY(i, n)
    out.push({ kind: "rect", x: 6, y: y - 9, w: 18, h: 18, ...block(i, "ink") })
    // One flow is just "source"; several are told apart by name.
    const name = n === 1 ? "source" : f.name
    let from: number
    if (below) {
      out.push({ kind: "text", x: 4, y: y + 9 + 14 * k, text: name, size: fs(12), anchor: "start", fill: "ink" })
      from = 28
    } else {
      out.push({ kind: "text", x: 30, y: y + 4, text: name, size: fs(12), anchor: "start", fill: "ink" })
      from = 30 + name.length * 7 * k + 4
    }
    if (f.shaper) {
      const bh = n === 1 ? 44 : Math.max(12, Math.min(46, 168 / n) - 28)
      out.push({ kind: "rect", x: bx, y: y - bh / 2, w: 34, h: bh, stroke: "ink", fill: "surface" })
      const lh = Math.max(0, Math.min(1, f.shaper.level)) * (bh - 2)
      if (lh > 0) out.push({ kind: "rect", x: bx + 1, y: y + bh / 2 - 1 - lh, w: 32, h: lh, fill: "muted" })
      out.push({ kind: "text", x: bx + 17, y: y - bh / 2 - 4, text: f.shaper.label, size: fs(12), anchor: "middle", fill: "muted" })
      const flashing = fig.flash?.where === "shaper" && fig.flash.flow === i
      if (flashing || f.shaper.held > 0)
        out.push({
          kind: "text",
          x: bx + 17,
          y: y + bh / 2 + 11 * k,
          text: flashing ? "✕ dropped" : `${f.shaper.held} held`,
          size: fs(12),
          anchor: "middle",
          fill: flashing ? "alarm" : "ink",
        })
      from = bx + 34
    }
    out.push({ kind: "line", x1: from, y1: y, x2: RX, y2: MID, stroke: "muted", arrow: true })
  })
  if (anyShaper) {
    const kinds = new Set(fig.flows.map((f) => f.shaper?.kind).filter(Boolean))
    const what = kinds.size === 2 ? "tokens or bytes held" : kinds.has("token") ? "tokens" : "bytes held"
    const sb = pathBox(fig, narrow, k)
    out.push({
      kind: "text",
      x: narrow ? 4 : bx + 17,
      y: sb.y0 + sb.h - 8 - 15 * k,
      text: `shaper (fill: ${what})`,
      size: fs(12),
      anchor: narrow ? "start" : "middle",
      fill: "muted",
    })
  }

  // What a coloured block is, in the picture rather than only in the caption.
  const box = pathBox(fig, narrow, k)
  out.push({
    kind: "text",
    x: 4,
    y: box.y0 + box.h - 8,
    text: n === 1 ? "Each filled block is one packet." : "Each block is one packet, coloured by the source it came from.",
    size: fs(12),
    anchor: "start",
    fill: "muted",
  })

  // The router: processing, then the queue, then the transmitter.
  out.push({ kind: "rect", x: RX, y: MID - 30, w: RX2 - RX, h: 60, stroke: "ink", fill: "surface" })
  out.push({ kind: "rect", x: RX + 6, y: MID - 14, w: 28, h: 28, stroke: "muted", dashed: true })
  fig.processing.slice(0, 4).forEach((f, j) => {
    out.push({ kind: "rect", x: RX + 9 + (j % 2) * 12, y: MID - 11 + Math.floor(j / 2) * 12, w: 10, h: 10, ...block(f) })
  })
  out.push({ kind: "text", x: RX + 20, y: MID + 46, text: "process", size: fs(12), anchor: "middle", fill: "muted" })

  const QX0 = RX + 42
  const QX1 = RX2 - 44
  const slot = (QX1 - QX0) / SLOTS
  const shown = fig.waiting.slice(0, SLOTS)
  shown.forEach((w, j) => {
    const x = QX1 - (j + 1) * slot
    out.push({
      kind: "rect",
      x: x + 1,
      y: MID - 13,
      w: slot - 2,
      h: 26,
      ...block(w.flow),
    })
    if (w.id === fig.selected) out.push({ kind: "rect", x: x - 1, y: MID - 16, w: slot + 2, h: 32, stroke: "ink" })
  })
  out.push({ kind: "line", x1: QX0, y1: MID - 15, x2: QX1, y2: MID - 15, stroke: "muted" })
  out.push({ kind: "line", x1: QX0, y1: MID + 15, x2: QX1, y2: MID + 15, stroke: "muted" })
  if (fig.waiting.length > SLOTS)
    out.push({
      kind: "text",
      x: QX0 + 2,
      y: MID - 20,
      text: `+${fig.waiting.length - SLOTS} more`,
      size: fs(12),
      anchor: "start",
      fill: "ink",
    })
  out.push({
    kind: "text",
    x: (QX0 + QX1) / 2,
    // Packed for a phone, the line's label goes one row lower, clear of "process" and "send".
    y: MID + 46 + (narrow ? 15 * k : 0),
    text: `${fig.waiting.length} waiting in line`,
    size: fs(12),
    anchor: "middle",
    fill: "muted",
  })
  if (fig.flash?.where === "buffer")
    out.push({ kind: "text", x: QX0 + 4, y: MID + 28, text: "✕ buffer full", size: fs(12), anchor: "start", fill: "alarm" })

  // The transmitter: how much of the packet is on the wire.
  const TX = RX2 - 36
  out.push({ kind: "rect", x: TX, y: MID - 14, w: 30, h: 28, stroke: "ink" })
  if (fig.sending) {
    out.push({ kind: "rect", x: TX + 1, y: MID - 13, w: 28 * (1 - fig.sending.frac), h: 26, ...block(fig.sending.flow) })
    if (fig.sending.id === fig.selected) out.push({ kind: "rect", x: TX - 2, y: MID - 17, w: 34, h: 34, stroke: "ink" })
  }
  out.push({ kind: "text", x: TX + 15, y: MID + 46, text: "send", size: fs(12), anchor: "middle", fill: "muted" })
  const lines = narrow ? fig.link : [fig.link[0], fig.link.slice(1).join(", ")]
  lines.forEach((text, j) =>
    out.push({
      kind: "text",
      x: (RX + RX2) / 2,
      y: MID - 38 - (lines.length - 1 - j) * 14 * k,
      text,
      size: fs(12),
      anchor: "middle",
      fill: "ink",
    }),
  )

  // The wire, and the receiver.
  out.push({ kind: "line", x1: RX2, y1: MID, x2: WIRE0, y2: MID, stroke: "muted" })
  out.push({ kind: "line", x1: WIRE0, y1: MID, x2: WIRE1, y2: MID, stroke: "ink", width: 1 })
  for (const w of fig.wire) {
    out.push({
      kind: "rect",
      x: WIRE0 + w.tail * (WIRE1 - WIRE0),
      y: MID - 7,
      w: Math.max(1.5, (w.head - w.tail) * (WIRE1 - WIRE0)),
      h: 14,
      ...block(w.flow, w.id === fig.selected ? "ink" : undefined),
    })
  }
  out.push({ kind: "text", x: (WIRE0 + WIRE1) / 2, y: MID + 46, text: "travel", size: fs(12), anchor: "middle", fill: "muted" })
  out.push({ kind: "rect", x: WIRE1 + 4, y: MID - 18, w: 40, h: 36, stroke: "ink", fill: "surface" })
  out.push({ kind: "text", x: WIRE1 + 24, y: MID + 4, text: String(fig.delivered), size: fs(12), anchor: "middle", fill: "ink" })
  out.push({ kind: "text", x: WIRE1 + 24, y: MID - 24, text: "arrived", size: fs(12), anchor: "middle", fill: "muted" })
  if (fig.dropped > 0)
    out.push({ kind: "text", x: WIRE1 + 24, y: MID + 34, text: `${fig.dropped} lost`, size: fs(12), anchor: "middle", fill: "alarm" })
  return out
}

const PALETTE: Record<Ink, string> = {
  ink: INK,
  muted: MUTED,
  alarm: ALARM,
  surface: "#f6f5f2",
  flow0: hex(FLOW_COLORS[0]),
  flow1: hex(FLOW_COLORS[1]),
  flow2: hex(FLOW_COLORS[2]),
  flow3: hex(FLOW_COLORS[3]),
}

/** The theme's colour for each role, for the page. */
export const CSS: Record<Ink, string> = {
  ink: "var(--foreground)",
  muted: "var(--muted-foreground)",
  alarm: "var(--nv-bad)",
  surface: "var(--background)",
  flow0: FLOW_COLORS[0],
  flow1: FLOW_COLORS[1],
  flow2: FLOW_COLORS[2],
  flow3: FLOW_COLORS[3],
}

const n1 = (v: number) => Number(v.toFixed(1))

export function pathSvg(fig: PathFigure): string {
  const { y0, h } = pathBox(fig)
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 20}" height="${h + 40}" viewBox="-10 ${y0 - 10} ${W + 20} ${h + 40}" font-family="Newsreader, Georgia, serif">`,
    `<title>${esc(fig.caption)}</title>`,
    `<rect x="-10" y="${y0 - 10}" width="100%" height="100%" fill="#f6f5f2"/>`,
    `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${MUTED}"/></marker></defs>`,
  ]
  for (const s of pathShapes(fig)) {
    if (s.kind === "rect")
      out.push(
        `<rect x="${n1(s.x)}" y="${n1(s.y)}" width="${n1(s.w)}" height="${n1(s.h)}" fill="${s.fill ? PALETTE[s.fill] : "none"}"${s.opacity ? ` fill-opacity="${s.opacity}"` : ""} stroke="${s.stroke ? PALETTE[s.stroke] : "none"}"${s.dashed ? ' stroke-dasharray="3 3"' : ""}/>`,
      )
    else if (s.kind === "line")
      out.push(
        `<line x1="${n1(s.x1)}" y1="${n1(s.y1)}" x2="${n1(s.x2)}" y2="${n1(s.y2)}" stroke="${PALETTE[s.stroke]}" stroke-width="${s.width ?? 1.2}"${s.dashed ? ' stroke-dasharray="3 3"' : ""}${s.arrow ? ' marker-end="url(#a)"' : ""}/>`,
      )
    else
      out.push(
        `<text x="${n1(s.x)}" y="${n1(s.y)}" text-anchor="${s.anchor}" font-size="${s.size}" fill="${PALETTE[s.fill]}"${s.bold ? ' font-weight="bold"' : ""}>${esc(s.text)}</text>`,
      )
  }
  out.push(`<text x="${W / 2}" y="${y0 + h + 22}" text-anchor="middle" font-size="12" fill="${INK}">${esc(fig.caption)}</text>`, `</svg>`)
  return out.join("\n")
}

export function pathTikz(fig: PathFigure): string {
  // 1 cm per 40 units; TikZ's y axis points up.
  const c = (x: number, y: number) => `(${(x / 40).toFixed(2)},${(-y / 40).toFixed(2)})`
  const col = (i: Ink) => (i === "surface" ? "white" : `nv${i}`)
  const L = [
    "% Exported from net-visual. Compile with pdflatex.",
    "\\documentclass[tikz,border=6pt]{standalone}",
    ...(Object.keys(PALETTE) as Ink[])
      .filter((i) => i !== "surface")
      .map((i) => `\\definecolor{nv${i}}{HTML}{${PALETTE[i].slice(1).toUpperCase()}}`),
    "\\usetikzlibrary{arrows.meta}",
    "\\begin{document}",
    "\\begin{tikzpicture}[font=\\sffamily]",
  ]
  for (const s of pathShapes(fig)) {
    if (s.kind === "rect") {
      const opts = [
        s.fill ? `fill=${col(s.fill)}` : "",
        s.opacity ? `fill opacity=${s.opacity}` : "",
        s.stroke ? `draw=${col(s.stroke)}` : "",
        s.dashed ? "dashed" : "",
      ].filter(Boolean)
      L.push(`  \\path[${opts.join(", ")}] ${c(s.x, s.y)} rectangle ${c(s.x + s.w, s.y + s.h)};`)
    } else if (s.kind === "line") {
      const opts = [`draw=${col(s.stroke)}`, s.dashed ? "dashed" : "", s.arrow ? "-{Stealth[length=2mm]}" : ""].filter(Boolean)
      L.push(`  \\draw[${opts.join(", ")}] ${c(s.x1, s.y1)} -- ${c(s.x2, s.y2)};`)
    } else {
      const anchor = { start: "base west", middle: "base", end: "base east" }[s.anchor]
      const size = s.size >= 12 ? "\\small" : s.size >= 11 ? "\\footnotesize" : "\\scriptsize"
      L.push(`  \\node[anchor=${anchor}, inner sep=0pt, text=${col(s.fill)}, font=\\sffamily${size}] at ${c(s.x, s.y)} {${tex(s.text)}};`)
    }
  }
  const { y0, h } = pathBox(fig)
  L.push(`  \\node[anchor=north, font=\\sffamily\\small] at ${c(W / 2, y0 + h + 6)} {${tex(fig.caption)}};`)
  L.push("\\end{tikzpicture}", "\\end{document}", "")
  return L.join("\n")
}

/** A one-line description of the moment, for captions. */
export const momentCaption = (title: string, t: number) => `${title} at ${us(t)}`
