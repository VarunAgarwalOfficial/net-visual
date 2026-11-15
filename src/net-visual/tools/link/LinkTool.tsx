import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { chartExports } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { LineChart, useWidth } from "../../components/LineChart"
import { LiterateSource } from "../../components/LiterateSource"
import { ToolActions } from "../../components/ToolActions"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import { keepFocus, timelineKeys, useTimeline } from "../../components/timeline"
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
/** The tab that belongs to each mode. */
const MODE_TAB: Record<Mode, { id: string; title: string }> = {
  aloha: { id: "frames", title: "Frames" },
  csmacd: { id: "backoff", title: "Backoff" },
  csmaca: { id: "stations", title: "Stations" },
  switch: { id: "tables", title: "Tables" },
  stp: { id: "ports", title: "Ports" },
  crc: { id: "props", title: "Properties" },
  hamming: { id: "syndrome", title: "Syndrome" },
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
/** Events in each slice of the trace on screen; the slice moves in steps so most clock ticks re-render nothing. */
const SLICE = 200

const HELP: Record<Mode, string> = {
  aloha:
    "One row per station, time left to right. A frame is drawn as it is sent: solid when it got through, red when another frame overlapped it. The shaded band is the latest frame's vulnerable window: any other start inside it destroys the frame.",
  csmacd:
    "Position along the cable across, time down. Each transmission spreads both ways along the cable at the speed of the signal, so it fills a widening band; a station hears another only once that band reaches its line. Red is the jam after a collision is heard.",
  csmaca:
    "The map shows who hears whom (dashed lines join nodes in range) and, while a frame is on the air, its sender's range. Below, one lane per node: frames on the air, red when lost at their receiver, and dashed bars where the node's NAV holds it silent.",
  switch:
    "Switches are rectangles, hubs dashed, hosts circles; the small numbers are port numbers. Each dot is one copy of a frame on its link, coloured by frame. The node that acted last is ringed, and a red bar marks a port the spanning tree blocks.",
  stp: "Each bridge shows its ID and what it believes: that it is the root, or its cost to the root it believes in. Port markers give the role (R root, D designated, A alternate) in the colour of the state. Small squares are BPDUs in flight; heavy links forward.",
  crc: "The long division as written by hand: the dividend, then each subtraction of the generator under the leftmost remaining 1 and what it leaves. The quotient grows on top. In the receiver's half, flipped bits are red.",
  hamming:
    "One box per position; parity positions are tinted, and the binary under each number says which checks cover it. The dots below mark each check's positions. The checks light up as they are computed and rechecked, and the syndrome points at the bit the decoder blames.",
}

function rateFor(p: LinkParams, duration: number): number {
  // Real seconds per frame at speed 1: half a second for ALOHA's frames, a second and a half for an Ethernet frame, a millisecond of air per second for Wi-Fi.
  // A switch hop in 0.8 s; three seconds of spanning tree per second; one and a half division or parity steps per second.
  if (p.mode === "switch") return p.sw.hop_us * 1.25
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
    return { fig: f, label: `Space-time diagram of the cable: ${f.collisions} collisions so far` }
  }
  if (p.mode === "csmaca" && r.mode === "csmaca") {
    const f = caFigure(p.ca, r.run, t, w)
    return { fig: f, label: f.onAir.length ? `On the air: ${f.onAir.join(", ")}` : "The medium is idle" }
  }
  if (p.mode === "switch" && r.mode === "switch") {
    const f = switchFigure(p.sw, r.run, t, index, w)
    return { fig: f, label: `The LAN: ${f.onWire} copies of frames on links` }
  }
  if (p.mode === "stp" && r.mode === "stp") {
    const f = stpFigure(p.stp, r.run, t, index, w)
    const agree = f.roots === 1 ? "all agree on the root" : `${f.roots} different roots believed`
    return {
      fig: f,
      label: `The bridges: ${f.forwarding} ports forwarding, ${f.waiting} listening or learning, ${f.blocking} blocking; ${agree}`,
    }
  }
  if (p.mode === "crc" && r.mode === "crc") return { fig: crcFigure(p.crc, r.run, index, w), label: "Long division over GF(2)" }
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
  const [tab, setTab] = useState("trace")
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
  const fmt = FORMAT[mode]
  const sourceTool = SOURCE[mode].tool
  const source = useMemo(() => sim.call<string>(sourceTool, "source"), [sim, sourceTool])
  const stepTitles = useMemo(() => new Map([...source.matchAll(STEP_RE)].map((m) => [m[1], m[2]])), [source])

  const times = useMemo(() => eventTimes(run), [run])
  const duration = useMemo(() => linkDuration(p, run), [p, run])
  const tl = useTimeline(times, duration, rateFor(p, duration), shared?.t ?? 0)
  const index = Math.max(0, tl.index)
  const event = run.run.events[index]

  const { fig, label } = useMemo(() => figureFor(p, run, tl.t, index, Math.max(320, Math.round(width))), [p, run, tl.t, index, width])
  const chart = useMemo(() => chartFor(sim, p, run), [sim, p, run])

  const trace = useMemo(() => run.run.events.map((e, i) => ({ t: e.t, step: e.step, text: textFor(p, run, i) })), [p, run])
  const offset = Math.max(0, Math.floor(index / SLICE) * SLICE - SLICE)
  const traceSlice = useMemo(() => trace.slice(offset, offset + 3 * SLICE), [trace, offset])

  const apply = (next: LinkParams, id = "") => {
    if (next.mode !== params.mode && tab === MODE_TAB[params.mode].id) setTab(MODE_TAB[next.mode].id)
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
    root.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    root.current?.focus({ preventScroll: true })
  }, [])
  const goTour = (i: number | null) => {
    setTour(i)
    if (i === null) return
    load(TOUR[i].preset, TOUR[i].at)
  }

  const presetInfo = PRESETS.find((q) => q.id === preset)
  const title = presetInfo?.title ?? "Your own setup"
  const caption = `${title}, at ${fmt(tl.t)}`
  const choices = PRESETS.filter((pr) => pr.mode === mode)

  return (
    <section
      ref={root}
      tabIndex={-1}
      className="nv-tool space-y-5 outline-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
      }}
    >
      <ToggleGroup
        type="single"
        variant="outline"
        aria-label="Which protocol"
        value={mode}
        onValueChange={(v) => {
          if (!v) return
          load(PRESETS.find((pr) => pr.mode === v)!.id)
          setTour(null)
        }}
        className="flex-wrap"
      >
        {MODES.map((m) => (
          <ToggleGroupItem key={m.id} value={m.id} className="px-3">
            {m.title}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className="mb-1 block font-sans text-xs text-muted-foreground" htmlFor="link-preset">
            Scenario
          </label>
          <Select value={preset || "custom"} onValueChange={(id) => load(id)}>
            <SelectTrigger id="link-preset" className="w-full max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((pr) => (
                <SelectItem key={pr.id} value={pr.id}>
                  {pr.title}
                </SelectItem>
              ))}
              <SelectItem value="custom" disabled>
                Your own setup
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant={tour === null ? "outline" : "secondary"} onClick={() => goTour(tour === null ? 0 : null)}>
          {tour === null ? "Guided tour" : "End tour"}
        </Button>
        <ToolActions
          root={root}
          link={() => linkFor("link", { p, t: Math.round(tl.t) } satisfies Shared)}
          figures={[
            {
              label: FIGURE_LABEL[mode],
              stem: `link-${preset || "custom"}-figure`,
              svg: () => figSvg({ ...fig, caption }),
              tikz: () => figTikz({ ...fig, caption }),
            },
            {
              label: chart.title,
              stem: `link-${preset || "custom"}-chart`,
              ...chartExports(() => chartFigure(chart, `${title}: ${chart.title.toLowerCase()}`)),
            },
          ]}
        />
      </div>

      {tour !== null ? (
        <div className="rounded-sm border border-border bg-muted/40 p-4" aria-live="polite">
          <p className="font-sans text-xs text-muted-foreground">
            Tour, {tour + 1} of {TOUR.length}
          </p>
          <p className="mt-1 max-w-[70ch]">{TOUR[tour].text}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" disabled={tour === 0} onClick={() => goTour(tour - 1)}>
              Back
            </Button>
            <Button size="sm" onClick={() => goTour(tour + 1 < TOUR.length ? tour + 1 : null)}>
              {tour + 1 < TOUR.length ? "Next" : "Finish"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => tl.toggle()}>
              {tl.playing ? "Pause" : "Play from here"}
            </Button>
          </div>
        </div>
      ) : (
        presetInfo && (
          <p className="max-w-[70ch] text-[0.98rem]">
            {presetInfo.note} <span className="text-muted-foreground">({presetInfo.source}.)</span>
          </p>
        )
      )}
      {error && (
        <p role="alert" className="font-sans text-sm text-destructive">
          That setting cannot run ({error}); the run shown is the last one that could.
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <div ref={figBox}>
            <ShapeView fig={fig} label={`${caption}. ${label}`} />
          </div>
          <p className="font-sans text-xs text-muted-foreground">{HELP[mode]} Space plays, arrow keys step, Home and End jump.</p>
          <Transport tl={tl} events={run.run.events.length} format={fmt} />
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
            onSeek={chart.timed ? (t) => tl.seek(t) : undefined}
            overlay={(s) => <RefLines s={s} refs={chart.refs} />}
          />
        </div>

        <div className="min-w-0 space-y-4">
          {event && (
            <div className="rounded-sm border border-border p-3" aria-live={tl.playing ? "off" : "polite"}>
              <p className="font-sans text-xs text-muted-foreground">
                {fmt(event.t)}, {whoFor(p, run, index)}
              </p>
              <p className="mt-0.5">
                <b className="lining">{event.step}.</b> [{stepTitles.get(event.step) ?? ""}] {textFor(p, run, index)}
              </p>
            </div>
          )}
          <ModeTotals p={p} r={run} />
          <ModeEquations p={p} r={run} t={tl.t} index={index} />

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="trace">Trace</TabsTrigger>
              <TabsTrigger value={MODE_TAB[mode].id}>{MODE_TAB[mode].title}</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="lab">Lab</TabsTrigger>
            </TabsList>
            <TabsContent value="trace">
              <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} format={fmt} />
              {run.run.events.length > traceSlice.length && (
                <p className="mt-1 font-sans text-xs text-muted-foreground">
                  Events {offset + 1} to {offset + traceSlice.length} of {run.run.events.length}; the list follows the clock.
                </p>
              )}
            </TabsContent>
            <TabsContent value="frames">{tab === "frames" && run.mode === "aloha" && <AlohaFrames run={run.run} t={tl.t} />}</TabsContent>
            <TabsContent value="backoff">
              {tab === "backoff" && p.mode === "csmacd" && run.mode === "csmacd" && <CdBackoffs p={p.cd} run={run.run} t={tl.t} />}
            </TabsContent>
            <TabsContent value="stations">
              {tab === "stations" && p.mode === "csmaca" && run.mode === "csmaca" && <CaStations p={p.ca} run={run.run} t={tl.t} />}
            </TabsContent>
            <TabsContent value="tables">
              {tab === "tables" && p.mode === "switch" && run.mode === "switch" && <SwitchTables p={p.sw} run={run.run} index={index} />}
            </TabsContent>
            <TabsContent value="ports">
              {tab === "ports" && p.mode === "stp" && run.mode === "stp" && <StpPorts p={p.stp} run={run.run} index={index} />}
            </TabsContent>
            <TabsContent value="props">
              {tab === "props" && p.mode === "crc" && run.mode === "crc" && <CrcProps p={p.crc} run={run.run} />}
            </TabsContent>
            <TabsContent value="syndrome">
              {tab === "syndrome" && p.mode === "hamming" && run.mode === "hamming" && <HammingSyndrome p={p.ham} run={run.run} />}
            </TabsContent>
            <TabsContent value="setup">
              <ModeSetup p={params} r={run} set={(next) => apply(next)} />
            </TabsContent>
            <TabsContent value="source">
              <p className="mb-2 font-sans text-xs text-muted-foreground">
                The Rust that produced this run (crates/netsim/src/{SOURCE[mode].file}), compiled into the page. The step behind the current
                event is shaded.
              </p>
              <LiterateSource source={source} active={tab === "source" && event ? event.step : null} className="max-h-[32rem]" />
            </TabsContent>
            <TabsContent value="lab" forceMount className="data-[state=inactive]:hidden">
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
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <Article sim={sim} onLoad={onLoad} lanFirst={MODES.find((m) => m.id === mode)?.group !== "access"} />
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
