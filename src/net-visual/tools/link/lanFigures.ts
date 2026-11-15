// The two LAN pictures at one moment, as plain shapes: switches with the
// copies of each frame on the wire, and bridges with their port roles and the
// BPDUs just sent. Pure TypeScript, so the Node tests can check it.
import {
  bridgeId,
  inFlight,
  lanPorts,
  viewsAt,
  type LanLink,
  type PortState,
  type Role,
  type StpParams,
  type StpRun,
  type SwitchParams,
  type SwitchRun,
} from "../../core/lan.ts"
import { type Ink, type Shape, type ShapeFigure } from "./shapes.ts"

const text = (x: number, y: number, s: string, o: Partial<Extract<Shape, { kind: "text" }>> = {}): Shape => ({
  kind: "text",
  x,
  y,
  text: s,
  size: 11,
  anchor: "middle",
  fill: "muted",
  ...o,
})

interface Place {
  x: number
  y: number
}

/** Where a node sits in a w × h box with a margin. */
const placer = (w: number, h: number, pad: number) => (n: { x: number; y: number }) => ({
  x: pad + n.x * (w - 2 * pad),
  y: pad + n.y * (h - 2 * pad),
})

/** The point a distance d beyond the edge of a hw × hh half-size box at a, towards b. */
function beyond(a: Place, b: Place, hw: number, hh: number, d: number): Place {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const edge = Math.min(ux ? hw / Math.abs(ux) : Infinity, uy ? hh / Math.abs(uy) : Infinity)
  const k = Math.min(edge + d, len / 2)
  return { x: a.x + ux * k, y: a.y + uy * k }
}

/** Two links between the same pair are drawn as gentle offsets, so both stay visible. */
function linkOffsets(links: LanLink[]): number[] {
  return links.map((l, i) => {
    const same = links.map((m, j) => ({ m, j })).filter(({ m }) => (m.a === l.a && m.b === l.b) || (m.a === l.b && m.b === l.a))
    if (same.length < 2) return 0
    const k = same.findIndex(({ j }) => j === i)
    return (k - (same.length - 1) / 2) * 14
  })
}

function shifted(a: Place, b: Place, off: number): [Place, Place] {
  if (!off) return [a, b]
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const nx = (-(b.y - a.y) / len) * off
  const ny = ((b.x - a.x) / len) * off
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
  ]
}

// --- Switches --------------------------------------------------------------

export interface SwitchFigure extends ShapeFigure {
  onWire: number
}

const HALF = { switch: [22, 13], hub: [18, 10], host: [13, 13] } as const

/** The LAN with each copy of a frame on its link, the switch that acted last ringed, and blocked ports barred. */
export function switchFigure(p: SwitchParams, run: SwitchRun, t: number, index: number, w: number): SwitchFigure {
  const h = Math.round(Math.min(340, Math.max(230, w * 0.5)))
  const at = placer(w, h, 34)
  const pos = p.nodes.map(at)
  const ports = lanPorts(p.nodes.length, p.links)
  const offs = linkOffsets(p.links)
  const shapes: Shape[] = []
  const blocked = new Set(run.blocked.map(([n, k]) => `${n}:${k}`))
  const ends = (i: number): [Place, Place] => shifted(pos[p.links[i].a], pos[p.links[i].b], offs[i])

  p.links.forEach((l, i) => {
    const [a, b] = ends(i)
    const cut =
      blocked.has(`${l.a}:${ports[l.a].findIndex((e) => e.link === i) + 1}`) ||
      blocked.has(`${l.b}:${ports[l.b].findIndex((e) => e.link === i) + 1}`)
    shapes.push({ kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: cut ? "muted" : "ink", width: cut ? 1 : 1.4, dashed: cut })
  })

  // Port numbers on switches and hubs; a bar across each blocked port.
  p.nodes.forEach((n, i) => {
    if (n.kind === "host") return
    const [hw, hh] = HALF[n.kind]
    ports[i].forEach((e, k) => {
      const [a, b] = ends(e.link)
      const self = p.links[e.link].a === i ? a : b
      const peer = p.links[e.link].a === i ? b : a
      const q = beyond(self, peer, hw, hh, 9)
      shapes.push(text(q.x, q.y + 3.5, String(k + 1), { size: 9.5 }))
      if (blocked.has(`${i}:${k + 1}`)) {
        const m = beyond(self, peer, hw, hh, 20)
        const len = Math.hypot(peer.x - self.x, peer.y - self.y) || 1
        const nx = (-(peer.y - self.y) / len) * 8
        const ny = ((peer.x - self.x) / len) * 8
        shapes.push({ kind: "line", x1: m.x - nx, y1: m.y - ny, x2: m.x + nx, y2: m.y + ny, stroke: "alarm", width: 3 })
      }
    })
  })

  const wire = inFlight(p, run, t)
  for (const c of wire.slice(0, 400)) {
    const [a, b] = ends(c.link)
    const fromA = p.links[c.link].a === c.from
    const s = fromA ? a : b
    const d = fromA ? b : a
    const f = Math.min(1, Math.max(0, c.f))
    shapes.push({ kind: "circle", cx: s.x + (d.x - s.x) * f, cy: s.y + (d.y - s.y) * f, r: 4.5, fill: "busy", stroke: "surface" })
  }

  const e = run.events[index]
  p.nodes.forEach((n, i) => {
    const c = pos[i]
    const [hw, hh] = HALF[n.kind]
    if (e && e.node === i && e.t <= t)
      shapes.push({
        kind: "circle",
        cx: c.x,
        cy: c.y,
        r: Math.max(hw, hh) + 7,
        stroke: e.frame < p.frames.length ? "ink" : "muted",
      })
    if (n.kind === "host") shapes.push({ kind: "circle", cx: c.x, cy: c.y, r: hw, fill: "surface", stroke: "muted" })
    else
      shapes.push({
        kind: "rect",
        x: c.x - hw,
        y: c.y - hh,
        w: 2 * hw,
        h: 2 * hh,
        fill: "surface",
        stroke: n.kind === "hub" ? "muted" : "ink",
        dashed: n.kind === "hub",
      })
    shapes.push(text(c.x, c.y + 4, n.name, { fill: "ink", bold: n.kind === "switch", size: n.kind === "hub" ? 10 : 11 }))
  })
  return { w, h, shapes, caption: "", onWire: wire.length }
}

// --- The spanning tree -----------------------------------------------------

export const ROLE_LETTER: Record<Role, string> = { root: "R", designated: "D", alternate: "A", disabled: "×" }
export const STATE_INK: Record<PortState, Ink> = {
  forwarding: "ok",
  learning: "busy",
  listening: "busy",
  blocking: "alarm",
  disabled: "muted",
}

export interface StpFigure extends ShapeFigure {
  forwarding: number
  blocking: number
  waiting: number
  roots: number
}

/** How long a BPDU's dot takes to cross its link in the picture: slower than the model's few milliseconds, so it can be seen. */
export const BPDU_SHOW_MS = 600

/** The bridges, their port roles and states after event `index`, and the BPDUs sent in the last 0.6 s. */
export function stpFigure(p: StpParams, run: StpRun, t: number, index: number, w: number): StpFigure {
  const legend = 22
  const h = Math.round(Math.min(400, Math.max(270, w * 0.62))) + legend
  const at = placer(w, h - legend, 40)
  const pos = p.bridges.map(at)
  const views = viewsAt(run, index)
  const ports = lanPorts(p.bridges.length, p.links)
  const offs = linkOffsets(p.links)
  const shapes: Shape[] = []
  // Sized for the 11-unit labels the page renders at 17px.
  const hw = w < 480 ? 32 : 36
  const hh = 25
  const failed = p.failure && t >= p.failure.at_ms ? p.failure.link : -1
  const ends = (i: number): [Place, Place] => shifted(pos[p.links[i].a], pos[p.links[i].b], offs[i])
  const portView = (b: number, link: number) => views[b].ports.find((x) => x.link === link)!

  p.links.forEach((l, i) => {
    const [a, b] = ends(i)
    const sa = portView(l.a, i).state
    const sb = portView(l.b, i).state
    const both = sa === "forwarding" && sb === "forwarding"
    const cut = sa === "blocking" || sb === "blocking"
    const dead = i === failed
    shapes.push({
      kind: "line",
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      stroke: dead ? "alarm" : both ? "ink" : "muted",
      width: both ? 2.4 : 1.1,
      dashed: dead || cut,
    })
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    if (dead) shapes.push(text(mx, my + 5, "×", { fill: "alarm", size: 16, bold: true }))
    else {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
      shapes.push(text(mx - ((b.y - a.y) / len) * 10, my + ((b.x - a.x) / len) * 10 + 4, String(l.cost), { size: 9.5 }))
    }
  })

  // BPDUs in flight, drawn crossing the link over 0.6 s.
  const byId = new Map(p.bridges.map((b, i) => [b.id, i]))
  let shown = 0
  for (let i = index; i >= 0 && shown < 160; i--) {
    const e = run.events[i]
    if (t - e.t >= BPDU_SHOW_MS) break
    if (!e.bpdu || e.port === null || !(e.what === "send" || e.what === "reply" || e.what === "relay")) continue
    const link = ports[e.bridge][e.port - 1].link
    const [a, b] = ends(link)
    const fromA = p.links[link].a === e.bridge
    const s = beyond(fromA ? a : b, fromA ? b : a, hw, hh, 0)
    const d = beyond(fromA ? b : a, fromA ? a : b, hw, hh, 0)
    const f = Math.min(1, (t - e.t) / BPDU_SHOW_MS)
    const x = s.x + (d.x - s.x) * f
    const y = s.y + (d.y - s.y) * f
    shapes.push({ kind: "rect", x: x - 4.5, y: y - 3.5, w: 9, h: 7, fill: "busy", stroke: "surface" })
    shown++
  }

  // Port markers: the role's letter on the state's colour.
  p.bridges.forEach((_, b) => {
    for (const pv of views[b].ports) {
      const [a, c] = ends(pv.link)
      const self = p.links[pv.link].a === b ? a : c
      const peer = p.links[pv.link].a === b ? c : a
      const m = beyond(self, peer, hw, hh, 10)
      shapes.push({ kind: "circle", cx: m.x, cy: m.y, r: 8.5, fill: STATE_INK[pv.state], stroke: "surface" })
      shapes.push(text(m.x, m.y + 3.8, ROLE_LETTER[pv.role], { fill: "surface", size: 11, bold: true }))
    }
  })

  const e = run.events[index]
  const roots = new Set(views.map((v) => v.root))
  p.bridges.forEach((br, b) => {
    const c = pos[b]
    const v = views[b]
    const isRoot = v.root === br.id
    if (e && e.bridge === b)
      shapes.push({ kind: "rect", x: c.x - hw - 5, y: c.y - hh - 5, w: 2 * hw + 10, h: 2 * hh + 10, stroke: "ink", dashed: true })
    shapes.push({ kind: "rect", x: c.x - hw, y: c.y - hh, w: 2 * hw, h: 2 * hh, fill: "surface", stroke: "ink" })
    // Name, ID, and what the bridge believes: that it is the root, or its cost to the root it believes in.
    shapes.push(text(c.x, c.y - 9, br.name, { fill: "ink", bold: true, size: 12 }))
    shapes.push(text(c.x, c.y + 3.5, bridgeId(br.id), { size: 11 }))
    const rootName = p.bridges[byId.get(v.root) ?? b].name
    shapes.push(text(c.x, c.y + 16, isRoot ? "root" : `${v.cost} to ${rootName}`, { size: 11, fill: "ink", bold: isRoot }))
  })

  // The legend.
  const ly = h - 8
  const items: [Ink, string][] =
    w < 480
      ? [
          ["ok", "forwarding"],
          ["busy", "waiting"],
          ["alarm", "blocking"],
        ]
      : [
          ["ok", "forwarding"],
          ["busy", "listening or learning"],
          ["alarm", "blocking"],
          ["muted", "disabled"],
        ]
  let x = 8
  if (w >= 480) {
    shapes.push(text(x, ly, "R root, D designated, A alternate:", { anchor: "start", size: 11 }))
    x += 196
  }
  for (const [ink, label] of items) {
    shapes.push({ kind: "circle", cx: x + 5, cy: ly - 3.5, r: 5, fill: ink })
    shapes.push(text(x + 13, ly, label, { anchor: "start", size: 11 }))
    x += 24 + label.length * 5.8
  }

  const count = (s: PortState) => views.reduce((a, v) => a + v.ports.filter((x) => x.state === s).length, 0)
  return {
    w,
    h,
    shapes,
    caption: "",
    forwarding: count("forwarding"),
    blocking: count("blocking"),
    waiting: count("listening") + count("learning"),
    roots: roots.size,
  }
}
