import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { chartExports } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { LineChart, useWidth } from "../../components/LineChart"
import { LiterateSource } from "../../components/LiterateSource"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import {
  DeeperHeading,
  Disclosure,
  AboutExample,
  ExampleIntro,
  Readouts,
  StepCard,
  TourAndSharing,
  TourCard,
  scrollBehavior,
  sourceLine,
} from "../../components/ToolFrame"
import { keepFocus, timeIn, timelineKeys, useTimeline } from "../../components/timeline"
import {
  LABS,
  MODES,
  PRESETS,
  SOURCE,
  TOUR,
  eventTimes,
  fmtTime,
  frameNs,
  linkDuration,
  runLink,
  type LinkParams,
  type LinkRun,
  type Mode,
} from "../../core/link"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import { linkFor, readHash } from "../../core/share"
import {
  CrcEquations,
  CrcProps,
  CrcSetup,
  CrcTotals,
  HammingEquations,
  HammingSetup,
  HammingSyndrome,
  HammingTotals,
  crcChart,
  crcText,
  crcWho,
  hammingChart,
  hammingText,
  hammingWho,
} from "./CodeViews"
import { crcFigure, hammingFigure } from "./codeFigures"
import { LanAnalysis, LanFrontier, LanInternals, LanIntro, LanMechanics } from "./LanArticle"
import { stpFigure, switchFigure } from "./lanFigures"
import {
  StpEquations,
  StpPorts,
  StpSetup,
  StpTotals,
  SwitchEquations,
  SwitchSetup,
  SwitchTables,
  SwitchTotals,
  stpChart,
  stpText,
  stpWho,
  switchChart,
  switchText,
  switchWho,
} from "./LanViews"
import { LinkAnalysis, LinkFrontier, LinkInternals, LinkIntro, LinkMechanics } from "./LinkArticle"
import { alohaFigure, caFigure, cdFigure } from "./linkFigures"
import {
  AlohaFrames,
  CaStations,
  CdBackoffs,
  EquationCard,
  LinkSetup,
  RefLines,
  ShapeView,
  Totals,
  chartFigure,
  eventText,
  eventWho,
  modeChart,
} from "./LinkViews"
import { figSvg, figTikz, type ShapeFigure } from "./shapes"

interface Shared {
  p: LinkParams
  t?: number
}

/** Link layer and wireless: ALOHA, CSMA/CD, 802.11 CSMA/CA, switch learning, spanning tree, CRC and Hamming codes. */
export function LinkTool() {
  const [sim, setSim] = useState<Netsim | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadNetsim().then(setSim, (e: Error) => setError(e.message))
  }, [])
  if (error) return <p role="alert">The simulation could not load: {error}</p>
  if (!sim) return <p className="font-sans text-sm text-muted-foreground">Loading the simulation…</p>
  return <LinkLoaded sim={sim} />
}

const STEP_RE = /([A-Z]\d+)\.\s\[([^\]]+)\]/g
/** The deeper view that belongs to each mode, named for what it shows. */
const MODE_VIEW: Record<Mode, { title: string; note: string }> = {
  aloha: { title: "Each frame, and what hit it", note: "One row per frame: who sent it, when, and whether another frame overlapped it." },
  csmacd: {
    title: "Each station's backoff",
    note: "After each collision, how many slot times each station chose to wait, and from how many choices.",
  },
  csmaca: {
    title: "Each station's state",
    note: "Per station: frames sent and lost, and the reservations (NAV, network allocation vector) that held it silent.",
  },
  switch: { title: "Each switch's table", note: "What each switch has learned so far: which port leads to which host." },
  stp: { title: "Each bridge's ports", note: "Each port's role and state, as the bridges settle on a tree." },
  crc: {
    title: "What this check can and cannot catch",
    note: "Which kinds of error this generator always detects, and which it can miss.",
  },
  hamming: {
    title: "The syndrome, worked out",
    note: "Each parity check recomputed at the receiver, and the bit position the failed checks point to.",
  },
}
/** Stable time formatters, so the memoised trace rows do not re-render. */
const FORMAT: Record<Mode, (t: number) => string> = {
  aloha: (t) => fmtTime(t, "aloha"),
  csmacd: (t) => fmtTime(t, "csmacd"),
  csmaca: (t) => fmtTime(t, "csmaca"),
  switch: (t) => fmtTime(t, "switch"),
  stp: (t) => fmtTime(t, "stp"),
  crc: (t) => fmtTime(t, "crc"),
  hamming: (t) => fmtTime(t, "hamming"),
}
const STEP_IS: Record<Mode, string> = {
  aloha: "one frame starting or ending",
  csmacd: "one station sensing, sending, hearing a collision or backing off",
  csmaca: "one station sensing, counting down, sending or being acknowledged",
  switch: "one thing a switch does with a frame",
  stp: "one switch sending or taking in a message about the tree",
  crc: "one stage of the calculation",
  hamming: "one stage of the calculation",
}
/** Events in each slice of the trace on screen; the slice moves in steps so most clock ticks re-render nothing. */
const SLICE = 200

const HELP: Record<Mode, string> = {
  aloha:
    "One row per station (S1, S2 and so on), time left to right in milliseconds (ms). The picture shows 12 frame times at a time (8 on a phone; a frame time is how long one frame takes to send) and slides along as the run plays. A frame is drawn as a bar while it is sent, with its number (#0 is the first): in its station's colour when it got through, red when another frame overlapped it. The bottom row, air, is the channel as a receiver hears it, every frame at once. Once frames appear, a grey band marks the latest frame's vulnerable window: any other frame starting inside it destroys this one.",
  csmacd:
    "Position along the cable across, time down. Each transmission spreads both ways along the cable at the speed of the signal, so it fills a widening band; a station hears another only once that band reaches its line. Red is the jam after a collision is heard.",
  csmaca:
    "The map shows who hears whom (dashed lines join stations in range) and, while a frame is on the air, its sender's range. Below, one lane per station, time left to right: frames on the air, red when lost at their receiver, and dashed bars where a reservation it overheard (the network allocation vector, NAV) holds it silent.",
  switch:
    "Switches are rectangles, hubs dashed, hosts circles; the small numbers are port numbers. Each dot is one copy of a frame on its link, coloured by frame. The node that acted last is ringed, and a red bar marks a port the spanning tree blocks.",
  stp: "Each bridge shows its ID and what it believes: that it is the root of the tree, or its cost to the root it believes in. Each port carries a letter for its role: R, root port (its way towards the root); D, designated port (the one that serves that link); A, alternate (a spare, kept blocked). Its colour gives the state. Small squares are bridge messages (BPDUs, bridge protocol data units) in flight; heavy links forward frames. The number on each link is its cost. A bridge's ID is its priority, a dot, then the end of its hardware address; the lowest ID should end up as root. A dashed box marks the bridge that acted last.",
  crc: "The long division as written by hand: the message with zeros added (the dividend), then each subtraction of the generator under the leftmost remaining 1, and what it leaves. Subtracting is exclusive or: bits that differ give 1. The quotient grows on top, and what is left at the end is the check value. In the receiver's half, flipped bits are red. In the heading, M(x) is the message and G(x) the generator, each a row of bits read as a polynomial; multiplying by x to a power adds that many zeros.",
  hamming:
    "One box per bit position, numbered from 1; the tinted boxes are parity bits. The binary under each number says which checks cover it: a 1 in the last place means check 1, and so on. The dots below mark each check's positions. The checks light up as they are computed and rechecked, and the syndrome (the failed checks, read as a binary number) points at the bit the decoder blames.",
}

function rateFor(p: LinkParams, duration: number): number {
  // Real seconds per frame at speed 1: half a second for ALOHA's frames, a second and a half for an Ethernet frame, a millisecond of air per second for Wi-Fi.
  // A switch hop in 0.8 s; three seconds of spanning tree per second; one and a half division or parity steps per second.
  if (p.mode === "switch") return Math.max(p.sw.hop_us * 1.25, duration / 300)
  if (p.mode === "stp") return 3000
  if (p.mode === "crc" || p.mode === "hamming") return 1.5
  const base = p.mode === "aloha" ? 2 * p.aloha.frame_us : p.mode === "csmacd" ? frameNs(p.cd) / 1.5 : 1000
  return Math.max(base, duration / 300)
}

function figureFor(p: LinkParams, r: LinkRun, t: number, index: number, w: number): { fig: ShapeFigure; label: string } {
  if (p.mode === "aloha" && r.mode === "aloha") {
    const f = alohaFigure(p.aloha, r.run, t, w)
    return { fig: f, label: `${f.onAir} frames on the air, ${f.delivered} delivered and ${f.garbled} lost so far` }
  }
  if (p.mode === "csmacd" && r.mode === "csmacd") {
    const f = cdFigure(p.cd, r.run, t, w)
    return { fig: f, label: `${f.collisions} collision${f.collisions === 1 ? "" : "s"} on the cable so far` }
  }
  if (p.mode === "csmaca" && r.mode === "csmaca") {
    const f = caFigure(p.ca, r.run, t, w)
    return { fig: f, label: f.onAir.length ? `On the air: ${f.onAir.join(", ")}` : "The medium is idle" }
  }
  if (p.mode === "switch" && r.mode === "switch") {
    const f = switchFigure(p.sw, r.run, t, index, w)
    return { fig: f, label: `${f.onWire} cop${f.onWire === 1 ? "y" : "ies"} of frames on the links now` }
  }
  if (p.mode === "stp" && r.mode === "stp") {
    const f = stpFigure(p.stp, r.run, t, index, w)
    const agree = f.roots === 1 ? "all agree on the root" : `${f.roots} different roots believed`
    return {
      fig: f,
      label: `${f.forwarding} ports forwarding, ${f.waiting} listening or learning, ${f.blocking} blocking; ${agree}`,
    }
  }
  if (p.mode === "crc" && r.mode === "crc")
    return {
      fig: crcFigure(p.crc, r.run, index, w),
      label: "Long division of bits, where subtracting is exclusive or (XOR) and nothing carries",
    }
  if (p.mode === "hamming" && r.mode === "hamming") {
    const f = hammingFigure(p.ham, r.run, index, w)
    return { fig: f, label: `Hamming codeword by position${f.flipped.length ? `, bits ${f.flipped.join(", ")} flipped` : ""}` }
  }
  throw new Error("settings and run disagree on the mode")
}

/** The words for event i, whichever mode. */
function textFor(p: LinkParams, r: LinkRun, i: number): string {
  if (p.mode === "switch" && r.mode === "switch") return switchText(p.sw, r.run, i)
  if (p.mode === "stp" && r.mode === "stp") return stpText(p.stp, r.run, i)
  if (p.mode === "crc" && r.mode === "crc") return crcText(p.crc, r.run, i)
  if (p.mode === "hamming" && r.mode === "hamming") return hammingText(p.ham, r.run, i)
  return eventText(p, r, i)
}

function whoFor(p: LinkParams, r: LinkRun, i: number): string {
  if (p.mode === "switch" && r.mode === "switch") return switchWho(p.sw, r.run, i)
  if (p.mode === "stp" && r.mode === "stp") return stpWho(p.stp, r.run, i)
  if (p.mode === "crc" && r.mode === "crc") return crcWho(p.crc, r.run, i)
  if (p.mode === "hamming" && r.mode === "hamming") return hammingWho(p.ham, r.run, i)
  return eventWho(p, r, i)
}

function chartFor(sim: Netsim, p: LinkParams, r: LinkRun) {
  if (p.mode === "switch" && r.mode === "switch") return switchChart(sim, p.sw, r.run)
  if (p.mode === "stp" && r.mode === "stp") return stpChart(p.stp, r.run)
  if (p.mode === "crc" && r.mode === "crc") return crcChart(r.run)
  if (p.mode === "hamming" && r.mode === "hamming") return hammingChart(p.ham, r.run)
  return modeChart(sim, p, r)
}

function ModeTotals({ p, r }: { p: LinkParams; r: LinkRun }) {
  let rows: ReactNode
  if (p.mode === "switch" && r.mode === "switch") rows = <SwitchTotals p={p.sw} run={r.run} />
  else if (p.mode === "stp" && r.mode === "stp") rows = <StpTotals p={p.stp} run={r.run} />
  else if (p.mode === "crc" && r.mode === "crc") rows = <CrcTotals p={p.crc} run={r.run} />
  else if (p.mode === "hamming" && r.mode === "hamming") rows = <HammingTotals p={p.ham} run={r.run} />
  else return <Totals p={p} r={r} />
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-3">{rows}</dl>
}

function ModeEquations({ p, r, t, index }: { p: LinkParams; r: LinkRun; t: number; index: number }) {
  if (p.mode === "switch" && r.mode === "switch") return <SwitchEquations p={p.sw} run={r.run} index={index} />
  if (p.mode === "stp" && r.mode === "stp") return <StpEquations p={p.stp} run={r.run} index={index} />
  if (p.mode === "crc" && r.mode === "crc") return <CrcEquations p={p.crc} run={r.run} index={index} />
  if (p.mode === "hamming" && r.mode === "hamming") return <HammingEquations p={p.ham} run={r.run} />
  return <EquationCard p={p} r={r} t={t} />
}

/** Settings for the mode. The coding modes also take the last good run, to show the codeword whose bits can be flipped. */
function ModeSetup({ p, r, set }: { p: LinkParams; r: LinkRun; set(p: LinkParams): void }) {
  if (p.mode === "switch") return <SwitchSetup p={p.sw} set={(sw) => set({ mode: "switch", sw })} />
  if (p.mode === "stp") return <StpSetup p={p.stp} set={(stp) => set({ mode: "stp", stp })} />
  if (p.mode === "crc") return r.mode === "crc" ? <CrcSetup p={p.crc} run={r.run} set={(crc) => set({ mode: "crc", crc })} /> : null
  if (p.mode === "hamming")
    return r.mode === "hamming" ? <HammingSetup p={p.ham} run={r.run} set={(ham) => set({ mode: "hamming", ham })} /> : null
  return <LinkSetup p={p} set={set} />
}

const FIGURE_LABEL: Record<Mode, string> = {
  aloha: "The channel at this moment",
  csmacd: "The space-time diagram at this moment",
  csmaca: "The channel at this moment",
  switch: "The LAN at this moment",
  stp: "The bridges at this moment",
  crc: "The division at this step",
  hamming: "The codeword at this step",
}

function LinkLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("link"), [])
  const first = PRESETS[0]
  const [params, setParams] = useState<LinkParams>(shared?.p ?? first.params)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [tour, setTour] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)
  const [figBox, width] = useWidth<HTMLDivElement>()

  // A setting the model refuses leaves the last good run on screen with the reason.
  const [good, setGood] = useState<{ p: LinkParams; run: LinkRun }>(() => ({ p: params, run: runLink(sim, params) }))
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(params)
  if (tried !== params) {
    // Adjusting state while rendering, as React documents for derived state.
    setTried(params)
    try {
      setGood({ p: params, run: runLink(sim, params) })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { run, p } = good
  const mode = p.mode
  // The clock in microseconds, so every time on the first screen uses the player's one unit.
  const toUs = (t: number) => (mode === "csmacd" ? t / 1000 : mode === "stp" ? t * 1000 : t)
  const sourceTool = SOURCE[mode].tool
  const source = useMemo(() => sim.call<string>(sourceTool, "source"), [sim, sourceTool])
  const stepTitles = useMemo(() => new Map([...source.matchAll(STEP_RE)].map((m) => [m[1], m[2]])), [source])

  const times = useMemo(() => eventTimes(run), [run])
  const duration = useMemo(() => linkDuration(p, run), [p, run])
  const tl = useTimeline(times, duration, rateFor(p, duration), shared?.t ?? 0)
  const index = Math.max(0, tl.index)
  const event = run.run.events[index]

  // Before the first event the channel is drawn empty, not with the first frame already on it.
  const figT = tl.index < 0 && p.mode === "aloha" ? -Infinity : tl.t
  const { fig, label } = useMemo(() => figureFor(p, run, figT, index, Math.max(320, Math.round(width))), [p, run, figT, index, width])
  const chart = useMemo(() => chartFor(sim, p, run), [sim, p, run])

  const trace = useMemo(() => run.run.events.map((e, i) => ({ t: e.t, step: e.step, text: textFor(p, run, i) })), [p, run])
  const offset = Math.max(0, Math.floor(index / SLICE) * SLICE - SLICE)
  const traceSlice = useMemo(() => trace.slice(offset, offset + 3 * SLICE), [trace, offset])

  const apply = (next: LinkParams, id = "") => {
    setParams(next)
    setPreset(id)
    keepFocus(root)
  }
  const load = (id: string, at = 0) => {
    const pr = PRESETS.find((q) => q.id === id)
    if (!pr) return
    apply(pr.params, pr.id)
    tl.pause()
    tl.seek(at)
  }
  // The article is memoised, so it gets a stable function that calls the latest loader.
  const loader = useRef(load)
  useEffect(() => {
    loader.current = load
  })
  const onLoad = useCallback((id: string) => {
    loader.current(id)
    root.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" })
    root.current?.focus({ preventScroll: true })
  }, [])
  const goTour = (i: number | null) => {
    setTour(i)
    if (i === null) return
    load(TOUR[i].preset, TOUR[i].at)
  }

  const presetInfo = PRESETS.find((q) => q.id === preset)
  const title = presetInfo?.title ?? "Your own setup"
  // A frame already on the air when the run begins has a time before 0: say so rather than print a minus sign.
  const fmt =
    mode === "crc" || mode === "hamming"
      ? FORMAT[mode]
      : (t: number) => (t < 0 ? `${timeIn(-toUs(t), toUs(tl.duration))} before the start` : timeIn(toUs(t), toUs(tl.duration)))
  const caption = `${title}, at ${fmt(tl.t)}`
  const started = tl.index >= 0 && !!event
  const coding = mode === "crc" || mode === "hamming"
  const stepTitle = started ? (stepTitles.get(event.step) ?? "").replace(/\.$/, "") : ""
  const who = started ? whoFor(p, run, index) : ""

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Link layer and wireless"
      className="nv-tool max-w-4xl space-y-4 outline-none [&.nv-present]:max-w-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
      }}
    >
      {tour !== null && <TourCard index={tour} steps={TOUR} go={goTour} playing={tl.playing} toggle={tl.toggle} />}

      <ExampleIntro title={title} />
      {error && (
        <p role="alert" className="font-sans text-sm text-destructive">
          That setting cannot run ({error}); the run shown is the last one that could.
        </p>
      )}

      <Transport
        tl={tl}
        events={run.run.events.length}
        us={toUs}
        stepIs={coding ? "one stage of the calculation" : STEP_IS[mode]}
        clock={!coding}
      />

      <figure className="space-y-2">
        <div ref={figBox}>
          <ShapeView fig={fig} label={`${caption}. ${label}`} />
        </div>
        <figcaption className="max-w-[70ch] font-sans text-sm text-muted-foreground">{HELP[mode]}</figcaption>
      </figure>
      <AboutExample
        note={
          presetInfo?.note ??
          `Your own settings for: ${MODES.find((m) => m.id === mode)?.title}. Open "Change the settings", further down the page, to see them.`
        }
      />

      <StepCard
        live={!tl.playing}
        when={started ? `At ${fmt(event.t)}${who ? `, ${who}` : ""}` : null}
        title={stepTitle || undefined}
        text={started ? textFor(p, run, index) : undefined}
        empty={
          <>
            Nothing has happened yet. Press <b>Play</b> to run the example, or <b>Next</b> to go one step at a time (the arrow keys do the
            same).
          </>
        }
      />

      <Readouts
        caption="So far"
        cols={2}
        items={[
          ...(coding ? [] : [["Simulated time", fmt(tl.t)] as [string, string]]),
          [coding ? "Steps done" : "Steps so far", `${started ? tl.index + 1 : 0} of ${run.run.events.length}`],
        ]}
      />
      {!coding && started && <p className="max-w-[70ch] font-sans text-sm">{label[0].toUpperCase() + label.slice(1)}.</p>}

      <div className="space-y-2">
        <label className="block text-lg" htmlFor="link-preset">
          Try another example
        </label>
        <Select
          value={preset || "custom"}
          onValueChange={(id) => {
            setTour(null)
            load(id)
          }}
        >
          <SelectTrigger
            id="link-preset"
            className="h-auto min-h-9 w-full max-w-xl text-left whitespace-normal [&_[data-slot=select-value]]:line-clamp-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectGroup key={m.id}>
                <SelectLabel>{m.title}</SelectLabel>
                {PRESETS.filter((pr) => pr.mode === m.id).map((pr) => (
                  <SelectItem key={pr.id} value={pr.id}>
                    {pr.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
            <SelectItem value="custom" disabled>
              Your own setup
            </SelectItem>
          </SelectContent>
        </Select>
        {presetInfo && <p className="font-sans text-sm text-muted-foreground">{sourceLine(presetInfo.source)}</p>}
      </div>

      <div>
        <DeeperHeading />
        <Disclosure title={chart.title} note="The whole run as a chart. Where it runs over time, select a point to jump there.">
          <LineChart
            title={chart.title}
            series={chart.series}
            xLabel={chart.xLabel}
            yLabel={chart.yLabel}
            xFormat={chart.xFormat}
            yFormat={chart.yFormat}
            xDomain={chart.xDomain}
            yDomain={chart.yDomain}
            height={220}
            cursor={chart.timed ? tl.t : undefined}
            upTo={chart.timed ? tl.t : undefined}
            onSeek={chart.timed ? (t) => tl.seek(t) : undefined}
            overlay={(s) => <RefLines s={s} refs={chart.refs} />}
          />
        </Disclosure>
        <Disclosure title={MODE_VIEW[mode].title} note={MODE_VIEW[mode].note}>
          {run.mode === "aloha" && <AlohaFrames run={run.run} t={tl.t} />}
          {p.mode === "csmacd" && run.mode === "csmacd" && <CdBackoffs p={p.cd} run={run.run} t={tl.t} />}
          {p.mode === "csmaca" && run.mode === "csmaca" && <CaStations p={p.ca} run={run.run} t={tl.t} />}
          {p.mode === "switch" && run.mode === "switch" && <SwitchTables p={p.sw} run={run.run} index={index} />}
          {p.mode === "stp" && run.mode === "stp" && <StpPorts p={p.stp} run={run.run} index={index} />}
          {p.mode === "crc" && run.mode === "crc" && <CrcProps p={p.crc} run={run.run} />}
          {p.mode === "hamming" && run.mode === "hamming" && <HammingSyndrome p={p.ham} run={run.run} />}
        </Disclosure>
        <Disclosure
          title="The formulas, with this run's numbers"
          note="What theory predicts for this example, set beside what the run did."
        >
          <ModeEquations p={p} r={run} t={tl.t} index={index} />
        </Disclosure>
        <Disclosure title="What the whole run comes to" note="Totals for the full run, from start to end.">
          <ModeTotals p={p} r={run} />
        </Disclosure>
        <Disclosure title="Change the settings" note="Every setting of this example, which you can change; the run follows at once.">
          <ModeSetup p={params} r={run} set={(next) => apply(next)} />
        </Disclosure>
        <Disclosure title="Every step, as a list" note="Each event of the run in order. Select one to jump there.">
          <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} format={fmt} />
          {run.run.events.length > traceSlice.length && (
            <p className="mt-1 font-sans text-xs text-muted-foreground">
              Events {offset + 1} to {offset + traceSlice.length} of {run.run.events.length}; the list follows the clock.
            </p>
          )}
        </Disclosure>
        <Disclosure title="Exercises this page can check" note="Short tasks; each says whether the run on screen meets it." keepMounted>
          <LabPanel
            labs={LABS}
            load={(start) => {
              // Lab starts are copies, so match a scenario by its settings.
              const key = JSON.stringify(start)
              const pr = PRESETS.find((q) => q.mode === start.mode && JSON.stringify(q.params) === key)
              apply(start, pr?.id ?? "")
              setTour(null)
              tl.home()
            }}
            check={(lab) => LABS.find((l) => l.id === lab.id)!.check(p, run)}
          />
        </Disclosure>
        <Disclosure
          title="The program that produced this run"
          note="The Rust code behind the simulation, with the step behind the current event shaded."
        >
          <p className="mb-2 font-sans text-xs text-muted-foreground">
            From crates/netsim/src/{SOURCE[mode].file}, compiled into the page. Each step has a letter and number, such as E1; the list of
            steps above uses the same names.
          </p>
          <LiterateSource source={source} active={started ? event.step : null} className="max-h-[32rem]" />
        </Disclosure>
        <TourAndSharing
          root={root}
          tour={tour}
          stops={TOUR.length}
          startTour={() => goTour(0)}
          link={() => linkFor("link", { p, t: Math.round(tl.t) } satisfies Shared)}
          figures={[
            {
              label: FIGURE_LABEL[mode].toLowerCase(),
              stem: `link-${preset || "custom"}-figure`,
              svg: () => figSvg({ ...fig, caption }),
              tikz: () => figTikz({ ...fig, caption }),
            },
            {
              label: `the chart: ${chart.title.toLowerCase()}`,
              stem: `link-${preset || "custom"}-chart`,
              ...chartExports(() => chartFigure(chart, `${title}: ${chart.title.toLowerCase()}`)),
            },
          ]}
        />
      </div>

      <div>
        <DeeperHeading>Read about it</DeeperHeading>
        <Article sim={sim} onLoad={onLoad} lanFirst={MODES.find((m) => m.id === mode)?.group !== "access"} />
      </div>
    </section>
  )
}

/** Both articles, the one for the current mode's group first. */
const Article = memo(function Article({ sim, onLoad, lanFirst }: { sim: Netsim; onLoad(id: string): void; lanFirst: boolean }) {
  const access = (
    <>
      <LinkIntro onLoad={onLoad} />
      <LinkMechanics />
      <LinkAnalysis sim={sim} />
      <LinkFrontier />
      <LinkInternals />
    </>
  )
  const lan = (
    <>
      <LanIntro onLoad={onLoad} />
      <LanMechanics />
      <LanAnalysis />
      <LanFrontier />
      <LanInternals />
    </>
  )
  return lanFirst ? (
    <>
      {lan}
      {access}
    </>
  ) : (
    <>
      {access}
      {lan}
    </>
  )
})
