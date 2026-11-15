import { useEffect, useRef, useState } from "react"

import type { RdtParams, Snapshot } from "../../core/rdt"
import { scrollBehavior } from "../../components/ToolFrame"

const BOX = 30
const GAP = 4
const GUTTER = 112

const SENDER: Record<string, { fill: string; label: string }> = {
  ".": { fill: "transparent", label: "not sent yet" },
  q: { fill: "color-mix(in oklab, var(--chart-1) 12%, transparent)", label: "waiting for the link" },
  s: { fill: "color-mix(in oklab, var(--chart-1) 35%, transparent)", label: "sent, waiting for its acknowledgement" },
  a: { fill: "var(--chart-1)", label: "acknowledged" },
}
const RECEIVER: Record<string, { fill: string; label: string }> = {
  ".": { fill: "transparent", label: "not received yet" },
  b: { fill: "color-mix(in oklab, var(--chart-2) 35%, transparent)", label: "kept, waiting for an earlier one" },
  d: { fill: "var(--chart-2)", label: "handed to the application" },
  x: { fill: "var(--destructive)", label: "handed over, but it was the wrong message" },
}

/**
 * Both sides' messages on one strip each, in order, left to right. The
 * outline is the window: on the sender, the messages it may have out at
 * once, never more than N wide; on the receiver, the ones it will accept.
 * Each row names its own marks underneath, so there is no separate key.
 */
export function WindowView({ p, s, t, started }: { p: RdtParams; s: Snapshot; t: number; started: boolean }) {
  const n = p.messages
  const m = 2 ** p.seq_bits
  const rw = p.rules.buffer ? p.window : 1
  const width = GUTTER + n * (BOX + GAP) + 12
  const strip = useRef<HTMLDivElement>(null)
  const x = (i: number) => GUTTER + i * (BOX + GAP)
  // Only the boxes near the visible part of the strip are drawn, so a run of
  // thousands of messages still plays smoothly.
  const [left, setLeft] = useState(0)
  const first = Math.max(0, Math.floor((left - GUTTER) / (BOX + GAP)) - 8)
  const last = Math.min(n, Math.ceil((left + 1600) / (BOX + GAP)) + 8)
  const shown = Array.from({ length: Math.max(0, last - first) }, (_, k) => first + k)

  useEffect(() => {
    const el = strip.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    const target = x(s.base) - el.clientWidth / 3
    if (x(s.base) < el.scrollLeft + GUTTER || x(s.base + p.window) > el.scrollLeft + el.clientWidth - 20)
      el.scrollTo({ left: Math.max(0, target), behavior: scrollBehavior() })
  }, [s.base, p.window])

  // Before the first event nothing has been sent, whatever the first snapshot says.
  const sender = started ? s.sender : ".".repeat(n)
  const receiver = started ? s.receiver : ".".repeat(n)
  const base = started ? s.base : 0
  const next = started ? s.next : 0
  const rcvBase = started ? s.rcv_base : 0
  const timer = new Map(started ? s.timers : [])
  const ySend = 18
  const yRecv = 18
  const present = (row: string, keys: string[]) => keys.filter((k) => k === "." || row.includes(k))

  const row = (who: "sender" | "receiver") => {
    const isSender = who === "sender"
    const states = isSender ? sender : receiver
    const table = isSender ? SENDER : RECEIVER
    const lo = isSender ? base : rcvBase
    const span = isSender ? Math.min(p.window, n - base) : Math.max(0, Math.min(rw, n - rcvBase))
    const y = isSender ? ySend : yRecv
    return (
      <svg width={width} height={y + BOX + 10} role="img" aria-label={`${who}: ${states.length} messages`}>
        <text x={0} y={y + BOX / 2} dy="0.35em" fontSize="11" fill="var(--muted-foreground)">
          sequence number
        </text>
        {isSender && timer.size > 0 && (
          <text x={0} y={y - 9} dy="0.35em" fontSize="11" fill="var(--muted-foreground)">
            timer, time left
          </text>
        )}
        {span > 0 && (
          <rect
            x={x(lo) - 3}
            y={y - 5}
            width={span * (BOX + GAP) + 2}
            height={BOX + 10}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={1.5}
            rx={2}
          />
        )}
        {shown.map((i) => {
          const st = table[states[i]] ?? table["."]
          const exp = isSender ? timer.get(i) : undefined
          const rest = exp !== undefined ? Math.max(0, Math.min(1, (exp - t) / p.timeout_us)) : null
          const solid = states[i] === "a" || states[i] === "d" || states[i] === "x"
          return (
            <g key={i}>
              <title>{`message ${i}, sequence number ${i % m}: ${st.label}`}</title>
              {rest !== null && <rect x={x(i)} y={y - 12} width={BOX * rest} height={4} fill="var(--foreground)" opacity={0.7} />}
              <rect x={x(i)} y={y} width={BOX} height={BOX} fill={st.fill} stroke="var(--input)" rx={2} />
              <text
                x={x(i) + BOX / 2}
                y={y + BOX / 2}
                dy="0.35em"
                textAnchor="middle"
                fontSize="13"
                fill={solid ? "white" : "var(--foreground)"}
              >
                {i % m}
              </text>
            </g>
          )
        })}
      </svg>
    )
  }

  const key = (row: string, table: Record<string, { fill: string; label: string }>, keys: string[]) => (
    <ul className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
      {present(row, keys).map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden>
            <rect x="0.5" y="0.5" width="11" height="11" rx="2" fill={table[k].fill} stroke="var(--input)" />
          </svg>
          {table[k].label}
        </li>
      ))}
    </ul>
  )

  return (
    <figure className="space-y-4 font-sans text-sm lining">
      <figcaption className="max-w-[70ch] text-[0.98rem] text-foreground">
        Each box is one message, in order from the left. The number in it is the sequence number the message travels with
        {m < n ? `; the numbers run from 0 to ${m - 1} and then start again` : ""}. The outline is the window.
      </figcaption>
      <div ref={strip} className="space-y-4 overflow-x-auto" onScroll={(e) => setLeft(e.currentTarget.scrollLeft)}>
        <div>
          <p>
            <b className="font-semibold">Sender.</b> The outline holds the messages it may have out at once without an acknowledgement: at
            most {p.window}. {started ? `${next - base} out now.` : ""}
          </p>
          {row("sender")}
          {key(sender, SENDER, [".", "q", "s", "a"])}
        </div>
        <div>
          <p>
            <b className="font-semibold">Receiver.</b> The outline holds the messages it will accept now. It is waiting for message{" "}
            {rcvBase < n ? `${rcvBase} (sequence number ${rcvBase % m})` : "none: it has them all"}.
          </p>
          {row("receiver")}
          {key(receiver, RECEIVER, [".", "b", "d", "x"])}
        </div>
      </div>
    </figure>
  )
}
