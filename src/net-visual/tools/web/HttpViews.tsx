// Totals, live equations, setup, the objects table and the charts for the
// HTTP modes of "Naming and the web".
import { memo } from "react"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ParamSlider, ParamSwitch } from "../../components/Controls"
import { Tex, texNum } from "../../components/Tex"
import {
  MS,
  SWEEP_LOSS,
  SWEEP_RTT_MS,
  SWEEP_SEEDS,
  fitsWindow,
  fmtNs,
  nonPersistentFormula,
  persistentFormula,
  progressAt,
  protocolName,
  setupRtts,
  sweepHttp,
  transferNs,
  ttfbFormula,
  txNs,
  type HttpParams,
  type HttpRun,
  type HttpWeb,
  type Protocol,
  type Variant,
} from "../../core/http"
import type { Netsim } from "../../core/netsim"
import { Card, Group, Row, TH, cached, type LinkChart } from "../link/LinkViews"

const ms = (ns: number) => texNum(ns / MS, 3)
const isH1 = (p: HttpParams) => p.protocol === "h10" || p.protocol === "h11"

export const HttpTotals = memo(function HttpTotals({ run }: { run: HttpRun }) {
  const s = run.stats
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-3">
      <Row k="Page load time" v={fmtNs(s.plt_ns)} />
      <Row k="First byte" v={fmtNs(s.ttfb_ns)} />
      <Row k="Setup round trips" v={String(s.setup_rtts)} />
      <Row k="Connections" v={String(s.connections)} />
      <Row k="Data packets" v={String(s.packets)} />
      <Row k="Lost" v={String(s.lost)} bad={s.lost > 0} />
      <Row k="Objects held" v={`${s.held_objects} of ${run.objects.length}`} bad={s.held_objects > 0} />
      <Row k="Time held" v={fmtNs(s.held_ns)} bad={s.held_ns > 0} />
      <Row k="Bytes" v={`${(s.bytes / 1000).toFixed(1)} kB`} />
    </dl>
  )
})

/** The page's first byte from the handshake's round trips. */
function TtfbEquation({ p, run }: { p: HttpParams; run: HttpRun }) {
  const h = setupRtts(p)
  const first = Math.min(p.mss_bytes, p.objects[0].bytes)
  const rtt = p.rtt_us / 1000
  const f = ttfbFormula(p)
  return (
    <>
      <Tex
        display
      >{`t_{\\text{first byte}} = (h + 1)\\,\\text{RTT} + \\frac{L_1}{R} = ${h + 1} \\times ${texNum(rtt, 3)} + ${ms(txNs(first, p.rate_bps))} = ${ms(f)}\\text{ ms}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        h = {h} round trip{h === 1 ? "" : "s"} of setup for {protocolName(p)}; L₁ = {first} bytes is the first packet. This run:{" "}
        {fmtNs(run.stats.ttfb_ns)}
        {p.loss > 0 || p.drops.length ? ", which loss can only delay" : ""}.
      </p>
    </>
  )
}

function ConnectionsEquations({ p, run }: { p: HttpParams; run: HttpRun }) {
  const h = setupRtts(p)
  const n = p.objects.length
  const rtt = p.rtt_us / 1000
  const sum = transferNs(p)
  const bound = (h + (n > 1 ? 2 : 1)) * p.rtt_us * 1000 + sum
  return (
    <>
      {fitsWindow(p) ? (
        <>
          <Tex
            display
          >{`T_{\\text{non-persistent}} = \\sum_{i=1}^{${n}} \\Big((h + 1)\\,\\text{RTT} + \\frac{L_i}{R}\\Big) = ${n} \\times ${texNum((h + 1) * rtt, 3)} + ${ms(sum)} = ${ms(nonPersistentFormula(p))}\\text{ ms}`}</Tex>
          <Tex
            display
          >{`T_{\\text{persistent}} = h\\,\\text{RTT} + \\sum_{i=1}^{${n}} \\Big(\\text{RTT} + \\frac{L_i}{R}\\Big) = ${texNum(h * rtt, 3)} + ${n} \\times ${texNum(rtt, 3)} + ${ms(sum)} = ${ms(persistentFormula(p))}\\text{ ms}`}</Tex>
        </>
      ) : (
        <p className="font-sans text-sm">
          Some objects are larger than the initial window of {p.iw} × {p.mss_bytes} bytes, so slow start adds round trips the textbook
          formulas leave out.
        </p>
      )}
      <Tex
        display
      >{`T \\ge (h + 2)\\,\\text{RTT} + \\sum_i \\frac{L_i}{R} = ${ms(bound)}\\text{ ms};\\quad T_{\\text{run}} = ${ms(run.stats.plt_ns)}\\text{ ms}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        The first two are exact for one connection at a time when every object fits in the initial window. The bound holds for any protocol
        on one reused connection: the setup, a round trip for the base page, one for the rest, and every byte through the bottleneck once.
      </p>
    </>
  )
}

function HolEquations({ p, run, t }: { p: HttpParams; run: HttpRun; t: number }) {
  const { arrived, delivered } = progressAt(run, t)
  const lost = run.packets.findIndex((q) => q.lost && q.retx_of === null)
  const fix = lost >= 0 ? run.packets.find((q) => q.retx_of === lost && q.arrive_ns !== null) : undefined
  const due = lost >= 0 ? run.packets[lost].depart_ns + (p.rtt_us * 1000) / 2 : 0
  // Pipelined responses wait to be sent, not to be delivered: the delay is the
  // time from the request reaching the server to its response starting.
  const rtt = p.rtt_us * 1000
  const waits = run.objects.map((o, i) => ({ i, w: o.first_byte_ns - o.requested_ns - rtt }))
  const worst = p.protocol === "h11" && p.pipelining ? waits.reduce((a, b) => (b.w > a.w ? b : a)) : null
  return (
    <>
      {worst && worst.w > 0 && (
        <Tex
          display
        >{`W_{\text{${run.objects[worst.i].name.replace(/_/g, "\\_")}}} = t_{\text{first byte}} - t_{\text{asked}} - \text{RTT} = ${ms(run.objects[worst.i].first_byte_ns)} - ${ms(run.objects[worst.i].requested_ns)} - ${texNum(p.rtt_us / 1000, 3)} = ${ms(worst.w)}\text{ ms}`}</Tex>
      )}
      <Tex
        display
      >{`H = \\sum_{\\text{packets}} \\big(t_{\\text{delivered}} - t_{\\text{arrived}}\\big) = ${ms(run.stats.held_ns)}\\text{ ms over } ${run.stats.held_objects} \\text{ stream${run.stats.held_objects === 1 ? "" : "s"}}`}</Tex>
      {fix && fix.arrive_ns !== null && (
        <Tex
          display
        >{`\\Delta_{\\text{hole}} = t_{\\text{repair}} - t_{\\text{due}} = ${ms(fix.arrive_ns)} - ${ms(due)} = ${ms(fix.arrive_ns - due)}\\text{ ms} \\approx \\text{RTT} + 3\\,\\tfrac{\\text{MSS}}{R} + \\text{queue}`}</Tex>
      )}
      <table className="w-full font-sans text-sm tabular-nums">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className={TH}>At {fmtNs(t)}</th>
            <th className={TH}>arrived</th>
            <th className={TH}>delivered</th>
            <th className={TH}>held</th>
          </tr>
        </thead>
        <tbody>
          {run.objects.map((o, i) => (
            <tr key={o.name} className={arrived[i] > delivered[i] ? "text-destructive" : undefined}>
              <td className="pr-2 font-mono text-xs">{o.name}</td>
              <td className="pr-2">{(arrived[i] / 1000).toFixed(1)} kB</td>
              <td className="pr-2">{(delivered[i] / 1000).toFixed(1)} kB</td>
              <td className="pr-2">{arrived[i] > delivered[i] ? `${((arrived[i] - delivered[i]) / 1000).toFixed(1)} kB` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {worst && worst.w > 0 && (
        <p className="font-sans text-xs text-muted-foreground">
          W is head-of-line blocking in the application: the server had the request, but its response had to wait on the same connection for
          every response asked for before it. Nothing arrives early, so nothing is held and H can be zero.
        </p>
      )}
      <p className="font-sans text-xs text-muted-foreground">
        A stream is frozen when bytes have arrived that the browser cannot have yet. A hole lasts about a round trip while three later
        packets are acknowledged and the repair crosses the path, plus any queue at the bottleneck ahead of it.
      </p>
    </>
  )
}

const SETUPS: { label: string; p: Pick<HttpParams, "protocol" | "tls" | "zero_rtt"> }[] = [
  { label: "TCP", p: { protocol: "h11", tls: false, zero_rtt: false } },
  { label: "TCP + TLS 1.3", p: { protocol: "h11", tls: true, zero_rtt: false } },
  { label: "TCP + TLS 0-RTT", p: { protocol: "h11", tls: true, zero_rtt: true } },
  { label: "QUIC", p: { protocol: "h3", tls: false, zero_rtt: false } },
  { label: "QUIC 0-RTT", p: { protocol: "h3", tls: false, zero_rtt: true } },
]

function HandshakeEquations({ p, run }: { p: HttpParams; run: HttpRun }) {
  const mine = setupRtts(p)
  const quic = p.protocol === "h3"
  const tx = txNs(Math.min(p.mss_bytes, p.objects[0].bytes), p.rate_bps)
  const lost = run.stats.lost
  return (
    <>
      <table className="w-full font-sans text-sm tabular-nums">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className={TH}>Setup</th>
            <th className={TH}>h</th>
            <th className={TH}>first byte at this RTT</th>
          </tr>
        </thead>
        <tbody>
          {SETUPS.map((x) => {
            const h = setupRtts(x.p)
            const here = (x.p.protocol === "h3") === quic && h === mine && (quic || x.p.tls === p.tls)
            return (
              <tr key={x.label} className={here ? "font-semibold" : undefined}>
                <td className="pr-2">{x.label}</td>
                <td className="pr-2">{h}</td>
                <td className="pr-2">{fmtNs((h + 1) * p.rtt_us * 1000 + tx)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {(p.loss > 0 || p.drops.length > 0) && (
        <Tex
          display
        >{`\\hat p = \\frac{${lost}}{${run.stats.packets}} = ${texNum(lost / Math.max(1, run.stats.packets), 3)}\\quad (p = ${texNum(p.loss, 3)})`}</Tex>
      )}
      <p className="font-sans text-xs text-muted-foreground">
        The table counts round trips before the first request can leave. 0-RTT data can be replayed by an attacker, so servers accept it
        only for requests that are safe to repeat. Retransmissions can be lost too; p̂ counts every data packet, repairs included.
      </p>
    </>
  )
}

export function HttpEquations({ w, run, t }: { w: HttpWeb; run: HttpRun; t: number }) {
  const p = w.http
  const title = {
    connections: "Every connection pays its handshake; every request without pipelining waits a round trip",
    hol: "Bytes that arrived but cannot be delivered are held behind a gap",
    handshake: "Round trips before the first request, and what loss costs",
  }[w.mode]
  return (
    <Card title={title}>
      <TtfbEquation p={p} run={run} />
      {w.mode === "connections" && <ConnectionsEquations p={p} run={run} />}
      {w.mode === "hol" && <HolEquations p={p} run={run} t={t} />}
      {w.mode === "handshake" && <HandshakeEquations p={p} run={run} />}
    </Card>
  )
}

export function HttpObjects({ run }: { run: HttpRun }) {
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full font-sans text-sm tabular-nums">
        <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
          <tr>
            <th className={TH}>Object</th>
            <th className={TH}>Size</th>
            <th className={TH}>Conn.</th>
            <th className={TH}>Asked</th>
            <th className={TH}>First byte</th>
            <th className={TH}>Complete</th>
            <th className={TH}>Held</th>
          </tr>
        </thead>
        <tbody>
          {run.objects.map((o) => (
            <tr key={o.name} className={o.held_ns > 0 ? "text-destructive" : undefined}>
              <td className="pr-2 font-mono text-xs">{o.name}</td>
              <td className="pr-2">{(o.bytes / 1000).toFixed(1)} kB</td>
              <td className="pr-2">{o.conn + 1}</td>
              <td className="pr-2">{fmtNs(o.requested_ns)}</td>
              <td className="pr-2">{fmtNs(o.first_byte_ns)}</td>
              <td className="pr-2">{fmtNs(o.done_ns)}</td>
              <td className="pr-2">{o.held_ns ? fmtNs(o.held_ns) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const PROTOCOLS: { id: Protocol; label: string }[] = [
  { id: "h10", label: "HTTP/1.0" },
  { id: "h11", label: "HTTP/1.1" },
  { id: "h2", label: "HTTP/2" },
  { id: "h3", label: "HTTP/3" },
]

const sel = "w-28 rounded-sm border border-input bg-background px-1.5 py-1 font-mono text-sm"

export function HttpSetup({ w, set }: { w: HttpWeb; set(w: HttpWeb): void }) {
  const p = w.http
  const put = (o: Partial<HttpParams>) => set({ ...w, http: { ...p, ...o } })
  const putObj = (k: number, o: Partial<{ name: string; bytes: number }>) =>
    put({ objects: p.objects.map((x, j) => (j === k ? { ...x, ...o } : x)) })
  return (
    <div className="space-y-5">
      <Group legend="Protocol">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="HTTP version"
          value={p.protocol}
          onValueChange={(v) => v && put({ protocol: v as Protocol })}
          className="flex-wrap"
        >
          {PROTOCOLS.map((x) => (
            <ToggleGroupItem key={x.id} value={x.id} className="px-3">
              {x.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {isH1(p) && (
          <ParamSlider label="Most connections at once" value={p.parallel} min={1} max={8} onChange={(v) => put({ parallel: v })} />
        )}
        {p.protocol === "h11" && (
          <ParamSwitch
            label="Pipelining"
            name="Pipeline requests"
            checked={p.pipelining}
            onChange={(v) => put({ pipelining: v })}
            on="Each connection sends all its requests at once; responses come back in order"
            off="Each connection waits for one response before the next request"
          />
        )}
        {p.protocol !== "h3" && (
          <ParamSwitch
            label="TLS 1.3"
            name="Encrypt with TLS 1.3"
            checked={p.tls}
            onChange={(v) => put({ tls: v, zero_rtt: v && p.zero_rtt })}
            on="One more round trip before the first request"
            off="Plain TCP"
          />
        )}
        {(p.protocol === "h3" || p.tls) && (
          <ParamSwitch
            label="0-RTT resumption"
            name="Resume with 0-RTT"
            checked={p.zero_rtt}
            onChange={(v) => put({ zero_rtt: v })}
            on="The request goes with the first handshake flight; it could be replayed"
            off="A full handshake"
          />
        )}
        {!isH1(p) && (
          <ParamSwitch
            label="Interleave streams"
            name="Interleave streams"
            checked={p.schedule === "interleave"}
            onChange={(v) => put({ schedule: v ? "interleave" : "sequential" })}
            on="One packet from each stream in turn (RFC 9218 incremental)"
            off="Each response to its end before the next"
          />
        )}
      </Group>
      <Group legend="Path">
        <ParamSlider
          label="Round-trip time"
          value={p.rtt_us / 1000}
          min={1}
          max={300}
          format={(v) => `${v} ms`}
          onChange={(v) => put({ rtt_us: v * 1000 })}
        />
        <ParamSlider
          label="Bottleneck rate"
          value={p.rate_bps / 1e6}
          min={1}
          max={100}
          log
          format={(v) => `${v} Mb/s`}
          onChange={(v) => put({ rate_bps: Math.round(v * 1e6) })}
        />
        <ParamSlider label="Initial window" value={p.iw} min={1} max={40} format={(v) => `${v} packets`} onChange={(v) => put({ iw: v })} />
        <ParamSlider
          label="Random loss"
          value={p.loss * 100}
          min={0}
          max={10}
          step={0.5}
          format={(v) => `${v}%`}
          onChange={(v) => put({ loss: v / 100 })}
        />
        <ParamSlider label="Seed" value={p.seed} min={1} max={50} onChange={(v) => put({ seed: v })} />
        <label className="block font-sans text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Lose these data packets (numbered from 0 in sending order)</span>
          <input
            className="w-full rounded-sm border border-input bg-background px-2 py-1 font-mono text-sm"
            defaultValue={p.drops.join(", ")}
            key={p.drops.join(",")}
            onBlur={(e) => {
              const drops = e.target.value
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(Number)
                .filter((x) => Number.isInteger(x) && x >= 0)
                .slice(0, 32)
              put({ drops })
            }}
          />
        </label>
      </Group>
      <Group legend="Page: the base object first, then the objects it names">
        {p.objects.map((o, k) => (
          <div key={k} className="flex flex-wrap items-end gap-2">
            <input
              aria-label={`Name of object ${k + 1}`}
              className={sel}
              defaultValue={o.name}
              key={o.name}
              maxLength={12}
              onBlur={(e) => e.target.value && putObj(k, { name: e.target.value })}
            />
            <div className="min-w-40 flex-1">
              <ParamSlider
                label={k === 0 ? "Base page" : `Object ${k}`}
                value={Math.max(1, Math.round(o.bytes / 1000))}
                min={1}
                max={500}
                log
                format={(v) => `${v} kB`}
                onChange={(v) => putObj(k, { bytes: v * 1000 })}
              />
            </div>
            {k > 0 && (
              <Button size="sm" variant="ghost" onClick={() => put({ objects: p.objects.filter((_, j) => j !== k) })}>
                Remove
              </Button>
            )}
          </div>
        ))}
        {p.objects.length < 24 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => put({ objects: [...p.objects, { name: `obj${p.objects.length}.png`, bytes: 10_000 }] })}
          >
            Add an object
          </Button>
        )}
      </Group>
    </div>
  )
}

// --- Charts ------------------------------------------------------------------

const variant = (protocol: Protocol, parallel: number, tls: boolean, zero_rtt = false): Variant => ({
  protocol,
  parallel,
  pipelining: false,
  tls,
  zero_rtt,
})

function sweep(sim: Netsim, p: HttpParams, variants: Variant[], axis: "loss" | "rtt", values: number[], seeds: number): number[][] {
  const base = { ...p, trace: false, drops: [] }
  return cached(sim, `http ${axis} ${seeds} ${JSON.stringify([base, variants, values])}`, () =>
    sweepHttp(sim, base, variants, axis, values, seeds),
  )
}

// Protocols and objects are told apart by ink or grey and by dash, and each line is named beside it.
const DASHES = [undefined, undefined, "7 3", "7 3", "2 3", "2 3"]
const look = (k: number) => ({ color: k % 2 ? "var(--muted-foreground)" : "var(--foreground)", dash: DASHES[k % DASHES.length] })

export function httpChart(sim: Netsim, w: HttpWeb, run: HttpRun): LinkChart {
  const p = w.http
  if (w.mode === "connections") {
    const vs = [
      variant("h10", 1, p.tls),
      variant("h11", 1, p.tls),
      variant("h10", 6, p.tls),
      variant("h11", 6, p.tls),
      variant("h2", 1, p.tls),
    ]
    const rtts = SWEEP_RTT_MS.map((x) => x * 1000)
    const ys = sweep(sim, p, vs, "rtt", rtts, p.loss > 0 ? SWEEP_SEEDS : 1)
    const series: LinkChart["series"] = vs.map((v, k) => ({
      id: `v${k}`,
      label: protocolName(v),
      ...look(k),
      kind: "line",
      points: SWEEP_RTT_MS.map((x, j) => [x, ys[k][j]] as [number, number]),
    }))
    if (fitsWindow(p) && p.loss === 0) {
      const at = (r: number) => ({ ...p, rtt_us: r * 1000 })
      const xs = [0, ...SWEEP_RTT_MS]
      series.push(
        {
          id: "f0",
          label: "Σ (2 RTT + L/R)",
          color: look(0).color,
          dash: "1 3",
          kind: "line",
          points: xs.map((x) => [x, nonPersistentFormula(at(x)) / MS]),
        },
        {
          id: "f1",
          label: "RTT + Σ (RTT + L/R)",
          color: look(1).color,
          dash: "1 3",
          kind: "line",
          points: xs.map((x) => [x, persistentFormula(at(x)) / MS]),
        },
      )
    }
    series.push({
      id: "run",
      label: "this run",
      color: "var(--foreground)",
      kind: "dots",
      points: [[p.rtt_us / 1000, run.stats.plt_ns / MS]],
    })
    const top = Math.max(...series.flatMap((s) => s.points.map((q) => q[1])))
    return {
      title: "Page load time against round-trip time",
      series,
      xLabel: "round-trip time, ms",
      yLabel: "page load time, ms",
      xFormat: (v) => String(Math.round(v)),
      yFormat: (v) => String(Math.round(v)),
      xDomain: [0, Math.max(300, p.rtt_us / 1000)],
      yDomain: [0, top * 1.05],
      refs: [],
      timed: false,
    }
  }
  if (w.mode === "handshake") {
    const vs = [variant("h11", 6, true), variant("h2", 1, true), variant("h3", 1, false), variant("h3", 1, false, true)]
    const ys = sweep(sim, p, vs, "loss", SWEEP_LOSS, SWEEP_SEEDS)
    const series: LinkChart["series"] = vs.map((v, k) => ({
      id: `v${k}`,
      label: protocolName(v),
      ...look(k),
      kind: "line",
      points: SWEEP_LOSS.map((x, j) => [x * 100, ys[k][j]] as [number, number]),
    }))
    series.push({ id: "run", label: "this run", color: "var(--foreground)", kind: "dots", points: [[p.loss * 100, run.stats.plt_ns / MS]] })
    const top = Math.max(...series.flatMap((s) => s.points.map((q) => q[1])))
    return {
      title: `Page load time against loss rate, mean of ${SWEEP_SEEDS} seeds`,
      series,
      xLabel: "data packets lost, %",
      yLabel: "page load time, ms",
      xFormat: (v) => String(Number(v.toFixed(1))),
      yFormat: (v) => String(Math.round(v)),
      xDomain: [0, Math.max(8, p.loss * 100)],
      yDomain: [0, top * 1.05],
      refs: [],
      timed: false,
    }
  }
  // Head-of-line blocking: each object's share arrived and delivered over time.
  const end = run.stats.plt_ns / MS
  const series: LinkChart["series"] = []
  run.objects.forEach((o, i) => {
    const { color, dash } = look(i)
    const mine = run.packets.filter((q) => q.obj === i && !q.lost)
    const curve = (key: "arrive_ns" | "delivered_ns"): [number, number][] => {
      const ts = mine.map((q) => [q[key]!, q.len] as const).sort((a, b) => a[0] - b[0])
      let sum = 0
      const pts: [number, number][] = [[0, 0]]
      for (const [t, len] of ts) {
        sum += len
        pts.push([t / MS, (100 * sum) / o.bytes])
      }
      pts.push([end, 100])
      return pts
    }
    if (o.held_ns > 0)
      series.push({ id: `a${i}`, label: `${o.name} arrived`, color, dash: "1 3", kind: "step", points: curve("arrive_ns") })
    series.push({
      id: `d${i}`,
      label: o.held_ns > 0 ? `${o.name} delivered` : o.name,
      color,
      dash,
      kind: "step",
      points: curve("delivered_ns"),
    })
  })
  return {
    title: "Share of each object delivered to the browser",
    series,
    xLabel: "time, ms",
    yLabel: "delivered, %",
    xFormat: (v) => String(Math.round(v)),
    yFormat: (v) => String(Math.round(v)),
    xDomain: [0, end * 1.02],
    yDomain: [0, 100],
    refs: [],
    timed: true,
  }
}
