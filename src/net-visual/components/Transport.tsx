import { Pause, Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LabelledSlider } from "./Controls"
import { inUnit, runUnit, type Timeline } from "./timeline"

const SPEEDS: [number, string][] = [
  [0.25, "quarter speed"],
  [0.5, "half speed"],
  [1, "normal speed"],
  [2, "twice as fast"],
  [4, "4 times as fast"],
  [16, "16 times as fast"],
  [64, "64 times as fast"],
]

/**
 * The player. Play comes first and is the one filled button on the page;
 * every other control is an outlined button named in words, and the five
 * fit one row at phone width. Keys: space plays and pauses, the left and
 * right arrows step, Home and End jump to the start and the end.
 */
export function Transport({
  tl,
  events,
  us = (t) => t,
  format,
  noun = "step",
  stepIs = "one thing happening in the run",
  clock = true,
}: {
  tl: Timeline
  events: number | null
  /** Simulated microseconds at clock value t. */
  us?: (t: number) => number
  /** Replaces the time counter where the clock is not plain time (rounds). */
  format?: (t: number) => string
  /** What one step is called in the counter. */
  noun?: string
  /** What one step is, in a few words: "one packet sent, arriving or lost". */
  stepIs?: string
  /** False where the clock only counts steps, so the counter is not said twice. */
  clock?: boolean
}) {
  const atEnd = tl.t >= tl.duration && tl.duration > 0
  const unit = runUnit(us(tl.duration))
  const time = format
    ? `${format(tl.t)} of ${format(tl.duration).replace(/^[a-z ]+/, "")}`
    : `${inUnit(us(tl.t), unit)} of ${inUnit(us(tl.duration), unit)} ${unit.name}`
  const Noun = noun[0].toUpperCase() + noun.slice(1)
  return (
    <div className="space-y-2" role="group" aria-label="Player">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={tl.toggle} aria-keyshortcuts="Space" className="min-w-20" data-nv-play>
          {tl.playing ? <Pause /> : <Play />}
          {tl.playing ? "Pause" : atEnd ? "Play again" : tl.t > 0 ? "Continue" : "Play"}
        </Button>
        <span className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => tl.step(-1)} aria-label={`Back one ${noun}`} aria-keyshortcuts="ArrowLeft">
            Back
          </Button>
          <Button variant="outline" size="sm" onClick={() => tl.step(1)} aria-label={`Next ${noun}`} aria-keyshortcuts="ArrowRight">
            Next
          </Button>
        </span>
        <span className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={tl.home} aria-label="Go to the start" aria-keyshortcuts="Home">
            Start
          </Button>
          <Button variant="outline" size="sm" onClick={tl.end} aria-label="Go to the end" aria-keyshortcuts="End">
            End
          </Button>
        </span>
      </div>
      <LabelledSlider
        label="Simulated time"
        valueText={format ? format(tl.t) : `${inUnit(us(tl.t), unit)} ${unit.name}`}
        min={0}
        max={Math.max(1, tl.duration)}
        step={Math.max(1, tl.duration / 2000)}
        value={[tl.t]}
        onValueChange={([v]) => {
          tl.pause()
          tl.seek(v)
        }}
      />
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-sans text-sm text-muted-foreground" data-nv-num>
        <span aria-live="off">
          {events !== null && (
            <>
              {Noun} {Math.max(0, tl.index + 1)} of {events}
              <span className="text-muted-foreground/90">
                {" "}
                (a {noun} is {stepIs})
              </span>
              {clock && "; "}
            </>
          )}
          {clock && (format ? time : events === null ? `Time ${time}` : `time ${time}`)}
        </span>
        <label className="flex items-center gap-1.5">
          Playing speed
          <select
            className="rounded-sm border border-input bg-background px-1 py-0.5 text-sm"
            value={tl.speed}
            onChange={(e) => tl.setSpeed(Number(e.target.value))}
          >
            {SPEEDS.map(([s, name]) => (
              <option key={s} value={s}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
