// Two figures of one page load. The streams view gives each object a row
// and marks, packet by packet, when its bytes arrived at the client and when
// they reached the browser, with the wait between in red: head-of-line
// blocking made visible. The ladder draws every handshake message, request
// and data packet from its sending to its arrival. Plain shapes, so the page
// and the SVG and TikZ exports draw the same figures.
import { fmtNs, progressAt, type HttpParams, type HttpRun } from "../../core/http.ts"
import { station, type Shape, type ShapeFigure } from "../link/shapes.ts"

export interface HttpFigure extends ShapeFigure {
  summary: string
}

const NICE = [1, 2, 5]
/** A tick step near span / n, from 1, 2 and 5 times a power of ten. */
export function niceStep(span: number, n: number): number {
  const raw = span / Math.max(1, n)
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const k of NICE) if (k * p >= raw) return k * p
  return 10 * p
}

const kB = (b: number) => (b >= 10_000 ? `${Math.round(b / 1000)} kB` : `${Number((b / 1000).toFixed(1))} kB`)

/** Where a lost packet would have arrived. */
const dueAt = (p: HttpParams, depart: number) => depart + (p.rtt_us * 1000) / 2

function summaryAt(run: HttpRun, t: number): string {
  const { arrived, delivered } = progressAt(run, t)
  const done = run.objects.filter((o) => o.done_ns <= t).length
  const held = run.objects.filter((_, o) => arrived[o] > delivered[o]).length
  const lost = run.packets.filter((q) => q.lost && q.depart_ns <= t).length
  const parts = [`${done} of ${run.objects.length} objects complete`]
  if (lost) parts.push(`${lost} packet${lost === 1 ? "" : "s"} lost so far`)
  parts.push(held ? `${held} stream${held === 1 ? "" : "s"} holding data behind a gap` : "nothing held")
  return parts.join("; ")
}

/** The streams view at time t (ns). */
export function streamsFigure(p: HttpParams, run: HttpRun, t: number, width: number): HttpFigure {
  const w = Math.max(320, width)
  const narrow = w < 560
  const n = run.objects.length
  const labelW = narrow ? 74 : 112
  const pctW = narrow ? 34 : 44
  const left = labelW + 6
  const right = w - pctW - 4
  const top = narrow ? 44 : 34
  const rowH = narrow ? 26 : 28
  const h = top + n * rowH + 34
  const tEnd = Math.max(1, run.stats.plt_ns) * 1.02
  const sx = (x: number) => left + (Math.min(x, tEnd) / tEnd) * (right - left)
  const s: Shape[] = []
  const fs = narrow ? 9 : 10

  // Legend.
  const legend = narrow
    ? ["upper ticks: arrived · lower: delivered", "red: held behind a gap · ×: lost"]
    : ["upper ticks: arrived at the client · lower ticks: delivered to the browser · red: held behind a gap · ×: lost"]
  legend.forEach((line, i) => s.push({ kind: "text", x: left, y: 12 + i * 12, text: line, size: fs, anchor: "start", fill: "muted" }))

  // Time axis.
  const step = niceStep(tEnd / 1e6, narrow ? 4 : 8) * 1e6
  const axisY = top + n * rowH + 4
  s.push({ kind: "line", x1: left, y1: axisY, x2: right, y2: axisY, stroke: "muted" })
  for (let x = 0; x <= tEnd; x += step) {
    s.push({ kind: "line", x1: sx(x), y1: axisY, x2: sx(x), y2: axisY + 4, stroke: "muted" })
    s.push({ kind: "text", x: sx(x), y: axisY + 15, text: `${Math.round(x / 1e6)}`, size: fs, anchor: "middle", fill: "muted" })
  }
  s.push({ kind: "text", x: right, y: axisY + 28, text: "time, ms", size: fs, anchor: "end", fill: "muted" })

  // The moments of loss, across every row: under TCP every stream can freeze from here.
  for (const q of run.packets) {
    if (!q.lost) continue
    const due = dueAt(p, q.depart_ns)
    if (due > t) continue
    s.push({ kind: "line", x1: sx(due), y1: top - 2, x2: sx(due), y2: axisY, stroke: "alarm", dashed: true, width: 0.6 })
  }

  const { delivered } = progressAt(run, t)
  run.objects.forEach((o, i) => {
    const y = top + i * rowH
    const mid = y + rowH / 2
    const ink = station(i)
    const name = narrow && o.name.length > 11 ? `${o.name.slice(0, 10)}…` : o.name
    s.push({ kind: "text", x: labelW, y: mid - 1, text: name, size: fs + 1, anchor: "end", fill: "ink", mono: true })
    s.push({ kind: "text", x: labelW, y: mid + 10, text: kB(o.bytes), size: fs - 1, anchor: "end", fill: "muted" })
    s.push({ kind: "line", x1: left, y1: mid, x2: right, y2: mid, stroke: "muted", width: 0.3 })
    if (o.requested_ns <= t)
      s.push({ kind: "line", x1: sx(o.requested_ns), y1: y + 3, x2: sx(o.requested_ns), y2: y + rowH - 3, stroke: "muted", width: 1 })
    for (const q of run.packets) {
      if (q.obj !== i) continue
      if (q.lost) {
        const due = dueAt(p, q.depart_ns)
        if (due <= t) {
          const cx = sx(due)
          const r = 3.5
          s.push({ kind: "line", x1: cx - r, y1: y + 4 - r + 3, x2: cx + r, y2: y + 4 + r + 3, stroke: "alarm", width: 1.6 })
          s.push({ kind: "line", x1: cx - r, y1: y + 4 + r + 3, x2: cx + r, y2: y + 4 - r + 3, stroke: "alarm", width: 1.6 })
        }
        continue
      }
      const a = q.arrive_ns!
      if (a > t) continue
      s.push({ kind: "line", x1: sx(a), y1: y + 3, x2: sx(a), y2: mid - 2, stroke: ink, width: 1 })
      const d = q.delivered_ns!
      if (d > a) s.push({ kind: "line", x1: sx(a), y1: mid, x2: sx(Math.min(d, t)), y2: mid, stroke: "alarm", width: 2.2 })
      if (d <= t) s.push({ kind: "line", x1: sx(d), y1: mid + 2, x2: sx(d), y2: y + rowH - 3, stroke: ink, width: 1.6 })
    }
    const pct = Math.round((100 * delivered[i]) / o.bytes)
    s.push({
      kind: "text",
      x: w - 4,
      y: mid + 4,
      text: `${pct}%`,
      size: fs + 1,
      anchor: "end",
      fill: pct === 100 ? "ink" : "muted",
      bold: pct === 100,
    })
  })

  // The clock.
  s.push({ kind: "line", x1: sx(t), y1: top - 4, x2: sx(t), y2: axisY, stroke: "ink", width: 1 })
  return { w, h, shapes: s, caption: "", summary: summaryAt(run, t) }
}

/** The packet ladder up to time t (ns): client on the left, server on the right, time running down. */
export function ladderFigure(p: HttpParams, run: HttpRun, t: number, width: number): HttpFigure {
  const w = Math.max(320, width)
  const narrow = w < 560
  const fs = narrow ? 9 : 10
  const axisW = narrow ? 40 : 52
  const cx = axisW + (narrow ? 70 : 150)
  const sxv = w - (narrow ? 70 : 150)
  const top = 34
  const H = narrow ? 560 : 600
  const h = top + H + 24
  const tEnd = Math.max(1, run.stats.plt_ns) * 1.02
  const sy = (x: number) => top + (Math.min(x, tEnd) / tEnd) * H
  const s: Shape[] = []

  s.push({ kind: "text", x: cx, y: 14, text: "client", size: fs + 2, anchor: "middle", fill: "ink", bold: true })
  s.push({ kind: "text", x: sxv, y: 14, text: "server", size: fs + 2, anchor: "middle", fill: "ink", bold: true })
  s.push({ kind: "line", x1: cx, y1: top - 8, x2: cx, y2: top + H, stroke: "muted" })
  s.push({ kind: "line", x1: sxv, y1: top - 8, x2: sxv, y2: top + H, stroke: "muted" })

  const step = niceStep(tEnd / 1e6, 8) * 1e6
  for (let x = 0; x <= tEnd; x += step) {
    s.push({ kind: "line", x1: axisW - 4, y1: sy(x), x2: axisW, y2: sy(x), stroke: "muted" })
    s.push({ kind: "text", x: axisW - 6, y: sy(x) + 3, text: `${Math.round(x / 1e6)}`, size: fs, anchor: "end", fill: "muted" })
  }
  s.push({ kind: "line", x1: axisW, y1: top, x2: axisW, y2: top + H, stroke: "muted" })
  s.push({ kind: "text", x: 2, y: top - 12, text: "ms", size: fs, anchor: "start", fill: "muted" })

  /** A message from one column to the other, cut off at the clock. */
  const arrow = (fromClient: boolean, t0: number, t1: number, stroke: Extract<Shape, { kind: "line" }>) => {
    if (t0 > t) return null
    const x0 = fromClient ? cx : sxv
    const x1 = fromClient ? sxv : cx
    const f = t1 <= t ? 1 : (t - t0) / Math.max(1, t1 - t0)
    return { ...stroke, x1: x0, y1: sy(t0), x2: x0 + (x1 - x0) * f, y2: sy(t0 + (t1 - t0) * f), arrow: f === 1 && stroke.arrow }
  }

  // Labels for handshakes and requests, skipping any that would overlap the one above.
  let lastLabel = -Infinity
  const many = run.conns.length > 1
  for (const m of run.msgs) {
    const line = arrow(m.up, m.send_ns, m.arrive_ns, {
      kind: "line",
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      stroke: m.request ? "ink" : "muted",
      width: m.request ? 1.2 : 1,
      arrow: true,
    })
    if (!line) continue
    s.push(line)
    const y = sy(m.send_ns)
    if (y - lastLabel >= 11) {
      const text = (many ? `[${m.conn + 1}] ` : "") + m.label
      const max = narrow ? 14 : 30
      const short = text.length > max ? `${text.slice(0, max - 1)}…` : text
      s.push({
        kind: "text",
        x: m.up ? cx - 4 : sxv + 4,
        y: y + 3,
        text: short,
        size: fs - 1,
        anchor: m.up ? "end" : "start",
        fill: m.request ? "ink" : "muted",
      })
      lastLabel = y
    }
  }

  for (const q of run.packets) {
    if (q.start_ns > t) continue
    const ink = station(q.obj)
    if (q.lost) {
      const due = dueAt(p, q.depart_ns)
      const mid = q.depart_ns + (due - q.depart_ns) / 2
      const line = arrow(false, q.depart_ns, mid, { kind: "line", x1: 0, y1: 0, x2: 0, y2: 0, stroke: ink, width: 1 })
      if (line) s.push(line)
      if (mid <= t) {
        const x = (cx + sxv) / 2
        const y = sy(mid)
        s.push({ kind: "line", x1: x - 4, y1: y - 4, x2: x + 4, y2: y + 4, stroke: "alarm", width: 1.8 })
        s.push({ kind: "line", x1: x - 4, y1: y + 4, x2: x + 4, y2: y - 4, stroke: "alarm", width: 1.8 })
      }
      if (q.detected_ns !== null && q.detected_ns <= t) {
        s.push({ kind: "circle", cx: sxv, cy: sy(q.detected_ns), r: 3, fill: "alarm" })
        s.push({
          kind: "text",
          x: sxv + 6,
          y: sy(q.detected_ns) + 3,
          text: `lost: ${q.detected_by}`,
          size: fs - 1,
          anchor: "start",
          fill: "alarm",
        })
      }
      continue
    }
    const line = arrow(false, q.depart_ns, q.arrive_ns!, {
      kind: "line",
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      stroke: ink,
      width: 1,
      dashed: q.retx_of !== null,
    })
    if (line) s.push(line)
  }

  s.push({ kind: "line", x1: axisW, y1: sy(t), x2: w - 4, y2: sy(t), stroke: "ink", width: 0.6, dashed: true })
  const sent = run.packets.filter((q) => q.start_ns <= t).length
  const summary = `${sent} data packet${sent === 1 ? "" : "s"} sent by ${fmtNs(t)}; ${summaryAt(run, t)}`
  return { w, h, shapes: s, caption: "", summary }
}
