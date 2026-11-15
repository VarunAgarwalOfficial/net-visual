// The space-time ladder of one DNS resolution: a column per machine, time
// down the page, every message drawn from its send to its arrival. Plain
// shapes, so the page and the SVG and TikZ exports draw the same figure.
import { fmtUs, resolutionOf, type DnsParams, type DnsRun, type MsgKind } from "../../core/dns.ts"
import type { Ink, Shape, ShapeFigure } from "../link/shapes.ts"

export interface LadderFigure extends ShapeFigure {
  res: number | null
  summary: string
}

export const KIND_INK: Record<MsgKind, Ink> = {
  query: "muted",
  referral: "c0",
  answer: "c2",
  cname: "c3",
  nxdomain: "alarm",
  nodata: "alarm",
}

const KIND_WORD: Record<MsgKind, string> = {
  query: "",
  referral: "referral",
  answer: "answer",
  cname: "CNAME",
  nxdomain: "NXDOMAIN",
  nodata: "NODATA",
}

/** The resolution to draw at event i: its own, or for an expiry or a change, the latest one begun by then. */
export function focusResolution(run: DnsRun, i: number): number | null {
  const ev = run.events[i]
  if (!ev) return null
  const own = resolutionOf(run, i)
  if (own !== null && ev.step !== "E1") return own
  let best: number | null = null
  run.resolutions.forEach((r, k) => {
    if (r.at_us <= ev.t) best = k
  })
  return best ?? (run.resolutions.length ? 0 : null)
}

const zoneLabel = (origin: string) => (origin === "." ? "root" : origin.replace(/\.$/, ""))

function niceStep(span: number, count: number): number {
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
}

export function outcomeWords(o: string): string {
  return o === "stub"
    ? "from its own cache"
    : o === "cache"
      ? "from the resolver's cache"
      : o === "joined"
        ? "by joining a lookup in flight"
        : "from the servers"
}

export function ladderFigure(p: DnsParams, run: DnsRun, index: number, width: number): LadderFigure {
  const w = Math.max(320, Math.round(width))
  const narrow = w < 560
  const fs = narrow ? 12 : 13
  const L = narrow ? 44 : 56
  const R = 12
  const cols = [null, "resolver", ...p.zones.map((z) => zoneLabel(z.origin))]
  const span = (w - L - R) / cols.length
  const xOf = (c: number) => L + (c + 0.5) * span
  const colOf = (node: number) => (node === run.resolver ? 1 : node < run.resolver ? 0 : 2 + node - run.resolver - 1)
  const shapes: Shape[] = []
  const r = focusResolution(run, index)
  const res = r === null ? null : run.resolutions[r]
  cols[0] = res ? p.clients[res.client].name : p.clients.map((c) => c.name).join(" or ")

  // What each column is, in the picture: under its name where there is room, in a key above the names on a phone.
  const zones = p.zones.map((z) => zoneLabel(z.origin))
  const tlds = zones.filter((z) => z !== "root" && !z.includes("."))
  const gloss = (c: number, label: string) =>
    c === 0
      ? "the device asking"
      : c === 1
        ? "looks the name up"
        : label === "root"
          ? `knows ${tlds.join(", ") || "the next servers"}`
          : label.includes(".")
            ? "holds the address"
            : `names ending .${label}`
  const keyLines: string[] = []
  if (narrow) {
    const phrases = [
      "resolver: looks the name up, asking these name servers:",
      `root knows ${tlds.join(" and ") || "the next servers"}`,
      ...tlds.map((t) => `${t} knows names ending .${t}`),
      `${zones.filter((z) => z.includes(".")).join(" and ")} hold the addresses.`,
    ]
    const fit = Math.floor((w - 8) / ((fs - 1) * 0.5))
    let line = ""
    phrases.forEach((ph, i) => {
      const piece = i === 0 || i === phrases.length - 1 ? ph : `${ph};`
      if (line && (line + " " + piece).length > fit) {
        keyLines.push(line)
        line = piece
      } else line = line ? `${line} ${piece}` : piece
    })
    if (line) keyLines.push(line)
  }
  keyLines.forEach((l, i) => shapes.push({ kind: "text", x: 4, y: 13 + i * 14, text: l, size: fs - 1, anchor: "start", fill: "muted" }))
  const head = narrow ? 14 + keyLines.length * 14 + 6 : 14
  const top = head + 28
  const H = 340
  // The line colours, under the columns, each phrase in its own colour.
  const colourKey: { text: string; fill: Ink }[] = [
    { text: "grey: a question", fill: "muted" },
    { text: "blue: a referral (ask this other server)", fill: KIND_INK.referral },
    { text: "green: the answer", fill: KIND_INK.answer },
    ...(run.messages.some((m) => m.kind === "cname")
      ? [{ text: "orange: an alias (CNAME), look up this other name", fill: KIND_INK.cname }]
      : []),
    ...(run.messages.some((m) => m.kind === "nxdomain" || m.kind === "nodata")
      ? [{ text: "red: no such name or record", fill: KIND_INK.nxdomain }]
      : []),
    { text: "small square: a record kept in a cache", fill: KIND_INK.answer },
  ]
  const keyAt: { x: number; row: number }[] = []
  {
    let x = 4
    let row = 0
    for (const k of colourKey) {
      const len = k.text.length * (fs - 1) * 0.48
      if (x > 4 && x + len > w - 4) {
        x = 4
        row++
      }
      keyAt.push({ x, row })
      x += len + 14
    }
  }
  const keyRows = keyAt[keyAt.length - 1].row + 1
  const h = top + H + 30 + keyRows * 15
  colourKey.forEach((k, i) =>
    shapes.push({
      kind: "text",
      x: keyAt[i].x,
      y: top + H + 16 + keyAt[i].row * 15,
      text: k.text,
      size: fs - 1,
      anchor: "start",
      fill: k.fill,
    }),
  )

  cols.forEach((label, c) => {
    const x = xOf(c)
    const name = label ?? ""
    // On a phone a long name breaks onto two lines (at " or " or its first dot) instead of running into its neighbours.
    const cut = name.indexOf(" or ") > 0 ? name.indexOf(" or ") + 1 : name.indexOf(".") > 0 ? name.indexOf(".") : -1
    const lines = narrow
      ? name.length * fs * 0.52 > span - 4 && cut > 0
        ? [name.slice(0, cut).trim(), name.slice(cut).trim()]
        : [name]
      : [name, gloss(c, name)]
    lines.forEach((t, j) =>
      shapes.push({
        kind: "text",
        x,
        y: head + j * 14,
        text: t,
        size: narrow ? fs - 1 : j === 0 ? fs : fs - 2,
        anchor: "middle",
        fill: j === 0 || narrow ? "ink" : "muted",
      }),
    )
    shapes.push({ kind: "line", x1: x, y1: top - 6, x2: x, y2: top + H, stroke: "muted", width: 0.6, dashed: true })
  })

  if (!res) {
    // Before the first question: say so in the picture, and what Play will draw.
    const lines = ["Nothing sent yet.", "Play draws each question and answer", "as a line between these columns."]
    shapes.push({ kind: "rect", x: w / 2 - 130, y: top + 70, w: 260, h: 58, fill: "surface", opacity: 0.92 })
    lines.forEach((l, i) =>
      shapes.push({ kind: "text", x: w / 2, y: top + 90 + i * 17, text: l, size: fs + 1, anchor: "middle", fill: "ink" }),
    )
    return { w, h, shapes, caption: "", res: null, summary: "Nothing sent yet" }
  }

  const ev = run.events[index]
  const t0 = res.at_us
  const t1 = Math.max(res.done_us, t0 + 1)
  // The event's own message is drawn whole: the event is its sending.
  const sent = ev && ev.msg !== null ? run.messages[ev.msg] : undefined
  const now = Math.max(t0, Math.min(t1, Math.max(ev?.t ?? t1, sent && sent.res === r ? sent.arrive_us : 0)))
  const y = (t: number) => top + 6 + ((t - t0) / (t1 - t0)) * (H - 12)
  const latency = res.done_us - res.at_us
  const who = p.clients[res.client].name
  const summary = `${who} asks for ${res.name}: answered ${outcomeWords(res.outcome)} in ${fmtUs(latency)}${res.stale ? ", with a stale address" : ""}`

  if (latency === 0) {
    shapes.push({ kind: "circle", cx: xOf(0), cy: top + 30, r: 6, fill: "c2" })
    shapes.push({
      kind: "text",
      x: xOf(0) + 12,
      y: top + 34,
      text: "answered by the stub's own cache: nothing is sent",
      size: fs,
      anchor: "start",
      fill: "ink",
    })
  } else {
    // Time ticks, relative to the question.
    const step = niceStep(latency, narrow ? 4 : 6)
    for (let k = 0; k * step <= latency + 1e-6; k++) {
      const yy = y(t0 + k * step)
      shapes.push({ kind: "line", x1: L - 4, y1: yy, x2: L, y2: yy, stroke: "muted", width: 0.8 })
      shapes.push({
        kind: "text",
        x: L - 6,
        y: yy + 4,
        text: String(Number(((k * step) / 1000).toPrecision(3))),
        size: fs - 1,
        anchor: "end",
        fill: "muted",
      })
    }
    shapes.push({ kind: "text", x: L - 6, y: top - 4, text: "ms", size: fs - 1, anchor: "end", fill: "muted" })
    // What was cached, and where, as the lookup went.
    const marks = new Set<string>()
    for (const e of run.entries) {
      if (e.res !== r || e.from_us > now || e.from_us < t0 || e.from_us > t1) continue
      const key = `${e.cache} ${e.from_us}`
      if (marks.has(key)) continue
      marks.add(key)
      const c = colOf(e.cache)
      shapes.push({
        kind: "rect",
        x: xOf(c) - 4,
        y: y(e.from_us) - 4,
        w: 8,
        h: 8,
        fill: e.kind === "NXDOMAIN" || e.kind === "NODATA" ? "alarm" : "c2",
      })
    }
    run.messages.forEach((m, k) => {
      if (m.res !== r || m.send_us > now) return
      const a = colOf(m.from)
      const b = colOf(m.to)
      const end = Math.min(m.arrive_us, now)
      const f = m.arrive_us > m.send_us ? (end - m.send_us) / (m.arrive_us - m.send_us) : 1
      const x1 = xOf(a)
      const x2 = x1 + (xOf(b) - x1) * f
      const current = ev?.msg === k
      shapes.push({
        kind: "line",
        x1,
        y1: y(m.send_us),
        x2,
        y2: y(end),
        stroke: KIND_INK[m.kind],
        width: current ? 2.8 : 1.6,
        arrow: f >= 1,
      })
      const word = KIND_WORD[m.kind]
      if (word && f >= 1 && Math.abs(xOf(b) - x1) > 40) {
        shapes.push({
          kind: "text",
          x: (x1 + x2) / 2,
          y: (y(m.send_us) + y(end)) / 2 - 4,
          text: word,
          size: fs - 1,
          anchor: "middle",
          fill: KIND_INK[m.kind],
        })
      }
    })
    if (now < t1) shapes.push({ kind: "line", x1: L, y1: y(now), x2: w - R, y2: y(now), stroke: "muted", width: 0.8, dashed: true })
  }
  shapes.push({
    kind: "text",
    x: L,
    y: h - 8,
    text: narrow ? `${res.name} in ${fmtUs(latency)}` : summary,
    size: fs,
    anchor: "start",
    fill: res.stale ? "alarm" : "ink",
  })
  return { w, h, shapes, caption: "", res: r, summary }
}
