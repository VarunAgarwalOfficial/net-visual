import { memo } from "react"

import { cn } from "@/lib/utils"
import { formatTime } from "./timeline"

export interface TraceItem {
  t: number
  step: string
  text: string
}

/** Keep the current row visible by scrolling its list only, never the page. */
function scrollWithin(el: HTMLElement | null) {
  const box = el?.closest("ol")
  if (!el || !box) return
  const top = el.offsetTop // the list is the offset parent (position: relative)
  if (top < box.scrollTop) box.scrollTop = top
  else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight
}

const TraceRow = memo(function TraceRow({
  e,
  i,
  active,
  onSeek,
  format,
}: {
  e: TraceItem
  i: number
  active: boolean
  onSeek(i: number): void
  format(t: number): string
}) {
  return (
    <li>
      <button
        className={cn("grid w-full grid-cols-[4.5rem_2rem_1fr] gap-2 px-1 py-0.5 text-left hover:bg-muted", active && "bg-mark")}
        onClick={() => onSeek(i)}
        ref={active ? scrollWithin : undefined}
      >
        <span className="text-muted-foreground tabular-nums">{format(e.t)}</span>
        <b>{e.step}</b>
        <span>{e.text}</span>
      </button>
    </li>
  )
})

/**
 * The event trace: one row per step the model took, lettered as in the
 * source. Clicking a row moves the clock there. Rows are memoised, so
 * playback re-renders only the two rows whose highlight changes.
 */
export const TraceList = memo(function TraceList({
  events,
  index,
  onSeek,
  className,
  format = formatTime,
}: {
  events: readonly TraceItem[]
  index: number
  onSeek(i: number): void
  className?: string
  /** How to print an event's time; microseconds by default. */
  format?: (t: number) => string
}) {
  return (
    <ol className={cn("relative max-h-80 overflow-auto font-sans text-sm", className)} aria-label="Event trace">
      {events.map((e, i) => (
        <TraceRow key={i} e={e} i={i} active={i === index} onSeek={onSeek} format={format} />
      ))}
    </ol>
  )
})
