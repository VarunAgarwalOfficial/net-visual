import { useId, type KeyboardEvent } from "react"

import { cn } from "@/lib/utils"
import { useWidth } from "../../components/LineChart"
import { H, R, W, labelY, px, segment, type GraphFigure } from "./graphFigure"

/** A message on the wire: where it is along its link, and what it says about the destination. */
export interface WireMessage {
  id: number
  from: number
  to: number
  /** 0 at the sender, 1 at the receiver. */
  frac: number
  /** The sender's advertised cost to the destination, as shown on the message. */
  label: string
  poisoned: boolean
  lost: boolean
}

/** Dijkstra's progress from one source, drawn over the graph. */
export interface DijkstraOverlay {
  source: number
  /** Routers already in N'. */
  done: Set<number>
  /** The router added at this step. */
  added: number
  d: number[]
  p: number[]
  infinity: number
}

const press = (f: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    f()
  }
}

/**
 * The network: links with their costs (dashed when failed), routers with
 * their cost to the chosen destination, each router's next hop towards it
 * (red where the next hops form a loop), and the vectors on the wire. With
 * the Dijkstra disclosure open it shows N' and the tree of predecessors instead.
 */
export function Graph({
  fig,
  messages,
  changed,
  actor,
  selected,
  link,
  dijkstra,
  crowded = false,
  onNode,
  onLink,
}: {
  fig: GraphFigure
  messages: WireMessage[]
  /** Routers whose table changed at this event. */
  changed: Set<number>
  /** The router that acted at this event, or -1 for a link change. */
  actor: number
  selected: number | null
  link: [number, number] | null
  dijkstra: DijkstraOverlay | null
  /** Many messages at once (flooding, or a failure among six routers): the drawing may be taller, so that they stay apart. */
  crowded?: boolean
  onNode(i: number): void
  onLink(a: number, b: number): void
}) {
  const marker = useId().replace(/:/g, "")
  // On a narrow screen the drawing shrinks, so routers, labels and messages grow in drawing units to stay legible.
  const [box, width] = useWidth<HTMLDivElement>()
  const k = Math.min(2.3, Math.max(1, 760 / width))
  // The drawing's scale on screen (it is capped in height), and the drawing units that give 17px text at that scale.
  // The margins grow with the labels, which changes the scale, so this settles in a few rounds.
  const vh = typeof window === "undefined" ? 800 : window.innerHeight
  // On a phone the full-width drawing is too small for its labels and messages to stay apart, so
  // it is drawn taller instead: the routers' heights are stretched and the height cap is raised.
  const sy = width > 0 && width < 600 ? (crowded ? Math.min(3, 1170 / width) : Math.min(2.3, 900 / width)) : 1
  const HS = H * sy
  const tall = sy > 1 || crowded
  const cap = tall ? 0.8 * vh : Math.min(0.55 * vh, 416)
  let padX = 24
  let padY = 36
  let min = 17
  for (let round = 0; round < 4; round++) {
    const scale = Math.min(width || W + 2 * padX, cap * ((W + 2 * padX) / (HS + 2 * padY))) / (W + 2 * padX)
    min = 17 / Math.max(scale, 0.1)
    const f = Math.max(12 * k, min)
    const rr = Math.max(R * k, Math.max(16 * k, min) * 0.95)
    padY = Math.max(36, rr + (14 + 18) * (f / 12) + 0.35 * f + 4)
    padX = Math.max(24, 2.7 * f - rr)
  }
  const fCost = Math.max(14 * k, min)
  const fMsg = Math.max(11 * k, min)
  const fName = Math.max(16 * k, min)
  const fLabel = Math.max(12 * k, min)
  const lk = fLabel / 12
  const r = Math.max(R * k, fName * 0.95)
  const P = fig.pos.map((q): [number, number] => [px(q)[0], px(q)[1] * sy])
  const dTree: { from: number; to: number }[] = dijkstra
    ? dijkstra.p.flatMap((u, v) => (u >= 0 && v !== dijkstra.source ? [{ from: u, to: v }] : []))
    : []
  // Where each message on the wire is drawn: beside its link, far enough out to clear the link's
  // cost, and nudged along the link where it would cover another label, a router or another message.
  type Box = { l: number; t: number; r: number; b: number }
  const hit = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
  const costBoxes: Box[] = fig.links.map((l) => {
    const cx = (P[l.a][0] + P[l.b][0]) / 2
    const cy = (P[l.a][1] + P[l.b][1]) / 2
    const cw = (0.3 * String(l.cost ?? "×").length + 0.1) * fCost
    return { l: cx - cw, r: cx + cw, t: cy - 0.55 * fCost, b: cy + 0.55 * fCost }
  })
  // Each router's label: above or below it; the destination's sits further out and to the right,
  // and moves to the other side of its router, or further out, where it would cover a link's cost.
  const labelAt = fig.nodes.map((_, i) => {
    const [x, y] = P[i]
    const text = dijkstra ? "cost 00" : (fig.labels[i] ?? "")
    const half = 0.26 * fLabel * text.length
    const at = (lx: number, ly: number) => ({
      x: lx,
      y: ly,
      box: { l: lx - half, r: lx + half, t: ly - 0.8 * fLabel, b: ly + 0.25 * fLabel },
    })
    const base = labelY(fig, i, y, r, lk)
    if (i !== fig.dest || dijkstra) return at(x, base)
    const lx = x + Math.max(0, Math.min(12 * lk, W + padX - 4 - x - 2.7 * fLabel))
    const out = base > y ? 1 : -1
    const first = at(lx, base + out * 18 * lk)
    const tries = [first, at(lx, 2 * y - first.y + 0.55 * fLabel), ...[1, 2, 3, 4].map((d) => at(lx, first.y + out * d * 0.5 * fLabel))]
    return tries.find((a) => !costBoxes.some((c) => hit(c, a.box))) ?? first
  })
  const taken: Box[] = [
    ...costBoxes,
    ...P.map(([x, y]) => ({ l: x - r - 7 * k, r: x + r + 7 * k, t: y - r - 7 * k, b: y + r + 7 * k })),
    ...labelAt.map((a) => a.box),
  ]
  const placed = messages.map((m) => {
    const [ax, ay] = P[m.from]
    const [bx, by] = P[m.to]
    const len = Math.hypot(bx - ax, by - ay) || 1
    const [nx, ny] = [Math.abs(by - ay) / len, Math.abs(bx - ax) / len]
    const cost = fig.links.find((l) => (l.a === m.from && l.b === m.to) || (l.a === m.to && l.b === m.from))?.cost
    const hw = Math.max(0.9, 0.31 * m.label.length + 0.45) * fMsg
    const hh = 0.7 * fMsg
    const cw = (0.3 * String(cost ?? "×").length + 0.1) * fCost
    const off = hw * nx + hh * ny + cw * nx + 0.55 * fCost * ny + 2
    // Drawn over the middle of the link, so that a vector just sent or about to arrive clears the routers and their labels.
    const f0 = 0.2 + 0.6 * (m.lost ? Math.min(m.frac, 0.5) : m.frac)
    const at = (side: number, f: number, out: number) => {
      const s = segment(P[m.from], P[m.to], r + 2, -side * (off + out))
      const x = s.x1 + (s.x2 - s.x1) * f
      const y = s.y1 + (s.y2 - s.y1) * f
      return { x, y, box: { l: x - hw - 2, r: x + hw + 2, t: y - hh - 2, b: y + hh + 2 } }
    }
    const inside = (a: Box) => a.l >= -padX && a.r <= W + padX && a.t >= -padY && a.b <= HS + padY
    // Its own side first, then the other side, the nearer places first, then a little further out.
    // Where there is no clear place (a flood of link-state messages on a phone), it is drawn as a
    // dot on its link, without its label, rather than over another label (or not at all, if even a dot has no room).
    let best: { x: number; y: number; box: Box } | null = null
    search: for (const out of [0, 0.8 * fMsg, 1.6 * fMsg])
      for (const side of [1, -1])
        for (const d of [0, 0.06, -0.06, 0.12, -0.12, 0.18, -0.18, 0.24, -0.24, 0.3, -0.3, 0.4, -0.4]) {
          const f = f0 + d
          if (f < 0 || f > 1) continue
          const c = at(side, f, out)
          if (inside(c.box) && !taken.some((b) => hit(c.box, b))) {
            best = c
            break search
          }
        }
    if (!best) return { m, x: 0, y: 0, hw: 0, f0 }
    taken.push(best.box)
    return { m, x: best.x, y: best.y, hw, f0 }
  })
  // The dots go where they cover no label, once every labelled message has its place.
  const dots = placed.flatMap(({ m, hw, f0 }) => {
    if (hw) return []
    const s = segment(P[m.from], P[m.to], r + 2)
    const d = 0.25 * fMsg + 1
    for (const f of [0, 0.06, -0.06, 0.12, -0.12, 0.18, -0.18, 0.24, -0.24, 0.3, -0.3].map((e) => f0 + e)) {
      if (f < 0 || f > 1) continue
      const [x, y] = [s.x1 + (s.x2 - s.x1) * f, s.y1 + (s.y2 - s.y1) * f]
      const box = { l: x - d, r: x + d, t: y - d, b: y + d }
      if (!taken.some((b) => hit(box, b))) {
        taken.push(box)
        return [{ m, x, y }]
      }
    }
    return []
  })
  return (
    <div ref={box}>
      <svg
        viewBox={`${-padX} ${-padY} ${W + 2 * padX} ${HS + 2 * padY}`}
        className={cn("w-full touch-manipulation font-sans select-none", tall ? "max-h-[80vh]" : "max-h-[min(55vh,26rem)]")}
        role="group"
        aria-label="The network: routers, links and their costs"
      >
        <defs>
          {["tree", "loop", "dij"].map((k) => (
            <marker
              key={k}
              id={`${marker}-${k}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
              className={k === "loop" ? "fill-bad" : k === "tree" ? "fill-busy" : "fill-foreground"}
            >
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          ))}
        </defs>

        {fig.links.map((l) => {
          const s = segment(P[l.a], P[l.b], 0)
          const on = link && ((link[0] === l.a && link[1] === l.b) || (link[0] === l.b && link[1] === l.a))
          const inTree = dijkstra && dTree.some((t) => (t.from === l.a && t.to === l.b) || (t.from === l.b && t.to === l.a))
          return (
            <g
              key={`${l.a}-${l.b}`}
              role="button"
              tabIndex={0}
              aria-label={`Link between ${fig.nodes[l.a]} and ${fig.nodes[l.b]}, ${l.cost === null ? "failed" : `cost ${l.cost}`}. Press to change it.`}
              aria-pressed={!!on}
              className="cursor-pointer outline-none [&:focus-visible>line:last-of-type]:stroke-ring"
              onClick={() => onLink(l.a, l.b)}
              onKeyDown={press(() => onLink(l.a, l.b))}
            >
              <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="transparent" strokeWidth={18} />
              <line
                x1={s.x1}
                y1={s.y1}
                x2={s.x2}
                y2={s.y2}
                className={on ? "stroke-foreground" : "stroke-muted-foreground"}
                strokeWidth={on ? 3.5 : inTree ? 3 : 1.5}
                strokeDasharray={l.cost === null ? "6 5" : undefined}
              />
            </g>
          )
        })}

        {!dijkstra &&
          fig.tree.map((t) => {
            const s = segment(P[t.from], P[t.to], r + 4, 5 * k)
            return (
              <line
                key={`t${t.from}`}
                x1={s.x1}
                y1={s.y1}
                x2={s.x2}
                y2={s.y2}
                className={t.loop ? "stroke-bad" : "stroke-busy"}
                strokeWidth={3}
                markerEnd={`url(#${marker}-${t.loop ? "loop" : "tree"})`}
                pointerEvents="none"
              />
            )
          })}
        {dijkstra &&
          dTree.map((t) => {
            const s = segment(P[t.from], P[t.to], r + 4, 0)
            return (
              <line
                key={`d${t.to}`}
                x1={s.x1}
                y1={s.y1}
                x2={s.x2}
                y2={s.y2}
                className={dijkstra.done.has(t.to) ? "stroke-foreground" : "stroke-muted-foreground"}
                strokeWidth={dijkstra.done.has(t.to) ? 3 : 1.5}
                strokeDasharray={dijkstra.done.has(t.to) ? undefined : "3 3"}
                markerEnd={`url(#${marker}-dij)`}
                pointerEvents="none"
              />
            )
          })}

        {fig.links.map((l) => {
          const [ax, ay] = P[l.a]
          const [bx, by] = P[l.b]
          return (
            <text
              key={`c${l.a}-${l.b}`}
              x={(ax + bx) / 2}
              y={(ay + by) / 2}
              dy="0.35em"
              textAnchor="middle"
              fontSize={fCost}
              className={cn("pointer-events-none stroke-background tabular-nums lining", l.cost === null ? "fill-bad" : "fill-foreground")}
              strokeWidth={5}
              paintOrder="stroke"
            >
              {l.cost === null ? "×" : l.cost}
            </text>
          )
        })}

        {dots.map(({ m, x, y }) => (
          <circle
            key={`m${m.id}`}
            cx={x}
            cy={y}
            r={0.25 * fMsg}
            className={m.lost ? "fill-muted-foreground" : "fill-foreground"}
            pointerEvents="none"
          />
        ))}
        {placed.map(({ m, x, y, hw }) => {
          if (!hw) return null
          return (
            <g key={`m${m.id}`} transform={`translate(${x} ${y})`} pointerEvents="none">
              <rect
                x={-hw}
                y={-0.7 * fMsg}
                width={2 * hw}
                height={1.4 * fMsg}
                rx={4}
                className={cn("fill-background", m.lost ? "stroke-muted-foreground" : m.poisoned ? "stroke-again" : "stroke-foreground")}
                strokeWidth={m.poisoned ? 2 : 1.25}
                strokeDasharray={m.poisoned && !m.lost ? "4 2" : undefined}
              />
              <text
                dy="0.35em"
                textAnchor="middle"
                fontSize={fMsg}
                className={cn(m.lost ? "fill-muted-foreground" : "fill-foreground", "tabular-nums lining")}
                fontWeight={600}
              >
                {m.lost ? "×" : m.label}
              </text>
            </g>
          )
        })}

        {fig.nodes.map((name, i) => {
          const [x, y] = P[i]
          const isDest = i === fig.dest
          const inN = dijkstra?.done.has(i)
          const dLabel = dijkstra
            ? i === dijkstra.source
              ? "source"
              : `cost ${dijkstra.d[i] >= dijkstra.infinity ? "∞" : dijkstra.d[i]}`
            : fig.labels[i]
          return (
            <g
              key={`n${i}`}
              role="button"
              tabIndex={0}
              aria-label={`Router ${name}, ${dLabel}. Press to show its working under Go deeper.`}
              aria-pressed={selected === i}
              className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-ring"
              onClick={() => onNode(i)}
              onKeyDown={press(() => onNode(i))}
            >
              {/* The destination's word sits a little right of centre and further out, clear of the arrows coming in. */}
              {(changed.has(i) || actor === i) && !dijkstra && (
                <circle cx={x} cy={y} r={r + 7 * k} className={changed.has(i) ? "fill-mark" : "fill-muted"} />
              )}
              {dijkstra && dijkstra.added === i && <circle cx={x} cy={y} r={r + 7 * k} className="fill-mark" />}
              <circle
                cx={x}
                cy={y}
                r={r}
                className={cn(inN ? "fill-foreground" : "fill-background", "stroke-foreground")}
                strokeWidth={selected === i ? 4.5 : isDest && !dijkstra ? 3 : 1.5}
              />
              {isDest && !dijkstra && <circle cx={x} cy={y} r={r - 4 * k} className="fill-none stroke-foreground" strokeWidth={1} />}
              <text x={x} y={y} dy="0.35em" textAnchor="middle" fontSize={fName} className={inN ? "fill-background" : "fill-foreground"}>
                {name}
              </text>
              <text
                x={labelAt[i].x}
                y={labelAt[i].y}
                textAnchor="middle"
                fontSize={fLabel}
                className="fill-muted-foreground stroke-background tabular-nums lining"
                strokeWidth={4}
                paintOrder="stroke"
              >
                {dLabel}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
