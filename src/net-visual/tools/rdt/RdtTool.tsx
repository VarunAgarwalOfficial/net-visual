import { memo, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
import { ladderExports } from "../../components/figure"
import { HeaderDiagram, type HeaderField } from "../../components/HeaderDiagram"
import { LabPanel } from "../../components/LabPanel"
import { Ladder, type LadderFlight, type LadderMark } from "../../components/Ladder"
import { LiterateSource } from "../../components/LiterateSource"
import {
  DeeperHeading,
  Disclosure,
  AboutExample,
  ExampleIntro,
  Readouts,
  StepCard,
  TourAndSharing,
  TourCard,
  sourceLine,
} from "../../components/ToolFrame"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import { formatTime, keepFocus, timeIn, timelineKeys, useTimeline } from "../../components/timeline"
import { RdtAnalysis, RdtFrontier, RdtIntro, RdtInternals } from "./RdtArticle"
import { plainRdt } from "./plain"
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

// What happened to a packet on arrival, in a word or two that fits beside the lane.
const FATES: Record<string, string> = {
  "accepted as the wrong message": "wrong message",
  delivered: "delivered",
  buffered: "kept",
  duplicate: "a copy",
  "out of order": "thrown away",
  "outside window": "thrown away",
  "advances base": "accepted",
  "marks one": "accepted",
  ignored: "ignored",
}

const toLadder = (run: RdtRun): LadderFlight[] =>
  run.flights.map((f) => ({
    id: f.id,
    from: f.kind === "data" ? 0 : 1,
    t_start: f.t_start,
    t_sent: f.t_sent,
    t_arrive: f.t_arrive,
    lost: f.lost,
    label: f.kind === "data" ? `packet ${f.wire}${f.occurrence > 1 ? ", again" : ""}` : `ACK ${f.wire}`,
    fate: FATES[f.fate] ?? f.fate,
    color: f.kind === "data" ? "var(--chart-1)" : "var(--chart-2)",
    alarm: f.fate.includes("wrong"),
  }))

function RdtLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("rdt"), [])
  const [params, setParams] = useState<RdtParams>(shared?.p ?? PRESETS[0].params)
  const [preset, setPreset] = useState<string>(shared ? "" : PRESETS[0].id)
  const [selected, setSelected] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [follow, setFollow] = useState(true)
  const [tour, setTour] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)

  const source = useMemo(() => sim.call<string>("rdt", "source"), [sim])

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

  const ladderHeight = 320
  const usPerPx = Math.max(0.01, Math.min(duration, Math.max(roundTrip, 1) * 3.2) / (ladderHeight - 60) / zoom)

  const apply = (p: RdtParams, id = "") => {
    setParams(p)
    setPreset(id)
    setSelected(null)
    keepFocus(root)
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
    () => (run ? run.events.filter((e) => e.step === "S4").map((e) => ({ t: e.t, lane: 0, text: "timer ran out" })) : []),
    [run],
  )

  // Running counts up to each event, for the "so far" readouts.
  const counts = useMemo(() => {
    let sent = 0
    let again = 0
    let timeouts = 0
    return (run?.events ?? []).map((e) => {
      if (e.step === "S2") {
        sent++
        if (e.text.includes("(again)")) again++
      }
      if (e.step === "S4") timeouts++
      return { sent, again, timeouts }
    })
  }, [run])

  if (!run) {
    return (
      <div className="space-y-3">
        <p role="alert">These settings cannot run: {"error" in result ? result.error : ""}</p>
        <Button onClick={() => apply(PRESETS[0].params, PRESETS[0].id)}>Back to the first example</Button>
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
  const started = tl.index >= 0
  const plain = started ? plainRdt(event, run, params) : null
  const sofar = counts[Math.max(0, tl.index)]
  const delivered = started ? [...event.state.receiver].filter((c) => c === "d" || c === "x").length : 0
  const playToggle = () => {
    setFollow(true)
    tl.toggle()
  }

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Reliable data transfer"
      className="nv-tool max-w-4xl space-y-4 outline-none [&.nv-present]:max-w-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
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
      {tour !== null && <TourCard index={tour} steps={TOUR} go={goTour} playing={tl.playing} toggle={playToggle} />}

      <ExampleIntro title={presetInfo?.title ?? "Your own settings"} />

      <Transport
        tl={{ ...tl, toggle: playToggle }}
        events={run.events.length}
        stepIs="one packet or acknowledgement sent, arriving or lost, or a timer running out"
      />

      <figure className="space-y-2">
        <div onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}>
          <Ladder
            lanes={["Sender", "Receiver"]}
            flights={ladderFlights}
            marks={marks}
            t={started ? tl.t : -1}
            duration={duration}
            usPerPx={usPerPx}
            selected={selected}
            onSelect={setSelected}
            onDelay={delay}
            follow={follow}
            height={ladderHeight}
            empty={["Nothing sent yet.", "Play draws each packet", "as a band crossing the gap."]}
          />
        </div>
        <figcaption className="font-sans text-sm text-muted-foreground">
          Sender on the left, receiver on the right, time running down. A band from the sender to the receiver is a data packet, named by
          its sequence number; a band back is an acknowledgement (ACK) that it arrived. A red cross is a packet lost on the way. Once Play
          starts, a dotted line marks now.
        </figcaption>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm text-muted-foreground">
          {started && <span className="mr-auto">Select a packet to see its header, drop it or delay it.</span>}
          <Button variant="outline" size="xs" onClick={() => setZoom(zoom / 1.6)}>
            Zoom out: more time in view
          </Button>
          <Button variant="outline" size="xs" onClick={() => setZoom(zoom * 1.6)}>
            Zoom in: less time in view
          </Button>
        </div>
        {flight && (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-lg">The selected packet</h2>
              <Button variant="ghost" size="xs" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
            <PacketView
              f={flight}
              p={params}
              m={m}
              onToggle={() => toggleDrop(flight)}
              onDelay={() => delay(flight.id, 5000)}
              interventions={params.interventions}
            />
          </div>
        )}
      </figure>
      <AboutExample
        note={
          presetInfo?.note ??
          `${protocol} with up to ${params.window} message${params.window === 1 ? "" : "s"} out at once, ${params.messages} messages to send, sequence numbers 0 to ${m - 1}. Open "Change the settings", further down the page, to see the rest.`
        }
      />

      <StepCard
        live={!tl.playing}
        when={started ? `At ${timeIn(event.t, tl.duration)}, the ${event.who === "S" ? "sender" : "receiver"}` : null}
        title={plain?.title}
        text={plain?.text}
        why={plain?.why}
        empty={
          <>
            Nothing has happened yet. Press <b>Play</b> to run the example, or <b>Next</b> to go one step at a time (the arrow keys do the
            same).
          </>
        }
      />

      <WindowView p={params} s={event.state} t={tl.t} started={started} />

      <Readouts
        caption="So far"
        cols={4}
        items={[
          ["Simulated time", timeIn(tl.t, tl.duration)],
          ["Packets put on the link", started ? `${sofar.sent}${sofar.again ? `, ${sofar.again} of them again` : ""}` : "0"],
          ["Times a timer ran out", started ? String(sofar.timeouts) : "0"],
          ["Messages handed to the application", `${delivered} of ${params.messages}`],
        ]}
      />

      <div className="space-y-2">
        <label className="block text-lg" htmlFor="rdt-preset">
          Try another example
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
          <SelectTrigger
            id="rdt-preset"
            className="h-auto min-h-9 w-full max-w-xl text-left whitespace-normal [&_[data-slot=select-value]]:line-clamp-none"
          >
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
        {presetInfo && <p className="font-sans text-sm text-muted-foreground">{sourceLine(presetInfo.source)}</p>}
      </div>

      <div>
        <DeeperHeading />
        <Disclosure
          title="Change the settings"
          note="Protocol, how many messages may be out at once, link speed and length, the timer, and how often packets are lost."
        >
          <Setup p={params} set={(p) => apply(p)} />
        </Disclosure>
        <Disclosure
          title="Every event so far, as a list"
          note="The simulation's own log, one line per event, with its step code. Select a line to go back to that moment."
        >
          <TraceList events={run.events} index={tl.index} onSeek={tl.seekIndex} />
        </Disclosure>
        <Disclosure
          title="How fast this run is, against the formula"
          note="The figures this run ends with, and the bound the formula predicts."
        >
          <Totals run={run} p={params} />
        </Disclosure>
        <Disclosure
          title="Exercises this page can check"
          note="Short tasks, from recall to investigation. The page checks your answer against the run."
          keepMounted
        >
          <LabPanel
            labs={LABS}
            load={(p) => {
              apply(p)
              tl.home()
            }}
            check={(lab) => LABS.find((l) => l.id === lab.id)!.check(params, run, sim)}
          />
        </Disclosure>
        <Disclosure
          title="The program that produced this run"
          note="The Rust source, compiled into the page. The step behind the current event is shaded."
        >
          <p className="mb-2 font-sans text-xs text-muted-foreground">crates/netsim/src/rdt.rs</p>
          <LiterateSource source={source} active={started ? event.step : ""} className="max-h-[32rem]" />
        </Disclosure>
        <TourAndSharing
          root={root}
          tour={tour}
          stops={TOUR.length}
          startTour={() => goTour(0)}
          link={() => linkFor("rdt", { p: params, t: Math.round(tl.t) } satisfies Shared)}
          figures={[
            {
              label: "the sequence diagram",
              stem: `rdt-${preset || "custom"}`,
              ...ladderExports({
                lanes: ["Sender", "Receiver"],
                flights: ladderFlights,
                marks,
                upTo: tl.t,
                caption: `${protocol}, window ${params.window}, sequence numbers mod ${m}, at ${formatTime(tl.t)}`,
              }),
            },
          ]}
        />
      </div>

      <div>
        <DeeperHeading>Read about it</DeeperHeading>
        <Article sim={sim} p={params} run={run} />
      </div>
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

const pct = (x: number) => (x >= 0.001 ? `${(x * 100).toFixed(x >= 0.1 ? 1 : 2)}%` : `${(x * 100).toExponential(1)}%`)

const Totals = memo(function Totals({ run, p }: { run: RdtRun; p: RdtParams }) {
  const T = run.totals
  return (
    <div className="space-y-3">
      <Readouts
        caption="What this run ends with"
        items={[
          ["Every message acknowledged at", T.finished ? formatTime(T.completion_us) : "never: the run stops first"],
          ["Share of time the link is busy sending data", pct(T.utilisation)],
          ["The formula's upper bound on that share", pct(run.theory.bound)],
          ["Packets put on the link", `${T.transmissions}, ${T.retransmissions} of them again`],
          ["Times a timer ran out", String(T.timeouts)],
          [
            "Messages handed to the application",
            `${T.delivered} of ${p.messages}${T.misdelivered ? `, ${T.misdelivered} of them wrong` : ""}`,
          ],
        ]}
      />
      <p className="max-w-[70ch] font-sans text-sm text-muted-foreground">
        The bound is the smaller of two limits: the link cannot be busier than the share of packets that survive, and a window of N messages
        can keep it busy at most N packet-sending times out of every time a message holds its place in the window. The reading section
        &ldquo;How fast can it go?&rdquo; derives it.
      </p>
    </div>
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
