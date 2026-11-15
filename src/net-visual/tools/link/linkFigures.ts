// The three link-layer pictures at one moment, as plain shapes: ALOHA's
// station rows, CSMA/CD's space-time diagram and the 802.11 map with its
// timeline. Pure TypeScript, so the Node tests can check it.
import {
  backoffsAt,
  caAt,
  caNear,
  fmtTime,
  type AirKind,
  type AlohaParams,
  type AlohaRun,
  type CaParams,
  type CaRun,
  type CdParams,
  type CdRun,
} from "../../core/link.ts"
import { clipY, station, type Ink, type Shape, type ShapeFigure } from "./shapes.ts"

/** A window of the run that follows the clock, keeping it three quarters of the way across. */
export function windowAt(t: number, span: number, total: number): [number, number] {
  const t0 = Math.max(0, Math.min(t - 0.75 * span, total - span))
  return [t0, t0 + span]
}

/** Round tick values between lo and hi, about count of them. */
export function ticks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(1, count)
  if (!(raw > 0)) return [lo]
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

const text = (x: number, y: number, s: string, o: Partial<Extract<Shape, { kind: "text" }>> = {}): Shape => ({
  kind: "text",
  x,
  y,
  text: s,
  size: 11.5,
  anchor: "start",
  fill: "muted",
  ...o,
})

export const stationName = (i: number) => `S${i + 1}`

// --- ALOHA -----------------------------------------------------------------

export interface AlohaFigure extends ShapeFigure {
  onAir: number
  delivered: number
  garbled: number
}

/** Station rows over a dozen frame times, frames drawn up to the clock, and the vulnerable window of the latest frame. */
export function alohaFigure(p: AlohaParams, run: AlohaRun, t: number, w: number): AlohaFigure {
  const F = p.frame_us
  const span = (w < 520 ? 8 : 12) * F
  const [t0, t1] = windowAt(t, span, (p.length + 1) * F)
  const left = 34
  const right = w - 8
  const n = p.stations
  // A key over the rows, so the colours and names are read in the picture, not only in the caption under it.
  const key: { swatch: null | { fill: Ink; opacity: number }; label: string }[] = [
    { swatch: null, label: `S1 to S${n}: stations, the computers sharing the channel` },
    { swatch: { fill: station(0), opacity: 0.9 }, label: "a frame that got through (#0 is the first)" },
    { swatch: { fill: "alarm", opacity: 0.75 }, label: "a frame lost: another overlapped it" },
    { swatch: { fill: "muted", opacity: 0.25 }, label: "vulnerable window" },
    { swatch: null, label: "air: everything a receiver hears" },
  ]
  const keyShapes: Shape[] = []
  let kx = 4
  let ky = 12
  for (const k of key) {
    const width = (k.swatch ? 20 : 0) + k.label.length * 5.6
    if (kx > 4 && kx + width > right) {
      kx = 4
      ky += 15
    }
    if (k.swatch) {
      keyShapes.push({ kind: "rect", x: kx, y: ky - 8, w: 14, h: 9, fill: k.swatch.fill, opacity: k.swatch.opacity })
      kx += 18
    }
    keyShapes.push(text(kx, ky, k.label, { size: 11, fill: "ink" }))
    kx += k.label.length * 5.6 + 16
  }
  const top = ky + 26
  const rowH = Math.max(10, Math.min(22, 176 / n))
  const chanY = top + n * rowH + 10
  const chanH = 18
  const h = chanY + chanH + 18
  const X = (u: number) => left + ((Math.min(t1, Math.max(t0, u)) - t0) / span) * (right - left)
  const shapes: Shape[] = []

  const started = run.frames.filter((f) => f.start_us <= t)
  const visible = started.filter((f) => f.start_us < t1 && f.end_us > t0)
  // A frame is lost as soon as another overlaps it, so by time t only frames started by then count.
  const hitBy = (i: number) => started.some((g) => g.id !== i && g.start_us < run.frames[i].end_us && run.frames[i].start_us < g.end_us)

  const focus = started[started.length - 1]
  if (focus) {
    const [a, b] = p.slotted ? [focus.start_us, focus.end_us] : [focus.start_us - F, focus.end_us]
    if (b > t0 && a < t1) {
      shapes.push({ kind: "rect", x: X(a), y: top, w: X(b) - X(a), h: n * rowH, fill: "muted", opacity: 0.14 })
      const label = p.slotted
        ? `only a frame in this same slot ruins frame #${focus.id}`
        : `any frame starting in this band ruins frame #${focus.id}`
      const mid = (X(a) + X(b)) / 2
      shapes.push(
        text(Math.min(right, Math.max(left, mid)), top - 6, label, {
          anchor: mid < left + 60 ? "start" : mid > right - 60 ? "end" : "middle",
        }),
      )
    }
  }
  if (p.slotted)
    for (let k = Math.ceil(t0 / F); k * F <= t1; k++)
      shapes.push({ kind: "line", x1: X(k * F), y1: top, x2: X(k * F), y2: chanY + chanH, stroke: "muted", width: 0.6, dashed: true })

  for (let i = 0; i < n; i++) {
    const y = top + i * rowH
    shapes.push({ kind: "line", x1: left, y1: y + rowH, x2: right, y2: y + rowH, stroke: "muted", width: 0.4 })
    if (rowH >= 12 || i % 2 === 0)
      shapes.push(text(left - 6, y + rowH / 2 + 3.5, stationName(i), { anchor: "end", size: Math.min(11, rowH - 1) }))
  }

  let onAir = 0
  let garbled = 0
  let delivered = 0
  for (const f of visible) {
    const done = f.end_us <= t
    const lost = done ? !f.ok : hitBy(f.id)
    if (!done) onAir++
    else if (f.ok) delivered++
    else garbled++
    const x = X(f.start_us)
    const wd = X(Math.min(f.end_us, t)) - x
    const y = top + f.station * rowH + 2
    shapes.push({
      kind: "rect",
      x,
      y,
      w: wd,
      h: rowH - 4,
      fill: lost ? "alarm" : station(f.station),
      opacity: lost ? 0.75 : done ? 0.9 : 0.5,
      stroke: lost ? "alarm" : station(f.station),
    })
    if (wd > 28 && rowH >= 14) shapes.push(text(x + 4, y + rowH / 2 + 1.5, `#${f.id}`, { fill: "ink", size: 11 }))
    // The receiver's view: everything on one channel, overlaps in red.
    shapes.push({ kind: "rect", x, y: chanY, w: wd, h: chanH, fill: lost ? "alarm" : station(f.station), opacity: lost ? 0.45 : 0.85 })
  }
  shapes.push(text(left - 6, chanY + chanH / 2 + 3.5, "air", { anchor: "end", fill: "ink", size: 11, bold: true }))
  shapes.push({ kind: "rect", x: left, y: chanY, w: right - left, h: chanH, stroke: "muted" })

  // Ticks in milliseconds, the unit the player uses; the unit is named once, at the left.
  const every = (right - left) / (span / F) < 34 ? 2 : 1
  for (let k = Math.ceil(t0 / F); k * F <= t1; k++)
    if (k % every === 0)
      shapes.push(
        text(X(k * F), h - 4, String(Number(((k * F) / 1000).toPrecision(4))), {
          anchor: X(k * F) > right - 16 ? "end" : "middle",
          size: 11,
        }),
      )
  shapes.push(text(left - 6, h - 4, "ms", { anchor: "end", size: 11 }))
  if (!started.length) {
    // Before the first frame: say so in the picture, and what Play will draw.
    const cy = top + (n * rowH) / 2
    const lines = ["Nothing sent yet.", "Play draws each frame as a bar", "in its station's row, and on air."]
    shapes.push({ kind: "rect", x: (left + right) / 2 - 110, y: cy - 26, w: 220, h: 50, fill: "surface", opacity: 0.92 })
    lines.forEach((l, i) => shapes.push(text((left + right) / 2, cy - 10 + i * 15, l, { anchor: "middle", fill: "ink", size: 12 })))
  }
  if (t >= t0 && t <= t1) shapes.push({ kind: "line", x1: X(t), y1: top - 2, x2: X(t), y2: chanY + chanH + 2, stroke: "ink", width: 1.5 })

  return { w, h, shapes: [...keyShapes, ...shapes], caption: "", onAir, delivered, garbled }
}

// --- CSMA/CD -------------------------------------------------------------

export interface CdFigure extends ShapeFigure {
  collisions: number
}

/**
 * Position along the cable across, time down. A transmission from x_i that
 * runs from s to e reaches x at s + |x − x_i|/v and stops there at
 * e + |x − x_i|/v, so it fills a band shaped like a widening chevron.
 */
export function cdFigure(p: CdParams, run: CdRun, t: number, w: number): CdFigure {
  const L = Math.max(1, ...p.stations.map((s) => s.pos_m))
  const tau = run.stats.tau_ns
  // Five one-way delays fit a collision, its jam and the backoff that follows; long frames scroll past.
  const base = Math.max(40_000, 5 * tau)
  // Keep the latest transmission in view through an idle gap, such as a
  // backoff, by stretching the window (up to four times) rather than letting it scroll away.
  const last = run.txs.reduce((m, tx) => (tx.start_ns <= t ? Math.max(m, tx.start_ns) : m), -Infinity)
  let [t0, t1] = windowAt(t, base, p.duration_ns)
  if (last > -Infinity && last < t0 + 0.05 * base && t - last < 3.5 * base) {
    t0 = Math.max(0, last - 0.1 * base)
    t1 = t0 + Math.max(base, (t - t0) / 0.75)
  }
  const span = t1 - t0
  const tEnd = Math.min(t, t1)
  const left = 58
  const right = w - 18
  const top = 34
  const narrow = w < 520
  const H = narrow ? 300 : 330
  const h = top + H + 22
  const X = (m: number) => left + (m / L) * (right - left)
  const Y = (ns: number) => top + ((ns - t0) / span) * H
  const delay = (a: number, b: number) => (Math.abs(a - b) * 1e9) / p.speed_mps
  const shapes: Shape[] = []

  for (const v of ticks(t0 / 1000, t1 / 1000, 6)) {
    const y = Y(v * 1000)
    shapes.push({ kind: "line", x1: left - 4, y1: y, x2: right, y2: y, stroke: "muted", width: 0.3 })
    shapes.push(text(left - 6, y + 3.5, `${v} µs`, { anchor: "end", size: 11 }))
  }
  shapes.push(text(4, top - 8, "time ↓", { size: 11.5 }))
  p.stations.forEach((s, i) => {
    const x = X(s.pos_m)
    shapes.push({ kind: "line", x1: x, y1: top, x2: x, y2: top + H, stroke: "muted", width: 0.8, dashed: true })
    shapes.push({ kind: "circle", cx: x, cy: top - 14, r: 4, fill: station(i) })
    shapes.push(text(x + 7, top - 10, s.name, { fill: "ink", size: 11, bold: true }))
  })
  shapes.push(text(left, h - 4, "0 m", { size: 11 }))
  shapes.push(text(right, h - 4, `${L} m along the cable`, { anchor: "end", size: 11 }))

  const band = (xi: number, s: number, e: number): [number, number][] => {
    const pts: [number, number][] = [
      [0, s + delay(xi, 0)],
      [xi, s],
      [L, s + delay(xi, L)],
      [L, e + delay(xi, L)],
      [xi, e],
      [0, e + delay(xi, 0)],
    ]
    return clipY(pts, t0, tEnd).map(([m, ns]) => [X(m), Y(ns)])
  }

  let collisions = 0
  for (const tx of run.txs) {
    if (tx.start_ns > tEnd || tx.end_ns + tau < t0) continue
    const xi = p.stations[tx.station].pos_m
    const ink = station(tx.station)
    const cut = tx.detect_ns ?? tx.end_ns
    const body = band(xi, tx.start_ns, Math.min(cut, tEnd))
    if (body.length > 2)
      shapes.push({
        kind: "poly",
        points: body,
        fill: ink,
        opacity: 0.32,
        stroke: ink,
        dashed: tx.outcome === "undetected" && tx.end_ns <= t,
      })
    if (tx.detect_ns !== null && tx.detect_ns <= tEnd) {
      collisions++
      const jam = band(xi, tx.detect_ns, Math.min(tx.end_ns, tEnd))
      if (jam.length > 2) shapes.push({ kind: "poly", points: jam, fill: "alarm", opacity: 0.55, stroke: "alarm" })
    }
  }

  // Marks over the bands: detections, round trips, outcomes and backoffs.
  const side = (x: number) => (x > (left + right) / 2 ? { dx: -8, anchor: "end" as const } : { dx: 8, anchor: "start" as const })
  const lastDetect = run.txs.filter((tx) => tx.detect_ns !== null && tx.detect_ns <= tEnd && tx.start_ns >= t0).pop()
  if (lastDetect) {
    const x = X(p.stations[lastDetect.station].pos_m)
    const { dx, anchor } = side(x)
    const ya = Y(lastDetect.start_ns)
    const yb = Y(Math.min(lastDetect.start_ns + 2 * tau, t1))
    const bx = x + dx / 2
    shapes.push({ kind: "line", x1: bx, y1: ya, x2: bx, y2: yb, stroke: "ink", width: 1 })
    shapes.push({ kind: "line", x1: bx - 3, y1: ya, x2: bx + 3, y2: ya, stroke: "ink", width: 1 })
    shapes.push({ kind: "line", x1: bx - 3, y1: yb, x2: bx + 3, y2: yb, stroke: "ink", width: 1 })
    // Keep the 2τ label clear of the "heard after" label that sits just above the detection mark.
    const dy = lastDetect.detect_ns !== null && lastDetect.detect_ns <= tEnd ? Y(lastDetect.detect_ns) - 9 : Infinity
    const ly = Math.abs(yb - 4 - dy) < 14 ? dy - 15 : yb - 4
    shapes.push(text(bx + dx / 2, ly, `2τ = ${fmtTime(2 * tau, "csmacd")}`, { anchor, fill: "ink", size: 11.5 }))
  }
  for (const tx of run.txs) {
    if (tx.start_ns > tEnd || tx.end_ns < t0) continue
    const x = X(p.stations[tx.station].pos_m)
    const { dx, anchor } = side(x)
    if (tx.detect_ns !== null && tx.detect_ns <= tEnd && tx.detect_ns >= t0) {
      const y = Y(tx.detect_ns)
      shapes.push({ kind: "line", x1: x - 5, y1: y - 5, x2: x + 5, y2: y + 5, stroke: "alarm", width: 2 })
      shapes.push({ kind: "line", x1: x - 5, y1: y + 5, x2: x + 5, y2: y - 5, stroke: "alarm", width: 2 })
      shapes.push(
        text(
          x + dx,
          // Above the mark: below it the jam spreads out from the station.
          y - 9,
          `${narrow ? "heard after" : "hears it after"} ${fmtTime(tx.detect_ns - tx.start_ns, "csmacd")}${narrow ? "" : "; jams"}`,
          {
            anchor,
            fill: "alarm",
            size: 11.5,
          },
        ),
      )
    }
    if (tx.end_ns <= tEnd && tx.end_ns >= t0) {
      const y = Y(tx.end_ns) + 12
      if (tx.outcome === "delivered") shapes.push(text(x + dx, y, "✓ delivered", { anchor, fill: "ink", size: 11.5 }))
      if (tx.outcome === "undetected")
        shapes.push(
          text(x + dx, y, narrow ? "ended before the collision came" : "finished before the collision reached it", {
            anchor,
            fill: "alarm",
            size: 11.5,
            bold: true,
          }),
        )
    }
  }
  for (const b of run.backoffs) {
    if (b.t_ns < t0 || b.t_ns > tEnd) continue
    const x = X(p.stations[b.station].pos_m)
    const { dx, anchor } = side(x)
    shapes.push(
      text(
        x + dx,
        Y(b.t_ns) + 16,
        narrow
          ? `K = ${b.k} (0…${b.max}): ${fmtTime(b.k * run.stats.slot_ns, "csmacd")}`
          : `K = ${b.k} from 0…${b.max}: wait ${fmtTime(b.k * run.stats.slot_ns, "csmacd")}`,
        {
          anchor,
          fill: "ink",
          size: 11.5,
        },
      ),
    )
  }
  if (t >= t0 && t <= t1) shapes.push({ kind: "line", x1: left - 4, y1: Y(t), x2: right, y2: Y(t), stroke: "ink", width: 1.5 })

  return { w, h, shapes, caption: "", collisions }
}

// --- CSMA/CA -------------------------------------------------------------

export const KIND_LABEL: Record<AirKind, string> = { rts: "RTS", cts: "CTS", data: "DATA", ack: "ACK" }

export interface CaFigure extends ShapeFigure {
  onAir: string[]
}

/** The map (who hears whom, who is sending, whose NAV is set) above a timeline with one lane per node. */
export function caFigure(p: CaParams, run: CaRun, t: number, w: number): CaFigure {
  const shapes: Shape[] = []
  const n = p.nodes.length
  // The map: nodes, a line between each pair in range, and the range of each node now sending.
  const r = p.range_m
  const xs = p.nodes.map((v) => v.x_m)
  const ys = p.nodes.map((v) => v.y_m)
  // Room for most of each range circle; the rest is clipped to the map's band.
  const pad = 0.6 * r
  const [minX, maxX] = [Math.min(...xs) - pad, Math.max(...xs) + pad]
  const [minY, maxY] = [Math.min(...ys) - pad, Math.max(...ys) + pad]
  const mapH = w < 520 ? 190 : 230
  const s = Math.min((w - 16) / (maxX - minX), (mapH - 8) / (maxY - minY))
  const ox = (w - s * (maxX - minX)) / 2
  const oy = (mapH - s * (maxY - minY)) / 2
  const MX = (m: number) => ox + (m - minX) * s
  const MY = (m: number) => oy + (m - minY) * s
  const now = caAt(run, t)
  const back = backoffsAt(run, n, t)
  const senders = new Set(p.flows.map((f) => f.from))

  for (const a of now.onAir) {
    const [cx, cy] = [MX(p.nodes[a.from].x_m), MY(p.nodes[a.from].y_m)]
    const ring = Array.from({ length: 72 }, (_, k): [number, number] => [
      cx + r * s * Math.cos((k * Math.PI) / 36),
      cy + r * s * Math.sin((k * Math.PI) / 36),
    ])
    shapes.push({
      kind: "poly",
      points: clipY(ring, 0, mapH),
      fill: station(a.from),
      opacity: 0.1,
      stroke: station(a.from),
      dashed: true,
    })
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (caNear(p, i, j))
        shapes.push({
          kind: "line",
          x1: MX(xs[i]),
          y1: MY(ys[i]),
          x2: MX(xs[j]),
          y2: MY(ys[j]),
          stroke: "muted",
          width: 0.8,
          dashed: true,
        })
  for (const a of now.onAir) {
    const [x1, y1, x2, y2] = [MX(xs[a.from]), MY(ys[a.from]), MX(xs[a.to]), MY(ys[a.to])]
    const len = Math.hypot(x2 - x1, y2 - y1) || 1
    const k = 10 / len
    shapes.push({
      kind: "line",
      x1: x1 + (x2 - x1) * k,
      y1: y1 + (y2 - y1) * k,
      x2: x2 - (x2 - x1) * k,
      y2: y2 - (y2 - y1) * k,
      stroke: station(a.from),
      width: 2.2,
      arrow: true,
    })
    shapes.push(text((x1 + x2) / 2, (y1 + y2) / 2 - 6, KIND_LABEL[a.kind], { anchor: "middle", fill: "ink", size: 11.5, bold: true }))
  }
  p.nodes.forEach((v, i) => {
    const [x, y] = [MX(v.x_m), MY(v.y_m)]
    // A frame overlapping another here is garbled at this node.
    if (now.onAir.some((a) => a.lost_at.includes(i) && a.end_us > t && now.onAir.length > 1))
      shapes.push({ kind: "circle", cx: x, cy: y, r: 12, stroke: "alarm", fill: "alarm", opacity: 0.2 })
    shapes.push({ kind: "circle", cx: x, cy: y, r: 6.5, fill: station(i), stroke: "surface" })
    shapes.push(text(x, y - 11, v.name, { anchor: "middle", fill: "ink", size: 11, bold: true }))
    const nav = now.nav.filter((q) => q.node === i).pop()
    const sending = now.onAir.some((a) => a.from === i)
    const status = nav
      ? `NAV ${fmtTime(nav.until_us - t, "csmaca")}`
      : senders.has(i) && !sending && back[i] !== null
        ? `backoff ${back[i]}`
        : ""
    if (status) shapes.push(text(x, y + 19, status, { anchor: "middle", fill: nav ? "ink" : "muted", size: 11 }))
  })

  // The lanes: every frame on the air, coloured by sender, red once lost, and each NAV as a dashed bar.
  const st = run.stats
  const exchange = st.difs_us + st.data_us + p.sifs_us + st.ack_us + (p.rts ? st.rts_us + st.cts_us + 2 * p.sifs_us : 0)
  const span = Math.max(2000, 3.5 * exchange)
  const [t0, t1] = windowAt(t, span, p.duration_us)
  const tEnd = Math.min(t, t1)
  const left = 34
  const right = w - 8
  const top = mapH + 18
  const rowH = 22
  const h = top + n * rowH + 18
  const X = (u: number) => left + ((Math.min(t1, Math.max(t0, u)) - t0) / span) * (right - left)
  p.nodes.forEach((v, i) => {
    const y = top + i * rowH
    shapes.push({ kind: "line", x1: left, y1: y + rowH, x2: right, y2: y + rowH, stroke: "muted", width: 0.4 })
    shapes.push(text(left - 6, y + rowH / 2 + 3.5, v.name, { anchor: "end", fill: "ink", size: 11, bold: true }))
  })
  for (const q of run.navs) {
    if (q.from_us > tEnd || q.until_us < t0) continue
    const x = X(q.from_us)
    const wd = X(Math.min(q.until_us, tEnd)) - x
    const y = top + q.node * rowH + 5
    shapes.push({ kind: "rect", x, y, w: wd, h: rowH - 10, fill: "muted", opacity: 0.18, stroke: "ink", dashed: true })
    if (wd > 30) shapes.push(text(x + 4, y + rowH / 2 - 1.5, "NAV", { fill: "ink", size: 10.5 }))
  }
  for (const a of run.airs) {
    if (a.start_us > tEnd || a.end_us < t0) continue
    const x = X(a.start_us)
    const wd = Math.max(1, X(Math.min(a.end_us, tEnd)) - x)
    const lost = !a.ok && a.end_us <= t
    const y = top + a.from * rowH + 3
    shapes.push({
      kind: "rect",
      x,
      y,
      w: wd,
      h: rowH - 6,
      fill: lost ? "alarm" : station(a.from),
      opacity: lost ? 0.7 : 0.55,
      stroke: lost ? "alarm" : station(a.from),
    })
    if (wd > 26) shapes.push(text(x + 3, y + rowH / 2 + 0.5, KIND_LABEL[a.kind], { fill: "ink", size: 10.5 }))
  }
  for (const v of ticks(t0, t1, w < 520 ? 4 : 7)) shapes.push(text(X(v), h - 4, fmtTime(v, "csmaca"), { anchor: "middle", size: 11 }))
  if (t >= t0 && t <= t1) shapes.push({ kind: "line", x1: X(t), y1: top - 4, x2: X(t), y2: top + n * rowH + 2, stroke: "ink", width: 1.5 })

  return {
    w,
    h,
    shapes,
    caption: "",
    onAir: now.onAir.map((a) => `${p.nodes[a.from].name} sends ${KIND_LABEL[a.kind]} to ${p.nodes[a.to].name}`),
  }
}
