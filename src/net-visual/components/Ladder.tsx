import { useEffect, useId, useRef, useState, type ReactNode } from "react"

import { useWidth } from "./LineChart"
import { inUnit, runUnit } from "./timeline"

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
  /** The diagram begins here (default 0), for a trace that covers a window of a long run. */
  start?: number
  /** Lines said in the empty diagram before the first event: what Play will draw. */
  empty?: string[]
  /** A key drawn inside the diagram's frame, above the lanes, so it stays in view while the lanes scroll. */
  legend?: ReactNode
}

/** Labels closer than this many pixels to the last one on the same lane are left out. */
const LABEL_GAP = 19

/**
 * The flights whose send label and whose arrival label have room. Dense
 * bursts (a congestion window of 80 packets) would otherwise print labels on
 * top of each other; every packet is still drawn and still has its name.
 */
function roomy(list: LadderFlight[], marks: LadderMark[], y: (t: number) => number) {
  const send = new Set<number>()
  const arrive = new Set<number>()
  const last = [-Infinity, -Infinity, -Infinity, -Infinity]
  for (const f of [...list].sort((a, b) => a.t_start - b.t_start))
    if (y(f.t_start) - last[f.from] >= LABEL_GAP) {
      send.add(f.id)
      last[f.from] = y(f.t_start)
    }
  // A mark's label sits where the arrival labels on its lane go, so it takes their room.
  const marked = (f: LadderFlight) => marks.some((m) => m.lane === 1 - f.from && Math.abs(y(m.t) - y(f.t_arrive)) < LABEL_GAP)
  for (const f of [...list].sort((a, b) => a.t_arrive - b.t_arrive))
    if (!f.lost && !marked(f) && y(f.t_arrive) - last[2 + f.from] >= LABEL_GAP) {
      arrive.add(f.id)
      last[2 + f.from] = y(f.t_arrive)
    }
  return { send, arrive }
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
  // The axis unit and the lane names sit in a strip above the scrolling
  // lanes, so they stay in view; the lanes start just below the first label.
  const head = 48
  const top = 24
  // The right gutter holds what happened to each arriving packet, so it is
  // never narrower than the longest of those words at phone width.
  const xs = [Math.min(110, width * 0.22), width - Math.min(150, Math.max(112, width * 0.24))] as const
  const origin = props.start ?? 0
  const y = (time: number) => top + (time - origin) / usPerPx
  const total = y(props.duration) + 40

  useEffect(() => {
    if (!props.follow || !scroller.current) return
    const target = y(t) - height * 0.6
    const el = scroller.current
    if (Math.abs(el.scrollTop - target) > 2) el.scrollTop = Math.max(0, target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, usPerPx, props.follow, height])

  const lo = origin + (scroll - 200) * usPerPx
  const hi = origin + (scroll + height + 200) * usPerPx
  const visible = flights.filter((f) => f.t_start <= t && f.t_arrive >= lo && f.t_start <= hi)
  const labelled = roomy(
    visible,
    marks.filter((m) => m.t <= t),
    y,
  )
  const yt = y(t)
  const tickStep = niceStep(usPerPx * 80)
  // Words left of the first lane (an arrival there, or a timer mark): where one would meet a
  // tick's number, the number gives way and its grid line stays.
  const leftWords = [
    ...visible
      .filter((f) => xs[1 - f.from] === xs[0] && !f.lost && t >= f.t_arrive && labelled.arrive.has(f.id))
      .map((f) => ({ y: y(f.t_arrive), w: 0.5 * 17 * f.fate.length })),
    ...marks.filter((mk) => mk.lane === 0 && mk.t <= t).map((mk) => ({ y: y(mk.t), w: 0.5 * 17 * mk.text.length + 2 })),
  ].map((l) => ({ y: l.y, left: xs[0] - 6 - l.w }))
  const tickFree = (v: number, text: string) => !leftWords.some((l) => Math.abs(l.y - y(v)) < 19 && l.left < 4 + 0.55 * 17 * text.length)
  // One unit down the whole axis, named once at its head.
  const unit = runUnit(props.duration)

  return (
    <div ref={box} className="w-full overflow-hidden rounded-sm border border-border">
      {props.legend && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-2 py-1.5 font-sans text-sm text-muted-foreground">
          {props.legend}
        </div>
      )}
      <svg width={width} height={head} className="block font-sans lining select-none" aria-hidden>
        <text x={4} y={18} fontSize="17" fill="var(--chart-ink)" className="font-sans">
          {unit.name}
        </text>
        {props.lanes.map((name, i) => (
          <text key={name} x={xs[i]} y={40} textAnchor="middle" fontSize="17" fill="var(--foreground)" className="font-sans">
            {name}
          </text>
        ))}
      </svg>
      <div
        ref={scroller}
        className="relative overflow-x-hidden overflow-y-auto overscroll-contain"
        style={{ height: height - head }}
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
          {Array.from(
            { length: Math.floor((props.duration - origin) / tickStep) + 2 },
            (_, i) => (Math.ceil(origin / tickStep) + i) * tickStep,
          )
            .filter((v) => v >= lo && v <= hi)
            .map((v) => {
              const text = inUnit(v, { ...unit, digits: 3 })
              return (
                <g key={v}>
                  <line x1={xs[0]} x2={xs[1]} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" />
                  {tickFree(v, text) && (
                    <text x={4} y={y(v)} dy="0.32em" fontSize="17" fill="var(--chart-ink)" className="font-sans">
                      {text}
                    </text>
                  )}
                </g>
              )
            })}
          {t < 0 &&
            props.empty?.map((line, i) => (
              <text
                key={i}
                x={(xs[0] + xs[1]) / 2}
                y={top + 48 + i * 24}
                textAnchor="middle"
                fontSize="17"
                fill="var(--muted-foreground)"
                stroke="var(--background)"
                strokeWidth={4}
                paintOrder="stroke"
                className="font-sans"
              >
                {line}
              </text>
            ))}
          {props.lanes.map((name, i) => (
            <line key={name} x1={xs[i]} x2={xs[i]} y1={top} y2={total} stroke="var(--muted-foreground)" />
          ))}
          {t >= 0 && <line x1={0} x2={width} y1={yt} y2={yt} stroke="var(--muted-foreground)" strokeDasharray="2 3" />}
          {/* Only the past is drawn: the bands and the crosses stop at the now line. Labels
              are all of past events, so they are not cut, and a halo keeps lines off them. */}
          <g>
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
                  <g clipPath={`url(#${clip})`}>
                    <polygon points={band} fill={f.color} fillOpacity={f.lost ? 0.1 : 0.18} />
                    <line
                      x1={a}
                      y1={y(f.t_start)}
                      x2={bx}
                      y2={leadY}
                      stroke={f.color}
                      strokeWidth={sel ? 3 : 1.75}
                      strokeDasharray={f.lost ? "5 3" : undefined}
                    />
                    <line x1={a} y1={y(f.t_start)} x2={bx} y2={leadY} stroke="transparent" strokeWidth={14} />
                    {f.lost && <Cross x={bx} y={leadY} />}
                  </g>
                  {labelled.send.has(f.id) && (
                    <text
                      x={a + (f.from === 0 ? 6 : -6)}
                      y={y(f.t_start) - 3}
                      textAnchor={f.from === 0 ? "start" : "end"}
                      fontSize="17"
                      fill="var(--foreground)"
                      {...HALO}
                      className="font-sans"
                    >
                      {f.label}
                    </text>
                  )}
                  {!f.lost && t >= arrive && labelled.arrive.has(f.id) && (
                    <text
                      x={b + (f.from === 0 ? 6 : -6)}
                      y={y(arrive)}
                      dy="0.32em"
                      textAnchor={f.from === 0 ? "start" : "end"}
                      fontSize="17"
                      fill={f.alarm ? "var(--nv-bad)" : "var(--muted-foreground)"}
                      {...HALO}
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
                    fontSize="17"
                    fill="var(--foreground)"
                    {...HALO}
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
                    stroke="var(--foreground)"
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

/** A page-coloured outline under a label, so lines passing behind it stop short of the letters. */
const HALO = { stroke: "var(--background)", strokeWidth: 8, strokeLinejoin: "round", paintOrder: "stroke" } as const

function Cross({ x, y }: { x: number; y: number }) {
  return (
    <g stroke="var(--nv-bad)" strokeWidth={2.25} strokeLinecap="round">
      <line x1={x - 5} y1={y - 5} x2={x + 5} y2={y + 5} />
      <line x1={x - 5} y1={y + 5} x2={x + 5} y2={y - 5} />
    </g>
  )
}

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
}

/** One entry of a ladder's key: a small drawing of the mark, then what it means. */
export function LadderKey({
  mark,
  color = "var(--nv-busy)",
  children,
}: {
  mark: "band" | "back" | "cross" | "now" | "timer"
  color?: string
  children: ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="24" height="14" aria-hidden="true" className="shrink-0">
        {mark === "band" || mark === "back" ? (
          <>
            <polygon points={mark === "band" ? "1,1 1,5 23,13 23,9" : "23,1 23,5 1,13 1,9"} fill={color} fillOpacity={0.18} />
            <line x1={mark === "band" ? 1 : 23} y1={1} x2={mark === "band" ? 23 : 1} y2={9} stroke={color} strokeWidth={1.75} />
          </>
        ) : mark === "cross" ? (
          <Cross x={12} y={7} />
        ) : mark === "now" ? (
          <line x1={0} x2={24} y1={7} y2={7} stroke="var(--muted-foreground)" strokeDasharray="2 3" />
        ) : (
          <rect x={8} y={3} width={8} height={8} fill="var(--background)" stroke="var(--foreground)" transform="rotate(45 12 7)" />
        )}
      </svg>
      {children}
    </span>
  )
}
