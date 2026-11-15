import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { chartExports, type ChartFigure } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { LineChart, type Series } from "../../components/LineChart"
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
  scrollBehavior,
  sourceLine,
} from "../../components/ToolFrame"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import { keepFocus, timelineKeys, useTimeline } from "../../components/timeline"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import {
  LABS,
  PRESETS,
  TOUR,
  clock,
  epochAt,
  forwardingTo,
  normalise,
  periodic,
  runDuration,
  runRouting,
  showDist,
  stateAfter,
  type RoutingParams,
  type RoutingRun,
} from "../../core/routing"
import { linkFor, readHash } from "../../core/share"
import { toEnd } from "../tcp/CwndChart"
import { Graph, type DijkstraOverlay, type WireMessage } from "./Graph"
import { graphAt, graphSvg, graphTikz } from "./graphFigure"
import { RoutingAnalysis, RoutingFrontier, RoutingInternals, RoutingIntro } from "./RoutingArticle"
import { plainRouting } from "./plain"
import { BellmanCard, DijkstraTable, LinkEditor, MapCard, RoutingSetup, VectorMatrix } from "./RoutingViews"

interface Shared {
  p: RoutingParams
  t?: number
  dest?: number
}

/** Routing: distance vector and link state on the same network. */
export function RoutingTool() {
  const [sim, setSim] = useState<Netsim | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadNetsim().then(setSim, (e: Error) => setError(e.message))
  }, [])
  if (error) return <p role="alert">The simulation could not load: {error}</p>
  if (!sim) return <p className="font-sans text-sm text-muted-foreground">Loading the simulation…</p>
  return <RoutingLoaded sim={sim} />
}

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"]

/** Each router's cost to the destination over time, as step series. */
function distanceSeries(run: RoutingRun, p: RoutingParams, dest: number, end: number) {
  const top = Math.max(4, ...run.events.flatMap((e) => e.dist.map((row) => row[dest]).filter((d) => d < p.infinity)))
  const cap = Math.min(p.infinity, Math.ceil(top * 1.12) + 1)
  const series: Series[] = []
  p.nodes.forEach((n, x) => {
    if (x === dest) return
    const pts: [number, number][] = []
    for (const e of run.events) {
      const d = Math.min(cap, e.dist[x][dest])
      if (!pts.length || pts[pts.length - 1][1] !== d) pts.push([e.t, d])
    }
    series.push({
      id: n,
      label: `router ${n}`,
      color: COLORS[series.length % COLORS.length],
      kind: "step",
      points: toEnd(pts, end),
      dashed: series.length >= COLORS.length,
    })
  })
  return { series, cap }
}

function RoutingLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("routing"), [])
  const first = PRESETS[0]
  const [params, setParams] = useState<RoutingParams>(shared?.p ? normalise(shared.p) : first.params)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [dest, setDest] = useState(Math.min(shared?.dest ?? first.dest, params.nodes.length - 1))
  const [router, setRouterState] = useState(0)
  // The chosen router is marked on the drawing and in the tables only once the reader has chosen one.
  const [picked, setPicked] = useState(false)
  const setRouter = (r: number) => {
    setRouterState(r)
    setPicked(true)
  }
  const [link, setLink] = useState<[number, number] | null>(null)
  const [tour, setTour] = useState<number | null>(null)
  const [dijOpen, setDijOpen] = useState(false)
  const [dijSource, setDijSource] = useState(0)
  const [dijStep, setDijStep] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)

  const source = useMemo(() => sim.call<string>("routing", "source"), [sim])

  // A setting the model refuses leaves the last good run on screen with the reason.
  const [good, setGood] = useState<{ p: RoutingParams; run: RoutingRun }>(() => ({ p: params, run: runRouting(sim, params) }))
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(params)
  if (tried !== params) {
    // Adjusting state while rendering, as React documents for derived state.
    setTried(params)
    try {
      setGood({ p: params, run: runRouting(sim, params) })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { run } = good
  const p = good.p

  const times = useMemo(() => run.events.map((e) => e.t), [run])
  const duration = useMemo(() => runDuration(run, p), [run, p])
  // A round of messages in about a second; with RIP's timer, a period in a second and a half.
  const timed = periodic(p)
  const tl = useTimeline(times, duration, timed ? p.period_us / 1.5 : p.delay_us / 1.2, shared?.t ?? 0)
  const ls = p.algorithm === "ls"
  // Before the first event the page shows the starting state (event 0, where each router knows only its own links) and says nothing has happened.
  const started = tl.index >= 0
  const index = Math.max(0, tl.index)
  const event = run.events[index]
  const epoch = epochAt(run, event.t)
  const state = useMemo(() => stateAfter(run, p, index), [run, p, index])
  const d = Math.min(dest, p.nodes.length - 1)
  const x = Math.min(router, p.nodes.length - 1)

  // The event that sent each message: the first whose count of messages sent passes its id.
  const sendIndex = useMemo(() => {
    const m = new Map<number, number>()
    let i = 0
    for (const msg of run.messages) {
      while (i < run.events.length - 1 && run.events[i].sent <= msg.id) i++
      m.set(msg.id, i)
    }
    return m
  }, [run])
  const arriveIndex = useMemo(() => {
    const m = new Map<number, number>()
    run.events.forEach((e, i) => {
      if (e.message !== null) m.set(e.message, i)
    })
    return m
  }, [run])
  // Running counts, so the readouts say what has happened up to now and no further.
  const sofar = useMemo(() => {
    const out: { changed: number; lost: number }[] = []
    for (const e of run.events) {
      const last = out[out.length - 1] ?? { changed: 0, lost: 0 }
      out.push({ changed: last.changed + e.changed.length, lost: last.lost + (e.step === "L2" ? 1 : 0) })
    }
    return out
  }, [run])

  const wire: WireMessage[] = []
  const onLink = new Map<string, WireMessage>()
  for (const m of run.messages) {
    if (m.t_send > tl.t || (sendIndex.get(m.id) ?? 0) > index) continue
    const arrived = arriveIndex.get(m.id)
    if (arrived !== undefined ? arrived <= index : tl.t >= m.t_arrive) continue
    const frac = Math.min(1, Math.max(0, (tl.t - m.t_send) / Math.max(1, m.t_arrive - m.t_send)))
    const label = m.lsa ? `${p.nodes[m.lsa.origin]} #${m.lsa.seq}` : m.omitted.includes(d) ? "–" : showDist(m.vector[d], p.infinity)
    // Flooding puts several LSAs on a link at once: draw them as one box with a count.
    const prev = m.lsa ? onLink.get(`${m.from}-${m.to}`) : undefined
    if (prev && Math.abs(prev.frac - frac) < 0.08 && prev.lost === m.lost) {
      const more = prev.label.match(/ \+(\d+)$/)
      prev.label = more ? prev.label.replace(/\d+$/, String(Number(more[1]) + 1)) : `${prev.label} +1`
      continue
    }
    const w = { id: m.id, from: m.from, to: m.to, frac, label, poisoned: m.poisoned.includes(d) || m.omitted.includes(d), lost: m.lost }
    wire.push(w)
    onLink.set(`${m.from}-${m.to}`, w)
  }

  const base = useMemo(() => graphAt(run, p, index, d), [run, p, index, d])
  // Before Play, the routers that already know a cost are the destination's neighbours: their own link says so.
  const direct = base.links.filter((l) => l.cost !== null && (l.a === d || l.b === d)).map((l) => (l.a === d ? l.b : l.a))
  const fig = started ? base : { ...base, labels: base.labels.map((t, i) => (direct.includes(i) ? `${t}, direct link` : t)) }
  const loops = forwardingTo(event.hop, d)
  const changed = useMemo(() => (started ? new Set(event.changed.map(([r]) => r)) : new Set<number>()), [event, started])
  const plain = started ? plainRouting(run, p, index, d) : null
  const wrong = event.dist.reduce((n, row, a) => n + row.filter((v, b) => a !== b && v !== epoch.shortest[a][b]).length, 0)
  const pairs = p.nodes.length * (p.nodes.length - 1)

  const dij = epoch.dijkstra[Math.min(dijSource, p.nodes.length - 1)]
  const k = Math.min(dijStep ?? dij.length - 1, dij.length - 1)
  // The overlay is drawn only while its disclosure is open, so the first picture is the routes alone.
  const overlay: DijkstraOverlay | null = dijOpen
    ? {
        source: Math.min(dijSource, p.nodes.length - 1),
        done: new Set(dij.slice(0, k + 1).map((s) => s.added)),
        added: dij[k].added,
        d: dij[k].d,
        p: dij[k].p,
        infinity: p.infinity,
      }
    : null

  const chart = useMemo(() => distanceSeries(run, p, d, duration), [run, p, d, duration])

  const apply = (next: RoutingParams, id = "") => {
    setParams(next)
    setPreset(id)
    setDijStep(null)
    keepFocus(root)
  }
  const closeLink = () => {
    setLink(null)
    keepFocus(root)
  }
  const load = (id: string, at = 0) => {
    const pr = PRESETS.find((q) => q.id === id)
    if (!pr) return
    apply(pr.params, pr.id)
    setDest(pr.dest)
    setRouterState(pr.params.nodes.findIndex((_, i) => i !== pr.dest))
    setPicked(false)
    setLink(null)
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
    setTour(null)
    root.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" })
  }, [])
  const goTour = (i: number | null) => {
    setTour(i)
    if (i === null) return
    load(TOUR[i].preset, TOUR[i].at)
  }
  const pick = (r: number, y: number) => {
    setRouter(r)
    setDest(y)
  }

  const presetInfo = PRESETS.find((q) => q.id === preset)
  const caption = `${presetInfo?.title ?? "Your network"}: routes to ${p.nodes[d]} at ${clock(event.t, p)}`
  const sync = !timed && p.jitter_us === 0
  // Rounds when every message takes one delay, as the clock elsewhere says; otherwise milliseconds or seconds.
  const xAxis = timed
    ? { label: "simulated time (seconds)", format: (v: number) => String(Number((v / 1e6).toFixed(0))) }
    : sync
      ? {
          label: `round (one message delay, ${Number((p.delay_us / 1000).toFixed(2))} ms)`,
          format: (v: number) => String(Number((v / p.delay_us).toFixed(1))),
        }
      : { label: "simulated time (milliseconds)", format: (v: number) => String(Number((v / 1000).toFixed(1))) }
  const chartFigure = (): ChartFigure => ({
    xLabel: xAxis.label,
    yLabel: `cost to ${p.nodes[d]}`,
    xFormat: xAxis.format,
    yFormat: (v) => (v >= p.infinity ? "∞" : String(Math.round(v))),
    xDomain: [0, duration],
    yDomain: [0, chart.cap],
    series: chart.series.map((s) => ({ label: s.label, color: s.color, points: s.points, dashed: s.dashed, step: true })),
    refs: [{ y: chart.cap, label: chart.cap >= p.infinity ? `unreachable (infinity = ${p.infinity})` : "unreachable" }],
    caption: `${presetInfo?.title ?? "Your network"}: each router's cost to ${p.nodes[d]}`,
  })
  const D = p.nodes[d]

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Routing"
      className="nv-tool max-w-4xl space-y-4 outline-none [&.nv-present]:max-w-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
        else if (e.key === "Escape") closeLink()
      }}
    >
      {tour !== null && <TourCard index={tour} steps={TOUR} go={goTour} playing={tl.playing} toggle={tl.toggle} />}

      <ExampleIntro title={presetInfo?.title ?? "Your own network"} />
      {error && (
        <p role="alert" className="font-sans text-sm text-destructive">
          That setting cannot run ({error}); the run shown is the last one that could.
        </p>
      )}

      <Transport
        tl={tl}
        events={run.events.length}
        format={p.jitter_us === 0 && !periodic(p) ? (t) => clock(t, p) : undefined}
        stepIs="one router sending its table of costs to a neighbour, or taking one in"
        timeIs={p.jitter_us === 0 && !periodic(p) ? "a round is the time one message takes to cross a link" : undefined}
      />

      <figure className="space-y-3">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-sm">
          {!started && <strong className="font-semibold">Nothing has been exchanged yet: this is the start.</strong>}
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <svg width="28" height="10" aria-hidden="true" className="shrink-0">
              <line x1="1" y1="5" x2="20" y2="5" className="stroke-chart-1" strokeWidth="3" />
              <path d="M19,0 L28,5 L19,10 z" className="fill-chart-1" />
            </svg>
            blue arrow: the next router on the way to {D}
          </span>
        </p>
        <Graph
          fig={fig}
          messages={wire}
          changed={changed}
          actor={started ? event.node : -1}
          selected={picked ? x : null}
          link={link}
          dijkstra={overlay}
          onNode={(i) => (dijOpen ? setDijSource(i) : setRouter(i))}
          onLink={(a, b) => setLink(link && link[0] === a && link[1] === b ? null : [a, b])}
        />
        <div className="max-w-(--site-measure) space-y-1 font-sans text-sm">
          <p>
            {started ? (
              <>
                Method:{" "}
                {ls
                  ? "link state, each router sharing its whole list of links with all the others"
                  : "distance vector, each router telling its neighbours its own costs"}
                .
              </>
            ) : (
              <>
                Each router knows only its own links
                {direct.length > 0
                  ? `, so only ${direct.map((i) => p.nodes[i]).join(" and ")}, linked straight to ${D}, already know a cost to it`
                  : ""}
                . Method:{" "}
                {ls ? "link state (routers share their whole list of links)" : "distance vector (routers tell neighbours their costs)"}.
              </>
            )}
          </p>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
            <span>cost ∞: no route known yet</span>
            <span>number on a line: that link&apos;s cost</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-sans text-sm">
          <span id="routing-dest-label">Showing the routes to {D}, marked &quot;destination&quot; in the picture. To choose another:</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-labelledby="routing-dest-label"
            value={String(d)}
            onValueChange={(v) => v && setDest(Number(v))}
          >
            {p.nodes.map((n, i) => (
              <ToggleGroupItem key={i} value={String(i)} aria-label={`router ${n}`} className="min-w-8">
                {n}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <p className="max-w-(--site-measure) font-sans text-sm" aria-live="polite">
          {overlay ? (
            <>
              Dijkstra's algorithm from {p.nodes[overlay.source]}, step {k}: filled routers are settled; solid arrows are the cheapest paths
              found so far.
            </>
          ) : loops.cycles.length > 0 ? (
            <span className="text-destructive">
              A forwarding loop: packets for {D} would go{" "}
              {loops.cycles.map((c) => [...c, c[0]].map((v) => p.nodes[v]).join(" → ")).join(", and ")}.
            </span>
          ) : null}
        </p>
        {link && (
          <LinkEditor
            key={`${link[0]}-${link[1]}-${preset}`}
            p={params}
            link={link}
            now={tl.t}
            costNow={state.cost[link[0]][link[1]] >= 0 ? state.cost[link[0]][link[1]] : null}
            set={(next) => apply(next)}
            close={closeLink}
          />
        )}
        <figcaption className="max-w-(--site-measure) space-y-2 font-sans text-sm text-muted-foreground">
          <span className="block">
            Circles are routers and lines are links. The number on a link is its cost, the price of sending over it; routers look for the
            cheapest total. Next to each router, as &quot;cost 5&quot;, is its cost to reach {D} as far as it knows now (&quot;cost ∞&quot;:
            it knows no route yet). A thick blue arrow running beside a link shows where a router sends traffic for {D}
            {loops.cycles.length > 0 ? "; red arrows go round in a loop" : ""}; routers with no arrow have no route yet.
            {fig.links.some((l) => l.cost === null)
              ? " A dashed link marked × has failed; a faded box marked × is a message lost on it."
              : ""}
          </span>
          <span className="block">
            {started ? "" : "Once Play starts, "}
            {ls
              ? `${started ? "A" : "a"} box on a link is a router's list of its links on its way, named by the router that wrote it and its number ("${p.nodes[0]} #1"); "+2" means two more on the same link.`
              : `${started ? "A" : "a"} box on a link is a table on its way, showing the sender's cost to ${D}${p.poison ? "; dashed when the sender says it cannot reach it" : ""}${p.split_horizon ? "; a dash when the sender leaves it out" : ""}.`}{" "}
            A shaded ring marks a router whose table just changed.
            {sync
              ? ` Each message takes one round, ${Number((p.delay_us / 1000).toFixed(2))} millisecond${p.delay_us === 1000 ? "" : "s"}, to cross a link.`
              : ""}{" "}
            Select a router to see its working under Go deeper, further down the page, or a link to change it.
            {picked ? ` The router you selected, ${p.nodes[x]}, has a blue outline.` : ""}
          </span>
        </figcaption>
      </figure>
      <AboutExample
        note={
          presetInfo?.note ??
          `${p.nodes.length} routers and ${p.links.length} links, using ${ls ? "link state" : "distance vector"}. Open "Change the network and the rules", further down the page, to see the rest.`
        }
      />

      <StepCard
        live={!tl.playing}
        when={started ? (event.step === "D0" ? "At the start" : `At ${clock(event.t, p)}`) : null}
        title={plain?.title}
        text={plain?.text}
        why={plain?.why}
        empty={
          <>
            Nothing has happened yet: each router knows only its own links. Press <b>Play</b> to run the example, or <b>Next</b> to go one
            step at a time (the arrow keys do the same).
          </>
        }
      />

      <div className="space-y-2">
        <p className="font-sans text-sm text-muted-foreground">Every router's table, now</p>
        <VectorMatrix p={p} event={event} epoch={epoch} router={x} dest={d} started={started} picked={picked} onPick={pick} />
      </div>

      <Readouts
        caption="So far"
        cols={4}
        items={[
          [ls ? "Link lists sent" : "Tables sent", String(started ? event.sent : 0)],
          ["Messages lost", String(started ? sofar[index].lost : 0)],
          ["Table entries changed", String(started ? sofar[index].changed : 0)],
          ["Entries not yet the cheapest", `${wrong} of ${pairs}`],
        ]}
      />

      <div className="space-y-2">
        <label className="block text-lg" htmlFor="routing-preset">
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
            id="routing-preset"
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
              Your own network
            </SelectItem>
          </SelectContent>
        </Select>
        {presetInfo && <p className="font-sans text-sm text-muted-foreground">{sourceLine(presetInfo.source)}</p>}
      </div>

      <div>
        <DeeperHeading />
        <Disclosure
          title={`How router ${p.nodes[x]} works out its cost to ${D}`}
          note={
            ls
              ? "The lists of links it holds, against the network as it really is now."
              : "Each neighbour's offer, with the numbers it holds now, and the one it picks."
          }
        >
          <div className="space-y-3">
            <label className="flex items-center gap-2 font-sans text-sm">
              Router
              <select
                className="rounded-sm border border-input bg-background px-1 py-0.5"
                value={x}
                onChange={(e) => setRouter(Number(e.target.value))}
              >
                {p.nodes.map((n, i) => (
                  <option key={i} value={i}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {ls ? <MapCard p={p} s={state} event={event} x={x} y={d} /> : <BellmanCard p={p} s={state} event={event} x={x} y={d} />}
          </div>
        </Disclosure>
        <Disclosure
          title={`Each router's cost to ${D} over time`}
          note="A line per router; the upright line is now and the faint part is still to come."
        >
          <LineChart
            title={`Each router's cost to ${D}`}
            series={chart.series}
            xLabel={xAxis.label}
            yLabel={`cost to ${D}`}
            xFormat={xAxis.format}
            yFormat={(v) => (v >= p.infinity ? "∞" : String(Math.round(v)))}
            xDomain={[0, duration]}
            yDomain={[0, chart.cap]}
            height={240}
            cursor={tl.t}
            upTo={tl.t}
            onSeek={(t) => tl.seek(t)}
          >
            {(s) => (
              // Unreachable is drawn on the top line of the chart, which stands for infinity.
              <g pointerEvents="none">
                <line
                  x1={s.left}
                  x2={s.right}
                  y1={s.sy(chart.cap)}
                  y2={s.sy(chart.cap)}
                  stroke="var(--chart-ink)"
                  strokeOpacity={0.4}
                  strokeDasharray="2 3"
                />
                <text x={s.right} y={s.sy(chart.cap) - 4} textAnchor="end" fontSize="12" fill="var(--chart-ink)">
                  ∞, unreachable
                </text>
              </g>
            )}
          </LineChart>
        </Disclosure>
        <Disclosure
          title="Dijkstra's algorithm, step by step"
          note="How a router that knows the whole map finds every cheapest path, one router at a time. While open, the drawing shows its progress."
          open={dijOpen}
          onOpenChange={setDijOpen}
        >
          <DijkstraTable
            p={p}
            epoch={epoch}
            source={Math.min(dijSource, p.nodes.length - 1)}
            k={k}
            setK={setDijStep}
            setSource={(s) => {
              setDijSource(s)
              setDijStep(0)
            }}
          />
        </Disclosure>
        <Disclosure
          title="What the whole run comes to"
          note="When the tables stopped changing, whether they ended correct, and how many messages it took."
        >
          <Totals run={run} p={p} />
        </Disclosure>
        <Disclosure
          title="Change the network and the rules"
          note="Distance vector or link state, the rules for what a router tells its neighbours, timers, delays, links and their costs."
        >
          <RoutingSetup p={params} set={(next) => apply(next)} />
        </Disclosure>
        <Disclosure
          title="Every step, as a list"
          note="The simulation's own log, with the step codes used in the program. Select a line to go to that moment."
        >
          <TraceList events={run.events} index={tl.index} onSeek={tl.seekIndex} />
        </Disclosure>
        <Disclosure
          title="Exercises this page can check"
          note="Short tasks, from recall to investigation. The page checks your answer against the run."
          keepMounted
        >
          <LabPanel
            labs={LABS}
            load={(start) => {
              apply(start)
              setLink(null)
              tl.home()
            }}
            check={(lab) => LABS.find((l) => l.id === lab.id)!.check(p, run)}
          />
        </Disclosure>
        <Disclosure
          title="The program that produced this run"
          note="The Rust source, compiled into the page. The step behind the current event is shaded; K1 to K3 are Dijkstra's."
        >
          <p className="mb-2 font-sans text-xs text-muted-foreground">crates/netsim/src/routing.rs</p>
          <LiterateSource source={source} active={started ? event.step : null} className="max-h-[32rem]" />
        </Disclosure>
        <TourAndSharing
          root={root}
          tour={tour}
          stops={TOUR.length}
          startTour={() => goTour(0)}
          link={() => linkFor("routing", { p, t: Math.round(tl.t), dest: d } satisfies Shared)}
          figures={[
            {
              label: "the network drawing",
              stem: `routing-${preset || "custom"}-graph`,
              svg: () => graphSvg({ ...fig, caption }),
              tikz: () => graphTikz({ ...fig, caption }),
            },
            { label: "the chart of costs over time", stem: `routing-${preset || "custom"}-costs`, ...chartExports(chartFigure) },
          ]}
        />
      </div>

      <div>
        <DeeperHeading>Read about it</DeeperHeading>
        <Article sim={sim} p={p} run={run} onLoad={onLoad} />
      </div>
    </section>
  )
}

// The article is long; playback re-renders the tool many times a second, so it
// re-renders only when the run changes.
const Article = memo(function Article(props: { sim: Netsim; p: RoutingParams; run: RoutingRun; onLoad(id: string): void }) {
  return (
    <>
      <RoutingIntro onLoad={props.onLoad} />
      <RoutingAnalysis {...props} />
      <RoutingFrontier />
      <RoutingInternals />
    </>
  )
})

/** The whole run, from start to end. */
const Totals = memo(function Totals({ run, p }: { run: RoutingRun; p: RoutingParams }) {
  const T = run.totals
  const updates = run.events.reduce((n, e) => n + e.changed.length, 0)
  return (
    <Readouts
      cols={2}
      items={[
        ["Last change to any table", clock(T.last_change_us, p)],
        ["Every table correct at the end", T.truncated ? "not known: the run was cut short" : T.converged ? "yes" : "no"],
        [p.algorithm === "ls" ? "Link lists sent" : "Tables sent", `${T.messages}${T.lost ? `, of which ${T.lost} lost` : ""}`],
        ["Table entries changed", String(updates)],
      ]}
    />
  )
})
