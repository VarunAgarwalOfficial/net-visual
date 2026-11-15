import { lazy, type ComponentType, type LazyExoticComponent } from "react"

export interface ToolInfo {
  /** Hash route and share-link prefix. */
  id: string
  title: string
  /** One plain line for the list of tools. */
  summary: string
  /** The tool's opening sentence: what it shows and what to do first, in words the page has not yet had to explain. */
  lead: string
  /** The depth layers the tool reaches, in order. */
  layers: string[]
  Component: LazyExoticComponent<ComponentType>
}

export const TOOLS: ToolInfo[] = [
  {
    id: "rdt",
    title: "Reliable data transfer",
    summary:
      "How a sender gets every message across a link that loses, delays and reorders them: stop-and-wait, Go-Back-N and Selective Repeat.",
    lead: "Press Play to watch a sender pass messages to a receiver over a link that can lose them, and see how the two notice what went missing and send it again.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./rdt/RdtTool").then((m) => ({ default: m.RdtTool }))),
  },
  {
    id: "tcp",
    title: "TCP congestion control",
    summary: "How a TCP sender finds out how fast it may send, by speeding up until packets are lost: Tahoe, Reno, NewReno and CUBIC.",
    lead: "Press Play to watch a sender on the Internet find out how fast it may send: it sends more and more until packets start to be lost, then backs off, again and again.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./tcp/TcpTool").then((m) => ({ default: m.TcpTool }))),
  },
  {
    id: "routing",
    title: "Routing: distance vector and link state",
    summary: "How routers that each know only their own links agree on the cheapest paths: distance vector and link state.",
    lead: "Press Play to watch routers, each knowing only its own links, find the cheapest path to every other router: by distance vector (telling neighbours their costs) or link state (sharing the whole map).",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./routing/RoutingTool").then((m) => ({ default: m.RoutingTool }))),
  },
  {
    id: "queue",
    title: "Queueing and delay",
    summary: "Where a packet's time goes at a router, why waiting in line grows so fast with load, and how routers decide who goes next.",
    lead: "Press Play to watch packets cross one router and see the four places their time goes: being checked by the router, waiting in line, being put onto the wire, and travelling along it.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./queue/QueueTool").then((m) => ({ default: m.QueueTool }))),
  },
  {
    id: "link",
    title: "Link layer and wireless",
    summary:
      "How many stations share one cable or radio channel, what happens when two talk at once, and how switches learn where hosts are.",
    lead: "The link layer moves a message, called a frame, across one cable or radio channel. Press Play to watch several stations share one channel, and see which frames get through and which are lost because two were sent at once.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./link/LinkTool").then((m) => ({ default: m.LinkTool }))),
  },
  {
    id: "web",
    title: "Naming and the web",
    summary: "How a computer turns a name such as www.example.com into an address, and how a web page then arrives over HTTP.",
    lead: "Press Play to watch a laptop and a phone look up the address behind a web site's name (the number, such as 203.0.113.10, that computers use to find it), and see how a remembered answer makes later lookups faster.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./web/WebTool").then((m) => ({ default: m.WebTool }))),
  },
]
