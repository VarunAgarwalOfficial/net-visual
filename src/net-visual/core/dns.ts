// Types and helpers for the DNS model (crates/netsim/src/dns.rs): zones,
// clients and queries in; messages, cache entries and resolutions out. The
// page "Naming and the web" uses it for its naming modes. Erasable TypeScript
// only, so Node can run it in tests.
import type { HttpMode } from "./http.ts"
import type { Netsim } from "./netsim.ts"

export type RType = "A" | "NS" | "CNAME"

export interface DnsRecord {
  name: string
  rtype: RType
  value: string
  ttl_s: number
}

export interface Zone {
  origin: string
  server: string
  rtt_us: number
  records: DnsRecord[]
  soa_ttl_s: number
  soa_minimum_s: number
}

export interface DnsClient {
  name: string
  rtt_us: number
  stub_cache: boolean
}

export interface QuerySpec {
  at_us: number
  client: number
  name: string
}

export interface Poisson {
  rate_per_s: number
  names: string[]
  until_us: number
}

export interface Change {
  at_us: number
  name: string
  value: string
  ttl_s: number
}

export type Resolve = "iterative" | "recursive"

export interface DnsParams {
  mode: Resolve
  zones: Zone[]
  clients: DnsClient[]
  queries: QuerySpec[]
  poisson: Poisson | null
  changes: Change[]
  seed: number
  end_us: number
  trace: boolean
}

export type Kind = "A" | "NS" | "CNAME" | "NXDOMAIN" | "NODATA"

export interface CacheEntry {
  cache: number
  name: string
  kind: Kind
  values: string[]
  ttl_us: number
  from_us: number
  expires_us: number
  res: number
}

export type MsgKind = "query" | "referral" | "answer" | "cname" | "nxdomain" | "nodata"

export interface Msg {
  res: number
  from: number
  to: number
  send_us: number
  arrive_us: number
  kind: MsgKind
  name: string
  records: string[]
}

export interface DnsEvent {
  t: number
  step: string
  what: string
  res: number
  node: number
  msg: number | null
  entry: number | null
  text: string
}

export type Outcome = "stub" | "cache" | "joined" | "resolved"

export interface Resolution {
  client: number
  name: string
  at_us: number
  done_us: number
  outcome: Outcome
  answer: string[]
  negative: boolean
  stale: boolean
  servers: number[]
  resolver_us: number
  ttl_us: number
}

export interface DnsStats {
  queries: number
  stub_hits: number
  resolver_queries: number
  resolver_hits: number
  joined: number
  misses: number
  negative_answers: number
  stale: number
  mean_latency_us: number
  mean_miss_us: number
  server_queries: number[]
  hit_ratio: number
}

export interface DnsRun {
  nodes: string[]
  resolver: number
  events: DnsEvent[]
  messages: Msg[]
  entries: CacheEntry[]
  resolutions: Resolution[]
  stats: DnsStats
  end_us: number
}

export interface HitPoint {
  rate_per_s: number
  queries: number
  hit_ratio: number
  joined: number
  mean_miss_us: number
}

export const runDns = (sim: Netsim, p: DnsParams) => sim.call<DnsRun>("dns", "run", p)
export const sweepHits = (sim: Netsim, base: DnsParams, rates: number[], per_point: number) =>
  sim.call<HitPoint[]>("dns", "hit_sweep", { base, rates, per_point })

// --- The page's modes ----------------------------------------------------

/** The naming modes; the HTTP modes are in core/http.ts. */
export type WebMode = "resolve" | "cache" | "ttl"

/** Every mode on the page, naming first, then HTTP. */
export const MODES: { id: WebMode | HttpMode; title: string; group: "naming" | "http" }[] = [
  { id: "resolve", title: "Looking up a name (DNS, the Domain Name System)", group: "naming" },
  { id: "cache", title: "One shared cache, many devices asking", group: "naming" },
  { id: "ttl", title: "How long a cached answer lasts (TTL, time to live)", group: "naming" },
  { id: "connections", title: "Fetching a web page over HTTP connections", group: "http" },
  { id: "hol", title: "One reply holding up the rest (head-of-line blocking)", group: "http" },
  { id: "handshake", title: "Setting up before the first request, and losses", group: "http" },
]

export interface WebParams {
  mode: WebMode
  dns: DnsParams
}

export const SOURCE: Record<WebMode, { tool: string; file: string }> = {
  resolve: { tool: "dns", file: "dns.rs" },
  cache: { tool: "dns", file: "dns.rs" },
  ttl: { tool: "dns", file: "dns.rs" },
}

/** What each lettered step in the model does, for legends and the trace. */
export const STEPS: Record<string, string> = {
  C1: "stub asks",
  C2: "stub caches",
  R1: "resolver cache",
  R2: "query",
  A1: "server replies",
  A2: "server forwards",
  A3: "server caches",
  R3: "resolver caches",
  R4: "resolver answers",
  E1: "expiry",
  Z1: "owner's change",
}

// --- Theory ----------------------------------------------------------------

/**
 * The resolver's hit ratio for one name asked as a Poisson stream at rate λ
 * with TTL T, when a miss takes L to resolve and queries meanwhile join it:
 * each miss starts a cycle with λL joins, λT hits and then a wait for the
 * next query, so hits over queries is λT / (1 + λL + λT). With L = 0 this is
 * the textbook λT / (1 + λT).
 */
export const hitRatio = (rate: number, ttl_s: number, l_s = 0) => (rate * ttl_s) / (1 + rate * l_s + rate * ttl_s)

/** The latency a resolution should have: the client's round trip plus each server's that it asked. */
export const hopSum = (p: DnsParams, r: Resolution) =>
  r.outcome === "stub" ? 0 : p.clients[r.client].rtt_us + r.servers.reduce((s, z) => s + p.zones[z].rtt_us, 0)

/** The negative-caching TTL of a zone, RFC 2308 Section 5. */
export const negativeTtl = (z: Zone) => Math.min(z.soa_ttl_s, z.soa_minimum_s)

/** Entries a cache holds at time t: arrived, not expired, and not replaced by a newer copy. */
export function cacheAt(run: DnsRun, cache: number, t: number): { entry: CacheEntry; index: number }[] {
  const latest = new Map<string, number>()
  run.entries.forEach((e, i) => {
    if (e.cache !== cache || e.from_us > t || t >= e.expires_us) return
    const key = `${e.name} ${e.kind}`
    const j = latest.get(key)
    if (j === undefined || run.entries[j].from_us <= e.from_us) latest.set(key, i)
  })
  return [...latest.values()].sort((a, b) => a - b).map((index) => ({ entry: run.entries[index], index }))
}

/** The first event at or after time t; the last event if none. */
export function eventAt(run: DnsRun, t: number): number {
  const i = run.events.findIndex((e) => e.t >= t)
  return i < 0 ? Math.max(0, run.events.length - 1) : i
}

/** The resolution an event belongs to; owner's changes belong to none. */
export const resolutionOf = (run: DnsRun, i: number): number | null => {
  const r = run.events[i]?.res
  return r !== undefined && r < run.resolutions.length ? r : null
}

export const zoneOfNode = (run: DnsRun, p: DnsParams, node: number) => (node > run.resolver ? p.zones[node - run.resolver - 1] : null)

/** Formats microseconds as µs, ms or s, keeping four significant figures. */
export function fmtUs(u: number): string {
  if (!Number.isFinite(u)) return "∞"
  if (u === 0) return "0 s"
  const a = Math.abs(u)
  if (a >= 1e6) return `${Number((u / 1e6).toPrecision(a >= 1e9 ? 6 : 5))} s`
  if (a >= 1e3) return `${Number((u / 1e3).toPrecision(4))} ms`
  return `${Number(u.toPrecision(4))} µs`
}

// --- Zone data ---------------------------------------------------------------

const MS = 1000
const S = 1_000_000

const rec = (name: string, rtype: RType, value: string, ttl_s: number): DnsRecord => ({ name, rtype, value, ttl_s })

/**
 * The root, com. and net., example.com. and example.net. Addresses are from
 * the RFC 5737 documentation ranges and names from RFC 2606.
 * shop.example.com. is an alias for a name in example.net., as a site
 * served by a content network would be.
 */
export const ZONES: Zone[] = [
  {
    origin: ".",
    server: "a.root-servers.net.",
    rtt_us: 30 * MS,
    records: [
      rec("com.", "NS", "a.gtld-servers.net.", 172_800),
      rec("a.gtld-servers.net.", "A", "192.0.2.30", 172_800),
      rec("net.", "NS", "b.gtld-servers.net.", 172_800),
      rec("b.gtld-servers.net.", "A", "192.0.2.31", 172_800),
    ],
    soa_ttl_s: 86_400,
    soa_minimum_s: 86_400,
  },
  {
    origin: "com.",
    server: "a.gtld-servers.net.",
    rtt_us: 40 * MS,
    records: [rec("example.com.", "NS", "ns1.example.com.", 172_800), rec("ns1.example.com.", "A", "198.51.100.53", 172_800)],
    soa_ttl_s: 900,
    soa_minimum_s: 86_400,
  },
  {
    origin: "example.com.",
    server: "ns1.example.com.",
    rtt_us: 20 * MS,
    records: [
      rec("example.com.", "NS", "ns1.example.com.", 86_400),
      rec("www.example.com.", "A", "203.0.113.10", 300),
      rec("mail.example.com.", "A", "203.0.113.25", 3600),
      rec("shop.example.com.", "CNAME", "shop.example.net.", 600),
    ],
    soa_ttl_s: 3600,
    soa_minimum_s: 300,
  },
  {
    origin: "net.",
    server: "b.gtld-servers.net.",
    rtt_us: 36 * MS,
    records: [rec("example.net.", "NS", "ns1.example.net.", 172_800), rec("ns1.example.net.", "A", "198.51.100.80", 172_800)],
    soa_ttl_s: 900,
    soa_minimum_s: 86_400,
  },
  {
    origin: "example.net.",
    server: "ns1.example.net.",
    rtt_us: 12 * MS,
    records: [rec("example.net.", "NS", "ns1.example.net.", 86_400), rec("shop.example.net.", "A", "203.0.113.77", 60)],
    soa_ttl_s: 3600,
    soa_minimum_s: 300,
  },
]

/** The zones with one record's TTL changed. */
export function withTtl(zones: Zone[], name: string, rtype: RType, ttl_s: number): Zone[] {
  return zones.map((z) => ({ ...z, records: z.records.map((r) => (r.name === name && r.rtype === rtype ? { ...r, ttl_s } : r)) }))
}

/** The record a name has in the zone data, if any. */
export const recordOf = (zones: Zone[], name: string, rtype: RType) =>
  zones.flatMap((z) => z.records).find((r) => r.name === name && r.rtype === rtype)

export const LAPTOP: DnsClient = { name: "laptop", rtt_us: 10 * MS, stub_cache: false }
export const PHONE: DnsClient = { name: "phone", rtt_us: 24 * MS, stub_cache: false }

const DNS_BASE: DnsParams = {
  mode: "iterative",
  zones: ZONES,
  clients: [LAPTOP, PHONE],
  queries: [],
  poisson: null,
  changes: [],
  seed: 1,
  end_us: 0,
  trace: true,
}

const q = (s: number, name: string, client = 0): QuerySpec => ({ at_us: Math.round(s * S), client, name })
const hosts = (n: number): DnsClient[] =>
  Array.from({ length: n }, (_, i) => ({ name: `host ${i + 1}`, rtt_us: 10 * MS, stub_cache: false }))
const web = (mode: WebMode, p: Partial<DnsParams>): WebParams => ({ mode, dns: { ...DNS_BASE, ...p } })

const WWW = "www.example.com."
const MAIL = "mail.example.com."
const SHOP = "shop.example.com."
const TYPO = "wwww.example.com."
const MOVED = "203.0.113.99"

const every = (from: number, to: number, step: number, name: string) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => q(from + i * step, name, i % 2))

// --- Presets -----------------------------------------------------------------

export interface Preset {
  id: string
  mode: WebMode
  title: string
  source: string
  note: string
  params: WebParams
}

export const PRESETS: Preset[] = [
  {
    id: "cold-warm",
    mode: "resolve",
    title: "Looking a name up twice: first from scratch, then from the cache",
    source: "RFC 1034, Section 5.3.3; Kurose and Ross, Section 2.4",
    note: "A laptop and a phone ask a resolver, a server that looks names up for them and keeps what it learns; it starts empty. The laptop's first lookup of www.example.com. (the final dot stands for the root of all names) walks down from the root servers: 10 ms to the resolver and back, then 30 + 40 + 20 ms to the root, com. and example.com. servers, 100 ms in all. Two seconds later the phone asks for the same name and gets it from the resolver's cache in its own 24 ms round trip. At 4 s mail.example.com. needs only example.com.'s server, because the referral to it is cached: 30 ms.",
    params: web("resolve", { queries: [q(0, WWW), q(2, WWW, 1), q(4, MAIL)] }),
  },
  {
    id: "chain",
    mode: "resolve",
    title: "Each server asks the next (recursive lookup)",
    source: "RFC 1034, Section 4.3.1; Kurose and Ross, Figure 2.20",
    note: "The same three lookups, but each server asks the next on the asker's behalf and passes the answer back, as textbook figures of recursive resolution draw it. The cold total is the same 100 ms, but the resolver never sees the referrals, so mail.example.com. goes through the root and com. again: 100 ms instead of 30 ms, and the root is asked twice instead of once.",
    params: web("resolve", { mode: "recursive", queries: [q(0, WWW), q(2, WWW, 1), q(4, MAIL)] }),
  },
  {
    id: "cname",
    mode: "resolve",
    title: "An alias into another zone",
    source: "RFC 1034, Sections 3.6.2 and 4.3.2",
    note: "shop.example.com. is an alias (a CNAME, canonical name, record) for shop.example.net., as a site served by a content network often is. Cold, the resolver walks to example.com. (90 ms), learns the alias, and walks again from the root to example.net. (30 + 36 + 12 ms): 178 ms with the laptop's 10. A second later the chain is cached: 10 ms. At 70 s the alias (kept for 600 s) is still cached but the network's address (kept for 60 s) is not, so only example.net.'s server is asked: 22 ms.",
    params: web("resolve", { queries: [q(0, SHOP), q(1, SHOP), q(70, SHOP)] }),
  },
  {
    id: "stub",
    mode: "resolve",
    title: "The devices keep their own copies too",
    source: "RFC 1034, Section 5.3.1; RFC 1035, Section 7.4",
    note: "Both devices now keep their own cache in their stub, the small resolver on each device, and www.example.com. may be kept for 30 s, its time to live (TTL). The laptop's second lookup at 10 s is answered by its own stub in no time at all. The phone at 15 s gets the answer from the resolver, with only the time to live that remains, so its copy expires 12 ms after the resolver's: the time the answer took to reach it. At 40 s every copy has gone and the lookup costs 30 ms again.",
    params: web("resolve", {
      zones: withTtl(ZONES, WWW, "A", 30),
      clients: [
        { ...LAPTOP, stub_cache: true },
        { ...PHONE, stub_cache: true },
      ],
      queries: [q(0, WWW), q(10, WWW), q(15, WWW, 1), q(40, WWW)],
      end_us: 45 * S,
    }),
  },
  {
    id: "nxdomain",
    mode: "resolve",
    title: "A name that does not exist",
    source: "RFC 2308, Sections 3 and 5",
    note: "Someone types wwww.example.com. The example.com. server replies that no such name exists (NXDOMAIN) and attaches its zone's start-of-authority (SOA) record, which may be kept for 3600 s and whose MINIMUM field says 300 s. The resolver caches the denial for the smaller, 300 s, so the phone's repeat at 60 s costs only its round trip. At 400 s the denial has expired and the server is asked again.",
    params: web("resolve", { queries: [q(0, TYPO), q(60, TYPO, 1), q(400, TYPO)] }),
  },
  {
    id: "hit-ratio",
    mode: "cache",
    title: "One name, many clients",
    source: "Jung, Berger and Balakrishnan 2003; renewal argument in the article",
    note: "Eight hosts behind one resolver ask for www.example.com. (kept for 60 s here) at random moments, 0.05 queries a second in all, so 3 queries arrive on average while one answer is cached. After each miss the name stays cached, every query in that time hits, and the first query after expiry misses again: about 3 hits for each miss, so three quarters of lookups are answered from the cache. Forty minutes is about 120 queries, so the run's own ratio wanders; the sweep below uses 5000 queries a point.",
    params: web("cache", {
      zones: withTtl(ZONES, WWW, "A", 60),
      clients: hosts(8),
      poisson: { rate_per_s: 0.05, names: [WWW], until_us: 2400 * S },
    }),
  },
  {
    id: "root-load",
    mode: "cache",
    title: "What the root servers see",
    source: "RFC 1034, Section 5.3.3; RFC 7816",
    note: "Four names, one a typo, asked at 0.5 a second for ten minutes. Iterating, the resolver caches the referrals to com. and net. for two days, so the root is asked only twice, once for each top-level domain, however many lookups follow. Switch to recursive and the root hears every miss the resolver has: 15 queries in the same ten minutes, most of them for the content network's address, whose TTL is only 60 s.",
    params: web("cache", {
      clients: hosts(4),
      poisson: { rate_per_s: 0.5, names: [WWW, MAIL, SHOP, TYPO], until_us: 600 * S },
    }),
  },
  {
    id: "burst",
    mode: "cache",
    title: "A burst for a cold name",
    source: "RFC 5452, Section 5 (one query in flight per question)",
    note: "Eight hosts ask for www.example.com. within 70 ms of each other while the resolver is cold. The first query starts a 90 ms walk from the root; the others arrive while it is in flight and wait for the same answer instead of starting walks of their own, so the servers see three queries, not twenty-four.",
    params: web("cache", { clients: hosts(8), queries: Array.from({ length: 8 }, (_, i) => q(i * 0.01, WWW, i)) }),
  },
  {
    id: "ttl-change",
    mode: "ttl",
    title: "The address moves",
    source: "RFC 1034, Section 3.6; RFC 1035, Section 3.2.1",
    note: "www.example.com. moves to 203.0.113.99 at 100 s. The resolver cached the old address at 0.095 s for its time to live (TTL) of 300 s and keeps serving it, correctly by the rules, until 300.095 s: every lookup from 120 s to 300 s gets the old address. Changing the zone does not reach into caches; only the TTL bounds how long they may disagree.",
    params: web("ttl", {
      queries: every(0, 450, 30, WWW),
      changes: [{ at_us: 100 * S, name: WWW, value: MOVED, ttl_s: 60 }],
    }),
  },
  {
    id: "lower-first",
    mode: "ttl",
    title: "Shorten the time to live (TTL) before moving",
    source: "Operators' practice; RFC 1034, Section 3.6",
    note: "The move is at 400 s, and at 50 s the owner lowers the TTL to 30 s without changing the address. The copy cached at 0.095 s still carries the old 300 s promise, but after it expires at 300.095 s every copy lasts at most 30 s, so at most one stale answer is served after the move instead of a stream of them. Lowering must come at least one old TTL before the change.",
    params: web("ttl", {
      queries: every(0, 600, 30, WWW),
      changes: [
        { at_us: 50 * S, name: WWW, value: "203.0.113.10", ttl_s: 30 },
        { at_us: 400 * S, name: WWW, value: MOVED, ttl_s: 30 },
      ],
    }),
  },
]

export const presetFor = (mode: WebMode) => PRESETS.find((p) => p.mode === mode) ?? PRESETS[0]

// --- Tour --------------------------------------------------------------------

export interface TourStep {
  preset: string
  /** The moment to show, in µs: the page selects the first event at or after it. */
  at: number
  /** The step letter of that event. */
  step: string
  text: string
}

export const TOUR: TourStep[] = [
  {
    preset: "cold-warm",
    at: 0,
    step: "C1",
    text: "An application on the laptop wants www.example.com. Its stub resolver does no work of its own: it sends the question to the recursive resolver, here 5 ms away. Time runs down the ladder; each column is a machine.",
  },
  {
    preset: "cold-warm",
    at: 20 * MS,
    step: "A1",
    text: "The resolver's cache is empty, so it asks a root server. The root does not know the address, but it knows who serves com.: it replies with a referral, an NS record naming the com. server and a glue A record giving that server's address.",
  },
  {
    preset: "cold-warm",
    at: 35 * MS,
    step: "R3",
    text: "The resolver caches the referral for its TTL, two days, and asks the server it names. Every later name under com. can skip the root.",
  },
  {
    preset: "cold-warm",
    at: 95 * MS,
    step: "R3",
    text: "example.com.'s server is authoritative and answers: 203.0.113.10, TTL 300 s. The resolver caches it; the list of caches under Go deeper shows each entry counting down. The laptop has its answer at 100 ms, the sum of the four round trips.",
  },
  {
    preset: "cold-warm",
    at: 2012 * MS,
    step: "R1",
    text: "The phone asks for the same name two seconds later. The resolver has it, with 298 s of TTL left, and answers at once: the phone waits only for its own 24 ms round trip.",
  },
  {
    preset: "cold-warm",
    at: 4005 * MS,
    step: "R2",
    text: "A different name in the same zone: the resolver goes straight to example.com.'s server, because the referral to it is cached. Caching referrals is what keeps the root and the top-level servers out of most lookups.",
  },
  {
    preset: "chain",
    at: 4005 * MS,
    step: "R2",
    text: "In a recursive chain the resolver asks the root, the root asks com., and com. asks example.com. The resolver never sees the referrals, so the second name goes through the root again. Real root and top-level servers refuse to work this way, for exactly this load.",
  },
  {
    preset: "cname",
    at: 95 * MS,
    step: "R3",
    text: "example.com. answers with a CNAME: shop.example.com. is an alias for shop.example.net. That name is in another zone, so the resolver starts again for it, from the closest servers it knows; here, the root.",
  },
  {
    preset: "stub",
    at: 10 * S,
    step: "C1",
    text: "With a stub cache the laptop answers its own repeat lookup without sending anything. The copy it holds expires when the resolver's does, plus the 5 ms the answer took to arrive, because the resolver handed down only the TTL that remained.",
  },
  {
    preset: "nxdomain",
    at: 95 * MS,
    step: "R3",
    text: "The name does not exist. The server says so with NXDOMAIN and its zone's SOA record, and the resolver caches the denial for min(SOA TTL, MINIMUM) = min(3600, 300) = 300 s (RFC 2308).",
  },
  {
    preset: "burst",
    at: 15 * MS,
    step: "R1",
    text: "A second host asks while the first lookup is still walking down from the root. The resolver does not start another walk; the query waits for the answer already on its way.",
  },
  {
    preset: "hit-ratio",
    at: 0,
    step: "C1",
    text: "Eight hosts share one resolver. Each miss buys T seconds in which every query for the name hits; the formulas under Go deeper compare the run's hit ratio with λT / (1 + λT), where λ is queries a second and T the time to live, and the chart sweeps λT with 5000 queries a point.",
  },
  {
    preset: "ttl-change",
    at: 100 * S,
    step: "Z1",
    text: "The owner changes the address. Nothing tells the caches: until the old record's TTL runs out, the resolver keeps answering with the old address. Stale answers are drawn in red.",
  },
  {
    preset: "lower-first",
    at: 50 * S,
    step: "Z1",
    text: "The careful way to move: lower the TTL well ahead, wait out the old TTL, then change the address. The stale window shrinks to the new, short TTL.",
  },
]

// --- Labs --------------------------------------------------------------------

export interface LabTask {
  id: string
  difficulty: 1 | 2 | 3
  title: string
  task: string
  hint: string
  start: WebParams
  check(p: WebParams, run: DnsRun): { ok: boolean; message: string }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const preset = (id: string) => PRESETS.find((p) => p.id === id)!.params

export const LABS: LabTask[] = [
  {
    id: "warm-mail",
    difficulty: 1,
    title: "Warm the cache for a name you have not asked",
    task: "The laptop looks up mail.example.com. at 5 s with a cold resolver, which takes 100 ms. Add one query for a different name, earlier, so that the lookup at 5 s takes 30 ms.",
    hint: "What does the resolver keep from a lookup besides the answer? Any name it must ask example.com.'s server for will do; the settings under Go deeper add queries.",
    start: web("resolve", { queries: [q(5, MAIL)] }),
    check(p, run) {
      const others = p.dns.queries.filter((x) => x.name !== MAIL)
      const mail = run.resolutions.find((r) => r.name === MAIL && r.at_us === 5 * S)
      if (p.dns.queries.length !== 2 || others.length !== 1 || !mail)
        return { ok: false, message: "Keep the mail lookup at 5 s and add exactly one query for another name." }
      const ms = (mail.done_us - mail.at_us) / MS
      return ms === 30
        ? { ok: true, message: `30 ms: the earlier lookup of ${others[0].name} left the referral to example.com. in the cache.` }
        : { ok: false, message: `The mail lookup takes ${ms} ms. Which servers does it still ask?` }
    },
  },
  {
    id: "half-hits",
    difficulty: 2,
    title: "A hit ratio of one half",
    task: "Queries for www.example.com. reach the resolver at 0.05 a second. Change only the record's TTL so that the predicted hit ratio is 0.5, within 0.02.",
    hint: "The hit ratio is λT / (1 + λT). For which λT is that one half? Then T follows from λ.",
    start: preset("hit-ratio"),
    check(p) {
      const ttl = recordOf(p.dns.zones, WWW, "A")?.ttl_s ?? 0
      const base = preset("hit-ratio").dns
      if (!same({ ...p.dns, zones: withTtl(p.dns.zones, WWW, "A", 60) }, base))
        return { ok: false, message: "Change only the TTL of www.example.com." }
      const h = hitRatio(0.05, ttl)
      return Math.abs(h - 0.5) <= 0.02
        ? { ok: true, message: `T = ${ttl} s gives λT = ${(0.05 * ttl).toFixed(2)} and a hit ratio of ${h.toFixed(3)}.` }
        : { ok: false, message: `T = ${ttl} s predicts ${h.toFixed(3)}.` }
    },
  },
  {
    id: "typo-minute",
    difficulty: 2,
    title: "Cache the typo for a minute",
    task: "Make the resolver keep the denial of wwww.example.com. for exactly 60 s, without changing the TTL of example.com.'s SOA record itself (3600 s).",
    hint: "RFC 2308 Section 5 takes the smaller of two SOA fields. Which one can you lower? Look in the settings under Go deeper, under example.com.",
    start: preset("nxdomain"),
    check(p, run) {
      const z = p.dns.zones.find((x) => x.origin === "example.com.")
      if (!z || z.soa_ttl_s !== 3600) return { ok: false, message: "Leave the SOA record's TTL at 3600 s." }
      const neg = run.entries.find((e) => e.cache === run.resolver && e.kind === "NXDOMAIN")
      if (!neg) return { ok: false, message: "No denial was cached; keep the typo lookup." }
      return neg.ttl_us === 60 * S
        ? { ok: true, message: "MINIMUM = 60 s: the denial is cached for min(3600, 60) = 60 s." }
        : { ok: false, message: `The denial is cached for ${neg.ttl_us / S} s.` }
    },
  },
  {
    id: "lower-in-time",
    difficulty: 3,
    title: "Lower the TTL early enough",
    task: "The owner lowers the TTL of www.example.com. to 30 s at 350 s and moves the address at 400 s, yet stale answers keep coming after the move. Change only when the TTL is lowered so that at most one stale answer is served.",
    hint: "A copy fetched before the lowering still carries the old 300 s promise. When does the resolver fetch the copy it holds at 400 s? The lowering has to reach the zone before that fetch.",
    start: {
      ...preset("lower-first"),
      dns: {
        ...preset("lower-first").dns,
        changes: [
          { at_us: 350 * S, name: WWW, value: "203.0.113.10", ttl_s: 30 },
          { at_us: 400 * S, name: WWW, value: MOVED, ttl_s: 30 },
        ],
      },
    },
    check(p, run) {
      const [low, move] = p.dns.changes
      const okShape =
        p.dns.changes.length === 2 &&
        low.value === "203.0.113.10" &&
        low.ttl_s === 30 &&
        same(move, { at_us: 400 * S, name: WWW, value: MOVED, ttl_s: 30 }) &&
        same(p.dns.queries, preset("lower-first").dns.queries)
      if (!okShape) return { ok: false, message: "Move only the time of the first change; keep the move at 400 s." }
      const stale = run.stats.stale
      return stale <= 1
        ? { ok: true, message: `Lowered at ${fmtUs(low.at_us)}: ${stale} stale answer${stale === 1 ? "" : "s"} after the move.` }
        : { ok: false, message: `${stale} stale answers. Which fetch gave the resolver the copy it holds at the move?` }
    },
  },
]

// --- Sweep -------------------------------------------------------------------

/** The λT values the shared-cache sweep runs, and the queries per point. */
export const SWEEP_LT = [0.1, 0.2, 0.5, 1, 2, 3, 5, 10]
export const PER_POINT = 5000

/** The TTL of the first name in a Poisson stream, which the sweep's λT is measured against. */
export const streamTtl = (p: DnsParams) => recordOf(p.zones, p.poisson?.names[0] ?? "", "A")?.ttl_s ?? 0
