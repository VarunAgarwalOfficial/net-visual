// The DNS modes' panels: totals, live equations, the caches at a moment, the
// setup, and each mode's chart.
import { memo } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ParamSlider, ParamSwitch } from "../../components/Controls"
import { Tex, texNum } from "../../components/Tex"
import {
  PER_POINT,
  SWEEP_LT,
  cacheAt,
  fmtUs,
  hitRatio,
  hopSum,
  negativeTtl,
  recordOf,
  streamTtl,
  sweepHits,
  withTtl,
  type DnsClient,
  type DnsParams,
  type DnsRun,
  type HitPoint,
  type RType,
  type WebParams,
  type Zone,
} from "../../core/dns"
import type { Netsim } from "../../core/netsim"
import { Card, Group, Row, TH, cached, type LinkChart } from "../link/LinkViews"
import { focusResolution, outcomeWords } from "./dnsFigures"

const MS = 1000
const S = 1_000_000
const sec = (u: number) => `${Number((u / S).toPrecision(6))} s`
const ms = (u: number) => texNum(u / MS, 1)
/** A duration for the cache table: seconds up to an hour, then hours. */
const dur = (u: number) => (u < 3600 * S ? sec(Math.round(u / 1000) * 1000) : `${(u / 3600 / S).toFixed(2)} h`)
/** Lets a long name break after its dots. */
const wrapName = (n: string) => n.replace(/\./g, ".\u200b")
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Who acted at event i. */
export function dnsWho(run: DnsRun, i: number): string {
  const e = run.events[i]
  if (!e) return ""
  if (e.step === "Z1") return "the zone's owner"
  return cap(run.nodes[e.node] ?? "")
}

/** The resolver-side time of a miss: the server round trips it took. */
const missTime = (p: DnsParams, run: DnsRun) => {
  const done = run.resolutions.filter((r) => r.outcome === "resolved")
  if (!done.length) return 0
  return done.reduce((s, r) => s + hopSum(p, r) - p.clients[r.client].rtt_us, 0) / done.length
}

/** Root, top-level and other servers' queries. */
function serverLoad(p: DnsParams, run: DnsRun) {
  const depth = (z: Zone) => (z.origin === "." ? 0 : z.origin.split(".").length - 1)
  const by = [0, 0, 0]
  p.zones.forEach((z, k) => (by[Math.min(2, depth(z))] += run.stats.server_queries[k] ?? 0))
  return by
}

export const DnsTotals = memo(function DnsTotals({ p, run }: { p: DnsParams; run: DnsRun }) {
  const s = run.stats
  const [root, tld, auth] = serverLoad(p, run)
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-3">
      <Row k="Lookups" v={String(s.queries)} />
      <Row k="Stub hits" v={String(s.stub_hits)} />
      <Row k="Resolver hits" v={`${s.resolver_hits} of ${s.resolver_queries}`} />
      <Row k="Joined in flight" v={String(s.joined)} />
      <Row k="Hit ratio" v={s.resolver_queries ? s.hit_ratio.toFixed(3) : "–"} />
      <Row k="Mean latency" v={s.queries ? fmtUs(s.mean_latency_us) : "–"} />
      <Row k="Root queries" v={String(root)} />
      <Row k="Top-level queries" v={String(tld)} />
      <Row k="Authoritative" v={String(auth)} />
      <Row k="Negative answers" v={String(s.negative_answers)} />
      <Row k="Stale answers" v={String(s.stale)} bad={s.stale > 0} />
      <Row k="Mean miss" v={s.misses ? fmtUs(s.mean_miss_us) : "–"} />
    </dl>
  )
})

/** The latency of the lookup on the ladder as the sum of its hops. */
function LatencyEquation({ p, run, index }: { p: DnsParams; run: DnsRun; index: number }) {
  const r = focusResolution(run, index)
  if (r === null) return null
  const res = run.resolutions[r]
  const c = p.clients[res.client]
  const took = res.done_us - res.at_us
  if (res.outcome === "stub") return <Tex display>{`t_{\\text{lookup}} = 0 \\text{ (the stub's own cache)}`}</Tex>
  if (res.outcome === "joined")
    return (
      <Tex
        display
      >{`t_{\\text{lookup}} = \\text{RTT}_{\\text{${c.name}}} + \\text{rest of the walk in flight} = ${ms(took)}\\text{ ms}`}</Tex>
    )
  const terms = [ms(c.rtt_us), ...res.servers.map((z) => ms(p.zones[z].rtt_us))]
  const asked = res.servers.map((z) => (p.zones[z].origin === "." ? "root" : p.zones[z].origin))
  return (
    <>
      <Tex display>{`t_{\\text{lookup}} = \\text{RTT}_c + \\textstyle\\sum_{z\\,\\in\\,\\text{asked}} \\text{RTT}_z`}</Tex>
      <Tex display>{`= ${terms.join(" + ")} = ${ms(hopSum(p, res))}\\text{ ms}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        {c.name} to the resolver, then {asked.length ? asked.join(", ") : "no server"}; measured {fmtUs(took)}.
      </p>
    </>
  )
}

/** The entry an event inserted or used, counting down at the event's time. */
function EntryEquation({ run, index }: { run: DnsRun; index: number }) {
  const ev = run.events[index]
  if (!ev || ev.entry === null) return null
  const e = run.entries[ev.entry]
  if (!e) return null
  const left = Math.max(0, e.expires_us - ev.t)
  return (
    <>
      <Tex
        display
      >{`\\text{expires} = t_{\\text{in}} + \\text{TTL} = ${texNum(e.from_us / S, 3)} + ${texNum(e.ttl_us / S, 1)} = ${texNum(e.expires_us / S, 3)}\\text{ s}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        {e.name} {e.kind} at {e.cache === run.resolver ? "the resolver" : run.nodes[e.cache]}: {sec(left)} left at {fmtUs(ev.t)}.
      </p>
    </>
  )
}

export function DnsEquations({ w, run, index }: { w: WebParams; run: DnsRun; index: number }) {
  const p = w.dns
  const ev = run.events[index]
  if (w.mode === "resolve") {
    const z = p.zones.find((x) => x.origin === "example.com.") ?? p.zones[p.zones.length - 1]
    return (
      <Card title="Latency is the sum of the round trips taken; each cached set counts down from its TTL">
        <LatencyEquation p={p} run={run} index={index} />
        <EntryEquation run={run} index={index} />
        <Tex display>{`\\text{TTL}_{\\text{neg}} = \\min(\\text{SOA TTL}, \\text{MINIMUM})`}</Tex>
        <Tex display>{`= \\min(${z.soa_ttl_s}, ${z.soa_minimum_s}) = ${negativeTtl(z)}\\text{ s}`}</Tex>
        <p className="font-sans text-xs text-muted-foreground">
          A referral cached on the way down removes its server's term from every later lookup under that zone. The last line is RFC 2308's
          negative TTL for {z.origin}
        </p>
      </Card>
    )
  }
  if (w.mode === "cache") {
    const s = run.stats
    const one = p.poisson && p.poisson.names.length === 1
    const T = streamTtl(p)
    const lam = p.poisson?.rate_per_s ?? 0
    const L = missTime(p, run) / S
    const [root, tld] = serverLoad(p, run)
    return (
      <Card title="Every miss buys a TTL of hits for everyone behind the resolver">
        {one ? (
          <>
            <Tex
              display
            >{`h = \\frac{\\lambda T}{1 + \\lambda T} = \\frac{${texNum(lam * T, 3)}}{${texNum(1 + lam * T, 3)}} = ${texNum(hitRatio(lam, T), 3)}`}</Tex>
            <Tex display>{`h_L = \\frac{\\lambda T}{1 + \\lambda L + \\lambda T} = ${texNum(hitRatio(lam, T, L), 3)}`}</Tex>
            <Tex display>{`h_{\\text{run}} = \\frac{${s.resolver_hits}}{${s.resolver_queries}} = ${texNum(s.hit_ratio, 3)}`}</Tex>
            <p className="font-sans text-xs text-muted-foreground">
              L = {texNum(L * 1000, 1)} ms is this run's mean miss at the resolver. One run of {s.resolver_queries} queries wanders around
              the prediction: the standard deviation of a hit ratio over n cycles is of order 1/√n. The chart's dots use {PER_POINT} queries
              each.
            </p>
          </>
        ) : (
          <>
            <Tex
              display
            >{`\\frac{\\text{root queries}}{\\text{lookups}} = \\frac{${root}}{${s.queries}},\\quad \\frac{\\text{top-level}}{\\text{lookups}} = \\frac{${tld}}{${s.queries}}`}</Tex>
            <p className="font-sans text-sm">{s.joined} queries waited for a lookup already in flight.</p>
            <p className="font-sans text-xs text-muted-foreground">
              An iterating resolver keeps the referrals, so the root hears from it about once per top-level domain per referral TTL. A
              recursive chain forwards every miss through the root.
            </p>
          </>
        )}
        <EntryEquation run={run} index={index} />
      </Card>
    )
  }
  // TTLs and change.
  const ch = p.changes[p.changes.length - 1]
  const t = ev?.t ?? 0
  const held = ch ? cacheAt(run, run.resolver, t).find((x) => x.entry.name === ch.name && x.entry.kind === "A") : undefined
  const stale = held && ch && t >= ch.at_us && !held.entry.values.includes(ch.value)
  return (
    <Card title="A cached copy may disagree with its zone for at most its TTL">
      {ch && (
        <Tex
          display
        >{`t_{\\text{last stale}} < \\max_{f\\,<\\,t_{\\text{change}}} (f + T_f),\\ t_{\\text{change}} = ${texNum(ch.at_us / S, 1)}\\text{ s}`}</Tex>
      )}
      {held ? (
        <Tex
          display
        >{`f + T_f = ${texNum(held.entry.from_us / S, 3)} + ${texNum(held.entry.ttl_us / S, 1)} = ${texNum(held.entry.expires_us / S, 3)}\\text{ s}`}</Tex>
      ) : (
        <p className="font-sans text-sm text-muted-foreground">
          The resolver holds no copy of {ch?.name ?? "the name"} at {fmtUs(t)}.
        </p>
      )}
      <p className={cn("font-sans text-xs", stale ? "text-destructive" : "text-muted-foreground")}>
        {stale
          ? `At ${fmtUs(t)} the resolver's copy (${held!.entry.values.join(", ")}, ${sec(held!.entry.expires_us - t)} left) is stale: the zone now says ${ch!.value}.`
          : held
            ? `The resolver's copy has ${sec(held.entry.expires_us - t)} left. Lowering`
            : "Lowering a TTL takes effect only on copies fetched after the lowering, so it must come at least one old TTL before the change."}
      </p>
    </Card>
  )
}

/** Every cache in the run at time t, with what each entry has left. */
export function DnsCaches({ p, run, t }: { p: DnsParams; run: DnsRun; t: number }) {
  const caches = [run.resolver, ...p.clients.map((c, i) => (c.stub_cache ? i : -1)).filter((i) => i >= 0)]
  return (
    <div className="space-y-4">
      {caches.map((c) => {
        const rows = cacheAt(run, c, t)
        return (
          <div key={c}>
            <p className="mb-1 font-sans text-xs text-muted-foreground">
              {c === run.resolver ? "The recursive resolver" : `${cap(run.nodes[c])}'s stub`} at {fmtUs(t)}: {rows.length} record set
              {rows.length === 1 ? "" : "s"}
            </p>
            {rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full font-sans text-sm tabular-nums">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className={TH}>name</th>
                      <th className={TH}>type</th>
                      <th className={TH}>value</th>
                      <th className={cn(TH, "text-right")}>TTL</th>
                      <th className={cn(TH, "text-right")}>left</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ entry: e, index }) => {
                      const left = e.expires_us - t
                      const neg = e.kind === "NXDOMAIN" || e.kind === "NODATA"
                      return (
                        <tr key={index} className={cn("border-t border-border", neg && "text-destructive")}>
                          <td className="pr-2">{wrapName(e.name)}</td>
                          <td className="pr-2">{e.kind}</td>
                          <td className="pr-2">{neg ? "(none)" : wrapName(e.values.join(", "))}</td>
                          <td className="pr-2 text-right whitespace-nowrap">{dur(e.ttl_us)}</td>
                          <td className={cn("text-right whitespace-nowrap", left < 0.1 * e.ttl_us && "text-destructive")}>{dur(left)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="font-sans text-sm text-muted-foreground">Empty.</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

const sel = "rounded-sm border border-input bg-background px-1.5 py-1 font-sans text-sm"
const TTL_FMT = (v: number) => (v >= 3600 ? `${Number((v / 3600).toPrecision(3))} h` : `${v} s`)

/** The names the zones hold (not the delegations), and a typo to ask for. */
function askable(p: DnsParams): string[] {
  const names = p.zones.flatMap((z) =>
    z.records.filter((r) => r.rtype !== "NS" && !r.name.startsWith("ns1.") && !r.name.includes("servers")).map((r) => r.name),
  )
  return [...new Set([...names, "wwww.example.com."])]
}

export function DnsSetup({ w, set }: { w: WebParams; set(w: WebParams): void }) {
  const p = w.dns
  const put = (o: Partial<DnsParams>) => set({ ...w, dns: { ...p, ...o } })
  const putZone = (k: number, o: Partial<Zone>) => put({ zones: p.zones.map((z, j) => (j === k ? { ...z, ...o } : z)) })
  const putClients = (f: (c: DnsClient) => DnsClient) => put({ clients: p.clients.map(f) })
  const records = p.zones
    .flatMap((z) => z.records.filter((r) => r.rtype !== "NS" && z.origin !== "." && !r.name.startsWith("ns1.")))
    .map((r) => ({ name: r.name, rtype: r.rtype as RType }))
  const referralTtl = recordOf(p.zones, "com.", "NS")?.ttl_s ?? 172_800
  const setReferrals = (ttl: number) =>
    put({
      zones: p.zones.map((z) => (z.origin.split(".").length <= 2 ? { ...z, records: z.records.map((r) => ({ ...r, ttl_s: ttl })) } : z)),
    })
  const names = askable(p)
  const span = Math.max(60, ...p.queries.map((q) => q.at_us / S), ...p.changes.map((c) => c.at_us / S))
  return (
    <div className="space-y-5">
      <Group legend="Resolution">
        <ParamSwitch
          label="Recursive chain"
          name="Servers resolve recursively"
          checked={p.mode === "recursive"}
          onChange={(v) => put({ mode: v ? "recursive" : "iterative" })}
          on="Each server asks the next on the asker's behalf and passes the answer back"
          off="The resolver asks each server in turn and follows the referrals itself"
        />
        <ParamSwitch
          label="Stub caches"
          name="Clients cache answers"
          checked={p.clients.every((c) => c.stub_cache)}
          onChange={(v) => putClients((c) => ({ ...c, stub_cache: v }))}
          on="Each client keeps answers for the TTL the resolver handed down"
          off="Every lookup goes to the resolver"
        />
        <ParamSlider
          label="Client to resolver round trip"
          value={p.clients[0].rtt_us / MS}
          min={1}
          max={100}
          format={(v) => `${v} ms`}
          onChange={(v) => putClients((c) => ({ ...c, rtt_us: v * MS }))}
        />
      </Group>
      <Group legend="Record TTLs">
        {records.map((r) => (
          <ParamSlider
            key={`${r.name} ${r.rtype}`}
            label={`${r.name} ${r.rtype}`}
            value={recordOf(p.zones, r.name, r.rtype)?.ttl_s ?? 0}
            min={1}
            max={86_400}
            log
            format={TTL_FMT}
            onChange={(v) => put({ zones: withTtl(p.zones, r.name, r.rtype, v) })}
          />
        ))}
        <ParamSlider
          label="Referrals and glue from root and top-level servers"
          value={referralTtl}
          min={60}
          max={604_800}
          log
          format={TTL_FMT}
          onChange={setReferrals}
        />
      </Group>
      {p.zones.map((z, k) => (
        <Group key={z.origin} legend={`${z.origin === "." ? "The root" : z.origin} (${z.server})`}>
          <ParamSlider
            label="Round trip from the resolver"
            value={z.rtt_us / MS}
            min={1}
            max={300}
            format={(v) => `${v} ms`}
            onChange={(v) => putZone(k, { rtt_us: v * MS })}
          />
          {z.origin.split(".").length > 2 && (
            <>
              <ParamSlider
                label="SOA record's TTL"
                value={z.soa_ttl_s}
                min={10}
                max={86_400}
                step={10}
                format={TTL_FMT}
                onChange={(v) => putZone(k, { soa_ttl_s: v })}
              />
              <ParamSlider
                label="SOA MINIMUM (negative caching)"
                value={z.soa_minimum_s}
                min={10}
                max={86_400}
                step={10}
                format={TTL_FMT}
                onChange={(v) => putZone(k, { soa_minimum_s: v })}
              />
            </>
          )}
        </Group>
      ))}
      {p.poisson ? (
        <Group legend="Traffic: a Poisson stream from every host together">
          <ParamSlider
            label="Queries a second, all hosts"
            value={p.poisson.rate_per_s}
            min={0.001}
            max={10}
            log
            format={(v) => String(v)}
            onChange={(v) => put({ poisson: { ...p.poisson!, rate_per_s: v } })}
          />
          <ParamSlider
            label="Length"
            value={p.poisson.until_us / S}
            min={60}
            max={7200}
            step={60}
            format={(v) => `${v} s`}
            onChange={(v) => put({ poisson: { ...p.poisson!, until_us: v * S } })}
          />
          <ParamSlider label="Seed" value={p.seed} min={1} max={50} onChange={(v) => put({ seed: v })} />
          <p className="font-sans text-xs text-muted-foreground">Names: {p.poisson.names.join(", ")}</p>
        </Group>
      ) : null}
      <Group legend="Lookups">
        {p.queries.map((q, k) => (
          <div key={k} className="flex flex-wrap items-center gap-2 font-sans text-sm">
            <span className="w-8 text-muted-foreground">#{k + 1}</span>
            <input
              type="number"
              aria-label={`Lookup ${k + 1} time in seconds`}
              min={0}
              max={3600}
              step={1}
              value={q.at_us / S}
              onChange={(e) => {
                const at_us = Math.round(Math.max(0, Math.min(3600, Number(e.target.value) || 0)) * S)
                put({ queries: p.queries.map((x, j) => (j === k ? { ...x, at_us } : x)) })
              }}
              className={cn(sel, "w-20 tabular-nums")}
            />
            <span>s</span>
            <select
              aria-label={`Lookup ${k + 1} client`}
              className={sel}
              value={q.client}
              onChange={(e) => put({ queries: p.queries.map((x, j) => (j === k ? { ...x, client: Number(e.target.value) } : x)) })}
            >
              {p.clients.map((c, i) => (
                <option key={i} value={i}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              aria-label={`Lookup ${k + 1} name`}
              className={sel}
              value={q.name}
              onChange={(e) => put({ queries: p.queries.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })}
            >
              {[...new Set([...names, q.name])].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <Button size="xs" variant="ghost" onClick={() => put({ queries: p.queries.filter((_, j) => j !== k) })}>
              Remove
            </Button>
          </div>
        ))}
        {p.queries.length < 40 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const last = p.queries[p.queries.length - 1]
              const at_us = last ? last.at_us + S : 0
              put({ queries: [...p.queries, { at_us, client: 0, name: names[0] }].sort((a, b) => a.at_us - b.at_us) })
            }}
          >
            Add a lookup
          </Button>
        )}
      </Group>
      {p.changes.length > 0 && (
        <Group legend="The owner's changes">
          {p.changes.map((c, k) => (
            <div key={k} className="space-y-3">
              <p className="font-sans text-sm">
                {c.name} becomes {c.value}
              </p>
              <ParamSlider
                label="At"
                value={c.at_us / S}
                min={0}
                max={Math.ceil(span / 10) * 10}
                step={5}
                format={(v) => `${v} s`}
                onChange={(v) => put({ changes: p.changes.map((x, j) => (j === k ? { ...x, at_us: v * S } : x)) })}
              />
              <ParamSlider
                label="New TTL"
                value={c.ttl_s}
                min={1}
                max={86_400}
                log
                format={TTL_FMT}
                onChange={(v) => put({ changes: p.changes.map((x, j) => (j === k ? { ...x, ttl_s: v } : x)) })}
              />
            </div>
          ))}
        </Group>
      )}
    </div>
  )
}

// --- Charts ------------------------------------------------------------------

const sweep = (sim: Netsim, base: DnsParams): HitPoint[] => {
  const T = streamTtl(base)
  const b = { ...base, trace: false }
  return cached(sim, `dns ${JSON.stringify(b)}`, () =>
    sweepHits(
      sim,
      b,
      SWEEP_LT.map((lt) => lt / T),
      PER_POINT,
    ),
  )
}

function grid(lo: number, hi: number, n: number, log = false): number[] {
  return Array.from({ length: n + 1 }, (_, i) => (log ? lo * (hi / lo) ** (i / n) : lo + ((hi - lo) * i) / n))
}

export function dnsChart(sim: Netsim, w: WebParams, run: DnsRun): LinkChart {
  const p = w.dns
  const endT = Math.max(run.end_us, 1)
  if (w.mode === "cache" && p.poisson && p.poisson.names.length === 1) {
    const T = streamTtl(p)
    const pts = sweep(sim, p)
    const L = pts.length ? pts.reduce((s, x) => s + x.mean_miss_us, 0) / pts.length / S : 0
    const xs = grid(0.05, 20, 80, true)
    const lt = p.poisson.rate_per_s * T
    return {
      title: "Resolver hit ratio against λT",
      series: [
        { id: "f", label: "λT / (1 + λT)", color: "var(--chart-1)", kind: "line", points: xs.map((x) => [Math.log10(x), x / (1 + x)]) },
        {
          id: "fl",
          label: `with the sweep's miss time L = ${texNum(L * 1000, 0)} ms`,
          color: "var(--chart-1)",
          kind: "line",
          dashed: true,
          points: xs.map((x) => [Math.log10(x), hitRatio(x / T, T, L)]),
        },
        {
          id: "sim",
          label: `simulated, ${PER_POINT} queries a point`,
          color: "var(--chart-2)",
          kind: "dots",
          points: pts.map((x) => [Math.log10(x.rate_per_s * T), x.hit_ratio]),
        },
        {
          id: "run",
          label: "this run",
          color: "var(--chart-3)",
          kind: "dots",
          points: [[Math.log10(Math.min(20, Math.max(0.05, lt))), run.stats.hit_ratio]],
        },
      ],
      xLabel: "λT, queries per TTL (log scale)",
      yLabel: "hit ratio",
      xFormat: (v) => String(Number((10 ** v).toPrecision(2))),
      yFormat: (v) => v.toFixed(2),
      xDomain: [Math.log10(0.05), Math.log10(20)],
      yDomain: [0, 1],
      refs: [],
      timed: false,
    }
  }
  if (w.mode === "cache") {
    // Server load over time: a step per query to each level.
    const levels = ["root", "top-level", "authoritative"]
    const depth = (node: number) => {
      const z = p.zones[node - run.resolver - 1]
      return z.origin === "." ? 0 : Math.min(2, z.origin.split(".").length - 1)
    }
    const counts = [0, 0, 0]
    const series = levels.map((l, k) => ({
      id: l,
      label: `${l} servers`,
      color: `var(--chart-${k + 1})`,
      kind: "step" as const,
      points: [[0, 0]] as [number, number][],
    }))
    for (const m of run.messages) {
      if (m.kind !== "query" || m.to <= run.resolver) continue
      const k = depth(m.to)
      counts[k]++
      series[k].points.push([m.arrive_us, counts[k]])
    }
    series.forEach((s, k) => s.points.push([endT, counts[k]]))
    return {
      title: "Queries each level of server has received",
      series,
      xLabel: "time",
      yLabel: "queries",
      xFormat: fmtUs,
      yFormat: (v) => String(Math.round(v)),
      xDomain: [0, endT],
      yDomain: [0, Math.max(1, ...counts) * 1.1],
      refs: [],
      timed: true,
    }
  }
  if (w.mode === "ttl") {
    const ch = p.changes[p.changes.length - 1]
    const name = ch?.name ?? p.queries[0]?.name ?? ""
    const saw: [number, number][] = []
    for (const e of run.entries) {
      if (e.cache !== run.resolver || e.name !== name || e.kind !== "A") continue
      saw.push([e.from_us, 0], [e.from_us, e.ttl_us / S], [e.expires_us, 0])
    }
    const fresh: [number, number][] = []
    const stale: [number, number][] = []
    for (const r of run.resolutions) if (r.name === name) (r.stale ? stale : fresh).push([r.done_us, r.ttl_us / S])
    const top = Math.max(1, ...saw.map((x) => x[1]), ...fresh.map((x) => x[1]), ...stale.map((x) => x[1]))
    return {
      title: `TTL left on ${name} at the resolver, and each answer`,
      series: [
        { id: "saw", label: "resolver's copy", color: "var(--chart-1)", kind: "line", points: saw },
        { id: "fresh", label: "answer, current address", color: "var(--chart-3)", kind: "dots", points: fresh },
        { id: "stale", label: "answer, stale address", color: "var(--destructive)", kind: "dots", points: stale },
      ],
      xLabel: "time",
      yLabel: "TTL left (s)",
      xFormat: fmtUs,
      yFormat: (v) => String(Math.round(v)),
      xDomain: [0, endT],
      yDomain: [0, top * 1.1],
      refs: [],
      timed: true,
    }
  }
  const by = (o: string[]) =>
    run.resolutions.filter((r) => o.includes(r.outcome)).map((r) => [r.at_us, (r.done_us - r.at_us) / MS] as [number, number])
  const all = run.resolutions.map((r) => (r.done_us - r.at_us) / MS)
  return {
    title: "Latency of each lookup",
    series: [
      { id: "res", label: outcomeWords("resolved"), color: "var(--chart-1)", kind: "dots", points: by(["resolved"]) },
      { id: "hit", label: outcomeWords("cache"), color: "var(--chart-2)", kind: "dots", points: by(["cache", "joined"]) },
      { id: "stub", label: outcomeWords("stub"), color: "var(--chart-3)", kind: "dots", points: by(["stub"]) },
    ],
    xLabel: "time asked",
    yLabel: "latency (ms)",
    xFormat: fmtUs,
    yFormat: (v) => String(Math.round(v)),
    xDomain: [0, endT],
    yDomain: [0, Math.max(10, ...all) * 1.15],
    refs: [],
    timed: true,
  }
}
