// Words, numbers, charts, tables and settings for the two LAN modes:
// learning switches and the 802.1D spanning tree.
import { memo } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ParamSlider, ParamSwitch } from "../../components/Controls"
import type { Series } from "../../components/LineChart"
import { Tex } from "../../components/Tex"
import {
  bridgeId,
  lanPorts,
  portCounts,
  recoveryMs,
  runSwitch,
  tablesAt,
  viewsAt,
  type BridgeView,
  type StpEvent,
  type StpParams,
  type StpRun,
  type SwitchEvent,
  type SwitchParams,
  type SwitchRun,
} from "../../core/lan"
import { PRESETS, fmtTime } from "../../core/link"
import type { Netsim } from "../../core/netsim"
import { Card, Group, Row, TH, cached, type LinkChart } from "./LinkViews"
import { ROLE_LETTER } from "./lanFigures"

const list = (xs: (string | number)[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)
const us = (t: number) => fmtTime(t, "switch")
const sec = (ms: number) => `${Number((ms / 1000).toFixed(2))} s`

// --- Switches --------------------------------------------------------------

const frameName = (e: { frame: number }) => `frame #${e.frame + 1}`

export function switchText(p: SwitchParams, run: SwitchRun, i: number): string {
  const e: SwitchEvent = run.events[i]
  const name = (k: number) => p.nodes[k].name
  const at = name(e.node)
  const dst = e.dst === null ? "everyone (a broadcast)" : name(e.dst)
  switch (e.what) {
    case "send":
      return `${at} sends ${frameName(e)}, from ${at} to ${dst}. Its only port leads to the network.`
    case "learn":
      return `${at} has not seen ${name(e.src)} before. The frame came in on port ${e.port}, so ${at} records ${name(e.src)} → port ${e.port}, stamped ${us(e.t)}.`
    case "refresh":
      return `${at} already lists ${name(e.src)} on port ${e.port}. It restamps the entry, so the ageing clock starts over.`
    case "move":
      return `${at} had ${name(e.src)} on another port, but this frame came in on port ${e.port}. It overwrites the entry: either the host moved, or the frame came round a loop.`
    case "filter":
      return `${at}'s table puts ${dst} on port ${e.port}, the port the frame came in on. That segment already has the frame, so ${at} discards it (filtering).`
    case "forward":
      return e.out.length
        ? `${at}'s table puts ${dst} on port ${e.out[0]}: it forwards the frame out of that port alone.`
        : `${at}'s table puts ${dst} on a port the spanning tree blocks, so the frame goes no further.`
    case "flood": {
      const why = e.dst === null ? "It is a broadcast" : `${at} has no entry for ${dst}`
      return e.out.length
        ? `${why}: it floods the frame out of port${e.out.length > 1 ? "s" : ""} ${list(e.out)}, every open port except ${e.port}, where it came in.`
        : `${why}, but the only port is the one it came in on, so there is nowhere to flood.`
    }
    case "block":
      return `The frame reaches ${at} on port ${e.port}, which the spanning tree blocks. It is discarded there, and ${at} learns nothing from it.`
    case "age":
      return `${at} has not heard from ${name(e.src)} for the ageing time, ${us(p.aging_us)}. It drops the entry for port ${e.port}; the next frame for ${name(e.src)} will be flooded.`
    case "deliver":
      return `${at} receives ${frameName(e)}${e.dst === null ? ", a broadcast," : ""} and keeps it: it is addressed to ${e.dst === null ? "everyone" : at}.`
    case "ignore":
      return `${at} receives a copy of ${frameName(e)}, meant for ${dst}, and ignores it. Flooding reaches hosts that never needed the frame.`
    case "repeat":
      return `The hub copies the signal out of port${e.out.length > 1 ? "s" : ""} ${list(e.out)}. It learns nothing, so it cannot filter.`
    case "cap":
      return `The run stops at ${e.sent} transmissions: this flood would pass the limit of ${p.max_sends}. With loops and no spanning tree, nothing ever discards a broadcast, and it keeps multiplying.`
  }
}

export const switchWho = (p: SwitchParams, run: SwitchRun, i: number) => {
  const e = run.events[i]
  const n = p.nodes[e.node]
  return `${n.kind} ${n.name}${e.frame < p.frames.length ? `, ${frameName(e)}` : ""}`
}

export const SwitchTotals = memo(function SwitchTotals({ p, run }: { p: SwitchParams; run: SwitchRun }) {
  const count = (w: string) => run.events.filter((e) => e.what === w).length
  const floods = run.events.filter((e) => e.what === "flood")
  return (
    <>
      <Row k="transmissions on links" v={`${run.sent}${run.capped ? " (stopped)" : ""}`} bad={run.capped} />
      <Row
        k="copies delivered"
        v={run.delivered.join(" + ")}
        bad={run.delivered.some((d) => d > 1 && p.frames.some((f) => f.to !== null))}
      />
      <Row k="floods" v={`${floods.length}${floods.length ? `, last at ${us(floods[floods.length - 1].t)}` : ""}`} />
      <Row k="forwarded on one port" v={`${count("forward")}`} />
      <Row k="filtered" v={`${count("filter")}`} />
      <Row k="blocked ports" v={p.stp ? `${run.blocked.length}` : "no spanning tree"} />
    </>
  )
})

export function SwitchEquations({ p, run, index }: { p: SwitchParams; run: SwitchRun; index: number }) {
  // The latest lookup by now, so the rule shows the case that applied.
  const look = run.events
    .slice(0, index + 1)
    .reverse()
    .find((e) => e.what === "filter" || e.what === "forward" || e.what === "flood")
  const ports = lanPorts(p.nodes.length, p.links)
  const name = (k: number) => p.nodes[k].name
  const switches = p.nodes.filter((n) => n.kind === "switch").length
  const cycles = p.links.length - p.nodes.length + 1
  return (
    <Card title="A learning switch: learn where sources are, send each frame only where it is needed">
      <Tex
        display
      >{`\\text{out}(f) = \\begin{cases} \\varnothing & T[\\text{dst}] = p_{\\text{in}} \\quad\\text{(filter)} \\\\ \\{T[\\text{dst}]\\} & T[\\text{dst}] \\ne p_{\\text{in}} \\quad\\text{(forward)} \\\\ P \\setminus \\{p_{\\text{in}}\\} & \\text{dst} \\notin T \\text{ or broadcast} \\quad\\text{(flood)} \\end{cases}`}</Tex>
      {look && (
        <Tex display>{`${name(look.node)}:\\ p_{\\text{in}} = ${look.port},\\ ${
          look.what === "flood"
            ? `\\text{out} = \\{${look.out.join(", ")}\\}${look.dst === null ? "\\ \\text{(broadcast)}" : ""}`
            : look.what === "forward"
              ? `T[\\text{${name(look.dst!)}}] = ${look.out[0] ?? "\\text{blocked}"}`
              : `T[\\text{${name(look.dst!)}}] = ${look.port} = p_{\\text{in}}`
        }\\ \\Rightarrow\\ \\text{${look.what}}`}</Tex>
      )}
      <Tex display>{`\\text{entry dropped once } t - t_{\\text{seen}} \\ge T_{\\text{age}} = ${p.aging_us}\\ \\mu\\text{s}`}</Tex>
      <Tex display>{`\\text{independent loops} = |L| - |N| + 1 = ${p.links.length} - ${p.nodes.length} + 1 = ${cycles}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        {switches} switch{switches === 1 ? "" : "es"} with{" "}
        {ports.filter((_, i) => p.nodes[i].kind === "switch").reduce((a, x) => a + x.length, 0)} ports.{" "}
        {cycles > 0
          ? p.stp
            ? "The spanning tree blocks one port on each loop, so every frame has exactly one path."
            : "With loops and nothing to break them, a flooded frame comes back to switches that have already sent it, and they flood it again."
          : "There are no loops, so every frame has exactly one path."}{" "}
        A hop takes {us(p.hop_us)}; the ageing time is scaled down from 802.1D's default of 300 s so entries expire within the run.
      </p>
    </Card>
  )
}

/** Sends over time for this run and for the same LAN with the spanning tree switched the other way. */
export function switchChart(sim: Netsim, p: SwitchParams, run: SwitchRun): LinkChart {
  const other = { ...p, stp: !p.stp }
  const alt = cached(sim, `sw:${JSON.stringify(other)}`, () => runSwitch(sim, other))
  // Ageing can sit far after the traffic (the storm's long ageing time, say). The axis keeps this run's ageing only when it is
  // close to the traffic, and ignores the other run's.
  const last = (r: SwitchRun, ages: boolean) => Math.max(1, ...r.events.filter((e) => ages || e.what !== "age").map((e) => e.t))
  const own = last(run, true) <= 5 * last(run, false) ? last(run, true) : last(run, false) * 1.1
  const end = Math.max(own, last(alt, false) * 1.1)
  const curve = (r: SwitchRun): [number, number][] => {
    const pts = r.events.filter((e) => e.t <= end).map((e): [number, number] => [e.t, e.sent])
    return [[0, 0], ...pts, [end, pts.length ? pts[pts.length - 1][1] : 0]]
  }
  const label = (on: boolean) => (on ? "with the spanning tree" : "without it")
  const series: Series[] = [
    { id: "now", label: `this run, ${label(p.stp)}`, color: "var(--chart-1)", kind: "step", points: curve(run) },
    { id: "alt", label: label(!p.stp), color: "var(--chart-2)", kind: "step", dashed: true, points: curve(alt) },
  ]
  return {
    title: "Transmissions so far",
    series,
    xLabel: "time (µs)",
    yLabel: "frames sent on links",
    xFormat: (v) => String(Math.round(v)),
    yFormat: (v) => String(Math.round(v)),
    xDomain: [0, end],
    yDomain: [0, Math.max(10, Math.ceil(Math.max(run.sent, alt.sent) * 1.1))],
    refs: [],
    timed: true,
  }
}

/** Each switch's table after the current event. */
export function SwitchTables({ p, run, index }: { p: SwitchParams; run: SwitchRun; index: number }) {
  const tables = tablesAt(p, run, index)
  const t = run.events[Math.min(index, run.events.length - 1)]?.t ?? 0
  const ev = run.events.slice(0, index + 1)
  const lastFlood = ev.filter((e) => e.what === "flood").pop()
  const unicast = p.frames.some((f) => f.to !== null)
  return (
    <div className="space-y-4">
      {p.nodes.map((n, i) =>
        n.kind !== "switch" ? null : (
          <table key={i} className="w-full font-sans text-sm tabular-nums lining">
            <caption className="pb-1 text-left text-xs text-muted-foreground">
              {n.name}'s table at {us(t)}:{" "}
              {tables[i].length ? `${tables[i].length} entr${tables[i].length === 1 ? "y" : "ies"}` : "empty, so it floods every frame"}
            </caption>
            {tables[i].length > 0 && (
              <>
                <thead className="text-xs text-muted-foreground">
                  <tr className="text-right">
                    <th className={cn(TH, "text-left")}>host</th>
                    <th className={TH}>port</th>
                    <th className={TH}>last seen</th>
                    <th className="font-normal">expires</th>
                  </tr>
                </thead>
                <tbody>
                  {tables[i].map((e) => (
                    <tr
                      key={e.mac}
                      className={cn("text-right", run.events[index]?.node === i && run.events[index]?.src === e.mac && "bg-muted/60")}
                    >
                      <td className="pr-2 text-left">{p.nodes[e.mac].name}</td>
                      <td className="pr-2">{e.port}</td>
                      <td className="pr-2">{us(e.at)}</td>
                      <td>{us(e.at + p.aging_us)}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        ),
      )}
      <p className="font-sans text-xs text-muted-foreground">
        {lastFlood
          ? `The latest flood so far was at ${us(lastFlood.t)}, by ${p.nodes[lastFlood.node].name}${
              lastFlood.dst === null ? " (a broadcast, which is always flooded)" : ""
            }.`
          : "No flooding yet."}{" "}
        {unicast
          ? "A switch floods a unicast frame only until it has heard from the destination; once every host has sent once, frames take one path."
          : ""}
      </p>
    </div>
  )
}

const sel = "rounded-sm border border-input bg-background px-1.5 py-1 font-sans text-sm"

export function SwitchSetup({ p, set }: { p: SwitchParams; set(p: SwitchParams): void }) {
  const put = (o: Partial<SwitchParams>) => set({ ...p, ...o })
  const hosts = p.nodes.map((n, i) => ({ n, i })).filter((x) => x.n.kind === "host")
  // The scenario's full set of cables, so a link taken out can be put back in its place.
  const base = PRESETS.find((pr) => pr.params.mode === "switch" && JSON.stringify(pr.params.sw.nodes) === JSON.stringify(p.nodes))
  const all = base && base.params.mode === "switch" ? base.params.sw.links : p.links
  const inner = all.filter((l) => p.nodes[l.a].kind !== "host" && p.nodes[l.b].kind !== "host")
  const has = (l: (typeof all)[number]) => p.links.some((m) => m.a === l.a && m.b === l.b)
  const toggle = (l: (typeof all)[number]) => put({ links: all.filter((m) => (m === l ? !has(l) : has(m))) })
  const putFrame = (k: number, o: Partial<SwitchParams["frames"][number]>) =>
    put({ frames: p.frames.map((f, j) => (j === k ? { ...f, ...o } : f)).sort((a, b) => a.at_us - b.at_us) })
  return (
    <div className="space-y-5">
      <Group legend="The switches">
        <ParamSwitch
          label="Spanning tree"
          name="Block ports with the spanning tree"
          checked={p.stp}
          onChange={(v) => put({ stp: v })}
          on="Ports the spanning tree would block drop data frames"
          off="Every port forwards"
        />
        <ParamSlider
          label="Ageing time"
          value={p.aging_us}
          min={100}
          max={5000}
          step={50}
          format={(v) => us(v)}
          onChange={(v) => put({ aging_us: v })}
        />
        {inner.length > 0 && (
          <fieldset className="space-y-1 font-sans text-sm">
            <legend className="mb-1 text-xs text-muted-foreground">Links between switches and hubs</legend>
            {inner.map((l, k) => (
              <label key={k} className="mr-4 inline-flex items-center gap-1.5">
                <input type="checkbox" checked={has(l)} onChange={() => toggle(l)} />
                {p.nodes[l.a].name}–{p.nodes[l.b].name}
              </label>
            ))}
          </fieldset>
        )}
      </Group>
      <Group legend="Frames">
        {p.frames.map((f, k) => (
          <div key={k} className="flex flex-wrap items-center gap-2 font-sans text-sm">
            <span className="w-16 text-muted-foreground">#{k + 1} at</span>
            <input
              type="number"
              aria-label={`Frame ${k + 1} send time in microseconds`}
              min={0}
              max={5000}
              step={10}
              value={f.at_us}
              onChange={(e) => putFrame(k, { at_us: Math.max(0, Math.min(5000, Math.round(Number(e.target.value) || 0))) })}
              className={cn(sel, "w-20 tabular-nums")}
            />
            <span>µs from</span>
            <select
              aria-label={`Frame ${k + 1} source`}
              className={sel}
              value={f.from}
              onChange={(e) => putFrame(k, { from: Number(e.target.value) })}
            >
              {hosts.map(({ n, i }) => (
                <option key={i} value={i}>
                  {n.name}
                </option>
              ))}
            </select>
            <span>to</span>
            <select
              aria-label={`Frame ${k + 1} destination`}
              className={sel}
              value={f.to ?? "all"}
              onChange={(e) => putFrame(k, { to: e.target.value === "all" ? null : Number(e.target.value) })}
            >
              <option value="all">everyone</option>
              {hosts.map(({ n, i }) => (
                <option key={i} value={i}>
                  {n.name}
                </option>
              ))}
            </select>
            {p.frames.length > 1 && (
              <Button size="xs" variant="ghost" onClick={() => put({ frames: p.frames.filter((_, j) => j !== k) })}>
                Remove
              </Button>
            )}
          </div>
        ))}
        {p.frames.length < 8 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              put({
                frames: [
                  ...p.frames,
                  {
                    at_us: Math.min(5000, (p.frames[p.frames.length - 1]?.at_us ?? 0) + 100),
                    from: hosts[0].i,
                    to: hosts[hosts.length - 1].i,
                  },
                ],
              })
            }
          >
            Add a frame
          </Button>
        )}
      </Group>
    </div>
  )
}

// --- The spanning tree -----------------------------------------------------

const byId = (p: StpParams, id: number) => p.bridges.find((b) => b.id === id)?.name ?? bridgeId(id)
const priority = (id: number) => Math.floor(id / 65536)

export function stpText(p: StpParams, run: StpRun, i: number): string {
  const e: StpEvent = run.events[i]
  const b = p.bridges[e.bridge].name
  const ports = lanPorts(p.bridges.length, p.links)
  const port = e.port
  const peer = port ? p.bridges[ports[e.bridge][port - 1].peer].name : ""
  const cost = port ? p.links[ports[e.bridge][port - 1].link].cost : 0
  const v = e.bpdu?.v
  const claim = v ? `root ${byId(p, v.root)}, cost ${v.cost}, sent by ${byId(p, v.bridge)} port ${v.port}, age ${sec(e.bpdu!.age_ms)}` : ""
  switch (e.what) {
    case "start":
      return `${b} (ID ${bridgeId(p.bridges[e.bridge].id)}) starts up knowing no one else, so it takes itself as root, at cost 0. Each of its ports offers that claim and blocks data while the tree forms.`
    case "hello":
      return `${b} believes it is the root. Every hello time (${sec(p.hello_ms)}) it sends a BPDU with cost 0 out of each designated port.`
    case "send":
      return `${b} sends a BPDU out of port ${port} toward ${peer}: ${claim}.`
    case "receive":
      return `${b} hears on port ${port}, from ${peer}: ${claim}. Through this port the root is ${v!.cost} + ${cost} = ${v!.cost + cost} away. The BPDU replaces what the port heard before and is kept for ${sec(p.max_age_ms - e.bpdu!.age_ms)}.`
    case "lost":
      return `The BPDU for ${b}'s port ${port} is lost: the link to ${peer} is down.`
    case "stale":
      return `A BPDU reaches ${b}'s port ${port} with message age ${sec(e.bpdu!.age_ms)}, at or past the maximum age of ${sec(p.max_age_ms)}. It is discarded, which is what eventually kills news of a root that no longer exists.`
    case "reply":
      return `${b}'s port ${port} is designated and its own offer beats what ${peer} just sent, so it answers at once: ${claim}.`
    case "relay":
      return `${b} passes the root's news down the tree, out of designated port ${port}: ${claim}. The cost is now ${b}'s own, and the age has gone up by a second.`
    case "expire":
      return `What ${b}'s port ${port} last heard is now ${sec(p.max_age_ms)} old with nothing newer, so it is discarded, as if the port had heard nothing. This is how a bridge notices a silent failure.`
    case "roles": {
      const view = e.view!
      const rp = view.root_port
      const roles = view.ports.map((x) => `${x.port} ${x.role}`).join(", ")
      return view.root === p.bridges[e.bridge].id
        ? `${b} recomputes its roles. It still believes it is the root, so every port is designated: ${roles}.`
        : `${b} recomputes. Root ${byId(p, view.root)}, cost ${view.cost}; the cheapest way there is port ${rp}, which becomes the root port. Ports: ${roles}.`
    }
    case "state": {
      const x = e.view!.ports[port! - 1]
      const what: Record<string, string> = {
        listening: `starts listening. Its role allows forwarding, but it waits a forward delay (${sec(p.forward_delay_ms)}) in case the tree is still changing`,
        learning: `moves from listening to learning. It fills the address table from the frames it sees, but still forwards none of them, for another ${sec(p.forward_delay_ms)}`,
        forwarding: "starts forwarding data frames",
        blocking: "blocks. It still hears BPDUs but drops data, which keeps the loop it would close open",
        disabled: "is disabled",
      }
      return `${b}'s port ${port} (${x.role}) ${what[x.state]}.`
    }
    case "fail": {
      const f = p.failure!
      return f.detected
        ? `The link on ${b}'s port ${port} fails. ${b} loses the carrier and notices at once: it disables the port and forgets what it heard there.`
        : `The link on ${b}'s port ${port} fails, but ${b} keeps the carrier and does not notice. BPDUs on it are lost, and only ageing will tell.`
    }
  }
}

export const stpWho = (p: StpParams, run: StpRun, i: number) => {
  const e = run.events[i]
  return `bridge ${p.bridges[e.bridge].name}${e.port ? `, port ${e.port}` : ""}`
}

const agrees = (p: StpParams, run: StpRun, views: BridgeView[]) =>
  views.every(
    (v, i) =>
      v.root === p.bridges[run.direct.root].id &&
      v.ports.every(
        (x, k) =>
          x.role === run.direct.roles[i][k] ||
          (x.role === "disabled" && run.direct.roles[i][k] === "designated") ||
          (x.role === "designated" && run.direct.roles[i][k] === "disabled"),
      ),
  )

export const StpTotals = memo(function StpTotals({ p, run }: { p: StpParams; run: StpRun }) {
  const ph = run.phases
  const end = run.end
  const blocked = end.reduce((a, v) => a + v.ports.filter((x) => x.state === "blocking").length, 0)
  const last = ph[ph.length - 1]
  return (
    <>
      <Row k="root (lowest bridge ID)" v={`${p.bridges[run.direct.root].name}, ${bridgeId(p.bridges[run.direct.root].id)}`} />
      <Row k="BPDUs sent" v={`${run.bpdus}`} />
      <Row k="roles settled" v={ph.map((x) => sec(x.roles_ms)).join(", then ")} />
      <Row k="all ports settled" v={ph.map((x) => sec(x.settled_ms)).join(", then ")} />
      <Row k="ports blocking at the end" v={`${blocked}`} />
      <Row k="matches the direct computation" v={agrees(p, run, end) ? "yes" : "no"} bad={!agrees(p, run, end)} />
      {p.failure && ph.length > 1 && <Row k="outage after the failure" v={sec(last.settled_ms - p.failure.at_ms)} bad />}
    </>
  )
})

export function StpEquations({ p, run, index }: { p: StpParams; run: StpRun; index: number }) {
  const e = run.events[Math.min(index, run.events.length - 1)]
  const b = e?.bridge ?? 0
  const d = run.direct
  const ports = lanPorts(p.bridges.length, p.links)
  const rp = d.root_port[b]
  const name = (i: number) => p.bridges[i].name
  const via = rp ? ports[b][rp - 1] : null
  const f = p.failure
  return (
    <Card title="802.1D: elect a root, take the cheapest path to it, block the rest">
      <Tex
        display
      >{`\\text{root} = \\arg\\min_B \\text{ID}(B) = \\text{${name(d.root)}} = ${texId(p, d.root)},\\quad \\text{ID} = \\text{priority} \\cdot 2^{16} + \\text{MAC}_{\\text{low}}`}</Tex>
      {via && d.cost[b] !== null ? (
        <Tex
          display
        >{`C(\\text{${name(b)}}) = \\min_{p}\\big(C_{\\text{heard on } p} + c_p\\big) = C(\\text{${name(via.peer)}}) + c_{${rp}} = ${d.cost[via.peer]} + ${p.links[via.link].cost} = ${d.cost[b]}`}</Tex>
      ) : (
        <Tex display>{`C(\\text{${name(b)}}) = ${d.cost[b] ?? "\\infty"}${b === d.root ? "\\quad\\text{(the root)}" : ""}`}</Tex>
      )}
      <Tex display>{`\\text{ties: lower cost, then lower sender ID, then lower sender port}`}</Tex>
      <Tex
        display
      >{`\\text{outage} = \\begin{cases} 2 T_{\\text{fwd}} = ${sec(recoveryMs(p, true)).replace(" s", "")}\\ \\text{s} & \\text{failure sensed} \\\\ T_{\\text{max age}} + 2 T_{\\text{fwd}} = ${sec(recoveryMs(p, false)).replace(" s", "")}\\ \\text{s} & \\text{silent failure} \\end{cases}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        Hello {sec(p.hello_ms)}, max age {sec(p.max_age_ms)}, forward delay {sec(p.forward_delay_ms)}, as 802.1D recommends; a BPDU takes{" "}
        {p.delay_ms} ms per link.
        {f
          ? ` The link ${name(p.links[f.link].a)}–${name(p.links[f.link].b)} fails at ${sec(f.at_ms)}, ${f.detected ? "and both ends sense it" : "silently"}.`
          : ""}
      </p>
    </Card>
  )
}

const texId = (p: StpParams, i: number) => {
  const id = p.bridges[i].id
  return `${priority(id)}.\\text{${(id % 65536).toString(16).padStart(4, "0")}}`
}

/** Ports forwarding, blocking and waiting, over time. */
export function stpChart(p: StpParams, run: StpRun): LinkChart {
  const c = portCounts(run)
  const v = [...run.start]
  const waiting = (vs: BridgeView[]) =>
    vs.reduce((a, b) => a + b.ports.filter((x) => x.state === "listening" || x.state === "learning").length, 0)
  const wait: [number, number][] = [[0, waiting(v)]]
  for (const e of run.events) {
    if (!e.view) continue
    v[e.bridge] = e.view
    wait.push([e.t, waiting(v)])
  }
  const end = p.until_ms
  const close = (s: [number, number][]): [number, number][] => [...s, [end, s[s.length - 1][1]]]
  const total = run.start.reduce((a, b) => a + b.ports.length, 0)
  return {
    title: "Ports by state over time",
    series: [
      { id: "fwd", label: "forwarding", color: "var(--chart-3)", kind: "step", points: close(c.forwarding) },
      { id: "wait", label: "listening or learning", color: "var(--chart-4)", kind: "step", points: close(wait) },
      { id: "blk", label: "blocking", color: "var(--destructive)", kind: "step", dashed: true, points: close(c.blocking) },
    ],
    xLabel: "time (s)",
    yLabel: "ports",
    xFormat: (x) => String(Number((x / 1000).toFixed(1))),
    yFormat: (y) => String(Math.round(y)),
    xDomain: [0, end],
    yDomain: [0, total + 1],
    refs: [],
    timed: true,
  }
}

/** Every bridge's view after the current event, beside the direct computation. */
export function StpPorts({ p, run, index }: { p: StpParams; run: StpRun; index: number }) {
  const views = viewsAt(run, index)
  const d = run.direct
  const name = (i: number) => p.bridges[i].name
  const ok = agrees(p, run, views)
  return (
    <div className="space-y-3 overflow-x-auto">
      <table className="w-full font-sans text-sm tabular-nums lining">
        <caption className="pb-1 text-left text-xs text-muted-foreground">
          What each bridge believes now. Ports: R root, D designated, A alternate (blocked), × disabled; the colour of the state follows the
          picture.
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="text-right">
            <th className={cn(TH, "text-left")}>bridge</th>
            <th className={cn(TH, "text-left")}>ID</th>
            <th className={cn(TH, "text-left")}>believes root is</th>
            <th className={TH}>cost</th>
            <th className={cn(TH, "text-left")}>ports</th>
          </tr>
        </thead>
        <tbody>
          {views.map((v, i) => (
            <tr key={i} className={cn("text-right", run.events[index]?.bridge === i && "bg-muted/60")}>
              <td className="pr-2 text-left">{name(i)}</td>
              <td className="pr-2 text-left">{bridgeId(p.bridges[i].id)}</td>
              <td className={cn("pr-2 text-left", v.root !== p.bridges[d.root].id && "text-destructive")}>{byId(p, v.root)}</td>
              <td className="pr-2">{v.cost}</td>
              <td className="text-left">
                {v.ports.map((x) => (
                  <span
                    key={x.port}
                    className={cn(
                      "mr-2",
                      x.state === "blocking" && "text-destructive",
                      x.state === "forwarding" && "text-[var(--chart-3)]",
                      (x.state === "listening" || x.state === "learning") && "text-[var(--chart-4)]",
                    )}
                  >
                    {x.port}:{ROLE_LETTER[x.role]} {x.state}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="font-sans text-sm">
        Direct computation (shortest paths to the lowest ID, ties broken as 802.1D does): root {name(d.root)}; root ports{" "}
        {d.root_port
          .map((r, i) => (r ? `${name(i)}:${r}` : null))
          .filter(Boolean)
          .join(", ")}
        .{" "}
        <span className={ok ? "text-[var(--chart-3)]" : "text-muted-foreground"}>
          {ok ? "The bridges' roles now match it." : "The bridges have not reached it yet."}
        </span>
      </p>
    </div>
  )
}

const PRIORITIES = Array.from({ length: 16 }, (_, i) => i * 4096)
const COSTS = [2, 4, 19, 100]

/** Run length and failure time that leave room for the tree to settle, given the timers. */
function withTimes(s: StpParams): StpParams {
  const at = 2 * s.forward_delay_ms + 10_000
  const failure = s.failure ? { ...s.failure, at_ms: at } : null
  const until = failure ? at + recoveryMs(s, failure.detected) + 20_000 : at
  return { ...s, failure, until_ms: until }
}

export function StpSetup({ p, set }: { p: StpParams; set(p: StpParams): void }) {
  const put = (o: Partial<StpParams>) => set({ ...p, ...o })
  const timed = (o: Partial<StpParams>) => set(withTimes({ ...p, ...o }))
  const name = (i: number) => p.bridges[i].name
  return (
    <div className="space-y-5">
      <Group legend="Bridge priorities (lower wins; the MAC address breaks ties)">
        <div className="grid grid-cols-2 gap-2 font-sans text-sm sm:grid-cols-3">
          {p.bridges.map((b, i) => (
            <label key={i} className="flex items-center gap-2">
              <span className="w-8">{b.name}</span>
              <select
                className={sel}
                value={priority(b.id)}
                onChange={(e) =>
                  put({ bridges: p.bridges.map((x, j) => (j === i ? { ...x, id: Number(e.target.value) * 65536 + (x.id % 65536) } : x)) })
                }
              >
                {PRIORITIES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </Group>
      <Group legend="Link costs (802.1D-1998: 100 for 10 Mb/s, 19 for 100 Mb/s, 4 for 1 Gb/s, 2 for 10 Gb/s)">
        <div className="grid grid-cols-2 gap-2 font-sans text-sm sm:grid-cols-3">
          {p.links.map((l, k) => (
            <label key={k} className="flex items-center gap-2">
              <span className="w-14">
                {name(l.a)}–{name(l.b)}
              </span>
              <select
                className={sel}
                value={l.cost}
                onChange={(e) => put({ links: p.links.map((m, j) => (j === k ? { ...m, cost: Number(e.target.value) } : m)) })}
              >
                {COSTS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </Group>
      <Group legend="A failure">
        <label className="flex flex-wrap items-center gap-2 font-sans text-sm">
          Cut
          <select
            className={sel}
            value={p.failure ? p.failure.link : "none"}
            onChange={(e) =>
              timed({
                failure:
                  e.target.value === "none" ? null : { at_ms: 0, link: Number(e.target.value), detected: p.failure?.detected ?? true },
              })
            }
          >
            <option value="none">no link</option>
            {p.links.map((l, k) => (
              <option key={k} value={k}>
                {name(l.a)}–{name(l.b)}
              </option>
            ))}
          </select>
          once the tree has settled
        </label>
        {p.failure && (
          <ParamSwitch
            label="Sensed"
            name="Both ends sense the failure"
            checked={p.failure.detected}
            onChange={(v) => timed({ failure: { ...p.failure!, detected: v } })}
            on="Both ends lose carrier and react at once"
            off="Silent: only ageing reveals it"
          />
        )}
      </Group>
      <Group legend="Timers">
        <ParamSlider
          label="Hello time"
          value={p.hello_ms}
          min={1000}
          max={10_000}
          step={1000}
          format={sec}
          onChange={(v) => timed({ hello_ms: v })}
        />
        <ParamSlider
          label="Max age"
          value={p.max_age_ms}
          min={6000}
          max={40_000}
          step={1000}
          format={sec}
          onChange={(v) => timed({ max_age_ms: v })}
        />
        <ParamSlider
          label="Forward delay"
          value={p.forward_delay_ms}
          min={4000}
          max={30_000}
          step={1000}
          format={sec}
          onChange={(v) => timed({ forward_delay_ms: v })}
        />
        <p className="font-sans text-xs text-muted-foreground">
          802.1D asks for 2 × (forward delay − 1 s) ≥ max age ≥ 2 × (hello time + 1 s), so that news crosses the LAN before anyone acts on
          it.
        </p>
      </Group>
    </div>
  )
}
