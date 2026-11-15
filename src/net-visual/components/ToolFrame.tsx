import { useState, type ReactNode, type RefObject } from "react"
import { ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ToolActions, type ExportFigure } from "./ToolActions"

/*
 * The parts every tool page shares, in reading order: the loaded example,
 * the player and picture (the tool's own), the card that says what just
 * happened, the live readouts, and then everything deeper behind named
 * disclosures, closed until asked for.
 */

/** Scroll without animation when the reader has asked for less motion. */
export const scrollBehavior = (): ScrollBehavior =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"

/**
 * A named disclosure. Its content mounts when first opened (so large
 * views do not re-render during playback while closed) unless
 * `keepMounted` is set, for content whose state must survive closing.
 */
export function Disclosure({
  title,
  note,
  open,
  onOpenChange,
  keepMounted = false,
  id,
  className,
  children,
}: {
  title: ReactNode
  /** One plain line under the title saying what is inside. */
  note?: ReactNode
  open?: boolean
  onOpenChange?(open: boolean): void
  keepMounted?: boolean
  id?: string
  className?: string
  children: ReactNode
}) {
  const [own, setOwn] = useState(false)
  const isOpen = open ?? own
  const [seen, setSeen] = useState(isOpen)
  if (isOpen && !seen) setSeen(true)
  return (
    <details
      id={id}
      open={isOpen}
      onToggle={(e) => {
        const now = e.currentTarget.open
        if (now === isOpen) return
        setOwn(now)
        onOpenChange?.(now)
      }}
      className={cn("group/disclosure border-t border-border py-3", className)}
    >
      <summary className="flex cursor-pointer list-none items-start gap-2 rounded-sm py-1 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground group-open/disclosure:rotate-90" />
        <span className="min-w-0">
          <span className="block text-lg leading-snug">{title}</span>
          {note && <span className="block font-sans text-sm text-muted-foreground">{note}</span>}
        </span>
      </summary>
      <div className="pt-3 pb-2 pl-6">{keepMounted || isOpen || seen ? children : null}</div>
    </details>
  )
}

/** The example on screen: its name and what it shows, in plain words. */
export function ExampleIntro({ title }: { title: string; note?: ReactNode }) {
  // Only the example's name above the player, so Play stays the first control and the picture reaches the first screen.
  return <h2 className="max-w-[70ch] text-xl leading-snug">Example: {title}</h2>
}

/** The example's paragraph, behind one line under the picture. */
export function AboutExample({ note }: { note: ReactNode }) {
  return (
    <details className="group/about max-w-[70ch]">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 font-sans text-sm text-link [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 shrink-0 group-open/about:rotate-90" />
        About this example
      </summary>
      <p className="mt-1 text-[0.98rem]">{note}</p>
    </details>
  )
}

/**
 * What the last event was and why it happened, in a full sentence, under
 * the picture. Before the first event it says how to start.
 */
export function StepCard({
  when,
  title,
  text,
  why,
  live,
  empty,
}: {
  /** "At 1.20 ms, the sender" and the like; null before the first event. */
  when: string | null
  title?: string
  text?: ReactNode
  why?: ReactNode
  live: boolean
  empty?: ReactNode
}) {
  return (
    <section aria-labelledby="nv-step-h" className="max-w-[70ch]" aria-live={live ? "polite" : "off"}>
      <h2 id="nv-step-h" className="font-sans text-sm text-muted-foreground">
        What just happened
      </h2>
      {when === null ? (
        <p className="mt-1">
          {empty ?? (
            <>
              Nothing yet. Press <b>Play</b> to run the example, or <b>Next</b> to go one step at a time.
            </>
          )}
        </p>
      ) : (
        <>
          <p className="mt-1">
            <span className="text-muted-foreground">{when}: </span>
            {title && <b>{title}. </b>}
            {text}
          </p>
          {why && <p className="mt-1 text-[0.98rem] text-muted-foreground">{why}</p>}
        </>
      )}
    </section>
  )
}

/** Labelled values; each label says what the number is, and each value carries its unit. */
export function Readouts({ items, caption, cols = 3 }: { items: [string, ReactNode][]; caption?: ReactNode; cols?: 2 | 3 | 4 }) {
  return (
    <div>
      {caption && <p className="mb-1 font-sans text-sm text-muted-foreground">{caption}</p>}
      <dl
        className={cn("grid grid-cols-2 gap-x-6 gap-y-2 font-sans text-sm", cols === 3 && "sm:grid-cols-3", cols === 4 && "sm:grid-cols-4")}
      >
        {items.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="tabular-nums lining">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** The guided tour's card, shown at the top of the tool while the tour runs. */
export function TourCard({
  index,
  steps,
  go,
  playing,
  toggle,
}: {
  index: number
  steps: { text: string }[]
  go(i: number | null): void
  playing: boolean
  toggle(): void
}) {
  return (
    <div className="max-w-[70ch] space-y-2" aria-live="polite">
      <h2 className="text-xl leading-snug">
        Guided tour, stop {index + 1} of {steps.length}
      </h2>
      <p>{steps[index].text}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={index === 0} onClick={() => go(index - 1)}>
          Back
        </Button>
        <Button size="sm" variant="outline" onClick={() => go(index + 1 < steps.length ? index + 1 : null)}>
          {index + 1 < steps.length ? "Next stop" : "Finish the tour"}
        </Button>
        <Button size="sm" variant="ghost" onClick={toggle}>
          {playing ? "Pause" : "Play from here"}
        </Button>
        {index + 1 < steps.length && (
          <Button size="sm" variant="ghost" onClick={() => go(null)}>
            End the tour
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The tour and the teacher's actions, together behind one disclosure at the
 * end of the tool. Kept mounted: presentation mode lives here.
 */
export function TourAndSharing({
  root,
  tour,
  stops,
  startTour,
  link,
  figures,
}: {
  root: RefObject<HTMLElement | null>
  tour: number | null
  stops: number
  startTour(): void
  link(): string
  figures: ExportFigure[]
}) {
  return (
    <Disclosure
      title="Guided tour, sharing and presenting"
      note="A tour of short stops; a link to this exact moment; the figure as an SVG image or a TikZ (LaTeX) drawing; full-screen presentation."
      keepMounted
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              startTour()
              root.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" })
            }}
          >
            {tour === null ? "Start the guided tour" : "Restart the guided tour"}
          </Button>
          <span className="font-sans text-sm text-muted-foreground">
            {stops} stops. Each loads an example at a chosen moment and explains one idea.
          </span>
        </div>
        <ToolActions root={root} link={link} figures={figures} />
      </div>
    </Disclosure>
  )
}

/** The heading over the deeper material, so the end of the first part is plain. */
export function DeeperHeading({ children = "Go deeper" }: { children?: ReactNode }) {
  return <h2 className="pt-6 text-xl">{children}</h2>
}

/** Where an example comes from, with the book named in full. */
export function sourceLine(source: string): string {
  const s = source
    .replace(/^Kurose and Ross,/, "Kurose and Ross, Computer Networking: A Top-Down Approach,")
    .replace(/\bFig\. /g, "Figure ")
  return `This example follows ${s}.`
}
