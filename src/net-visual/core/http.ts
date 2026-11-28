// Loading a page over HTTP/1.0, HTTP/1.1, HTTP/2 and HTTP/3: the types of
// crates/netsim/src/http.rs, the page's HTTP modes, presets, tour and labs.

import type { Netsim } from "./netsim.ts"

export type Protocol = "h10" | "h11" | "h2" | "h3"
export type Schedule = "interleave" | "sequential"

export interface HttpObject {
  name: string
  bytes: number
}

export interface HttpParams {
  protocol: Protocol
  parallel: number
  pipelining: boolean
  tls: boolean
  zero_rtt: boolean
  schedule: Schedule
  objects: HttpObject[]
  rtt_us: number
  rate_bps: number
  mss_bytes: number
  iw: number
  loss: number
  drops: number[]
  seed: number
  trace: boolean
}

export interface HttpConn {
  quic: boolean
  opened_ns: number
  ready_ns: number
  closed_ns: number
  objects: number[]
}

export interface HttpMsg {
  conn: number
  up: boolean
  send_ns: number
  arrive_ns: number
  label: string
  request: boolean
}

export interface HttpPacket {
  conn: number
  num: number
  seq: number
  obj: number
  offset: number
  len: number
  start_ns: number
  depart_ns: number
  arrive_ns: number | null
  lost: boolean
  retx_of: number | null
  detected_ns: number | null
  detected_by: "threshold" | "timer" | null
  delivered_ns: number | null
}

export interface HttpObjResult {
  name: string
  bytes: number
  conn: number
  requested_ns: number
  first_byte_ns: number
  done_ns: number
  held_ns: number
  held_packets: number
}

export interface HttpEvent {
  t: number
  step: string
  conn: number | null
  obj: number | null
  pkt: number | null
  text: string
}

export interface HttpStats {
  plt_ns: number
  ttfb_ns: number
  setup_rtts: number
  connections: number
  packets: number
  lost: number
  bytes: number
  held_objects: number
  held_ns: number
}

export interface HttpRun {
  conns: HttpConn[]
  msgs: HttpMsg[]
  packets: HttpPacket[]
  objects: HttpObjResult[]
  events: HttpEvent[]
  stats: HttpStats
}

export interface Variant {
  protocol: Protocol
  parallel: number
  pipelining: boolean
  tls: boolean
  zero_rtt: boolean
}

export type Axis = "loss" | "rtt"

export const runHttp = (sim: Netsim, p: HttpParams) => sim.call<HttpRun>("http", "run", p)
/** Mean page load time in ms, one row per variant, one column per value. */
export const sweepHttp = (sim: Netsim, base: HttpParams, variants: Variant[], axis: Axis, values: number[], seeds: number) =>
  sim.call<number[][]>("http", "sweep", { base, variants, axis, values, seeds })

// --- Modes -------------------------------------------------------------------

export type HttpMode = "connections" | "hol" | "handshake"

export const HTTP_MODES: HttpMode[] = ["connections", "hol", "handshake"]
export const isHttpMode = (m: string): m is HttpMode => (HTTP_MODES as string[]).includes(m)

export interface HttpWeb {
  mode: HttpMode
  http: HttpParams
}

/** What each lettered step in the model does. */
export const HTTP_STEPS: Record<string, string> = {
  C1: "open a connection",
  C2: "ask",
  S1: "queue the responses",
  S2: "send",
  R1: "receive",
  A1: "acknowledged",
  L1: "declare lost",
  O1: "object complete",
  P1: "page complete",
}

// --- Theory ------------------------------------------------------------------

export const NS = 1
export const US = 1000
export const MS = 1_000_000

/** Round trips before a connection's first request can leave. */
export const setupRtts = (p: Pick<HttpParams, "protocol" | "tls" | "zero_rtt">) =>
  p.protocol === "h3" ? (p.zero_rtt ? 0 : 1) : 1 + (p.tls && !p.zero_rtt ? 1 : 0)

/** Transmission time in ns; exact at rates that divide 8e9. */
export const txNs = (bytes: number, rate: number) => Math.floor((bytes * 8e9) / rate)

/** Time to the base page's first byte with no loss: setup, one round trip for the request, one packet. */
export const ttfbFormula = (p: HttpParams) =>
  (setupRtts(p) + 1) * p.rtt_us * US + txNs(Math.min(p.mss_bytes, p.objects[0].bytes), p.rate_bps)

/** Whether every object fits in the initial window, so that slow start never costs a round trip. */
export const fitsWindow = (p: HttpParams) => p.objects.every((o) => o.bytes <= p.iw * p.mss_bytes)

/** Non-persistent, one connection at a time: Σ (2 RTT + Lᵢ/R), handshake round trips per object as set. */
export const nonPersistentFormula = (p: HttpParams) =>
  p.objects.reduce((s, o) => s + (setupRtts(p) + 1) * p.rtt_us * US + txNs(o.bytes, p.rate_bps), 0)

/** Persistent without pipelining: one handshake, then RTT + Lᵢ/R per object. */
export const persistentFormula = (p: HttpParams) =>
  setupRtts(p) * p.rtt_us * US + p.objects.reduce((s, o) => s + p.rtt_us * US + txNs(o.bytes, p.rate_bps), 0)

/** The total transmission time of the page at the bottleneck: no protocol can beat this plus the round trips. */
export const transferNs = (p: HttpParams) => p.objects.reduce((s, o) => s + txNs(o.bytes, p.rate_bps), 0)

export const protocolName = (p: Pick<HttpParams, "protocol" | "tls" | "pipelining" | "parallel" | "zero_rtt">) => {
  const base = { h10: "HTTP/1.0", h11: "HTTP/1.1", h2: "HTTP/2", h3: "HTTP/3" }[p.protocol]
  const extra: string[] = []
  if (p.protocol === "h10" || p.protocol === "h11") extra.push(p.parallel === 1 ? "1 connection" : `up to ${p.parallel} connections`)
  if (p.protocol === "h11" && p.pipelining) extra.push("pipelined")
  if (p.protocol !== "h3" && p.tls) extra.push("TLS 1.3")
  if (p.zero_rtt && (p.protocol === "h3" || p.tls)) extra.push("0-RTT")
  return extra.length ? `${base}, ${extra.join(", ")}` : base
}

/** Bytes of each object that have arrived and that have been delivered by time t (ns). */
export function progressAt(run: HttpRun, t: number): { arrived: number[]; delivered: number[] } {
  const arrived = run.objects.map(() => 0)
  const delivered = run.objects.map(() => 0)
  for (const q of run.packets) {
    if (q.arrive_ns !== null && q.arrive_ns <= t) arrived[q.obj] += q.len
    if (q.delivered_ns !== null && q.delivered_ns <= t) delivered[q.obj] += q.len
  }
  return { arrived, delivered }
}

/** Index of the last event at or before t (ns), or 0. */
export function eventAtNs(run: HttpRun, t: number): number {
  let lo = 0
  let hi = run.events.length - 1
  if (hi < 0 || run.events[0].t > t) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (run.events[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function fmtNs(ns: number): string {
  if (ns < 1000) return `${ns} ns`
  if (ns < MS) return `${Number((ns / US).toPrecision(4))} µs`
  if (ns < 10_000 * MS) return `${Number((ns / MS).toFixed(3))} ms`
  return `${Number((ns / 1e9).toPrecision(5))} s`
}

// --- Presets -----------------------------------------------------------------

const obj = (name: string, bytes: number): HttpObject => ({ name, bytes })

/** A page whose objects all fit in the initial window, so the textbook formulas hold to the nanosecond. */
export const SMALL_PAGE: HttpObject[] = [
  obj("index.html", 10_000),
  obj("style.css", 4_000),
  obj("app.js", 12_000),
  obj("logo.svg", 3_000),
  obj("font.woff2", 14_000),
  obj("hero.jpg", 14_000),
  obj("icon1.png", 2_000),
  obj("icon2.png", 2_000),
  obj("data.json", 5_000),
]

/** A base page and four large images, for watching one loss. */
export const IMAGE_PAGE: HttpObject[] = [
  obj("index.html", 5_000),
  obj("a.jpg", 40_000),
  obj("b.jpg", 40_000),
  obj("c.jpg", 40_000),
  obj("d.jpg", 40_000),
]

/** A large response asked for ahead of small ones. */
export const HOL_PAGE: HttpObject[] = [obj("index.html", 2_000), obj("video.mp4", 300_000), obj("icon.png", 1_000), obj("style.css", 3_000)]

/** A heavier page for random loss: twelve objects of 30 kB. */
export const LOSSY_PAGE: HttpObject[] = [obj("index.html", 20_000), ...Array.from({ length: 11 }, (_, i) => obj(`img${i + 1}.jpg`, 30_000))]

export const HTTP_BASE: HttpParams = {
  protocol: "h11",
  parallel: 1,
  pipelining: false,
  tls: false,
  zero_rtt: false,
  schedule: "interleave",
  objects: SMALL_PAGE,
  rtt_us: 50_000,
  rate_bps: 10_000_000,
  mss_bytes: 1460,
  iw: 10,
  loss: 0,
  drops: [],
  seed: 1,
  trace: true,
}

export const httpWeb = (mode: HttpMode, p: Partial<HttpParams>): HttpWeb => ({ mode, http: { ...HTTP_BASE, ...p } })

export interface HttpPreset {
  id: string
  mode: HttpMode
  title: string
  source: string
  note: string
  params: HttpWeb
}

/** The lost packet in the scripted-loss presets: the third of a.jpg on HTTP/2 and HTTP/3. */
export const DROP = 12

export const HTTP_PRESETS: HttpPreset[] = [
  {
    id: "h10-serial",
    mode: "connections",
    title: "HTTP/1.0, one connection per object",
    source: "RFC 1945; Kurose and Ross, Section 2.2.2",
    note: "A web page of nine objects (the files it needs, HTTP being the Hypertext Transfer Protocol that fetches them), all small enough to fit in one initial window, over a 50 ms path at 10 Mb/s. Each object opens a TCP (Transmission Control Protocol) connection, waits a round trip for the handshake and another for the response, then closes it: two round trips of 50 ms each per object, plus 52.8 ms to send all nine, 952.8 ms in all.",
    params: httpWeb("connections", { protocol: "h10" }),
  },
  {
    id: "h11-persistent",
    mode: "connections",
    title: "HTTP/1.1, one persistent connection",
    source: "RFC 9112, Section 9.3; Kurose and Ross, Section 2.2.2",
    note: "The same page on one connection that stays open. The handshake is paid once; each object after it costs a round trip for its request, plus the time to send it: 552.8 ms in all, against 952.8 ms.",
    params: httpWeb("connections", { protocol: "h11" }),
  },
  {
    id: "h10-parallel",
    mode: "connections",
    title: "HTTP/1.0, eight connections at once",
    source: "RFC 1945; RFC 9112, Section 9.4",
    note: "Once the base page is complete at 108 ms, the browser opens a connection for each of the eight objects at once. The eight handshakes overlap, and the responses queue at the slowest link one after another: the page is complete at 252.8 ms. Each connection also starts with its own initial window, so together they send eight windows in the first round trip. Parallelism hides round trips, at the cost of eight connections for the server to keep.",
    params: httpWeb("connections", { protocol: "h10", parallel: 8 }),
  },
  {
    id: "h11-six",
    mode: "connections",
    title: "HTTP/1.1, encrypted, six connections",
    source: "RFC 9112, Section 9.4; RFC 8446",
    note: "What browsers did before HTTP/2: up to six persistent connections to a host, each encrypted with TLS 1.3 (Transport Layer Security). The base page takes three round trips plus its 8 ms of transmission; the first connection then asks for style.css at once while five more spend two round trips on their handshakes. The page is complete at 340 ms.",
    params: httpWeb("connections", { protocol: "h11", parallel: 6, tls: true }),
  },
  {
    id: "h2-page",
    mode: "connections",
    title: "HTTP/2, encrypted, one connection",
    source: "RFC 9113, Section 5",
    note: "One connection, one TLS handshake, and all eight requests sent together as streams the moment the base page is complete at 158 ms. The eight responses share one congestion window, 17 packets after the base page, so their 43 packets need two more round trips of slow start: the page is complete at 285.888 ms, against 340 ms for six HTTP/1.1 connections.",
    params: httpWeb("connections", { protocol: "h2", tls: true }),
  },
  {
    id: "pipeline-hol",
    mode: "hol",
    title: "HTTP/1.1 pipelining: small responses behind a large one",
    source: "RFC 9112, Section 9.3.2",
    note: "The page asks for a 300 kB video, then a 1 kB icon and a 3 kB stylesheet, all at once on one pipelined connection. The server must answer in the order asked, so the icon and the stylesheet sit behind the whole video: the icon is complete at 452.688 ms, 0.8 ms after the video. This is head-of-line blocking in the application, with no packet lost.",
    params: httpWeb("hol", { protocol: "h11", pipelining: true, objects: HOL_PAGE }),
  },
  {
    id: "h2-interleave",
    mode: "hol",
    title: "HTTP/2: the same page, interleaved",
    source: "RFC 9113, Section 5; RFC 9218",
    note: "The same three requests as streams on one HTTP/2 connection. The server sends a packet of each stream in turn, so the icon is complete at 153.568 ms and the stylesheet at 158.304 ms, while the video takes until 456.56 ms.",
    params: httpWeb("hol", { protocol: "h2", objects: HOL_PAGE }),
  },
  {
    id: "h2-loss",
    mode: "hol",
    title: "HTTP/2: one lost packet stalls every stream",
    source: "RFC 9113, Section 2; RFC 9000, Section 2.2",
    note: `Four 40 kB images as interleaved streams on one TCP connection, and packet ${DROP}, carrying part of a.jpg, is lost. TCP delivers only in order, so every packet behind the hole waits at the client for the retransmission, whichever image it carries: all four streams freeze. Packets spend 553.68 ms held in all, and the page is complete at 538.336 ms.`,
    params: httpWeb("hol", { protocol: "h2", tls: true, objects: IMAGE_PAGE, drops: [DROP] }),
  },
  {
    id: "h3-loss",
    mode: "hol",
    title: "HTTP/3: the same loss stalls one stream",
    source: "RFC 9114, Section 1; RFC 9000, Section 2.2",
    note: `The same page and the same lost packet over QUIC. QUIC orders bytes per stream, so only a.jpg waits, for 118.912 ms in all; b.jpg, c.jpg and d.jpg go straight to the browser as they arrive. The page is complete at 488.336 ms: exactly the round trip the handshake saves sooner, because the last bytes of every image still come after the repair.`,
    params: httpWeb("hol", { protocol: "h3", objects: IMAGE_PAGE, drops: [DROP] }),
  },
  {
    id: "tls-tcp",
    mode: "handshake",
    title: "TCP, then TLS encryption: two round trips before asking",
    source: "RFC 9293, Section 3.5; RFC 8446, Section 2",
    note: "The TCP handshake (SYN, then SYN-ACK: synchronise, and its acknowledgement), then the TLS (Transport Layer Security) handshake: a ClientHello and the server's reply up to its Finished. Only then can the request go: the first byte of the page arrives after three round trips plus the time to send a packet, 151.168 ms.",
    params: httpWeb("handshake", { protocol: "h2", tls: true }),
  },
  {
    id: "tls-0rtt",
    mode: "handshake",
    title: "TCP, then resumed TLS encryption with the request sent early",
    source: "RFC 8446, Sections 2.3 and 8",
    note: "A client that has talked to the server before can send its request as early data with the ClientHello, right after the TCP handshake: two round trips to the first byte. Early data can be replayed by an attacker, so servers accept it only for requests that are safe to repeat.",
    params: httpWeb("handshake", { protocol: "h2", tls: true, zero_rtt: true }),
  },
  {
    id: "quic-1rtt",
    mode: "handshake",
    title: "QUIC: connection and encryption set up in one round trip",
    source: "RFC 9000, Section 7; RFC 9001",
    note: "QUIC, the transport under HTTP/3, carries the TLS 1.3 encryption handshake in its first (Initial) packets, so one round trip sets up both: the request leaves with the client's Finished, and the first byte arrives after two round trips.",
    params: httpWeb("handshake", { protocol: "h3" }),
  },
  {
    id: "quic-0rtt",
    mode: "handshake",
    title: "QUIC, back to a known server: the request in the first packet (0-RTT)",
    source: "RFC 9000, Section 7; RFC 9001, Section 4.6",
    note: "With a ticket from an earlier connection the request rides in the first flight, so the first byte arrives one round trip after the browser decided to connect. The same replay caveat as TLS early data applies.",
    params: httpWeb("handshake", { protocol: "h3", zero_rtt: true }),
  },
  {
    id: "lossy-h2",
    mode: "handshake",
    title: "2% random loss, HTTP/2",
    source: "RFC 9113; RFC 6582",
    note: "Twelve objects, and 2% of data packets lost at random: three of 248 with this seed. Every loss freezes all streams on the connection until it is repaired, so all eleven images are held at some point, and the last loss holds every image to the end: they all complete together at 593.536 ms.",
    params: httpWeb("handshake", { protocol: "h2", tls: true, objects: LOSSY_PAGE, loss: 0.02, seed: 3 }),
  },
  {
    id: "lossy-h3",
    mode: "handshake",
    title: "2% random loss, HTTP/3",
    source: "RFC 9114; RFC 9002",
    note: "The same page, seed and losses over QUIC: each loss holds back only its own stream, so two images are held instead of eleven, and nine are complete by 517.5 ms. The page is complete at 543.536 ms, 50 ms sooner, which is the handshake's round trip.",
    params: httpWeb("handshake", { protocol: "h3", objects: LOSSY_PAGE, loss: 0.02, seed: 3 }),
  },
]

// --- Tour --------------------------------------------------------------------

export interface HttpTourStep {
  preset: string
  /** The moment to show, in µs. */
  at: number
  /** The step letter of the last event at or before it. */
  step: string
  text: string
}

export const HTTP_TOUR: HttpTourStep[] = [
  {
    preset: "h10-serial",
    at: 0,
    step: "C1",
    text: "A browser loads a page of nine objects over HTTP/1.0. Before it can ask for anything it opens a TCP connection: a SYN, a SYN-ACK, and the request goes with the final ACK, one round trip later. The ladder draws time running down; light brown lines are handshakes and requests, coloured lines are data packets, one colour per object.",
  },
  {
    preset: "h10-serial",
    at: 108 * 1000,
    step: "C1",
    text: "The base page is complete at 108 ms: 2 RTT plus its 8 ms of transmission. HTTP/1.0 closes the connection after each response, so for style.css the browser starts again with a new handshake. Every object pays the same two round trips.",
  },
  {
    preset: "h11-persistent",
    at: 108 * 1000,
    step: "C2",
    text: "HTTP/1.1 keeps the connection open: the request for style.css leaves at once, and each object after the first costs one round trip instead of two. The page takes 552.8 ms instead of 952.8 ms; the formulas under Go deeper show both totals worked out from the formulas.",
  },
  {
    preset: "h10-parallel",
    at: 108 * 1000,
    step: "C1",
    text: "The other way to hide round trips is to open connections in parallel. Here eight start at once, so their handshakes overlap and the page is complete at 252.8 ms. Browsers settled on six per host as the compromise.",
  },
  {
    preset: "h2-page",
    at: 158 * 1000,
    step: "C2",
    text: "HTTP/2 needs only one connection: all eight requests go together, each on its own stream, and the server interleaves their frames. The handshake now includes TLS 1.3, because browsers speak HTTP/2 only over TLS.",
  },
  {
    preset: "pipeline-hol",
    at: 451_888,
    step: "O1",
    text: "HTTP/1.1 pipelining lets the client send several requests without waiting, but the responses must come back in the order asked. The video was asked for first, so the 1 kB icon waits behind all 300 kB of it: in the Streams view its row stays empty until the video is done. That is head-of-line blocking in the application.",
  },
  {
    preset: "h2-interleave",
    at: 153_568,
    step: "O1",
    text: "HTTP/2 frames let the server send a packet of each stream in turn, so the icon is complete 52 ms after it was asked for, and the video still finishes at about the same time. Application-level head-of-line blocking is gone.",
  },
  {
    preset: "h2-loss",
    at: 215_680,
    step: "R1",
    text: `Now packet ${DROP} is lost. In the Streams view a red mark shows where a.jpg's bytes should have arrived. Packet 13, part of b.jpg, arrives intact, yet TCP cannot hand it to the browser, because TCP promises one ordered byte stream and a hole sits in front of it. The hollow tick is an arrival; the red bar is the time it waits.`,
  },
  {
    preset: "h2-loss",
    at: 243_016,
    step: "S2",
    text: "Three packets sent after the lost one have been acknowledged, so the server declares it lost, halves its window and retransmits at once. Meanwhile every stream's red bar keeps growing: all four images are frozen.",
  },
  {
    preset: "h2-loss",
    at: 279_696,
    step: "R1",
    text: "The retransmission arrives and fills the hole. TCP releases everything held behind it, twenty-five packets from all four images, in one burst. That is head-of-line blocking in the transport, which HTTP/2 cannot avoid by itself.",
  },
  {
    preset: "h3-loss",
    at: 165_680,
    step: "R1",
    text: "The same page and the same lost packet over HTTP/3, 50 ms earlier because QUIC's handshake takes one round trip. QUIC orders bytes per stream, not per connection, so b.jpg's packet goes straight to the browser.",
  },
  {
    preset: "h3-loss",
    at: 229_696,
    step: "R1",
    text: "Only a.jpg waited, and its six held packets go up when the retransmission arrives. The other three rows show no red at all: the loss stalled one stream instead of four.",
  },
  {
    preset: "quic-0rtt",
    at: 0,
    step: "C2",
    text: "A browser that has spoken to the server before can resume with 0-RTT: the request rides in the first flight, and the first byte comes back one round trip later. Early data can be replayed by an attacker, so it is meant for requests that are safe to repeat.",
  },
  {
    preset: "lossy-h2",
    at: 593_536,
    step: "P1",
    text: "Random loss on a bigger page: under HTTP/2 every loss freezes every stream, and the last one holds all eleven images to the very end. The chart sweeps the loss rate for HTTP/1.1 over six connections, HTTP/2 and HTTP/3. Switch to the HTTP/3 scenario to compare the same losses.",
  },
]

// --- Labs --------------------------------------------------------------------

export interface HttpLab {
  id: string
  difficulty: 1 | 2 | 3
  title: string
  task: string
  hint: string
  start: HttpWeb
  check(p: HttpWeb, run: HttpRun): { ok: boolean; message: string }
}

const sameObjects = (p: HttpParams, objects: HttpObject[]) => JSON.stringify(p.objects) === JSON.stringify(objects)
const samePath = (p: HttpParams, q: HttpParams) => p.rtt_us === q.rtt_us && p.rate_bps === q.rate_bps && p.loss === q.loss
const httpPreset = (id: string) => HTTP_PRESETS.find((p) => p.id === id)!.params
/** The page load time of the HTTP/2 run that the isolation lab must beat. */
export const H2_LOSS_PLT = 538_336_000

export const HTTP_LABS: HttpLab[] = [
  {
    id: "h10-parallel",
    difficulty: 1,
    title: "Hide the round trips of HTTP/1.0",
    task: "This page takes 952.8 ms over HTTP/1.0, one connection at a time. Without leaving HTTP/1.0 or changing the page or the path, load it in under 400 ms.",
    hint: "Each object costs two round trips that do nothing but wait. Can several objects wait at the same time? The settings under Go deeper have it.",
    start: httpPreset("h10-serial"),
    check(w, run) {
      const p = w.http
      const ok0 = p.protocol === "h10" && sameObjects(p, SMALL_PAGE) && samePath(p, HTTP_BASE)
      if (!ok0) return { ok: false, message: "Stay on HTTP/1.0 with the same nine objects and the same path." }
      const ms = run.stats.plt_ns / MS
      return ms < 400
        ? { ok: true, message: `${ms} ms with up to ${p.parallel} connections: their handshakes overlap instead of following one another.` }
        : { ok: false, message: `${ms} ms. How many connections can wait their two round trips together?` }
    },
  },
  {
    id: "first-byte",
    difficulty: 1,
    title: "The first byte in one round trip",
    task: "Over TCP and TLS 1.3 the first byte of the page arrives after three round trips plus a packet's transmission, 151.168 ms. Keep the 50 ms path and get it down to one round trip plus a packet, 51.168 ms.",
    hint: "Count the round trips each handshake spends before the request can leave: TCP, TLS 1.3, QUIC, and what changes when the client has talked to the server before.",
    start: httpPreset("tls-tcp"),
    check(w, run) {
      const p = w.http
      if (p.rtt_us !== 50_000) return { ok: false, message: "Keep the round trip at 50 ms." }
      const t = run.stats.ttfb_ns
      return t <= 51_168_000
        ? {
            ok: true,
            message: `${fmtNs(t)}: QUIC resumed with 0-RTT puts the request in the first flight. Early data can be replayed, so it suits only requests that are safe to repeat.`,
          }
        : {
            ok: false,
            message: `${fmtNs(t)}, ${setupRtts(p)} round trip${setupRtts(p) === 1 ? "" : "s"} of setup. Which handshake can carry the request in its very first packet?`,
          }
    },
  },
  {
    id: "free-icon",
    difficulty: 2,
    title: "Free the small response",
    task: "With pipelining the 1 kB icon is complete only after the 300 kB video asked for before it. Without changing the page or the path, make the icon complete before the video. Find two different ways.",
    hint: "The server must answer each connection's requests in order. Either the icon must not share a queue with the video, or the responses must be allowed to interleave.",
    start: httpPreset("pipeline-hol"),
    check(w, run) {
      const p = w.http
      if (!sameObjects(p, HOL_PAGE) || !samePath(p, HTTP_BASE))
        return { ok: false, message: "Keep the same four objects and the same path." }
      const [video, icon] = [run.objects[1], run.objects[2]]
      if (icon.done_ns >= video.done_ns)
        return {
          ok: false,
          message: `The icon is complete at ${fmtNs(icon.done_ns)}, after the video at ${fmtNs(video.done_ns)}. What is it queued behind?`,
        }
      const how =
        p.protocol === "h2" || p.protocol === "h3"
          ? "streams interleave, so nothing waits for a whole response"
          : "the icon went on a different connection from the video"
      return {
        ok: true,
        message: `The icon is complete at ${fmtNs(icon.done_ns)}, the video at ${fmtNs(video.done_ns)}: ${how}. Did you find the other way too?`,
      }
    },
  },
  {
    id: "tcp-isolate",
    difficulty: 3,
    title: "Contain a loss without QUIC",
    task: "Over HTTP/2 one lost packet holds back all four images and the page takes 538.336 ms. Staying on TCP with TLS, with the same page, path and scripted loss, make the loss hold back at most one image and load the page faster than HTTP/2 did.",
    hint: "TCP orders bytes per connection. What if the images did not share one?",
    start: httpPreset("h2-loss"),
    check(w, run) {
      const p = w.http
      if (p.protocol === "h3" || !p.tls) return { ok: false, message: "Stay on TCP with TLS: HTTP/1.0, HTTP/1.1 or HTTP/2." }
      if (!sameObjects(p, IMAGE_PAGE) || !samePath(p, HTTP_BASE) || run.stats.lost < 1)
        return { ok: false, message: "Keep the same page and path, and keep a scripted loss that hits a packet." }
      const s = run.stats
      if (s.held_objects > 1)
        return { ok: false, message: `${s.held_objects} images were held back by the loss. Which packets does TCP make wait?` }
      return s.plt_ns < H2_LOSS_PLT
        ? {
            ok: true,
            message: `${fmtNs(s.plt_ns)}, with ${s.held_objects} image held: a loss stalls only its own connection, which is why browsers kept several. HTTP/3 gets the same isolation on one connection.`,
          }
        : {
            ok: false,
            message: `Only ${s.held_objects} image held, but ${fmtNs(s.plt_ns)} is no faster than HTTP/2. Can the images travel at the same time?`,
          }
    },
  },
]

// --- Sweeps ------------------------------------------------------------------

export const SWEEP_LOSS = [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08]
export const SWEEP_RTT_MS = [10, 25, 50, 100, 150, 200, 300]
export const SWEEP_SEEDS = 6
