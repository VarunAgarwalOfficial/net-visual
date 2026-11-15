// The step card's words for the routing tool. The model's event texts are
// terse ("y hears z: D_y(x) 4 via x → 6 via z"); they stay in the trace and
// the source. This builds a full sentence from the event's data instead,
// saying what happened and why, with every term spelled out.

import type { REvent, RMessage, RoutingParams, RoutingRun } from "../../core/routing"

export interface Plain {
  title: string
  text: string
  why?: string
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)

/** The messages an event sent: message m belongs to the first event whose count of messages sent passes m. */
export const sentBy = (run: RoutingRun, i: number): RMessage[] => run.messages.slice(i > 0 ? run.events[i - 1].sent : 0, run.events[i].sent)

export function plainRouting(run: RoutingRun, p: RoutingParams, i: number, dest: number): Plain {
  const e: REvent = run.events[i]
  const before = i > 0 ? run.events[i - 1] : null
  const inf = p.infinity
  const n = (v: number) => p.nodes[v]
  const x = e.node
  const ls = p.algorithm === "ls"

  const route = (d: number, h: number, y: number) =>
    d >= inf || h < 0 ? "unreachable" : h === y ? `cost ${d}, direct` : `cost ${d} through ${n(h)}`
  // What changed in router r's table at this event, destination by destination, the one on the drawing first.
  const changes = (r: number) => {
    const ys = e.changed.filter(([a]) => a === r).map(([, y]) => y)
    ys.sort((a, b) => Number(b === dest) - Number(a === dest))
    return ys.map((y) => {
      const d0 = before ? before.dist[r][y] : inf
      const h0 = before ? before.hop[r][y] : -1
      return { y, d0, h0, d1: e.dist[r][y], h1: e.hop[r][y] }
    })
  }
  const changeText = (r: number) =>
    changes(r)
      .map((c) => `to ${n(c.y)}, ${route(c.d1, c.h1, c.y)} (it was ${c.d0 >= inf ? "unreachable" : `${c.d0}`})`)
      .join("; ")
  // Why the first change came out as it did, in distance vector's terms.
  const dvWhy = (r: number, from: number) => {
    const c = changes(r)[0]
    if (!c) return undefined
    if (c.d1 >= inf) return `No neighbour now offers ${n(r)} a route to ${n(c.y)}, so ${n(c.y)} is unreachable from ${n(r)} for now.`
    const link = linkCost(c.h1)
    const sum =
      link !== null && c.h1 !== c.y && c.h1 >= 0
        ? ` The link to ${n(c.h1)} costs ${link}, and ${n(c.h1)} says it can reach ${n(c.y)} for ${c.d1 - link}: ${link} + ${c.d1 - link} = ${c.d1}.`
        : ""
    if (c.d1 < c.d0)
      return `${n(r)} keeps the cheapest offer: for each neighbour, the cost of the link to it plus that neighbour's own cost to ${n(c.y)}.${sum}`
    if (c.h1 === c.h0 && c.h1 === from)
      return `${n(r)}'s route to ${n(c.y)} already went through ${n(from)}, and ${n(from)} now reports a higher cost, so ${n(r)} must take the higher cost too.${sum}`
    return `The route ${n(r)} had got dearer or went away, so it takes the cheapest offer left.${sum}`
  }
  // The cost of the link between x and v after this event: its starting cost, then the scripted changes in order.
  function linkCost(v: number): number | null {
    let c: number | null = null
    for (const l of p.links) if ((l.a === x && l.b === v) || (l.b === x && l.a === v)) c = l.cost
    let k = 0
    const ordered = [...p.changes].map((ch, j) => ({ ch, j })).sort((a, b) => a.ch.at_us - b.ch.at_us || a.j - b.j)
    for (let j = 0; j <= i; j++)
      if (run.events[j].step === "L1") {
        const ch = ordered[k++]?.ch
        if (ch && ((ch.a === x && ch.b === v) || (ch.b === x && ch.a === v))) c = ch.cost
      }
    return c
  }

  switch (e.step) {
    case "D0":
      return {
        title: "Start",
        text: ls
          ? "Each router knows only the links it is attached to and what each one costs."
          : "Each router knows only the links it is attached to. Its table lists each neighbour at the cost of the link to it; every other router is unreachable for now.",
        why: "No router can see the whole network. Everything else it learns, it learns from messages.",
      }
    case "D3":
    case "T1": {
      const out = sentBy(run, i)
      const to = list(out.map((m) => n(m.to)))
      const poisoned = out.filter((m) => m.poisoned.length).map((m) => `to ${n(m.to)} it reports ${list(m.poisoned.map(n))} as unreachable`)
      const omitted = out.filter((m) => m.omitted.length).map((m) => `to ${n(m.to)} it leaves out ${list(m.omitted.map(n))}`)
      const timer = e.step === "T1"
      return {
        title: timer ? "The update timer fires" : "Tell the neighbours",
        text: `${timer ? `Router ${n(x)}'s update timer fires, and it` : `Router ${n(x)}`} sends its table, its cost to every router, to ${to}.`,
        why: poisoned.length
          ? `But ${list(poisoned)}, because its own route there goes through that neighbour (poisoned reverse). Otherwise the neighbour might route back through ${n(x)}.`
          : omitted.length
            ? `But ${list(omitted)}, because its own route there goes through that neighbour (split horizon).`
            : timer
              ? `With the timer on, a router repeats its whole table every ${p.period_us / 1e6} s, changed or not.`
              : "A router tells its neighbours whenever its table changes, so they can check whether a path through it is now cheaper.",
      }
    }
    case "D1":
    case "D2": {
      const m = e.message !== null ? run.messages[e.message] : null
      const from = m ? m.from : -1
      if (e.step === "D1")
        return {
          title: "Nothing cheaper",
          text: `Router ${n(x)} receives ${n(from)}'s table. Nothing in it gives a cheaper route, so ${n(x)}'s table stays as it was.`,
        }
      return {
        title: "A better route, or a worse one",
        text: `Router ${n(x)} receives ${n(from)}'s table and changes its own: ${changeText(x)}.`,
        why: dvWhy(x, from),
      }
    }
    case "L1": {
      const r = e.text.match(/^link (.+?)–(.+?) (?:now costs (\d+)|fails)/)
      const what = r
        ? r[3]
          ? `The link between ${r[1]} and ${r[2]} now costs ${r[3]}.`
          : `The link between ${r[1]} and ${r[2]} fails.`
        : e.text
      const ends = [...new Set(e.changed.map(([a]) => a))]
      return {
        title: r?.[3] ? "A link's cost changes" : "A link fails",
        text: `${what}${ends.length ? ` ${list(ends.map((a) => `${n(a)} now has ${changeText(a)}`))}.` : ""}`,
        why: "Only the two routers at its ends notice. Every other router has to be told, by messages that take time.",
      }
    }
    case "L2": {
      const m = e.message !== null ? run.messages[e.message] : null
      return {
        title: "A message is lost",
        text: m ? `Router ${n(m.from)}'s message to ${n(m.to)} is lost: the link it was crossing has failed.` : e.text,
      }
    }
    case "F1": {
      const out = sentBy(run, i)
      const lsa = out[0]?.lsa
      const links = lsa ? list(lsa.links.map(([v, c]) => `${n(v)} at ${c}`)) : ""
      return {
        title: "Describe my links",
        text: `Router ${n(x)} writes a link-state advertisement (LSA): a list of its own links${links ? `, ${links}` : ""}. It sends it to ${out.length ? list(out.map((m) => n(m.to))) : "no one: it has no working link"}.`,
        why: `Each LSA carries a number, here ${lsa ? lsa.seq : "the next"}, that grows each time ${n(x)} writes a new one, so routers can tell a newer list from an older one.`,
      }
    }
    case "F2": {
      const m = run.messages[e.message!]
      const l = m.lsa!
      const on = sentBy(run, i).map((q) => n(q.to))
      const ch = changeText(x)
      return {
        title: "A new link list arrives",
        text: `Router ${n(x)} receives ${n(l.origin)}'s list of links (LSA number ${l.seq}) for the first time. It keeps it and passes it on to ${on.length ? list(on) : "no one else"}. ${
          ch ? `Its routes change: ${ch}.` : "Its routes do not change."
        }`,
        why: "With each new list, the router runs Dijkstra's algorithm on the map it has so far to find the cheapest path to every router.",
      }
    }
    case "F3": {
      const m = run.messages[e.message!]
      const l = m.lsa!
      return {
        title: "A copy it already has",
        text: `Router ${n(x)} already holds ${n(l.origin)}'s LSA number ${l.seq}, so it drops this copy and passes it no further.`,
        why: "Dropping copies is what stops the lists from circling the network forever.",
      }
    }
    case "T2": {
      const [v, y] = e.expired ?? [-1, -1]
      const ch = changeText(x)
      return {
        title: "A route times out",
        text: `Router ${n(x)} has heard nothing new from ${n(v)} about ${n(y)} for ${p.timeout_us / 1e6} s, so it forgets that route.${ch ? ` Its table now has ${ch}.` : ""}`,
        why: "A route that is not repeated is assumed to be gone. Under split horizon this is the only way a stale route ever goes away.",
      }
    }
  }
  return { title: "", text: e.text }
}
