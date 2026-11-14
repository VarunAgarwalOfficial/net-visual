import { useEffect, useRef } from "react"

import type { RdtParams, Snapshot } from "../../core/rdt"

const BOX = 30
const GAP = 4

const SENDER: Record<string, { fill: string; label: string }> = {
  ".": { fill: "transparent", label: "not yet sent" },
  q: { fill: "color-mix(in oklab, var(--chart-1) 12%, transparent)", label: "waiting for the link" },
  s: { fill: "color-mix(in oklab, var(--chart-1) 35%, transparent)", label: "sent, not yet acknowledged" },
  a: { fill: "var(--chart-1)", label: "acknowledged" },
}
const RECEIVER: Record<string, { fill: string; label: string }> = {
  ".": { fill: "transparent", label: "not received" },
  b: { fill: "color-mix(in oklab, var(--chart-2) 35%, transparent)", label: "buffered, out of order" },
  d: { fill: "var(--chart-2)", label: "delivered to the application" },
  x: { fill: "var(--destructive)", label: "delivered, but it held another message" },
}

/**
 * Both windows on one strip of message indices. The bracket is the window;
 * its width never exceeds N, which is the invariant next - base <= N drawn as
 * geometry. Timer bars shrink as the clock runs.
 */
export function WindowView({ p, s, t, onPick }: { p: RdtParams; s: Snapshot; t: number; onPick?(index: number): void }) {
  const n = p.messages
  const m = 2 ** p.seq_bits
  const rw = p.rules.buffer ? p.window : 1
  const width = Math.max(560, n * (BOX + GAP) + 40)
  const strip = useRef<HTMLDivElement>(null)
  const x = (i: number) => 20 + i * (BOX + GAP)

  useEffect(() => {
    const el = strip.current
    if (!el) return
    const target = x(s.base) - el.clientWidth / 3
    if (x(s.base) < el.scrollLeft + 20 || x(s.base + p.window) > el.scrollLeft + el.clientWidth - 20)
      el.scrollTo({ left: Math.max(0, target), behavior: "smooth" })
  }, [s.base, p.window])

  const timer = new Map(s.timers)
  const ySend = 46
  const yRecv = 150

  return (
    <div className="font-sans lining">
      <div ref={strip} className="overflow-x-auto">
        <svg
          width={width}
          height={214}
          role="img"
          aria-label={`Sender window from ${s.base} to ${s.base + p.window - 1}; receiver expects ${s.rcv_base}`}
        >
          <text x={4} y={14} fontSize="12" fill="var(--muted-foreground)">
            sender: base = {s.base}, next = {s.next}, next − base = {s.next - s.base} ≤ N = {p.window}
          </text>
          <rect
            x={x(s.base) - 3}
            y={ySend - 5}
            width={Math.min(p.window, n - s.base) * (BOX + GAP) + 2}
            height={BOX + 10}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={1.5}
            rx={2}
            style={{ transition: "x 180ms ease-out" }}
          />
          {Array.from({ length: n }, (_, i) => {
            const st = SENDER[s.sender[i]] ?? SENDER["."]
            const exp = timer.get(i)
            const left = exp !== undefined ? Math.max(0, Math.min(1, (exp - t) / p.timeout_us)) : null
            return (
              <g key={i} onClick={() => onPick?.(i)} className={onPick ? "cursor-pointer" : undefined}>
                <title>{`message ${i} (seq ${i % m}): ${st.label}`}</title>
                {left !== null && <rect x={x(i)} y={ySend - 13} width={BOX * left} height={4} fill="var(--foreground)" opacity={0.7} />}
                <rect x={x(i)} y={ySend} width={BOX} height={BOX} fill={st.fill} stroke="var(--input)" rx={2} />
                <text
                  x={x(i) + BOX / 2}
                  y={ySend + BOX / 2}
                  dy="0.35em"
                  textAnchor="middle"
                  fontSize="13"
                  fill={s.sender[i] === "a" ? "white" : "var(--foreground)"}
                >
                  {i % m}
                </text>
                <text x={x(i) + BOX / 2} y={ySend + BOX + 13} textAnchor="middle" fontSize="9.5" fill="var(--muted-foreground)">
                  {i}
                </text>
              </g>
            )
          })}
          <text x={4} y={yRecv - 22} fontSize="12" fill="var(--muted-foreground)">
            receiver: expects {s.rcv_base} (seq {s.rcv_base % m}), window {rw}
          </text>
          <rect
            x={x(s.rcv_base) - 3}
            y={yRecv - 5}
            width={Math.max(0, Math.min(rw, n - s.rcv_base)) * (BOX + GAP) + 2}
            height={BOX + 10}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={1.5}
            rx={2}
          />
          {Array.from({ length: n }, (_, i) => {
            const st = RECEIVER[s.receiver[i]] ?? RECEIVER["."]
            const solid = s.receiver[i] === "d" || s.receiver[i] === "x"
            return (
              <g key={i}>
                <title>{`message ${i}: ${st.label}`}</title>
                <rect x={x(i)} y={yRecv} width={BOX} height={BOX} fill={st.fill} stroke="var(--input)" rx={2} />
                <text
                  x={x(i) + BOX / 2}
                  y={yRecv + BOX / 2}
                  dy="0.35em"
                  textAnchor="middle"
                  fontSize="13"
                  fill={solid ? "white" : "var(--foreground)"}
                >
                  {i % m}
                </text>
                {s.receiver[i] === "x" && (
                  <text x={x(i) + BOX / 2} y={yRecv + BOX + 13} textAnchor="middle" fontSize="9.5" fill="var(--destructive)">
                    wrong
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Key">
        {(["q", "s", "a"] as const).map((k) => (
          <Key key={k} fill={SENDER[k].fill} label={SENDER[k].label} />
        ))}
        {(["b", "d", "x"] as const).map((k) => (
          <Key key={k} fill={RECEIVER[k].fill} label={RECEIVER[k].label} />
        ))}
        <li className="flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden>
            <rect x="0" y="2" width="18" height="4" fill="var(--foreground)" opacity={0.7} />
          </svg>
          timer remaining
        </li>
      </ul>
    </div>
  )
}

function Key({ fill, label }: { fill: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg width="12" height="12" aria-hidden>
        <rect x="0.5" y="0.5" width="11" height="11" rx="2" fill={fill} stroke="var(--input)" />
      </svg>
      {label}
    </li>
  )
}
