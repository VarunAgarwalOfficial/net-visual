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
 * the Dijkstra tab open it shows N' and the tree of predecessors instead.
 */
export function Graph({
  fig,
  messages,
  changed,
  actor,
  selected,
  link,
  dijkstra,
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
  onNode(i: number): void
  onLink(a: number, b: number): void
}) {
  const marker = useId().replace(/:/g, "")
  // On a narrow screen the drawing shrinks, so routers, labels and messages grow in drawing units to stay legible.
  const [box, width] = useWidth<HTMLDivElement>()
  const k = Math.min(2, Math.max(1, 640 / width))
  const r = R * k
  const P = fig.pos.map(px)
  const dTree: { from: number; to: number }[] = dijkstra
    ? dijkstra.p.flatMap((u, v) => (u >= 0 && v !== dijkstra.source ? [{ from: u, to: v }] : []))
    : []
  return (
    <div ref={box}>
      <svg
        viewBox={`-24 -36 ${W + 48} ${H + 72}`}
        className="w-full touch-manipulation font-sans select-none"
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
              className={k === "loop" ? "fill-destructive" : k === "tree" ? "fill-chart-1" : "fill-foreground"}
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
              aria-label={`Link ${fig.nodes[l.a]}–${fig.nodes[l.b]}, ${l.cost === null ? "failed" : `cost ${l.cost}`}. Press to change it.`}
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
                className={cn(on ? "stroke-link" : "stroke-muted-foreground", l.cost === null && "opacity-60")}
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
                className={t.loop ? "stroke-destructive" : "stroke-chart-1"}
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
              fontSize={14 * k}
              className={cn(
                "pointer-events-none stroke-background tabular-nums lining",
                l.cost === null ? "fill-destructive" : "fill-foreground",
              )}
              strokeWidth={5}
              paintOrder="stroke"
            >
              {l.cost === null ? "×" : l.cost}
            </text>
          )
        })}

        {messages.map((m) => {
          const s = segment(P[m.from], P[m.to], r + 2, -9 * k)
          // Drawn over the middle of the link, so that a vector just sent or about to arrive clears the routers and their labels.
          const f = 0.2 + 0.6 * (m.lost ? Math.min(m.frac, 0.5) : m.frac)
          const x = s.x1 + (s.x2 - s.x1) * f
          const y = s.y1 + (s.y2 - s.y1) * f
          return (
            <g key={`m${m.id}`} transform={`translate(${x} ${y})`} pointerEvents="none" className={cn(m.lost && "opacity-50")}>
              <rect
                x={-Math.max(15, 3.4 * m.label.length + 5) * k}
                y={-9 * k}
                width={2 * Math.max(15, 3.4 * m.label.length + 5) * k}
                height={18 * k}
                rx={4}
                className={cn("fill-background", m.poisoned ? "stroke-chart-4" : "stroke-chart-2")}
                strokeWidth={2}
                strokeDasharray={m.poisoned ? "4 2" : undefined}
              />
              <text dy="0.35em" textAnchor="middle" fontSize={11 * k} className="fill-foreground tabular-nums lining" fontWeight={600}>
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
              : `D = ${dijkstra.d[i] >= dijkstra.infinity ? "∞" : dijkstra.d[i]}`
            : fig.labels[i]
          return (
            <g
              key={`n${i}`}
              role="button"
              tabIndex={0}
              aria-label={`Router ${name}, ${dLabel}. Press to look at its table.`}
              aria-pressed={selected === i}
              className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-ring"
              onClick={() => onNode(i)}
              onKeyDown={press(() => onNode(i))}
            >
              {(changed.has(i) || actor === i) && !dijkstra && (
                <circle cx={x} cy={y} r={r + 7 * k} className={changed.has(i) ? "fill-chart-4/35" : "fill-muted"} />
              )}
              {dijkstra && dijkstra.added === i && <circle cx={x} cy={y} r={r + 7 * k} className="fill-chart-4/35" />}
              <circle
                cx={x}
                cy={y}
                r={r}
                className={cn(inN ? "fill-foreground" : "fill-background", selected === i ? "stroke-link" : "stroke-foreground")}
                strokeWidth={selected === i ? 3.5 : isDest && !dijkstra ? 3 : 1.5}
              />
              {isDest && !dijkstra && <circle cx={x} cy={y} r={r - 4 * k} className="fill-none stroke-foreground" strokeWidth={1} />}
              <text x={x} y={y} dy="0.35em" textAnchor="middle" fontSize={16 * k} className={inN ? "fill-background" : "fill-foreground"}>
                {name}
              </text>
              <text
                x={x}
                y={labelY(fig, i, y, r, k)}
                textAnchor="middle"
                fontSize={12 * k}
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
