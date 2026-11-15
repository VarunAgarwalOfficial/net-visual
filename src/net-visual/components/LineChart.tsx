import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"

export interface Series {
  id: string
  label: string
  /** A CSS colour, normally var(--chart-n), in fixed order per chart. */
  color: string
  kind: "line" | "dots" | "step"
  points: [number, number][]
  dashed?: boolean
}

interface Props {
  title: string
  series: Series[]
  xLabel: string
  yLabel: string
  xFormat?: (x: number) => string
  yFormat?: (y: number) => string
  xDomain?: [number, number]
  yDomain?: [number, number]
  height?: number
  /** A vertical marker, for charts synchronised with the timeline. */
  cursor?: number
  /**
   * Draw the series solid only up to this x, and faint after it, so a chart
   * synchronised with the timeline does not show results the run has not
   * reached as if they had happened.
   */
  upTo?: number
  onSeek?: (x: number) => void
  log?: { x?: boolean }
  /** Extra marks drawn under the series; a function receives the scales. */
  children?: ReactNode | ((scale: Scale) => ReactNode)
  /** Marks drawn over the series, such as labels that must stay legible. */
  overlay?: (scale: Scale) => ReactNode
}

/** The chart's scales, for marks placed in data coordinates. */
export interface Scale {
  sx(x: number): number
  sy(y: number): number
  left: number
  right: number
  top: number
  bottom: number
}

function ticks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo
  if (span <= 0) return [lo]
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

/**
 * Lines, steps and dots on one pair of axes. 2px lines, 8px dots with a
 * surface ring, hairline grid, each series named on the chart beside its
 * line (no separate key), a hover readout, and a table view so no value
 * depends on colour alone.
 */
export function LineChart(props: Props) {
  const { series, xLabel, yLabel, height = 260, cursor, onSeek, upTo } = props
  const xFormat = props.xFormat ?? ((x: number) => String(x))
  const yFormat = props.yFormat ?? ((y: number) => y.toFixed(2))
  const [box, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "")
  const m = { l: 52, r: 16, t: 10, b: 40 }
  const w = width - m.l - m.r
  const h = height - m.t - m.b

  const all = series.flatMap((s) => s.points)
  const [x0, x1] = props.xDomain ?? [Math.min(...all.map((p) => p[0]), 0), Math.max(...all.map((p) => p[0]), 1)]
  const [y0, y1] = props.yDomain ?? [0, Math.max(...all.map((p) => p[1]), 1e-9) * 1.08]
  const sx = (x: number) => m.l + ((x - x0) / (x1 - x0 || 1)) * w
  const sy = (y: number) => m.t + h - ((y - y0) / (y1 - y0 || 1)) * h
  const xt = ticks(x0, x1, Math.max(2, Math.floor(w / 90)))
  const yt = ticks(y0, y1, Math.max(2, Math.floor(h / 50)))

  const paths = useMemo(
    () =>
      series.map((s) => {
        if (s.kind === "dots") return ""
        let d = ""
        s.points.forEach(([x, y], i) => {
          const X = sx(x).toFixed(1)
          const Y = sy(Math.min(Math.max(y, y0), y1)).toFixed(1)
          if (i === 0) d += `M${X},${Y}`
          else if (s.kind === "step") d += `H${X}V${Y}`
          else d += `L${X},${Y}`
        })
        return d
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, width, height, x0, x1, y0, y1],
  )

  const nearest = (s: Series, x: number) => {
    let best: [number, number] | null = null
    for (const p of s.points) {
      if (s.kind === "step") {
        if (p[0] <= x) best = p
      } else if (!best || Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p
    }
    return best
  }

  // Each series is named where its line is drawn, at its last point up to
  // the clock, pushed apart so names do not overlap.
  const labels = useMemo(() => {
    if (series.length < 2) return []
    const limit = upTo ?? Infinity
    const out = series.flatMap((s) => {
      if (!s.points.length) return []
      let p = s.points[0]
      for (const q of s.points) if (q[0] <= limit) p = q
      const X = sx(p[0])
      return [{ id: s.id, label: s.label, color: s.color, x: X, y: sy(Math.min(Math.max(p[1], y0), y1)) - 7 }]
    })
    out.sort((a, b) => a.y - b.y)
    for (let k = 1; k < out.length; k++) if (out[k].y - out[k - 1].y < 13) out[k].y = out[k - 1].y + 13
    const over = out.length ? out[out.length - 1].y - (m.t + h - 2) : 0
    if (over > 0) for (const l of out) l.y -= over
    for (let k = 0; k < out.length; k++) out[k].y = Math.max(out[k].y, m.t + 10 + k * 13)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, upTo, width, height, x0, x1, y0, y1])
  const ahead = upTo !== undefined && upTo < x1 ? Math.max(m.l, sx(Math.max(upTo, x0))) : null

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = x0 + ((e.clientX - rect.left - m.l) / w) * (x1 - x0)
    setHover(Math.max(x0, Math.min(x1, x)))
  }

  return (
    <figure className="font-sans">
      <figcaption className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-serif text-base text-foreground">{props.title}</span>
        <button
          className="shrink-0 rounded-sm border border-input bg-background px-2 py-0.5 text-xs hover:bg-muted"
          onClick={() => setTable(!table)}
        >
          {table ? "Show the chart" : "Show the numbers as a table"}
        </button>
      </figcaption>
      <div ref={box} className="relative">
        {table ? (
          <div className="max-h-72 overflow-auto text-xs">
            <table className="w-full">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pr-3 font-normal">series</th>
                  <th className="pr-3 font-normal">{xLabel}</th>
                  <th className="font-normal">{yLabel}</th>
                </tr>
              </thead>
              <tbody>
                {series.flatMap((s) =>
                  s.points
                    .filter((_, i) => s.points.length < 200 || i % Math.ceil(s.points.length / 200) === 0)
                    .map((p, i) => (
                      <tr key={`${s.id}-${i}`}>
                        <td className="pr-3">{s.label}</td>
                        <td className="pr-3">{xFormat(p[0])}</td>
                        <td>{yFormat(p[1])}</td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-labelledby={`${id}-t`}
            onPointerMove={move}
            onPointerLeave={() => setHover(null)}
            onClick={() => hover !== null && onSeek?.(hover)}
            className={onSeek ? "cursor-crosshair" : undefined}
          >
            <title id={`${id}-t`}>{props.title}</title>
            {yt.map((v) => (
              <g key={`y${v}`}>
                <line x1={m.l} x2={m.l + w} y1={sy(v)} y2={sy(v)} stroke="var(--chart-grid)" />
                <text x={m.l - 6} y={sy(v)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--chart-ink)">
                  {yFormat(v)}
                </text>
              </g>
            ))}
            {xt.map((v) => (
              <text key={`x${v}`} x={sx(v)} y={m.t + h + 16} textAnchor="middle" fontSize="11" fill="var(--chart-ink)">
                {xFormat(v)}
              </text>
            ))}
            <line x1={m.l} x2={m.l + w} y1={m.t + h} y2={m.t + h} stroke="var(--chart-ink)" strokeOpacity={0.5} />
            <text x={m.l + w / 2} y={height - 4} textAnchor="middle" fontSize="12" fill="var(--chart-ink)">
              {xLabel}
            </text>
            <text transform={`translate(15 ${m.t + h / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="var(--chart-ink)">
              {yLabel}
            </text>
            {typeof props.children === "function"
              ? props.children({ sx, sy, left: m.l, right: m.l + w, top: m.t, bottom: m.t + h })
              : props.children}
            {ahead !== null && (
              <defs>
                <clipPath id={`${id}-past`}>
                  <rect x={0} y={0} width={ahead} height={height} />
                </clipPath>
                <clipPath id={`${id}-ahead`}>
                  <rect x={ahead} y={0} width={Math.max(0, width - ahead)} height={height} />
                </clipPath>
              </defs>
            )}
            {(ahead === null ? [null] : ["past", "ahead"]).map((part) => (
              <g key={part ?? "all"} clipPath={part ? `url(#${id}-${part})` : undefined} opacity={part === "ahead" ? 0.2 : undefined}>
                {series.map((s, i) =>
                  s.kind === "dots" ? (
                    <g key={s.id}>
                      {s.points.map(([x, y], k) => (
                        <circle key={k} cx={sx(x)} cy={sy(y)} r={4} fill={s.color} stroke="var(--background)" strokeWidth={2} />
                      ))}
                    </g>
                  ) : (
                    <path
                      key={s.id}
                      d={paths[i]}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      strokeDasharray={s.dashed ? "5 4" : undefined}
                    />
                  ),
                )}
              </g>
            ))}
            {ahead !== null && m.l + w - ahead > 150 && (
              <text x={m.l + w - 4} y={m.t + 12} textAnchor="end" fontSize="11" fill="var(--chart-ink)">
                faint: the rest of the run, not reached yet
              </text>
            )}
            {labels.map((l) => (
              <text
                key={l.id}
                x={l.x < m.l + w * 0.6 ? Math.max(l.x, m.l) + 6 : l.x - 6}
                y={l.y}
                textAnchor={l.x < m.l + w * 0.6 ? "start" : "end"}
                fontSize="11"
                fill={l.color}
                stroke="var(--background)"
                strokeWidth={3}
                paintOrder="stroke"
                pointerEvents="none"
              >
                {l.label}
              </text>
            ))}
            {props.overlay?.({ sx, sy, left: m.l, right: m.l + w, top: m.t, bottom: m.t + h })}
            {cursor !== undefined && cursor >= x0 && cursor <= x1 && (
              <line x1={sx(cursor)} x2={sx(cursor)} y1={m.t} y2={m.t + h} stroke="var(--foreground)" strokeOpacity={0.6} />
            )}
            {hover !== null && (
              <g pointerEvents="none">
                <line x1={sx(hover)} x2={sx(hover)} y1={m.t} y2={m.t + h} stroke="var(--chart-ink)" strokeOpacity={0.4} />
                {series.map((s) => {
                  const p = nearest(s, hover)
                  return p ? (
                    <circle key={s.id} cx={sx(p[0])} cy={sy(p[1])} r={4} fill={s.color} stroke="var(--background)" strokeWidth={2} />
                  ) : null
                })}
              </g>
            )}
          </svg>
        )}
        {!table && hover !== null && (
          <div
            className="pointer-events-none absolute top-1 rounded-sm border border-border bg-popover px-2 py-1 text-xs shadow-sm"
            style={sx(hover) > width / 2 ? { right: width - sx(hover) + 8 } : { left: sx(hover) + 8 }}
          >
            <div className="text-muted-foreground">
              {xLabel} {xFormat(hover)}
            </div>
            {series.map((s) => {
              const p = nearest(s, hover)
              return p ? (
                <div key={s.id} className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
                  {s.label}: <span className="tabular-nums">{yFormat(p[1])}</span>
                </div>
              ) : null
            })}
          </div>
        )}
      </div>
    </figure>
  )
}
