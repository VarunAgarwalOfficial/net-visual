import { memo, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ParamSlider, ParamSwitch } from "../../components/Controls"
import { Tex } from "../../components/Tex"
import { bellmanTerms, clock, maxCost, showDist, type Epoch, type REvent, type RoutingParams, type State } from "../../core/routing"

const name = (p: RoutingParams, i: number) => p.nodes[i]
/** Router names in TeX: single letters stay italic, longer names upright. */
const tn = (p: RoutingParams, i: number) => (p.nodes[i].length === 1 ? p.nodes[i] : `\\text{${p.nodes[i].replace(/[^A-Za-z0-9]/g, "")}}`)
const td = (d: number, inf: number) => (d >= inf ? "\\infty" : String(d))

/**
 * Every router's distance vector at this moment: row x is D_x, column y the
 * destination. Cells that changed at this event are shaded; cells that do
 * not yet agree with Dijkstra on the current network are marked.
 */
export const VectorMatrix = memo(function VectorMatrix({
  p,
  event,
  epoch,
  router,
  dest,
  started,
  picked,
  onPick,
}: {
  p: RoutingParams
  event: REvent
  epoch: Epoch
  router: number
  dest: number
  /** False before the first event: nothing has changed yet, so nothing is shaded. */
  started: boolean
  /** Whether the reader has chosen a router; only then is its row marked. */
  picked: boolean
  onPick(x: number, y: number): void
}) {
  const changed = new Set(started ? event.changed.map(([x, y]) => `${x}-${y}`) : [])
  const wrong = event.dist.flatMap((row, x) => row.filter((d, y) => d !== epoch.shortest[x][y]))
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table
          className="font-sans text-sm tabular-nums lining"
          aria-label="Every router's table: each row is one router's cost to each destination"
        >
          <thead>
            <tr>
              <th className="px-1.5 py-1 text-left text-xs font-normal text-muted-foreground">cost from ↓ to →</th>
              {p.nodes.map((n, y) => (
                <th key={y} scope="col" className={cn("px-1.5 py-1 font-normal", y === dest && "text-link underline underline-offset-4")}>
                  <button className="px-1" onClick={() => onPick(router, y)} aria-label={`Show routes to ${n}`}>
                    {n}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {event.dist.map((row, x) => (
              <tr key={x} className={cn(picked && x === router && "bg-muted/60")}>
                <th scope="row" className="px-1.5 py-1 text-left font-normal">
                  <button className="px-1" onClick={() => onPick(x, dest)} aria-label={`Show router ${name(p, x)}'s table`}>
                    {name(p, x)}
                  </button>
                </th>
                {row.map((d, y) => {
                  const off = d !== epoch.shortest[x][y]
                  const hop = event.hop[x][y]
                  return (
                    <td key={y} className="p-0">
                      <button
                        onClick={() => onPick(x, y)}
                        className={cn(
                          "block w-full min-w-11 rounded-xs px-1.5 py-1 text-center",
                          changed.has(`${x}-${y}`) && "bg-chart-4/30",
                          picked && x === router && y === dest && "ring-2 ring-link",
                          off && "text-destructive",
                        )}
                        aria-label={`D_${name(p, x)}(${name(p, y)}) = ${showDist(d, p.infinity)}${hop >= 0 && hop !== x ? ` via ${name(p, hop)}` : ""}${off ? `; the true cost is ${showDist(epoch.shortest[x][y], p.infinity)}` : ""}`}
                      >
                        {x === y ? "0" : showDist(d, p.infinity)}
                        {hop >= 0 && hop !== x && <span className="ml-0.5 text-[0.7rem] text-muted-foreground">{name(p, hop)}</span>}
                        {off && <span aria-hidden>*</span>}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="max-w-[70ch] font-sans text-xs text-muted-foreground">
        Each row is one router's table: its cost to reach each router named across the top, and in small letters the neighbour it sends
        through. ∞ means it knows no route yet. Shaded cells changed at this event. A red cell with a star is not yet the true cheapest cost
        on the network as it is now
        {wrong.length === 0 ? " (there are none: every table is correct)" : ""}. Select a cell to show that destination on the drawing.
      </p>
    </div>
  )
})

/**
 * The Bellman-Ford equation for one router and destination, with the
 * numbers that router holds right now: its link costs and the last vector
 * each neighbour sent it.
 */
export function BellmanCard({ p, s, event, x, y }: { p: RoutingParams; s: State; event: REvent; x: number; y: number }) {
  if (x === y)
    return (
      <div className="rounded-sm border border-border p-3 font-sans text-sm">
        {name(p, x)} is the destination itself: its cost to itself is 0. Choose another router or destination.
      </div>
    )
  const terms = bellmanTerms(s, p, x, y)
  const best = Math.min(p.infinity, ...terms.map((t) => t.total))
  const hop = event.hop[x][y]
  const X = tn(p, x)
  const Y = tn(p, y)
  const general = `D_{${X}}(${Y}) = \\min_{v} \\{\\, c(${X}, v) + D_v(${Y}) \\,\\}`
  const filled =
    terms.length === 0
      ? `D_{${X}}(${Y}) = \\infty`
      : `D_{${X}}(${Y}) = \\min \\{ ${terms.map((t) => `${t.c} + ${td(t.dv, p.infinity)}`).join(",\\ ")} \\} = ${td(best, p.infinity)}`
  return (
    <div className="space-y-2 rounded-sm border border-border p-3 max-sm:[&_.katex-display]:text-[0.85em]">
      <p className="max-w-[70ch] font-sans text-sm">
        Router {name(p, x)}'s cost to {name(p, y)}, from what it knows now. For each neighbour it adds the cost of the link to that
        neighbour to the cost the neighbour last reported, and keeps the smallest sum. In symbols, D<sub>x</sub>(y) is x's cost to y and
        c(x, v) is the cost of the link from x to its neighbour v; this is the Bellman-Ford equation.
      </p>
      <Tex display>{`\\begin{aligned} ${general.replace(" = ", " &= ")} \\\\ ${filled.replace(/ = /, " &= ")} \\end{aligned}`}</Tex>
      <ul className="space-y-0.5 font-sans text-sm">
        {terms.map((t) => {
          const h = s.heard[x][t.v]
          const m = h?.via[y] ?? null
          const poisoned = m?.poisoned.includes(y)
          // An entry set to infinity after the last message carrying it: the timer expired it.
          const expired = h !== null && m !== null && h.vector[y] >= p.infinity && m.vector[y] < p.infinity
          const left = h !== null && m === null ? " (left out of every update so far, by split horizon)" : null
          return (
            <li key={t.v} className={cn("tabular-nums lining", t.v === hop && best < p.infinity && "font-semibold")}>
              via {name(p, t.v)}: link {t.c} + {name(p, t.v)}'s cost {showDist(t.dv, p.infinity)}
              <span className="font-normal text-muted-foreground">
                {t.v === y
                  ? " (it is the destination)"
                  : m
                    ? expired
                      ? ` (heard as ${showDist(m.vector[y], p.infinity)} at ${clock(m.t_arrive, p)}, then timed out)`
                      : ` (heard at ${clock(m.t_arrive, p)}${poisoned ? `; poisoned, because ${name(p, t.v)} routes to ${name(p, y)} through ${name(p, x)}` : ""}${h?.last !== m && h?.last?.omitted.includes(y) ? `; not repeated since, because split horizon leaves it out` : ""})`
                    : (left ?? " (nothing heard yet)")}
              </span>
              {t.v === hop && best < p.infinity && <span className="font-normal text-muted-foreground">: chosen</span>}
            </li>
          )
        })}
      </ul>
      {best !== event.dist[x][y] && (
        <p className="font-sans text-sm text-destructive">
          The table still says {showDist(event.dist[x][y], p.infinity)}: {name(p, x)} recomputes when the next message arrives.
        </p>
      )}
    </div>
  )
}

/**
 * Link state: router x's map, the newest LSA it holds from each router, set
 * against the network as it really is now. A stale or missing LSA is where
 * x's Dijkstra can go wrong.
 */
export function MapCard({ p, s, event, x, y }: { p: RoutingParams; s: State; event: REvent; x: number; y: number }) {
  const truth = (o: number) => s.cost[o].flatMap((c, v) => (c >= 0 && v !== o ? [`${name(p, v)} ${c}`] : [])).join(", ")
  const rows = p.nodes.map((_, o) => {
    const l = s.db[x][o]
    const held = l ? l.links.map(([v, c]) => `${name(p, v)} ${c}`).join(", ") : null
    return { o, l, held, stale: held !== null && held !== truth(o) }
  })
  const behind = rows.filter((r) => r.held === null || r.stale).length
  const d = event.dist[x][y]
  const hop = event.hop[x][y]
  return (
    <div className="space-y-2 rounded-sm border border-border p-3 font-sans text-sm">
      <p className="max-w-[70ch]">
        Router {name(p, x)}'s map: the newest list of links (LSA) it holds from each router. The number counts the lists that router has
        written; a higher one is newer.
      </p>
      <table className="tabular-nums lining" aria-label={`Router ${name(p, x)}'s link-state database`}>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-0.5 pr-3 font-normal">from</th>
            <th className="py-0.5 pr-3 font-normal">number</th>
            <th className="py-0.5 font-normal">links it lists</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ o, l, held, stale }) => (
            <tr key={o} className={cn(stale && "text-destructive")}>
              <td className="py-0.5 pr-3">{name(p, o)}</td>
              <td className="py-0.5 pr-3">{l ? `#${l.seq}` : "–"}</td>
              <td className="py-0.5">
                {held === null ? <span className="text-muted-foreground">not received yet</span> : held || "none"}
                {stale && <span className="text-xs"> (now really: {truth(o) || "none"})</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {x === y
          ? `Pick another destination to see ${name(p, x)}'s route.`
          : d >= p.infinity
            ? `Dijkstra on this map finds no route to ${name(p, y)}.`
            : `Dijkstra on this map: ${name(p, y)} at cost ${d}, first hop ${name(p, hop)}.`}{" "}
        <span className="text-muted-foreground">
          {behind === 0
            ? "The map matches the network, so the route is right."
            : `${behind} ${behind === 1 ? "entry is" : "entries are"} missing or out of date. A link to another router counts only if that router's LSA lists it too (the two-way check).`}
        </span>
      </p>
    </div>
  )
}

/** Kurose and Ross's table for Dijkstra's algorithm, one row per step, up to step k. */
export function DijkstraTable({
  p,
  epoch,
  source,
  k,
  setK,
  setSource,
}: {
  p: RoutingParams
  epoch: Epoch
  source: number
  k: number
  setK(k: number): void
  setSource(s: number): void
}) {
  const steps = epoch.dijkstra[source]
  const others = p.nodes.map((_, v) => v).filter((v) => v !== source)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 font-sans text-sm">
        <label htmlFor="dij-source">Starting router</label>
        <select
          id="dij-source"
          className="rounded-sm border border-input bg-background px-1 py-0.5"
          value={source}
          onChange={(e) => setSource(Number(e.target.value))}
        >
          {p.nodes.map((n, i) => (
            <option key={i} value={i}>
              {n}
            </option>
          ))}
        </select>
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" disabled={k === 0} onClick={() => setK(k - 1)}>
            Back one step
          </Button>
          <span className="px-1 tabular-nums">
            step {k} of {steps.length - 1}
          </span>
          <Button size="sm" variant="outline" disabled={k >= steps.length - 1} onClick={() => setK(k + 1)}>
            Next step
          </Button>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="font-sans text-sm tabular-nums lining" aria-label="Dijkstra's algorithm, step by step">
          <thead>
            <tr className="text-left">
              <th className="px-1.5 py-1 font-normal text-muted-foreground">step</th>
              <th className="px-1.5 py-1 font-normal text-muted-foreground">N′ (settled)</th>
              {others.map((v) => (
                <th key={v} className="px-1.5 py-1 font-normal whitespace-nowrap">
                  <Tex>{`D(${tn(p, v)}), p(${tn(p, v)})`}</Tex>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {steps.slice(0, k + 1).map((st, j) => {
              const inN = new Set(steps.slice(0, j + 1).map((x) => x.added))
              return (
                <tr key={j} className={cn("border-t border-border", j === k && "bg-chart-4/20")}>
                  <td className="px-1.5 py-1">{j}</td>
                  <td className="px-1.5 py-1 whitespace-nowrap">
                    {steps
                      .slice(0, j + 1)
                      .map((x) => name(p, x.added))
                      .join("")}
                  </td>
                  {others.map((v) => {
                    const settled = inN.has(v) && j > 0 && steps[j].added !== v
                    return (
                      <td key={v} className={cn("px-1.5 py-1 whitespace-nowrap", settled && "text-muted-foreground/50")}>
                        {settled ? "" : st.d[v] >= p.infinity ? "∞" : `${st.d[v]}, ${name(p, st.p[v])}`}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="font-sans text-sm">
        {k === 0
          ? `Step 0: ${name(p, source)} starts with only its own links.`
          : `Step ${k}: ${name(p, steps[k].added)} is the closest router not yet settled, at cost ${steps[k].d[steps[k].added]}, so it is settled; then each of its neighbours is checked for a cheaper path through it.`}{" "}
        <span className="text-muted-foreground">
          N′ is the set of settled routers, whose cheapest cost is final. D(v) is the cheapest cost to v found so far and p(v) the router
          just before v on that path. This is the network as it stands at the current moment. A link-state router computes this table for
          itself after flooding has told it every link.
        </span>
      </p>
    </div>
  )
}

/** What a click on a link offers: its starting cost, and a change scripted at the current moment. */
export function LinkEditor({
  p,
  link,
  now,
  costNow,
  set,
  close,
}: {
  p: RoutingParams
  link: [number, number]
  now: number
  costNow: number | null
  set(p: RoutingParams): void
  close(): void
}) {
  const [a, b] = link
  const index = p.links.findIndex((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))
  const start = index >= 0 ? p.links[index].cost : null
  const [cost, setCost] = useState(costNow ?? start ?? 1)
  const at = Math.max(0, Math.round(now / 100) * 100)
  const top = p.infinity - 1
  const label = `${name(p, a)} to ${name(p, b)}`
  const script = (c: number | null) => set({ ...p, changes: [...p.changes, { at_us: at, a, b, cost: c }] })
  return (
    <div className="space-y-2 rounded-sm border border-link/50 p-3 font-sans text-sm">
      <div className="flex items-center justify-between gap-2">
        <p>
          The link from <b>{label}</b>: {costNow === null ? "failed now" : `cost ${costNow} now`}
          {start !== null && start !== costNow ? `, ${start} at the start` : ""}
        </p>
        <Button size="xs" variant="ghost" onClick={close}>
          Close
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="link-cost">New cost</label>
        <input
          id="link-cost"
          type="number"
          min={1}
          max={top}
          value={cost}
          onChange={(e) => setCost(Math.max(1, Math.min(top, Math.round(Number(e.target.value) || 1))))}
          className="w-16 rounded-sm border border-input bg-background px-1 py-0.5 tabular-nums"
        />
        {index >= 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => set({ ...p, links: p.links.map((l, j) => (j === index ? { ...l, cost } : l)) })}
          >
            Use from the start
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => script(cost)}>
          Change to {cost} at {clock(at, p)}
        </Button>
        {costNow !== null && (
          <Button size="sm" variant="destructive" onClick={() => script(null)}>
            Fail it at {clock(at, p)}
          </Button>
        )}
      </div>
    </div>
  )
}

const ms = (us: number) => `${Number((us / 1000).toFixed(2))} ms`

/** Every parameter of the model. */
export function RoutingSetup({ p, set }: { p: RoutingParams; set(p: RoutingParams): void }) {
  const [na, setNa] = useState(0)
  const [nb, setNb] = useState(1)
  const floor = maxCost(p) + 1
  const pairs = new Set(p.links.map((l) => `${Math.min(l.a, l.b)}-${Math.max(l.a, l.b)}`))
  const canAdd = na !== nb && !pairs.has(`${Math.min(na, nb)}-${Math.max(na, nb)}`) && p.links.length < 45
  const reverse = p.poison ? "poison" : p.split_horizon ? "split" : "none"
  const dv = p.algorithm === "dv"
  return (
    <div className="space-y-5">
      <fieldset className="space-y-1.5 font-sans text-sm">
        <legend className="mb-1 text-xs text-muted-foreground">Algorithm</legend>
        {(
          [
            ["dv", "Distance vector (Bellman-Ford, as RIP): routers trade cost tables with neighbours"],
            ["ls", "Link state (flooding and Dijkstra, as OSPF): every router learns every link"],
          ] as const
        ).map(([v, text]) => (
          <label key={v} className="flex items-start gap-2">
            <input
              type="radio"
              name="routing-algorithm"
              className="mt-1"
              checked={p.algorithm === v}
              onChange={() => set({ ...p, algorithm: v })}
            />
            <span>{text}</span>
          </label>
        ))}
      </fieldset>
      {dv && (
        <fieldset className="space-y-1.5 font-sans text-sm">
          <legend className="mb-1 text-xs text-muted-foreground">Routes through the neighbour being told</legend>
          {(
            [
              ["none", "Sent as they are: every neighbour hears the same vector"],
              ["split", "Split horizon: left out, so the neighbour hears nothing about them"],
              ["poison", "Poisoned reverse: sent as infinity"],
            ] as const
          ).map(([v, text]) => (
            <label key={v} className="flex items-start gap-2">
              <input
                type="radio"
                name="routing-reverse"
                className="mt-1"
                checked={reverse === v}
                onChange={() => set({ ...p, poison: v === "poison", split_horizon: v === "split" })}
              />
              <span>{text}</span>
            </label>
          ))}
        </fieldset>
      )}
      {dv && (
        <fieldset className="space-y-4 rounded-sm border border-border p-3 font-sans text-sm">
          <legend className="px-1 text-xs text-muted-foreground">RIP's timers</legend>
          <ParamSlider
            label="Update period (whole vector to every neighbour)"
            value={p.period_us / 1e6}
            min={0}
            max={60}
            step={1}
            format={(v) => (v === 0 ? "off: updates only when something changes" : `${v} s`)}
            onChange={(v) => {
              const period = v * 1e6
              set({
                ...p,
                period_us: period,
                triggered: period === 0 ? true : p.triggered,
                timeout_us: period === 0 ? 0 : p.timeout_us > period ? p.timeout_us : 6 * period,
                end_us: 0,
              })
            }}
          />
          {p.period_us > 0 && (
            <>
              <ParamSwitch
                label="Triggered updates"
                name="Triggered updates"
                checked={p.triggered}
                onChange={(v) => set({ ...p, triggered: v })}
                on="a router also speaks as soon as its vector changes"
                off="a router speaks only when its timer fires"
              />
              <ParamSlider
                label="Timeout (an entry not repeated this long becomes unreachable)"
                value={p.timeout_us / 1e6}
                min={0}
                max={Math.max(360, p.timeout_us / 1e6)}
                step={10}
                format={(v) => (v === 0 ? "never" : `${v} s`)}
                onChange={(v) => {
                  const t = v * 1e6
                  set({ ...p, timeout_us: t === 0 || t > p.period_us ? t : p.period_us + 1e6 })
                }}
              />
              <ParamSlider
                label="Run until"
                value={p.end_us / 1e6}
                min={0}
                max={Math.max(1200, p.end_us / 1e6)}
                step={10}
                format={(v) => (v === 0 ? "the last change, plus the timeout, plus four periods" : `${v} s`)}
                onChange={(v) => set({ ...p, end_us: v * 1e6 })}
              />
            </>
          )}
        </fieldset>
      )}
      <ParamSlider
        label="Infinity (a cost this large means unreachable)"
        value={p.infinity}
        min={Math.max(2, floor)}
        max={Math.max(200, p.infinity)}
        onChange={(v) => set({ ...p, infinity: v })}
      />
      <ParamSlider
        label="Delay per message"
        value={p.delay_us}
        min={100}
        max={20_000}
        step={100}
        format={ms}
        onChange={(v) => set({ ...p, delay_us: v, jitter_us: Math.min(p.jitter_us, 10 * v) })}
      />
      <ParamSlider
        label="Jitter (extra delay, uniform 0 to J)"
        value={p.jitter_us}
        min={0}
        max={Math.min(10 * p.delay_us, 20_000)}
        step={100}
        format={(v) => (v === 0 ? "none: synchronous rounds" : ms(v))}
        onChange={(v) => set({ ...p, jitter_us: v })}
      />
      <div className="flex items-center justify-between font-sans text-sm">
        <span>
          Seed <span className="text-muted-foreground tabular-nums">{p.seed}</span>
        </span>
        <Button size="sm" variant="outline" onClick={() => set({ ...p, seed: (p.seed * 1103515245 + 12345) % 2147483647 })}>
          New seed
        </Button>
      </div>

      <fieldset className="space-y-2 rounded-sm border border-border p-3 font-sans text-sm">
        <legend className="px-1 text-xs text-muted-foreground">Links and their costs at the start</legend>
        <ul className="space-y-1">
          {p.links.map((l, i) => (
            <li key={i} className="flex items-center gap-2">
              <label htmlFor={`link-${i}`} className="w-20">
                {name(p, l.a)}–{name(p, l.b)}
              </label>
              <input
                id={`link-${i}`}
                type="number"
                min={1}
                max={p.infinity - 1}
                value={l.cost}
                onChange={(e) => {
                  const c = Math.max(1, Math.min(p.infinity - 1, Math.round(Number(e.target.value) || 1)))
                  set({ ...p, links: p.links.map((x, j) => (j === i ? { ...x, cost: c } : x)) })
                }}
                className="w-16 rounded-sm border border-input bg-background px-1 py-0.5 tabular-nums"
              />
              <Button size="xs" variant="ghost" onClick={() => set({ ...p, links: p.links.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span>Add a link</span>
          {[
            [na, setNa],
            [nb, setNb],
          ].map(([v, setV], k) => (
            <select
              key={k}
              aria-label={k === 0 ? "First router" : "Second router"}
              className="rounded-sm border border-input bg-background px-1 py-0.5"
              value={v as number}
              onChange={(e) => (setV as (n: number) => void)(Number(e.target.value))}
            >
              {p.nodes.map((n, i) => (
                <option key={i} value={i}>
                  {n}
                </option>
              ))}
            </select>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={!canAdd}
            onClick={() => set({ ...p, links: [...p.links, { a: na, b: nb, cost: 1 }] })}
          >
            Add, cost 1
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2 rounded-sm border border-border p-3 font-sans text-sm">
        <legend className="px-1 text-xs text-muted-foreground">Scripted changes (click a link in the graph to add one)</legend>
        {p.changes.length === 0 ? (
          <p className="text-muted-foreground">None: the network stays as it starts.</p>
        ) : (
          <ul className="space-y-1">
            {p.changes.map((c, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-24 tabular-nums">at {clock(c.at_us, p)}</span>
                <span>
                  {name(p, c.a)}–{name(p, c.b)} {c.cost === null ? "fails" : `costs ${c.cost}`}
                </span>
                <Button size="xs" variant="ghost" onClick={() => set({ ...p, changes: p.changes.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </div>
  )
}
