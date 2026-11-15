import { useId } from "react"

import type { Algo, Phase, TcpEvent } from "../../core/tcp"

type Edge = "ss-ca" | "ss-loop" | "ca-loop" | "fr-loop" | "ss-fr" | "ca-fr" | "fr-ca" | "ca-ss" | "fr-ss" | "ss-timeout"

/**
 * Which transition the current event took, from the step that produced it
 * and the phase before it (the phase of the previous event). Steps that only
 * send, receive or count a duplicate take none.
 */
export function transition(event: TcpEvent | null, before: Phase | null, algo: Algo): Edge | null {
  if (!event) return null
  const from = before ?? event.state.phase
  const to = event.state.phase
  switch (event.step) {
    case "T1":
      return from === "S" ? "ss-timeout" : from === "A" ? "ca-ss" : "fr-ss"
    case "D2":
      // Tahoe's fast retransmit drops to one segment; the others' D2 is followed by F1.
      if (algo === "tahoe" && event.state.cwnd === 1) return from === "A" ? "ca-ss" : "ss-timeout"
      return null
    case "F1":
      return from === "A" ? "ca-fr" : "ss-fr"
    case "F4":
      // NewReno's full ACK sets cwnd = min(ssthresh, FlightSize + 1), which can leave it below ssthresh.
      return to === "S" ? "fr-ss" : "fr-ca"
    case "F5":
      return "fr-loop"
    case "D1":
      return from === "R" ? "fr-loop" : null
    case "A2":
    case "A3":
      if (from === "S" && to === "A") return "ss-ca"
      return to === "S" ? "ss-loop" : to === "A" ? "ca-loop" : null
    default:
      return null
  }
}

const NODES: { id: Phase; x: number; y: number; label: string }[] = [
  { id: "S", x: 100, y: 112, label: "slow start" },
  { id: "A", x: 380, y: 112, label: "congestion avoidance" },
  { id: "R", x: 240, y: 252, label: "fast recovery" },
]
const W = 150
const H = 40

/**
 * The congestion-control state machine of RFC 5681 (with RFC 6582's partial
 * ACKs), drawn as in the textbooks. The current phase is filled and the
 * transition the current event took is drawn heavier. Tahoe has no fast
 * recovery: three duplicate ACKs send it back to slow start.
 */
export function CongestionFsm({ event, before, algo }: { event: TcpEvent | null; before: Phase | null; algo: Algo }) {
  const marker = useId().replace(/:/g, "")
  const lit = transition(event, before, algo)
  const tahoe = algo === "tahoe"
  const cubic = algo === "cubic"
  const phase = event?.state.phase ?? null
  const edges: {
    id: Edge
    d: string
    label: string | string[]
    x: number
    y: number
    anchor?: "start" | "middle" | "end"
    off?: boolean
  }[] = [
    { id: "ss-ca", d: "M175,104 L305,104", label: "cwnd ≥ ssthresh", x: 240, y: 96 },
    {
      id: "ca-ss",
      d: "M305,122 L175,122",
      label: tahoe ? "timeout, or 3 dup ACKs: cwnd = 1" : "timeout: cwnd = 1",
      x: 240,
      y: 138,
    },
    { id: "ss-loop", d: "M75,92 C55,40 145,40 125,92", label: "new ACK: cwnd + 1", x: 100, y: 46 },
    {
      id: "ca-loop",
      d: "M355,92 C335,40 425,40 405,92",
      label: cubic ? "new ACK: cwnd follows W(t)" : "new ACK: cwnd + 1/cwnd",
      x: 380,
      y: 46,
    },
    {
      id: "ss-timeout",
      d: "M25,104 C-8,104 -8,136 25,128",
      label: tahoe ? "timeout or 3 dup ACKs" : "timeout",
      x: 22,
      y: 154,
      anchor: "start",
    },
    { id: "ss-fr", d: "M120,132 L200,232", label: "3 dup ACKs", x: 196, y: 206, anchor: "start", off: tahoe },
    { id: "ca-fr", d: "M350,132 L272,232", label: "3 dup ACKs", x: 318, y: 162, anchor: "end", off: tahoe },
    {
      id: "fr-ca",
      d: "M292,232 L370,132",
      label: algo === "reno" ? "new ACK" : "ACK covers recover",
      x: 344,
      y: 204,
      anchor: "start",
      off: tahoe,
    },
    {
      id: "fr-ss",
      d: "M165,256 C80,256 60,200 82,132",
      label: algo === "reno" ? "timeout" : ["timeout, or full ACK", "with cwnd < ssthresh"],
      x: 76,
      y: algo === "reno" ? 248 : 270,
      anchor: "end",
      off: tahoe,
    },
    {
      id: "fr-loop",
      d: "M220,272 C200,318 280,318 260,272",
      label: algo === "reno" ? "dup ACK: cwnd + 1" : ["dup ACK: cwnd + 1;", "partial ACK: resend the next hole"],
      x: 240,
      y: 318,
    },
  ]
  return (
    <figure className="font-sans">
      <figcaption className="mb-1 text-sm text-muted-foreground">
        Congestion control state, flow 1 ({tahoe ? "Tahoe has no fast recovery" : "RFC 5681 and 6582"})
      </figcaption>
      <div className="overflow-x-auto">
      <svg
        viewBox="-40 20 540 330"
        width={540 * (17 / 13)}
        height={330 * (17 / 13)}
        className="block"
        role="img"
        aria-label={`Current phase: ${phase ? NODES.find((n) => n.id === phase)!.label : "not started"}${lit ? `; transition taken: ${[edges.find((e) => e.id === lit)!.label].flat().join(" ")}` : ""}`}
      >
        <defs>
          <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
          </marker>
        </defs>
        {edges.map((e) => {
          const on = e.id === lit
          return (
            <g key={e.id}>
              <path
                d={e.d}
                fill="none"
                stroke={on ? "var(--foreground)" : e.off ? "var(--border)" : "var(--chart-ink)"}
                strokeDasharray={e.off ? "3 4" : undefined}
                strokeWidth={on ? 2.75 : 1.25}
                markerEnd={`url(#${marker})`}
              />
              <text
                x={e.x}
                y={e.y}
                textAnchor={e.anchor ?? "middle"}
                fontSize="13"
                fill={on ? "var(--foreground)" : "var(--muted-foreground)"}
                fontWeight={on ? 600 : 400}
              >
                {(Array.isArray(e.label) ? e.label : [e.label]).map((line, i) => (
                  <tspan key={i} x={e.x} dy={i ? "1.2em" : 0}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          )
        })}
        {NODES.map((n) => {
          const on = n.id === phase
          const off = tahoe && n.id === "R"
          return (
            <g key={n.id}>
              <rect
                x={n.x - W / 2}
                y={n.y - H / 2}
                width={W}
                height={H}
                rx={H / 2}
                fill={on ? "var(--nv-mark)" : "var(--background)"}
                stroke={off ? "var(--border)" : "var(--foreground)"}
                strokeDasharray={off ? "3 4" : undefined}
                strokeWidth={on ? 2.5 : 1.25}
              />
              <text x={n.x} y={n.y} dy="0.35em" textAnchor="middle" fontSize="13" fill={off ? "var(--muted-foreground)" : "var(--foreground)"} fontWeight={on ? 600 : 400}>
                {n.label}
              </text>
            </g>
          )
        })}
      </svg>
      </div>
    </figure>
  )
}
