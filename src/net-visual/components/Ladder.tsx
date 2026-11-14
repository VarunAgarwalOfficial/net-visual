import { useEffect, useId, useRef, useState } from "react"

import { useWidth } from "./LineChart"
import { formatTime } from "./timeline"

export interface LadderFlight {
  id: number
  /** Lane the packet leaves from: 0 left, 1 right. */
  from: 0 | 1
  t_start: number
  t_sent: number
  t_arrive: number
  lost: boolean
  label: string
  fate: string
  color: string
  /** Fate is a failure worth flagging (wrong data, discarded). */
  alarm?: boolean
}

export interface LadderMark {
  t: number
  lane: 0 | 1
  text: string
}

interface Props {
  lanes: [string, string]
  flights: LadderFlight[]
  marks: LadderMark[]
  t: number
  duration: number
  /** Simulated microseconds per pixel. */
  usPerPx: number
  selected: number | null
  onSelect(id: number | null): void
  /** Drag the arrival end of the selected packet: extra delay in µs. */
  onDelay?(id: number, extraUs: number): void
  follow: boolean
  height: number
}

/**
 * A time-sequence (ladder) diagram. Time runs down. Each packet is drawn as
 * the band its bits occupy: the first bit leaves at t_start, the last at
 * t_sent, so the band's thickness at the sender is the transmission time and
 * its slope is the propagation delay. Only the past is drawn.
 */
export function Ladder(props: Props) {
  const { flights, marks, t, usPerPx, selected, height } = props
  const [box, width] = useWidth<HTMLDivElement>()
  const scroller = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState(0)
  const [drag, setDrag] = useState<{ id: number; y0: number; dy: number } | null>(null)
  const clip = useId().replace(/:/g, "")
  const top = 28
  const xs = [Math.min(110, width * 0.22), width - Math.min(110, width * 0.22)] as const
  const y = (time: number) => top + time / usPerPx
  const total = y(props.duration) + 40

  useEffect(() => {
    if (!props.follow || !scroller.current) return
    const target = y(t) - height * 0.6
    const el = scroller.current
    if (Math.abs(el.scrollTop - target) > 2) el.scrollTop = Math.max(0, target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, usPerPx, props.follow, height])

  const lo = (scroll - 200) * usPerPx
  const hi = (scroll + height + 200) * usPerPx
  const visible = flights.filter((f) => f.t_start <= t && f.t_arrive >= lo && f.t_start <= hi)
  const yt = y(t)
  const tickStep = niceStep(usPerPx * 80)

  return (
    <div ref={box} className="w-full">
      <div
        ref={scroller}
        className="relative overflow-y-auto overscroll-contain rounded-sm border border-border"
        style={{ height }}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      >
        <svg
          width={width}
          height={total}
          className="block font-sans lining select-none"
          role="group"
          aria-label="Sequence diagram; packets are buttons"
        >
          <defs>
            <clipPath id={clip}>
              <rect x={0} y={0} width={width} height={yt} />
            </clipPath>
          </defs>
          {Array.from({ length: Math.floor(props.duration / tickStep) + 1 }, (_, i) => i * tickStep)
            .filter((v) => v >= lo && v <= hi)
            .map((v) => (
              <g key={v}>
                <line x1={xs[0]} x2={xs[1]} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" />
                <text x={4} y={y(v)} dy="0.32em" fontSize="10" fill="var(--chart-ink)" className="font-sans">
                  {formatTime(v)}
                </text>
              </g>
            ))}
          {props.lanes.map((name, i) => (
            <g key={name}>
              <text x={xs[i]} y={16} textAnchor="middle" fontSize="13" fill="var(--foreground)" className="font-sans">
                {name}
              </text>
              <line x1={xs[i]} x2={xs[i]} y1={top} y2={total} stroke="var(--foreground)" strokeOpacity={0.5} />
            </g>
          ))}
          <g clipPath={`url(#${clip})`}>
            {visible.map((f) => {
              const a = xs[f.from]
              const b = xs[1 - f.from]
              const delay = f.t_arrive - f.t_sent
              const extra = drag && drag.id === f.id ? drag.dy * usPerPx : 0
              const arrive = f.t_arrive + extra
              const lead = f.t_start + delay + extra
              const sel = f.id === selected
              const mid = f.lost ? 0.5 : 1
              const bx = a + (b - a) * mid
              const leadY = y(f.t_start + (lead - f.t_start) * mid)
              const tailY = y(f.t_sent + (arrive - f.t_sent) * mid)
              const band = `${a},${y(f.t_start)} ${a},${Math.max(y(f.t_sent), y(f.t_start) + 1.5)} ${bx},${Math.max(tailY, leadY + 1.5)} ${bx},${leadY}`
              return (
                <g
                  key={f.id}
                  className="cursor-pointer outline-none focus-visible:[&>line:first-of-type]:stroke-[var(--ring)]"
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel}
                  aria-label={`${f.label}${f.lost ? ", lost" : t >= arrive ? `, ${f.fate}` : ", in flight"}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    // Keep the keyboard with the diagram, so D and the arrows act at once.
                    e.currentTarget.focus({ preventScroll: true })
                    props.onSelect(sel ? null : f.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      e.stopPropagation()
                      props.onSelect(sel ? null : f.id)
                    }
                  }}
                >
                  <polygon points={band} fill={f.color} fillOpacity={f.lost ? 0.12 : 0.22} />
                  <line
                    x1={a}
                    y1={y(f.t_start)}
                    x2={bx}
                    y2={leadY}
                    stroke={f.color}
                    strokeWidth={sel ? 3 : 1.75}
                    strokeOpacity={f.lost ? 0.6 : 1}
                  />
                  <line x1={a} y1={y(f.t_start)} x2={bx} y2={leadY} stroke="transparent" strokeWidth={14} />
                  {f.lost && <Cross x={bx} y={leadY} />}
                  <text
                    x={a + (f.from === 0 ? 6 : -6)}
                    y={y(f.t_start) - 3}
                    textAnchor={f.from === 0 ? "start" : "end"}
                    fontSize="11"
                    fill="var(--foreground)"
                    className="font-sans"
                  >
                    {f.label}
                  </text>
                  {!f.lost && t >= arrive && (
                    <text
                      x={b + (f.from === 0 ? 6 : -6)}
                      y={y(arrive)}
                      dy="0.32em"
                      textAnchor={f.from === 0 ? "start" : "end"}
                      fontSize="10.5"
                      fill={f.alarm ? "var(--destructive)" : "var(--muted-foreground)"}
                      className="font-sans"
                    >
                      {f.fate}
                    </text>
                  )}
                </g>
              )
            })}
            {marks
              .filter((mk) => mk.t >= lo && mk.t <= hi && mk.t <= t)
              .map((mk, i) => (
                <g key={i}>
                  <rect
                    x={xs[mk.lane] - 4}
                    y={y(mk.t) - 4}
                    width={8}
                    height={8}
                    fill="var(--background)"
                    stroke="var(--foreground)"
                    transform={`rotate(45 ${xs[mk.lane]} ${y(mk.t)})`}
                  />
                  <text
                    x={xs[mk.lane] + (mk.lane === 0 ? -8 : 8)}
                    y={y(mk.t)}
                    dy="0.32em"
                    textAnchor={mk.lane === 0 ? "end" : "start"}
                    fontSize="10.5"
                    fill="var(--foreground)"
                    className="font-sans"
                  >
                    {mk.text}
                  </text>
                </g>
              ))}
          </g>
          {visible
            .filter((f) => !f.lost && t < f.t_arrive)
            .map((f) => {
              const a = xs[f.from]
              const b = xs[1 - f.from]
              const frac = Math.min(1, Math.max(0, (t - f.t_start) / (f.t_arrive - f.t_sent || 1)))
              return (
                <circle
                  key={`d${f.id}`}
                  cx={a + (b - a) * frac}
                  cy={yt}
                  r={4.5}
                  fill={f.color}
                  stroke="var(--background)"
                  strokeWidth={2}
                />
              )
            })}
          <line x1={0} x2={width} y1={yt} y2={yt} stroke="var(--foreground)" strokeOpacity={0.35} strokeDasharray="2 3" />
          {props.onDelay &&
            visible
              .filter((f) => f.id === selected && !f.lost && t >= f.t_start)
              .map((f) => {
                const b = xs[1 - f.from]
                const cy = y(f.t_arrive) + (drag?.id === f.id ? drag.dy : 0)
                return (
                  <circle
                    key="handle"
                    cx={b}
                    cy={cy}
                    r={7}
                    fill="var(--background)"
                    stroke="var(--link)"
                    strokeWidth={2}
                    className="cursor-ns-resize"
                    aria-label="Drag to delay this packet"
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId)
                      setDrag({ id: f.id, y0: e.clientY, dy: 0 })
                    }}
                    onPointerMove={(e) => drag && setDrag({ ...drag, dy: Math.max(0, e.clientY - drag.y0) })}
                    onPointerUp={() => {
                      if (drag && drag.dy > 2) props.onDelay?.(f.id, Math.round(drag.dy * usPerPx))
                      setDrag(null)
                    }}
                  />
                )
              })}
        </svg>
      </div>
    </div>
  )
}

function Cross({ x, y }: { x: number; y: number }) {
  return (
    <g stroke="var(--destructive)" strokeWidth={2.25} strokeLinecap="round">
      <line x1={x - 5} y1={y - 5} x2={x + 5} y2={y + 5} />
      <line x1={x - 5} y1={y + 5} x2={x + 5} y2={y - 5} />
    </g>
  )
}

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
}
