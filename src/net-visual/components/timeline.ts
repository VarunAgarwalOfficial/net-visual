import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"

/** Index of the last time <= t, or -1. `times` must be sorted. */
export function lastAtOrBefore(times: readonly number[], t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

export interface Timeline {
  t: number
  index: number
  duration: number
  playing: boolean
  speed: number
  setSpeed(s: number): void
  toggle(): void
  pause(): void
  step(delta: number): void
  seek(t: number): void
  seekIndex(i: number): void
  home(): void
  end(): void
}

/**
 * Reversible time over a precomputed trace. Playback moves a continuous
 * clock (so packets glide along their paths); stepping moves event by event,
 * including several events at the same instant. `rate` is simulated
 * microseconds per real second at speed 1.
 */
export function useTimeline(times: readonly number[], duration: number, rate: number, start = 0): Timeline {
  // `index` is kept only while the trace it was taken from is current; a new
  // trace keeps the clock where it was, clamped to the new run. `before`
  // marks the moment before the first event: at the start, nothing has
  // happened yet, even events stamped at time zero.
  const [cursor, setCursor] = useState<{ t: number; index: number | null; of: readonly number[] | null; before?: boolean }>({
    t: start,
    index: null,
    of: null,
    before: start <= 0,
  })
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const frame = useRef(0)
  const last = useRef(0)

  const t = Math.max(0, Math.min(cursor.t, duration))
  const index = cursor.before ? -1 : cursor.of === times && cursor.index !== null ? cursor.index : lastAtOrBefore(times, t)

  useEffect(() => {
    if (!playing) return
    last.current = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(now - last.current, 100) / 1000
      last.current = now
      let stop = false
      setCursor((c) => {
        const next = Math.min(duration, Math.min(c.t, duration) + dt * rate * speed)
        if (next >= duration) stop = true
        return { t: next, index: null, of: null }
      })
      if (stop) setPlaying(false)
      else frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [playing, duration, rate, speed])

  const seekIndex = useCallback(
    (i: number) => {
      const k = Math.max(-1, Math.min(times.length - 1, i))
      setCursor({ t: k < 0 ? 0 : times[k], index: k, of: times, before: k < 0 })
    },
    [times],
  )

  return useMemo(
    () => ({
      t,
      index,
      duration,
      playing,
      speed,
      setSpeed,
      toggle: () => {
        if (!playing && t >= duration) setCursor({ t: 0, index: null, of: null, before: true })
        setPlaying(!playing)
      },
      pause: () => setPlaying(false),
      step: (delta: number) => {
        setPlaying(false)
        seekIndex(index + delta)
      },
      // Not clamped here: a seek may target a run that is about to replace this one.
      seek: (to: number) => setCursor({ t: Math.max(0, to), index: null, of: null, before: to <= 0 }),
      seekIndex,
      home: () => {
        setPlaying(false)
        setCursor({ t: 0, index: null, of: null, before: true })
      },
      end: () => {
        setPlaying(false)
        setCursor({ t: duration, index: times.length - 1, of: times })
      },
    }),
    [t, index, duration, playing, speed, times, seekIndex],
  )
}

/** Keyboard map shared by every tool: space, arrows, Home, End. */
export function timelineKeys(tl: Timeline, e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement
  if (target.closest("input, textarea, select, [role=slider], [role=tab]")) return false
  // A closed scenario picker uses Space, Enter, the up and down arrows and
  // typed letters, but not left, right, Home or End: without this the page
  // would scroll on End just after choosing a scenario.
  const picker = target.closest("[role=combobox]")
  if (picker && (picker.getAttribute("aria-expanded") === "true" || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)))
    return false
  // Space and Enter on a focused button press that button, as everywhere else.
  if ((e.key === " " || e.key === "Enter") && target.closest("button, a")) return false
  switch (e.key) {
    case " ":
    case "k":
      tl.toggle()
      return true
    case "ArrowRight":
    case "l":
      tl.step(1)
      return true
    case "ArrowLeft":
    case "j":
      tl.step(-1)
      return true
    case "Home":
      tl.home()
      return true
    case "End":
      tl.end()
      return true
    default:
      return false
  }
}

/**
 * When an action removes the control that had focus (an editor closing, or
 * re-keyed because the scenario became "your own"), focus falls to the page
 * and the tool's keys stop working: End scrolls the page instead. This hands
 * focus back to the tool once the new frame is drawn. The root needs
 * tabIndex -1.
 */
export function keepFocus(root: { readonly current: HTMLElement | null }) {
  requestAnimationFrame(() => {
    const r = root.current
    if (r && !r.contains(document.activeElement)) r.focus({ preventScroll: true })
  })
}

/**
 * One unit for the whole run, chosen from its length and spelled out, so the
 * counter never reads "0 µs of 3.000 s".
 */
export function runUnit(durationUs: number): { name: string; per: number; digits: number } {
  const [name, per] = durationUs >= 2e6 ? ["seconds", 1e6] : durationUs >= 2e3 ? ["milliseconds", 1e3] : ["microseconds", 1]
  const span = durationUs / per
  return { name, per, digits: span >= 100 ? 1 : span >= 10 ? 2 : 3 }
}

export const inUnit = (us: number, u: { per: number; digits: number }) => {
  const v = us / u.per
  return v === 0 ? "0" : Number(v.toFixed(u.digits)).toString()
}

/** A time in the unit the player uses for this run, spelled out: "12.5 milliseconds". */
export const timeIn = (us: number, durationUs: number) => {
  const u = runUnit(durationUs)
  return `${inUnit(us, u)} ${u.name}`
}

/** A length of time by its own size, spelled out: "300 microseconds", "1.2 milliseconds". */
export const spanIn = (us: number) => {
  const [name, per] = us >= 1e6 ? ["seconds", 1e6] : us >= 1e3 ? ["milliseconds", 1e3] : ["microseconds", 1]
  return `${Number((us / per).toPrecision(3))} ${name}`
}

export function formatTime(us: number): string {
  if (us < 1000) return `${us.toFixed(0)} µs`
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`
  return `${(us / 1_000_000).toFixed(3)} s`
}
