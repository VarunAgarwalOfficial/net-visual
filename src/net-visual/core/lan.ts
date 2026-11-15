// Types and helpers for joining links into a LAN: learning switches
// (crates/netsim/src/lan.rs) and the 802.1D spanning tree
// (crates/netsim/src/stp.rs). Erasable TypeScript only, so Node can run it in
// tests.
import type { Netsim } from "./netsim.ts"

// --- Learning switches -----------------------------------------------------

export type NodeKind = "host" | "hub" | "switch"

/** A node; x and y place it in the figure (0 to 1 across and down) and the model ignores them. */
export interface LanNode {
  name: string
  kind: NodeKind
  x: number
  y: number
}

export interface LanLink {
  a: number
  b: number
  cost: number
}

export interface FrameSpec {
  at_us: number
  from: number
  /** null for broadcast */
  to: number | null
}

export interface SwitchParams {
  nodes: LanNode[]
  links: LanLink[]
  frames: FrameSpec[]
  aging_us: number
  hop_us: number
  stp: boolean
  max_sends: number
}

export interface MacEntry {
  mac: number
  port: number
  at: number
}

export type SwitchWhat =
  "send" | "learn" | "refresh" | "move" | "filter" | "forward" | "flood" | "block" | "age" | "deliver" | "ignore" | "repeat" | "cap"

export interface SwitchEvent {
  t: number
  step: string
  what: SwitchWhat
  node: number
  port: number | null
  out: number[]
  frame: number
  src: number
  dst: number | null
  sent: number
  table: MacEntry[] | null
}

export interface SwitchRun {
  events: SwitchEvent[]
  sent: number
  delivered: number[]
  capped: boolean
  blocked: [number, number][]
  tables: MacEntry[][]
}

export const runSwitch = (sim: Netsim, p: SwitchParams) => sim.call<SwitchRun>("link", "switch", p)

/** Each node's ports in order: ports(p)[i][k] is port k + 1 of node i. */
export function lanPorts(n: number, links: LanLink[]): { link: number; peer: number; peerPort: number }[][] {
  const ps: { link: number; peer: number; peerPort: number }[][] = Array.from({ length: n }, () => [])
  links.forEach((l, i) => {
    const pa = ps[l.a].length + 1
    const pb = ps[l.b].length + 1
    ps[l.a].push({ link: i, peer: l.b, peerPort: pb })
    ps[l.b].push({ link: i, peer: l.a, peerPort: pa })
  })
  return ps
}

/** Every switch's table just after event `index`. */
export function tablesAt(p: SwitchParams, run: SwitchRun, index: number): MacEntry[][] {
  const t: MacEntry[][] = p.nodes.map(() => [])
  for (let i = 0; i <= index && i < run.events.length; i++) {
    const e = run.events[i]
    if (e.table) t[e.node] = e.table
  }
  return t
}

/** Copies on the wire at time t: each leaves `out` at its event time and arrives one hop later. */
export function inFlight(p: SwitchParams, run: SwitchRun, t: number): { link: number; from: number; frame: number; f: number }[] {
  const ps = lanPorts(p.nodes.length, p.links)
  const out: { link: number; from: number; frame: number; f: number }[] = []
  for (const e of run.events) {
    if (e.t > t) break
    if (e.t + p.hop_us <= t) continue
    for (const k of e.out) out.push({ link: ps[e.node][k - 1].link, from: e.node, frame: e.frame, f: (t - e.t) / p.hop_us })
  }
  return out
}

/** Link transmissions so far, at each event: a step series for the chart. */
export const sendsOverTime = (run: SwitchRun): [number, number][] => run.events.map((e) => [e.t, e.sent])

// --- The spanning tree -----------------------------------------------------

export interface Bridge {
  name: string
  /** Priority × 65536 + the low 16 bits of the MAC address. */
  id: number
  x: number
  y: number
}

export interface Failure {
  at_ms: number
  link: number
  detected: boolean
}

export interface StpParams {
  bridges: Bridge[]
  links: LanLink[]
  hello_ms: number
  max_age_ms: number
  forward_delay_ms: number
  delay_ms: number
  until_ms: number
  failure: Failure | null
}

export interface Vector {
  root: number
  cost: number
  bridge: number
  port: number
}

export type Role = "root" | "designated" | "alternate" | "disabled"
export type PortState = "blocking" | "listening" | "learning" | "forwarding" | "disabled"

export interface PortView {
  port: number
  link: number
  peer: number
  role: Role
  state: PortState
}

export interface BridgeView {
  bridge: number
  root: number
  cost: number
  root_port: number | null
  ports: PortView[]
}

export type StpWhat = "start" | "hello" | "send" | "receive" | "lost" | "stale" | "reply" | "relay" | "expire" | "roles" | "state" | "fail"

export interface StpEvent {
  t: number
  step: string
  what: StpWhat
  bridge: number
  port: number | null
  bpdu: { v: Vector; age_ms: number } | null
  view: BridgeView | null
}

export interface Tree {
  root: number
  cost: (number | null)[]
  root_port: (number | null)[]
  roles: Role[][]
}

export interface Phase {
  from_ms: number
  roles_ms: number
  settled_ms: number
}

export interface StpRun {
  events: StpEvent[]
  start: BridgeView[]
  end: BridgeView[]
  phases: Phase[]
  direct: Tree
  bpdus: number
}

export const runStp = (sim: Netsim, p: StpParams) => sim.call<StpRun>("link", "stp", p)

/** Each bridge's view just after event `index`. */
export function viewsAt(run: StpRun, index: number): BridgeView[] {
  const v = [...run.start]
  for (let i = 0; i <= index && i < run.events.length; i++) {
    const e = run.events[i]
    if (e.view) v[e.bridge] = e.view
  }
  return v
}

/** A bridge ID as 802.1D writes it: priority, then the MAC address's last bytes. */
export const bridgeId = (id: number) => `${Math.floor(id / 65536)}.${(id % 65536).toString(16).padStart(4, "0")}`

export const bid = (priority: number, mac: number) => priority * 65536 + mac

/** Ports forwarding and blocking, step by step, for the chart. */
export function portCounts(run: StpRun): { forwarding: [number, number][]; blocking: [number, number][] } {
  const v = [...run.start]
  const count = (s: PortState) => v.reduce((a, b) => a + b.ports.filter((x) => x.state === s).length, 0)
  const forwarding: [number, number][] = [[0, count("forwarding")]]
  const blocking: [number, number][] = [[0, count("blocking")]]
  for (const e of run.events) {
    if (!e.view) continue
    v[e.bridge] = e.view
    forwarding.push([e.t, count("forwarding")])
    blocking.push([e.t, count("blocking")])
  }
  return { forwarding, blocking }
}

/** Sensed failure: a blocked port needs listening and learning. Silent: first the old information must age out. */
export const recoveryMs = (p: StpParams, detected: boolean) => (detected ? 0 : p.max_age_ms) + 2 * p.forward_delay_ms

// --- Scenarios -------------------------------------------------------------

const host = (name: string, x: number, y: number): LanNode => ({ name, kind: "host", x, y })
const sw = (name: string, x: number, y: number): LanNode => ({ name, kind: "switch", x, y })
const l = (a: number, b: number, cost = 1): LanLink => ({ a, b, cost })

const SW_BASE = { aging_us: 300, hop_us: 10, stp: false, max_sends: 400 }

/** Two switches, two hosts on each. */
export const SW_LEARN: SwitchParams = {
  ...SW_BASE,
  aging_us: 1000,
  nodes: [sw("S1", 0.3, 0.5), sw("S2", 0.7, 0.5), host("A", 0.08, 0.2), host("B", 0.08, 0.8), host("C", 0.92, 0.2), host("D", 0.92, 0.8)],
  links: [l(0, 1), l(0, 2), l(0, 3), l(1, 4), l(1, 5)],
  frames: [
    { at_us: 0, from: 2, to: 4 },
    { at_us: 100, from: 4, to: 2 },
    { at_us: 200, from: 3, to: 2 },
    { at_us: 300, from: 2, to: 5 },
  ],
}

/** A hub shares one switch port between A and B. */
export const SW_FILTER: SwitchParams = {
  ...SW_BASE,
  aging_us: 1000,
  nodes: [
    sw("S", 0.55, 0.5),
    { name: "hub", kind: "hub", x: 0.25, y: 0.5 },
    host("A", 0.06, 0.2),
    host("B", 0.06, 0.8),
    host("C", 0.92, 0.5),
  ],
  links: [l(0, 1), l(0, 4), l(1, 2), l(1, 3)],
  frames: [
    { at_us: 0, from: 3, to: 4 },
    { at_us: 100, from: 2, to: 3 },
    { at_us: 200, from: 4, to: 2 },
  ],
}

/** The learning scenario's switches, with a short ageing time and a pause. */
export const SW_AGING: SwitchParams = {
  ...SW_LEARN,
  aging_us: 250,
  frames: [
    { at_us: 0, from: 2, to: 4 },
    { at_us: 100, from: 4, to: 2 },
    { at_us: 600, from: 4, to: 2 },
  ],
}

/** Four switches, each joined to every other, a host on each. */
export const SW_STORM: SwitchParams = {
  ...SW_BASE,
  aging_us: 100_000,
  max_sends: 600,
  nodes: [
    sw("S1", 0.3, 0.25),
    sw("S2", 0.7, 0.25),
    sw("S3", 0.7, 0.75),
    sw("S4", 0.3, 0.75),
    host("A", 0.06, 0.1),
    host("B", 0.94, 0.1),
    host("C", 0.94, 0.9),
    host("D", 0.06, 0.9),
  ],
  links: [l(0, 1), l(1, 2), l(2, 3), l(3, 0), l(0, 2), l(1, 3), l(0, 4), l(1, 5), l(2, 6), l(3, 7)],
  frames: [{ at_us: 0, from: 4, to: null }],
}

/** The same loops with the spanning tree's blocked ports, and a reply from C. */
export const SW_STORM_STP: SwitchParams = {
  ...SW_STORM,
  stp: true,
  aging_us: 1000,
  frames: [
    { at_us: 0, from: 4, to: null },
    { at_us: 100, from: 6, to: 4 },
  ],
}

const STP_BASE = { hello_ms: 2000, max_age_ms: 20_000, forward_delay_ms: 15_000, delay_ms: 20, until_ms: 40_000, failure: null }
const br = (name: string, priority: number, mac: number, x: number, y: number): Bridge => ({ name, id: bid(priority, mac), x, y })

/** Five bridges: a ring with a chord, default priorities, so the lowest MAC address wins. */
export const STP_FIVE: StpParams = {
  ...STP_BASE,
  bridges: [
    br("B1", 32768, 0x0a1, 0.5, 0.12),
    br("B2", 32768, 0x0b2, 0.88, 0.42),
    br("B3", 32768, 0x0c3, 0.72, 0.88),
    br("B4", 32768, 0x0d4, 0.28, 0.88),
    br("B5", 32768, 0x0e5, 0.12, 0.42),
  ],
  links: [l(0, 1, 4), l(1, 2, 4), l(2, 3, 4), l(3, 4, 4), l(4, 0, 4), l(1, 4, 2), l(0, 2, 19)],
}

/** The same LAN; B3's root port, the link to B2, is cut at 40 s and both ends notice. */
export const STP_FAIL: StpParams = { ...STP_FIVE, until_ms: 90_000, failure: { at_ms: 40_000, link: 1, detected: true } }

/** The same cut, but silent: the ends keep their carrier and only ageing tells. */
export const STP_SILENT: StpParams = { ...STP_FAIL, until_ms: 110_000, failure: { at_ms: 40_000, link: 1, detected: false } }

/** Equal costs everywhere: R is root by priority; Z's paths through X and Y tie, and Y has two links to Z. */
export const STP_TIES: StpParams = {
  ...STP_BASE,
  bridges: [
    br("R", 4096, 0x040, 0.5, 0.12),
    br("X", 32768, 0x030, 0.18, 0.5),
    br("Y", 32768, 0x020, 0.82, 0.5),
    br("Z", 32768, 0x010, 0.5, 0.88),
  ],
  links: [l(0, 1, 4), l(0, 2, 4), l(1, 3, 4), l(2, 3, 4), l(2, 3, 4)],
}
