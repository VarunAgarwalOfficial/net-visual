import { lazy, type ComponentType, type LazyExoticComponent } from "react"

export interface ToolInfo {
  /** Hash route and share-link prefix. */
  id: string
  title: string
  summary: string
  /** The depth layers the tool reaches, in order. */
  layers: string[]
  Component: LazyExoticComponent<ComponentType>
}

export const TOOLS: ToolInfo[] = [
  {
    id: "rdt",
    title: "Reliable data transfer",
    summary: "Stop-and-wait, Go-Back-N and Selective Repeat on a channel that loses, delays and reorders.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./rdt/RdtTool").then((m) => ({ default: m.RdtTool }))),
  },
  {
    id: "tcp",
    title: "TCP congestion control",
    summary: "Tahoe, Reno, NewReno and CUBIC sharing a bottleneck: the window, every packet, the timer, and the formulas they obey.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./tcp/TcpTool").then((m) => ({ default: m.TcpTool }))),
  },
  {
    id: "routing",
    title: "Routing: distance vector and link state",
    summary:
      "Bellman-Ford exchanges and Dijkstra on the same network: every vector on the wire, count to infinity, poisoned reverse and its limits.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./routing/RoutingTool").then((m) => ({ default: m.RoutingTool }))),
  },
  {
    id: "queue",
    title: "Queueing and delay",
    summary:
      "M/M/1 and M/D/1 packet by packet against their formulas, the four delays of a hop, token and leaky buckets, and FIFO, priority and WFQ against GPS.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./queue/QueueTool").then((m) => ({ default: m.QueueTool }))),
  },
  {
    id: "link",
    title: "Link layer and wireless",
    summary:
      "ALOHA against its formulas, CSMA/CD on a space-time diagram with binary exponential backoff, and 802.11 CSMA/CA with hidden and exposed terminals, RTS/CTS and the NAV.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./link/LinkTool").then((m) => ({ default: m.LinkTool }))),
  },
  {
    id: "web",
    title: "Naming and the web",
    summary:
      "DNS lookups on a message ladder, with caches, TTLs, negative caching and stale answers; then page loads over HTTP/1.0, 1.1, 2 and 3, with handshakes, parallel connections, pipelining and head-of-line blocking in the application and the transport.",
    layers: ["intuition", "mechanics", "analysis", "frontier", "internals"],
    Component: lazy(() => import("./web/WebTool").then((m) => ({ default: m.WebTool }))),
  },
]
