import { memo, useEffect, useMemo, useRef, useState } from "react"
import { ZoomIn, ZoomOut } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import {
  GO_BACK_N,
  LABS,
  PRESETS,
  SELECTIVE_REPEAT,
  TOUR,
  protocolName,
  runDuration,
  runRdt,
  type Flight,
  type Intervention,
  type RdtParams,
  type RdtRun,
} from "../../core/rdt"
import { linkFor, readHash } from "../../core/share"
import { ParamSlider, ParamSwitch } from "../../components/Controls"
import { HeaderDiagram, type HeaderField } from "../../components/HeaderDiagram"
import { LabPanel } from "../../components/LabPanel"
import { Ladder, type LadderFlight, type LadderMark } from "../../components/Ladder"
import { LiterateSource } from "../../components/LiterateSource"
import { ToolActions } from "../../components/ToolActions"
import { Transport } from "../../components/Transport"
import { formatTime, timelineKeys, useTimeline } from "../../components/timeline"
import { RdtAnalysis, RdtFrontier, RdtIntro, RdtInternals } from "./RdtArticle"
import { WindowView } from "./WindowView"

interface Shared {
  p: RdtParams
  t?: number
}

/** Reliable data transfer: stop-and-wait, Go-Back-N, Selective Repeat. */
export function RdtTool() {
  const [sim, setSim] = useState<Netsim | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadNetsim().then(setSim, (e: Error) => setError(e.message))
  }, [])
  if (error) return <p role="alert">The simulation could not load: {error}</p>
  if (!sim) return <p className="font-sans text-sm text-muted-foreground">Loading the simulation…</p>
  return <RdtLoaded sim={sim} />
}

/** Keep the current row visible by scrolling its list only, never the page. */
function scrollWithin(el: HTMLElement | null) {
  const box = el?.closest("ol")
  if (!el || !box) return
  const top = el.offsetTop // the list is the offset parent (position: relative)
  if (top < box.scrollTop) box.scrollTop = top
  else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight
}

const toLadder = (run: RdtRun): LadderFlight[] =>
  run.flights.map((f) => ({
    id: f.id,
    from: f.kind === "data" ? 0 : 1,
    t_start: f.t_start,
    t_sent: f.t_sent,
    t_arrive: f.t_arrive,
    lost: f.lost,
    label: f.kind === "data" ? `seq ${f.wire}${f.occurrence > 1 ? "′" : ""}` : `ACK ${f.wire}`,
    fate: f.fate === "accepted as the wrong message" ? "wrong message" : f.fate,
    color: f.kind === "data" ? "var(--chart-1)" : "var(--chart-2)",
    alarm: f.fate.includes("wrong"),
  }))

const STEP_RE = /([A-Z]\d+)\.\s\[([^\]]+)\]/g

function RdtLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("rdt"), [])
  const [params, setParams] = useState<RdtParams>(shared?.p ?? PRESETS[0].params)
  const [preset, setPreset] = useState<string>(shared ? "" : PRESETS[0].id)
  const [selected, setSelected] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [follow, setFollow] = useState(true)
  const [tab, setTab] = useState("state")
  const [tour, setTour] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)

  const source = useMemo(() => sim.call<string>("rdt", "source"), [sim])
  const stepTitles = useMemo(() => new Map([...source.matchAll(STEP_RE)].map((m) => [m[1], m[2]])), [source])

  const result = useMemo<{ run: RdtRun } | { error: string }>(() => {
    try {
      return { run: runRdt(sim, params) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [sim, params])
  const run = "run" in result ? result.run : null

  const times = useMemo(() => run?.events.map((e) => e.t) ?? [], [run])
  const duration = useMemo(() => (run ? runDuration(run) : 1), [run])
  const roundTrip = run ? run.theory.t_data_us + run.theory.rtt_us + run.theory.t_ack_us : 1
  const tl = useTimeline(times, duration, roundTrip / 2.5, shared?.t ?? 0)

  const ladderHeight = 520
  const usPerPx = Math.max(0.01, Math.min(duration, Math.max(roundTrip, 1) * 3.2) / (ladderHeight - 60) / zoom)

  const apply = (p: RdtParams, id = "") => {
    setParams(p)
    setPreset(id)
    setSelected(null)
  }

  // The tour loads a preset and puts the clock at the moment it describes.
  const goTour = (i: number | null) => {
    setTour(i)
    if (i === null) return
    const step = TOUR[i]
    const pr = PRESETS.find((x) => x.id === step.preset)!
    const next = pr.id === preset ? run : runRdt(sim, pr.params)
    if (pr.id !== preset) apply(pr.params, pr.id)
    tl.pause()
    if (next) tl.seek(step.at * runDuration(next))
    setFollow(true)
  }

  const ladderFlights = useMemo(() => (run ? toLadder(run) : []), [run])
  const marks = useMemo<LadderMark[]>(
    () => (run ? run.events.filter((e) => e.step === "S4").map((e) => ({ t: e.t, lane: 0, text: "timeout" })) : []),
    [run],
  )

  if (!run) {
    return (
      <div className="space-y-3">
        <p role="alert">These settings cannot run: {"error" in result ? result.error : ""}</p>
        <Button onClick={() => apply(PRESETS[0].params, PRESETS[0].id)}>Back to the first preset</Button>
      </div>
    )
  }

  const event = run.events[Math.max(0, tl.index)]
  const flight = selected !== null ? run.flights[selected] : null
  const m = 2 ** params.seq_bits

  const keyOf = (f: Flight) => (iv: Intervention) => iv.kind === f.kind && iv.number === f.number && iv.occurrence === f.occurrence
  const toggleDrop = (f: Flight) => {
    const match = keyOf(f)
    const has = params.interventions.some((iv) => match(iv) && iv.action !== "delay")
    const rest = params.interventions.filter((iv) => !(match(iv) && iv.action !== "delay"))
    const add: Intervention[] = has
      ? []
      : [{ kind: f.kind, number: f.number, occurrence: f.occurrence, action: f.lost ? "keep" : "drop", delay_us: 0 }]
    apply({ ...params, interventions: [...rest, ...add] }, preset)
    setSelected(f.id)
  }
  const delay = (id: number, extra: number) => {
    const f = run.flights[id]
    const match = keyOf(f)
    const old = params.interventions.find((iv) => match(iv) && iv.action === "delay")
    const rest = params.interventions.filter((iv) => !(match(iv) && iv.action === "delay"))
    const iv: Intervention = {
      kind: f.kind,
      number: f.number,
      occurrence: f.occurrence,
      action: "delay",
      delay_us: (old?.delay_us ?? 0) + extra,
    }
    apply({ ...params, interventions: [...rest, iv] }, preset)
    setSelected(id)
  }

  const protocol = protocolName(params)
  const presetInfo = PRESETS.find((x) => x.id === preset)

  return (
    <section
      ref={root}
      className="nv-tool space-y-5 [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) {
          e.preventDefault()
          setFollow(true)
        } else if ((e.key === "d" || e.key === "D") && flight) {
          toggleDrop(flight)
          e.preventDefault()
        } else if (e.key === "Escape") setSelected(null)
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className="mb-1 block font-sans text-xs text-muted-foreground" htmlFor="rdt-preset">
            Scenario
          </label>
          <Select
            value={preset || "custom"}
            onValueChange={(id) => {
              const pr = PRESETS.find((x) => x.id === id)
              if (pr) {
                apply(pr.params, pr.id)
                tl.home()
              }
            }}
          >
            <SelectTrigger id="rdt-preset" className="w-full max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((pr) => (
                <SelectItem key={pr.id} value={pr.id}>
                  {pr.title}
                </SelectItem>
              ))}
              <SelectItem value="custom" disabled>
                Your own settings
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant={tour === null ? "outline" : "secondary"} onClick={() => goTour(tour === null ? 0 : null)}>
          {tour === null ? "Guided tour" : "End tour"}
        </Button>
        <ToolActions
          name={`rdt-${preset || "custom"}`}
          root={root}
          link={() => linkFor("rdt", { p: params, t: Math.round(tl.t) } satisfies Shared)}
          figure={() => ({
            lanes: ["Sender", "Receiver"],
            flights: ladderFlights,
            marks,
            upTo: tl.t,
            caption: `${protocol}, N = ${params.window}, sequence numbers mod ${m}, at ${formatTime(tl.t)}`,
          })}
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

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between font-sans text-sm text-muted-foreground">
            <span>
              {protocol}, N = {params.window}, sequence numbers mod {m}
            </span>
            <span className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon-sm" aria-label="Zoom out in time" onClick={() => setZoom(zoom / 1.6)}>
                <ZoomOut />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Zoom in in time" onClick={() => setZoom(zoom * 1.6)}>
                <ZoomIn />
              </Button>
            </span>
          </div>
          <div onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}>
            <Ladder
              lanes={["Sender", "Receiver"]}
              flights={ladderFlights}
              marks={marks}
              t={tl.t}
              duration={duration}
              usPerPx={usPerPx}
              selected={selected}
              onSelect={(id) => {
                setSelected(id)
                if (id !== null) setTab("packet")
              }}
              onDelay={delay}
              follow={follow}
              height={ladderHeight}
            />
          </div>
          <Transport
            tl={{
              ...tl,
              toggle: () => {
                setFollow(true)
                tl.toggle()
              },
            }}
            events={run.events.length}
          />
          <p className="font-sans text-xs text-muted-foreground">
            Click a packet to inspect it; press <kbd>D</kbd> to drop it (or rescue a lost one) and drag the ring at its far end to delay it.
            Space plays, arrow keys step, Home and End jump.
          </p>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="rounded-sm border border-border p-3" aria-live={tl.playing ? "off" : "polite"}>
            <p className="font-sans text-xs text-muted-foreground">
              {formatTime(event.t)}, {event.who === "S" ? "sender" : "receiver"}
            </p>
            <p className="mt-0.5">
              <b className="lining">{event.step}.</b> [{stepTitles.get(event.step) ?? ""}] {event.text}
            </p>
          </div>
          <WindowView p={params} s={event.state} t={tl.t} />
          <Totals run={run} p={params} />

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="state">Trace</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="packet">Packet</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="lab">Lab</TabsTrigger>
            </TabsList>
            <TabsContent value="state">
              <TraceList events={run.events} index={tl.index} onSeek={tl.seekIndex} />
            </TabsContent>
            <TabsContent value="setup">
              <Setup p={params} set={(p) => apply(p)} />
            </TabsContent>
            <TabsContent value="packet">
              {flight ? (
                <PacketView
                  f={flight}
                  p={params}
                  m={m}
                  onToggle={() => toggleDrop(flight)}
                  onDelay={() => delay(flight.id, 5000)}
                  interventions={params.interventions}
                />
              ) : (
                <p className="text-muted-foreground">Click a packet in the diagram to see its header.</p>
              )}
            </TabsContent>
            <TabsContent value="source">
              <p className="mb-2 font-sans text-xs text-muted-foreground">
                The Rust that produced this run (crates/netsim/src/rdt.rs), compiled into the page. The step behind the current event is
                shaded.
              </p>
              <LiterateSource source={source} active={event.step} className="max-h-[32rem]" />
            </TabsContent>
            <TabsContent value="lab" forceMount className="data-[state=inactive]:hidden">
              <LabPanel
                labs={LABS}
                load={(p) => {
                  apply(p)
                  tl.home()
                }}
                check={(lab) => LABS.find((l) => l.id === lab.id)!.check(params, run, sim)}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <Article sim={sim} p={params} run={run} />
    </section>
  )
}

// The article and the trace list are large; playback re-renders the tool many
// times a second, so these only re-render when their own inputs change.
const Article = memo(function Article(props: { sim: Netsim; p: RdtParams; run: RdtRun }) {
  return (
    <>
      <RdtIntro />
      <RdtAnalysis {...props} />
      <RdtFrontier />
      <RdtInternals />
    </>
  )
})

const TraceRow = memo(function TraceRow({
  e,
  i,
  active,
  onSeek,
}: {
  e: RdtRun["events"][number]
  i: number
  active: boolean
  onSeek(i: number): void
}) {
  return (
    <li>
      <button
        className={cn(
          "grid w-full grid-cols-[4.5rem_2rem_1fr] gap-2 px-1 py-0.5 text-left hover:bg-muted",
          active && "bg-[color-mix(in_oklab,var(--link)_14%,transparent)]",
        )}
        onClick={() => onSeek(i)}
        ref={active ? scrollWithin : undefined}
      >
        <span className="text-muted-foreground tabular-nums">{formatTime(e.t)}</span>
        <b>{e.step}</b>
        <span>{e.text}</span>
      </button>
    </li>
  )
})

const TraceList = memo(function TraceList({ events, index, onSeek }: { events: RdtRun["events"]; index: number; onSeek(i: number): void }) {
  return (
    <ol className="relative max-h-80 overflow-auto font-sans text-sm" aria-label="Event trace">
      {events.map((e, i) => (
        <TraceRow key={i} e={e} i={i} active={i === index} onSeek={onSeek} />
      ))}
    </ol>
  )
})

const Totals = memo(function Totals({ run, p }: { run: RdtRun; p: RdtParams }) {
  const T = run.totals
  const items: [string, string][] = [
    ["finished at", T.finished ? formatTime(T.completion_us) : "not finished"],
    ["utilisation", T.utilisation >= 0.01 ? T.utilisation.toFixed(3) : T.utilisation.toExponential(2)],
    ["formula bound", run.theory.bound >= 0.01 ? run.theory.bound.toFixed(3) : run.theory.bound.toExponential(2)],
    ["transmissions", `${T.transmissions} (${T.retransmissions} again)`],
    ["timeouts", String(T.timeouts)],
    ["delivered", `${T.delivered} of ${p.messages}${T.misdelivered ? `, ${T.misdelivered} wrong` : ""}`],
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className={cn("tabular-nums lining", k === "delivered" && T.misdelivered > 0 && "text-destructive")}>{v}</dd>
        </div>
      ))}
    </dl>
  )
})

const RATES = [1e4, 5.6e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10]
const rateLabel = (r: number) => (r >= 1e9 ? `${r / 1e9} Gb/s` : r >= 1e6 ? `${r / 1e6} Mb/s` : `${r / 1e3} kb/s`)

function Setup({ p, set }: { p: RdtParams; set(p: RdtParams): void }) {
  const kind = protocolName(p)
  const value =
    kind === "Go-Back-N" || (kind === "Stop-and-wait" && !p.rules.buffer)
      ? "gbn"
      : kind === "Selective Repeat"
        ? "sr"
        : kind === "Stop-and-wait"
          ? "gbn"
          : "custom"
  const ms = (us: number) => `${(us / 1000).toFixed(us < 10_000 ? 1 : 0)} ms`
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 font-sans text-xs text-muted-foreground">Protocol</p>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-label="Protocol"
          value={p.window === 1 && value === "gbn" ? "sw" : value}
          onValueChange={(v) => {
            if (v === "sw") set({ ...p, rules: GO_BACK_N, window: 1 })
            if (v === "gbn") set({ ...p, rules: GO_BACK_N, window: Math.max(p.window, 4) })
            if (v === "sr") set({ ...p, rules: SELECTIVE_REPEAT, window: Math.max(p.window, 4) })
          }}
        >
          <ToggleGroupItem value="sw">Stop-and-wait</ToggleGroupItem>
          <ToggleGroupItem value="gbn">Go-Back-N</ToggleGroupItem>
          <ToggleGroupItem value="sr">Selective Repeat</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <fieldset className="space-y-3 rounded-sm border border-border p-3">
        <legend className="px-1 font-sans text-xs text-muted-foreground">
          The protocol as four rules: all off is Go-Back-N, all on is Selective Repeat, and any mix runs
        </legend>
        <ParamSwitch
          label="Receiver"
          name="Receiver buffers out-of-order packets"
          checked={p.rules.buffer}
          onChange={(v) => set({ ...p, rules: { ...p.rules, buffer: v } })}
          on="buffers out-of-order packets"
          off="accepts only the next in order"
        />
        <ParamSwitch
          label="ACKs"
          name="Acknowledge each packet individually"
          checked={p.rules.ack === "individual"}
          onChange={(v) => set({ ...p, rules: { ...p.rules, ack: v ? "individual" : "cumulative" } })}
          on="individual: packet n"
          off="cumulative: everything up to n"
        />
        <ParamSwitch
          label="Timers"
          name="A timer for each packet"
          checked={p.rules.timer === "each"}
          onChange={(v) => set({ ...p, rules: { ...p.rules, timer: v ? "each" : "single" } })}
          on="one per packet"
          off="one, for the oldest packet"
        />
        <ParamSwitch
          label="On timeout"
          name="On timeout, resend only that packet"
          checked={p.rules.resend === "one"}
          onChange={(v) => set({ ...p, rules: { ...p.rules, resend: v ? "one" : "all" } })}
          on="resend only that packet"
          off="resend every outstanding packet"
        />
      </fieldset>
      <ParamSlider label="Window N" value={p.window} min={1} max={64} onChange={(v) => set({ ...p, window: v })} />
      <ParamSlider
        label={<>Sequence number bits k</>}
        value={p.seq_bits}
        min={1}
        max={16}
        format={(k) => `${k} (0 to ${2 ** k - 1})`}
        onChange={(v) => set({ ...p, seq_bits: v })}
      />
      <ParamSlider label="Messages to send" value={p.messages} min={1} max={600} onChange={(v) => set({ ...p, messages: v })} />
      <div className="grid grid-cols-[1fr_auto] items-center gap-2 font-sans text-sm">
        <label htmlFor="rdt-rate">Link rate R</label>
        <select
          id="rdt-rate"
          className="rounded-sm border border-input bg-background px-1 py-0.5"
          value={p.rate_bps}
          onChange={(e) => set({ ...p, rate_bps: Number(e.target.value) })}
        >
          {(RATES.includes(p.rate_bps) ? RATES : [...RATES, p.rate_bps].sort((a, b) => a - b)).map((r) => (
            <option key={r} value={r}>
              {rateLabel(r)}
            </option>
          ))}
        </select>
      </div>
      <ParamSlider
        label="Packet size L"
        value={p.data_bytes}
        min={40}
        max={12000}
        log
        format={(b) => `${b} bytes`}
        onChange={(v) => set({ ...p, data_bytes: Math.round(v) })}
      />
      <ParamSlider
        label="ACK size"
        value={p.ack_bytes}
        min={0}
        max={1500}
        step={10}
        format={(b) => `${b} bytes`}
        onChange={(v) => set({ ...p, ack_bytes: v })}
      />
      <ParamSlider
        label="Propagation delay d (each way)"
        value={p.prop_us}
        min={0}
        max={200_000}
        step={500}
        format={ms}
        onChange={(v) => set({ ...p, prop_us: v })}
      />
      <ParamSlider
        label="Jitter J (extra delay, uniform 0 to J)"
        value={p.jitter_us}
        min={0}
        max={100_000}
        step={500}
        format={ms}
        onChange={(v) => set({ ...p, jitter_us: v })}
      />
      <ParamSlider
        label="Timeout T"
        value={p.timeout_us}
        min={1000}
        max={1_000_000}
        log
        format={ms}
        onChange={(v) => set({ ...p, timeout_us: Math.round(v) })}
      />
      <ParamSlider
        label="Data loss probability"
        value={p.loss_data}
        min={0}
        max={0.5}
        step={0.01}
        format={(x) => x.toFixed(2)}
        onChange={(v) => set({ ...p, loss_data: v })}
      />
      <ParamSlider
        label="ACK loss probability"
        value={p.loss_ack}
        min={0}
        max={0.5}
        step={0.01}
        format={(x) => x.toFixed(2)}
        onChange={(v) => set({ ...p, loss_ack: v })}
      />
      <div className="flex items-center justify-between font-sans text-sm">
        <span>
          Seed <span className="text-muted-foreground tabular-nums">{p.seed}</span>
        </span>
        <Button size="sm" variant="outline" onClick={() => set({ ...p, seed: (p.seed * 1103515245 + 12345) % 2147483647 })}>
          New seed
        </Button>
      </div>
      {p.interventions.length > 0 && (
        <div className="font-sans text-sm">
          <p className="mb-1 text-xs text-muted-foreground">Your edits to individual packets</p>
          <ul className="space-y-1">
            {p.interventions.map((iv, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span>
                  {iv.action === "delay" ? `delay by ${(iv.delay_us / 1000).toFixed(1)} ms` : iv.action === "drop" ? "drop" : "deliver"}{" "}
                  {iv.kind === "data" ? "message" : "ACK for"} {iv.number}
                  {iv.occurrence > 1 ? `, copy ${iv.occurrence}` : ""}
                </span>
                <Button size="xs" variant="ghost" onClick={() => set({ ...p, interventions: p.interventions.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** RFC 1071 Internet checksum over 16-bit words. */
function internetChecksum(words: number[]): number {
  let sum = 0
  for (const w of words) {
    sum += w & 0xffff
    sum = (sum & 0xffff) + (sum >>> 16)
  }
  return ~sum & 0xffff
}

function PacketView({
  f,
  p,
  m,
  onToggle,
  onDelay,
  interventions,
}: {
  f: Flight
  p: RdtParams
  m: number
  onToggle(): void
  onDelay(): void
  interventions: Intervention[]
}) {
  const isData = f.kind === "data"
  const len = isData ? p.data_bytes : p.ack_bytes
  const payload = Array.from({ length: 4 }, (_, i) => ((f.number + 1) * 2654435761 + i * 40503) & 0xffff)
  const checksum = internetChecksum([isData ? 0 : 1, f.wire, len, ...(isData ? payload : [])])
  const fields: HeaderField[] = [
    { name: "type", bits: 8, value: isData ? "DATA" : "ACK" },
    { name: isData ? "seq" : "ack", bits: 8, value: String(f.wire) },
    { name: "length", bits: 16, value: String(len) },
    { name: "checksum", bits: 16, value: `0x${checksum.toString(16).padStart(4, "0")}` },
    { name: "reserved", bits: 16, value: "0" },
    { name: "really carries message", bits: 0, value: isData ? String(f.number) : `acknowledges ${f.number}`, hidden: true },
    { name: "copy", bits: 0, value: String(f.occurrence), hidden: true },
    { name: "first bit leaves", bits: 0, value: formatTime(f.t_start), hidden: true },
    { name: "arrives", bits: 0, value: f.lost ? "never (lost)" : formatTime(f.t_arrive), hidden: true },
    { name: "outcome", bits: 0, value: f.fate, hidden: true },
  ]
  const edited = interventions.some(
    (iv) => iv.kind === f.kind && iv.number === f.number && iv.occurrence === f.occurrence && iv.action !== "delay",
  )
  return (
    <div className="space-y-3">
      <HeaderDiagram
        title={`${isData ? "Data" : "ACK"} packet, sequence numbers mod ${m}`}
        fields={fields}
        note="A teaching header in RFC layout; the checksum is the RFC 1071 Internet checksum of the header and a stand-in payload. Values under the grid are known to the model, not carried on the wire."
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={f.lost || edited ? "outline" : "destructive"} onClick={onToggle}>
          {edited
            ? f.lost
              ? "Undo: deliver it again"
              : "Undo: let it be lost again"
            : f.lost
              ? "Deliver it anyway"
              : "Drop this packet (D)"}
        </Button>
        {!f.lost && (
          <Button size="sm" variant="outline" onClick={onDelay}>
            Delay it 5 ms more
          </Button>
        )}
      </div>
    </div>
  )
}
