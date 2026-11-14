import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LabelledSlider } from "./Controls"
import { formatTime, type Timeline } from "./timeline"

const SPEEDS = [0.25, 0.5, 1, 2, 4, 16, 64]

/** Play, pause, step and scrub. Keys: space, left and right arrows, Home, End. */
export function Transport({ tl, events }: { tl: Timeline; events: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="group" aria-label="Playback">
      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" onClick={tl.home} aria-label="Go to start (Home)">
          <SkipBack />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => tl.step(-1)} aria-label="Previous event (left arrow)">
          <StepBack />
        </Button>
        <Button variant="outline" size="icon" onClick={tl.toggle} aria-label={tl.playing ? "Pause (space)" : "Play (space)"}>
          {tl.playing ? <Pause /> : <Play />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => tl.step(1)} aria-label="Next event (right arrow)">
          <StepForward />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={tl.end} aria-label="Go to end (End)">
          <SkipForward />
        </Button>
      </div>
      <LabelledSlider
        className="min-w-40 flex-1"
        label="Simulated time"
        valueText={formatTime(tl.t)}
        min={0}
        max={Math.max(1, tl.duration)}
        step={Math.max(1, tl.duration / 2000)}
        value={[tl.t]}
        onValueChange={([v]) => {
          tl.pause()
          tl.seek(v)
        }}
      />
      <div className="flex items-center gap-3 font-sans text-sm text-muted-foreground lining">
        <span className="min-w-36 tabular-nums" aria-live="off">
          t = {formatTime(tl.t)} · {Math.max(0, tl.index + 1)}/{events}
        </span>
        <label className="flex items-center gap-1">
          <span className="sr-only">Speed</span>
          <select
            className="rounded-sm border border-input bg-background px-1 py-0.5 text-sm"
            value={tl.speed}
            onChange={(e) => tl.setSpeed(Number(e.target.value))}
            aria-label="Playback speed"
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
  )
}
