import { Pause, Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LabelledSlider } from "./Controls"
import { formatTime, type Timeline } from "./timeline"

const SPEEDS = [0.25, 0.5, 1, 2, 4, 16, 64]

/**
 * The player. Play comes first and is the one filled button on the page;
 * every other control is named in words. Keys: space plays and pauses, the
 * left and right arrows step, Home and End jump to the start and the end.
 */
export function Transport({
  tl,
  events,
  format = formatTime,
  noun = "event",
  clock = true,
}: {
  tl: Timeline
  events: number | null
  format?: (t: number) => string
  /** What one step is, for the counter: "event", "step". */
  noun?: string
  /** False where the clock only counts steps, so the counter is not said twice. */
  clock?: boolean
}) {
  const atEnd = tl.t >= tl.duration && tl.duration > 0
  return (
    <div className="space-y-2" role="group" aria-label="Player">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={tl.toggle} aria-keyshortcuts="Space" className="min-w-24" data-nv-play>
          {tl.playing ? <Pause /> : <Play />}
          {tl.playing ? "Pause" : atEnd ? "Play again" : tl.t > 0 ? "Continue" : "Play"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => tl.step(-1)} aria-keyshortcuts="ArrowLeft">
          Back one {noun}
        </Button>
        <Button variant="outline" size="sm" onClick={() => tl.step(1)} aria-keyshortcuts="ArrowRight">
          Next {noun}
        </Button>
        <Button variant="ghost" size="sm" onClick={tl.home} aria-keyshortcuts="Home">
          Start
        </Button>
        <Button variant="ghost" size="sm" onClick={tl.end} aria-keyshortcuts="End">
          End
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <LabelledSlider
          className="min-w-48 flex-1"
          label="Simulated time"
          valueText={format(tl.t)}
          min={0}
          max={Math.max(1, tl.duration)}
          step={Math.max(1, tl.duration / 2000)}
          value={[tl.t]}
          onValueChange={([v]) => {
            tl.pause()
            tl.seek(v)
          }}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-sm text-muted-foreground lining">
          <span className="tabular-nums" aria-live="off">
            {clock && `${format(tl.t)} of ${format(tl.duration)}`}
            {events !== null && `${clock ? ", " : ""}${noun} ${Math.max(0, tl.index + 1)} of ${events}`}
          </span>
          <label className="flex items-center gap-1.5">
            Speed
            <select
              className="rounded-sm border border-input bg-background px-1 py-0.5 text-sm"
              value={tl.speed}
              onChange={(e) => tl.setSpeed(Number(e.target.value))}
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  )
}
