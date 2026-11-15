import { useMemo, type ReactNode } from "react"

import { Tex } from "../../components/Tex"
import type { Netsim } from "../../core/netsim"
import { clock, forwardingTo, periodic, type RoutingParams, type RoutingRun } from "../../core/routing"
import { Exercise, Layer } from "../rdt/RdtArticle"

/** A button that loads a scenario, for claims the reader can check at once. */
function Try({ id, onLoad, children }: { id: string; onLoad(id: string): void; children: ReactNode }) {
  return (
    <button type="button" className="font-sans text-sm text-[var(--link)] underline underline-offset-2" onClick={() => onLoad(id)}>
      {children}
    </button>
  )
}

export function RoutingIntro({ onLoad }: { onLoad(id: string): void }) {
  return (
    <Layer id="routing-intuition" layer="Intuition" title="Two ways to find the cheapest path without a map-maker">
      <p>
        Every router must decide, for every destination, which neighbour to hand a packet to. Nobody computes this for it. There are two
        classic answers. In <em>link state</em> routing (OSPF, IS-IS) every router floods the costs of its own links to every other router,
        so each ends up with the whole map and runs Dijkstra's algorithm on it. In <em>distance vector</em> routing (RIP) a router never
        sees the map at all: it tells its neighbours only how far it thinks every destination is, and believes what they tell it.
      </p>
      <p>
        Distance vector rests on one equation. If my neighbour v can reach y for <Tex>{"D_v(y)"}</Tex>, then I can reach y through v for{" "}
        <Tex>{"c(x,v) + D_v(y)"}</Tex>, so my best is the least of those sums over my neighbours:
      </p>
      <Tex display>{"D_x(y) = \\min_{v}\\,\\bigl(c(x,v) + D_v(y)\\bigr)"}</Tex>
      <p>
        That is the Bellman-Ford equation. A router recomputes it whenever a neighbour's vector arrives or one of its links changes, and if
        the answer changed it tells its neighbours. The card beside the graph shows the sum for the router and destination you pick, with
        the numbers that router holds at that moment. The danger is that the numbers it holds can be stale, and nothing in the equation
        knows where a neighbour's number came from. That is the story of count to infinity.
      </p>

      <h3 className="pt-2 text-lg">Misconceptions this tool is built to correct</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>“Each router works out the whole path.”</b> In distance vector a router knows only a cost and a next hop for each destination.
          The path exists only as the chain of next hops, drawn as arrows in the graph.{" "}
          <Try id="six" onLoad={onLoad}>
            Six routers.
          </Try>
        </li>
        <li>
          <b>“Link state and distance vector find different routes.”</b> On the same costs both find least-cost paths. Once the vectors
          settle they equal Dijkstra's answers; the table marks any cell that does not, and on a settled network there are none. Only ties
          can be broken differently.{" "}
          <Try id="six" onLoad={onLoad}>
            Compare them.
          </Try>
        </li>
        <li>
          <b>“The rounds need a common clock.”</b> They do not. Routers act on whatever arrives, in whatever order, and the tables still end
          correct (Bertsekas and Gallager prove this for any delays, provided the costs stop changing).{" "}
          <Try id="async" onLoad={onLoad}>
            Unequal delays.
          </Try>
        </li>
        <li>
          <b>“Count to infinity needs a link to fail.”</b> A cost rise is enough. When x–y goes from 4 to 60, y and z bounce a stale route
          between them for 46 rounds before z's own link at 50 wins.{" "}
          <Try id="bad-news" onLoad={onLoad}>
            Bad news.
          </Try>
        </li>
        <li>
          <b>“Bad news is slow because messages are slow.”</b> The number of rounds depends on the costs, not on the delay: each round the
          stale route grows by one link's cost, so the gap between 4 and 50 sets the count. Double the delay in the settings under Go deeper
          and the count of rounds does not move.
        </li>
        <li>
          <b>“Poisoned reverse cures count to infinity.”</b> It stops a router offering a route back to the neighbour it goes through, which
          breaks every loop of two. A loop of three routers passes the stale route round and poisoned reverse does not see it (RFC 2453,
          Section 3.4.4).{" "}
          <Try id="loop-of-three" onLoad={onLoad}>
            Loop of three.
          </Try>
        </li>
        <li>
          <b>“Infinity should be a large number.”</b> It is the opposite: RIP's infinity is 16 so that counting ends quickly. The price is
          that no route may be longer than 15 hops.{" "}
          <Try id="cut-off" onLoad={onLoad}>
            Count to 16.
          </Try>
        </li>
        <li>
          <b>“Link state cannot loop.”</b> While a change floods, routers that have heard it and routers that have not compute from
          different maps, and their next hops can form a loop until the news arrives. The loop is short, one flooding delay rather than a
          count, but packets do circle (RFC 5715).{" "}
          <Try id="ls-microloop" onLoad={onLoad}>
            A microloop.
          </Try>
        </li>
        <li>
          <b>“Split horizon and poisoned reverse are the same thing.”</b> Split horizon leaves a route out of what the next hop is told;
          poisoned reverse sends it as infinity. Silence carries no news, so under plain split horizon a neighbour keeps the stale route it
          heard earlier until a timer expires it, and a loop can last minutes (RFC 2453, Section 3.4.3).{" "}
          <Try id="split-horizon" onLoad={onLoad}>
            Split horizon.
          </Try>{" "}
          <Try id="poison" onLoad={onLoad}>
            Poisoned reverse.
          </Try>
        </li>
      </ul>

      <h3 className="pt-2 text-lg">Hard cases</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>A transient forwarding loop.</b> In the six-router network with unequal delays, the failure of x–y reaches routers at different
          moments, and for a while some router's next hop points at a neighbour whose next hop points back. The caption under the graph
          turns red and names the loop.{" "}
          <Try id="six-failure" onLoad={onLoad}>
            Load it.
          </Try>
        </li>
        <li>
          <b>Counting in real time.</b> With RIP's 30-second timer and no triggered updates, each step of the count waits for a neighbour's
          next update. The count to 16 that takes milliseconds in the cut-off scenario takes nearly seven minutes.{" "}
          <Try id="rip-slow" onLoad={onLoad}>
            Load it.
          </Try>
        </li>
        <li>
          <b>Three routers deceiving one another.</b> With poisoned reverse on, b, c and d still count to 16, three at a time, because each
          stale offer goes to a router the offer does not run through.{" "}
          <Try id="loop-of-three" onLoad={onLoad}>
            Load it.
          </Try>
        </li>
      </ul>
    </Layer>
  )
}

/** n(2m - n + 1): the LSAs a cold start floods on the network before any change. */
function flood(p: RoutingParams, run: RoutingRun): number {
  const n = p.nodes.length
  const m = run.epochs[0].cost.flat().filter((c) => c >= 0).length / 2
  return n * (2 * m - n + 1)
}

/** Fewest links among the cheapest paths between any two routers, before any change. */
function hopBound(p: RoutingParams, run: RoutingRun): number {
  const n = p.nodes.length
  const { cost, shortest } = run.epochs[0]
  let H = 0
  for (let s = 0; s < n; s++) {
    // Settle routers in order of distance; ties do not matter for the hop count.
    const order = [...Array(n).keys()].filter((v) => shortest[s][v] < p.infinity).sort((a, b) => shortest[s][a] - shortest[s][b])
    const hops = Array<number>(n).fill(Infinity)
    hops[s] = 0
    for (const v of order) {
      if (v === s) continue
      for (let u = 0; u < n; u++)
        if (cost[u][v] >= 0 && shortest[s][u] + cost[u][v] === shortest[s][v]) hops[v] = Math.min(hops[v], hops[u] + 1)
      H = Math.max(H, hops[v])
    }
  }
  return H
}

export function RoutingAnalysis({ p, run }: { sim: Netsim; p: RoutingParams; run: RoutingRun; onLoad(id: string): void }) {
  const stats = useMemo(() => {
    const H = hopBound(p, run)
    const end0 = run.epochs[1]?.t ?? Infinity
    const settled = run.events.filter((e) => e.t < end0 && e.changed.length > 0).reduce((t, e) => Math.max(t, e.t), 0)
    let loopTime = 0
    let loopEvents = 0
    run.events.forEach((e, i) => {
      const looped = p.nodes.some((_, y) => forwardingTo(e.hop, y).cycles.length > 0)
      if (!looped) return
      loopEvents++
      loopTime += (run.events[i + 1]?.t ?? e.t) - e.t
    })
    return { H, settled, loopTime, loopEvents }
  }, [p, run])

  return (
    <Layer id="routing-analysis" layer="Analysis" title="Why the equation works, how fast, and when it lies">
      <h3 className="pt-2 text-lg">Theorem 1 (optimal substructure)</h3>
      <p>
        If every link cost is positive, the least cost <Tex>{"d(x,y)"}</Tex> satisfies{" "}
        <Tex>{"d(x,y) = \\min_v \\bigl(c(x,v) + d(v,y)\\bigr)"}</Tex> over the neighbours v of x, for every <Tex>{"x \\ne y"}</Tex>.
      </p>
      <p>
        <em>Proof.</em> Any path from x to y leaves x along some link to a neighbour v, and its remaining part is a path from v, so it costs
        at least <Tex>{"c(x,v) + d(v,y)"}</Tex>; hence <Tex>{"d(x,y) \\ge"}</Tex> the minimum. Conversely, for each v, going to v and then
        along a cheapest path from v is a path from x to y, so <Tex>{"d(x,y) \\le c(x,v) + d(v,y)"}</Tex> for every v. ∎
      </p>
      <p>
        So the true costs are a fixed point of the update every router performs. The theorem says nothing about how fast the estimates get
        there, or whether they get there from wrong starting values: the next two results answer that.
      </p>

      <h3 className="pt-2 text-lg">Theorem 2 (the synchronous hop bound)</h3>
      <p>
        Start every router cold, knowing only its own links, and let all messages take one round. After round k, each estimate{" "}
        <Tex>{"D_x(y)"}</Tex> equals the cost of the cheapest path from x to y that uses at most <Tex>{"k+1"}</Tex> links. So the tables are
        correct by round <Tex>{"H-1"}</Tex>, where H is the most links that any pair's cheapest path needs.
      </p>
      <p>
        <em>Proof.</em> By induction on <Tex>{"k"}</Tex>. At round 0 a router knows its links, which are the paths of one link. At round{" "}
        <Tex>{"k+1"}</Tex> <Tex>{"x"}</Tex> combines the vectors its neighbours sent after round <Tex>{"k"}</Tex>: by hypothesis{" "}
        <Tex>{"D_v(y)"}</Tex> is the cheapest path from <Tex>{"v"}</Tex> of at most <Tex>{"k+1"}</Tex> links, and a path from{" "}
        <Tex>{"x"}</Tex> of at most <Tex>{"k+2"}</Tex> links is a first link to some <Tex>{"v"}</Tex> followed by such a path, so the
        minimum is the cheapest of them. A cheapest path of <Tex>{"H"}</Tex> links is found at round <Tex>{"H-1"}</Tex>, and nothing cheaper
        exists to be found later. ∎
      </p>
      <p className="font-sans text-sm">
        {p.algorithm === "ls" ? (
          <>
            Your network: H = {stats.H}. This run uses link state, which the theorem is not about; switch the settings under Go deeper to
            distance vector to compare.
          </>
        ) : periodic(p) ? (
          <>
            Your network: H = {stats.H}. This run has RIP's timers on, so updates follow the clock rather than rounds; turn the update
            period off in the settings under Go deeper to compare.
          </>
        ) : p.jitter_us === 0 ? (
          <>
            Your network: H = {stats.H}, so the bound is round {Math.max(0, stats.H - 1)}. The run's last table change before any scripted
            change is at {clock(stats.settled, p)}. The Rust tests check this bound on the six-router network.
          </>
        ) : (
          <>
            Your network: H = {stats.H}. This run has unequal delays, so there are no rounds and the theorem does not apply; set the jitter
            to 0 in the settings under Go deeper to compare.
          </>
        )}
      </p>
      <p>
        Good news obeys the same bound: a cheaper link is a new short path, and it spreads one link per round like any other. Bad news does
        not, because the old, cheaper estimates are still in every table, and the equation will happily build on them.
      </p>

      <h3 className="pt-2 text-lg">Theorem 3 (the rate of the count)</h3>
      <p>
        Suppose that after a change routers <Tex>{"r_1, \\dots, r_L"}</Tex> form a cycle of next hops towards y (each <Tex>{"r_i"}</Tex>{" "}
        forwards to <Tex>{"r_{i+1}"}</Tex>, and <Tex>{"r_L"}</Tex> to <Tex>{"r_1"}</Tex>) whose links cost <Tex>{"C"}</Tex> in total, and
        that none of them has an offer cheaper than the ones from the cycle. Then in synchronous rounds every router on the cycle raises its
        estimate by exactly <Tex>{"C"}</Tex> every <Tex>{"L"}</Tex> rounds, until one of them meets a genuine alternative or infinity.
      </p>
      <p>
        <em>Proof.</em> While <Tex>{"r_i"}</Tex>'s best offer comes from <Tex>{"r_{i+1}"}</Tex>, a change in <Tex>{"D_{r_{i+1}}(y)"}</Tex>{" "}
        at round <Tex>{"k"}</Tex> reaches <Tex>{"r_i"}</Tex> at round <Tex>{"k+1"}</Tex>, which sets{" "}
        <Tex>{"D_{r_i}(y) = c(r_i, r_{i+1}) + D_{r_{i+1}}(y)"}</Tex>. So the change travels round the cycle against the arrows, one hop per
        round, gaining each link's cost as it goes; after <Tex>{"L"}</Tex> hops it is back where it started, <Tex>{"C"}</Tex> higher. ∎
      </p>
      <p>
        Counting from an estimate d to infinity therefore takes about <Tex>{"L(\\infty - d)/C"}</Tex> rounds. For unit costs that is{" "}
        <Tex>{"\\infty - d"}</Tex> rounds whatever the cycle's length, and it is why RIP's infinity is 16. In the bad-news scenario{" "}
        <Tex>{"L = 2"}</Tex> and <Tex>{"C = 2"}</Tex>: the estimates climb 6, 7, 8, …, one of y or z a round, until z's direct link at 50
        undercuts the climb, 47 updates in all. In the loop of three <Tex>{"L = C = 3"}</Tex> and each router's estimate rises by 3, as the
        trace shows (with poisoned reverse, a router briefly reports infinity between steps). In general the count stops at the cheapest
        genuine alternative, which is why the tool's lab can bound it by making infinity small.
      </p>
      <p className="font-sans text-sm">
        This run: some router's next hops form a loop at {stats.loopEvents} of {run.events.length} events, for{" "}
        {periodic(p)
          ? `${Number((stats.loopTime / 1e6).toFixed(1))} s`
          : p.jitter_us === 0
            ? `${stats.loopTime / p.delay_us} round${stats.loopTime === p.delay_us ? "" : "s"}`
            : `${(stats.loopTime / 1000).toFixed(1)} ms`}{" "}
        in total. A packet sent then would circle until its TTL ran out.
      </p>

      <h3 className="pt-2 text-lg">Theorem 4 (Dijkstra)</h3>
      <p>
        With non-negative costs, when step K2 adds w to <Tex>{"N'"}</Tex>, its label <Tex>{"D(w)"}</Tex> is the least cost from the source.
        Dijkstra's algorithm on n routers takes <Tex>{"O(n^2)"}</Tex> time with the plain scan used here, or{" "}
        <Tex>{"O((n + m)\\log n)"}</Tex> with a heap on m links.
      </p>
      <p>
        <em>Proof.</em> Every label is the cost of a real path through <Tex>{"N'"}</Tex>, so <Tex>{"D(w) \\ge d(w)"}</Tex>. Take any path
        from the source to w and let u be its first router outside <Tex>{"N'"}</Tex>. The part up to u runs inside <Tex>{"N'"}</Tex> and
        ends with a link that step K3 relaxed, so it costs at least <Tex>{"D(u)"}</Tex>, and <Tex>{"D(u) \\ge D(w)"}</Tex> because K2 chose
        w. The rest of the path costs at least 0. So every path to w costs at least <Tex>{"D(w)"}</Tex>. Each of the n iterations scans all
        n labels, giving <Tex>{"O(n^2)"}</Tex>. ∎
      </p>
      <p>
        The comparison that matters in practice is not the computation but the messages. Link state floods every router's links to every
        router, so each change costs a message on every link, and every router then holds the whole map. Distance vector sends only to
        neighbours but may need many rounds, and, as Theorem 3 shows, the number of rounds after bad news depends on the costs rather than
        the size of the network.
      </p>

      <h3 className="pt-2 text-lg">Theorem 5 (the cost of flooding)</h3>
      <p>
        On a connected network of n routers and m links, flooding one LSA sends exactly <Tex>{"2m - n + 1"}</Tex> messages, whatever the
        delays. A cold start, in which every router floods one, sends <Tex>{"n(2m - n + 1)"}</Tex>.
      </p>
      <p>
        <em>Proof.</em> Every router forwards the LSA once, on the first copy it receives, and drops the rest (steps F2 and F3). The origin
        sends it on all of its <Tex>{"\\deg(o)"}</Tex> links; every other router v sends it on every link but the one it came in on,{" "}
        <Tex>{"\\deg(v) - 1"}</Tex>. Summing, <Tex>{"\\sum_v \\deg(v) - (n - 1) = 2m - n + 1"}</Tex>. ∎
      </p>
      <p className="font-sans text-sm">
        {p.algorithm === "ls" ? (
          <>
            This run: n = {p.nodes.length}, m = {run.epochs[0].cost.flat().filter((c) => c >= 0).length / 2}, so a cold start costs{" "}
            {flood(p, run)} LSAs if the network is connected. Before any change the run sent{" "}
            {run.messages.filter((m) => m.t_send < (run.epochs[1]?.t ?? Infinity)).length}.
          </>
        ) : (
          <>Switch the settings under Go deeper to link state to count the LSAs of this network; the six-router preset sends 6 × 15 = 90.</>
        )}
      </p>
      <p>
        The price buys independence. A link-state router computes from descriptions written by the routers themselves, never from another
        router's conclusions, so stale news cannot be amplified: once the last LSA about a change has arrived everywhere, every route is
        right. Until then two routers can hold different maps, and a router that has heard can point at one that has not. In the microloop
        scenario b, which sees its own link fail, turns to a while a still routes through b; the loop lasts exactly one flooding delay. A
        loop needs disagreement, so its length is bounded by how long the news takes to spread, not by the costs as in Theorem 3.
      </p>

      <h3 className="pt-2 text-lg">Timers: what RIP adds</h3>
      <p>
        With an update period P and no triggered updates, a change travels one hop per update instead of one per message delay, so the
        rounds of Theorems 2 and 3 become periods. In the cut-off scenario with P = 30 s, b's route climbs by 2 every two periods and
        reaches 16 about seven minutes after the failure; the Rust tests check every step. Triggered updates bring back the speed of rounds,
        and RIP rate-limits them to one every 1 to 5 seconds so that a change does not set off a storm (RFC 2453, Section 3.10.1).
      </p>
      <p>
        Timeouts are how a router forgets a neighbour that says nothing. Under simple split horizon this matters: a route left out of an
        update is not withdrawn, so a stale entry survives until the timeout, 180 s in RIP, and a loop that poisoned reverse would break at
        once can last that long. RFC 2453 states the trade directly: poisoned reverse breaks such loops at once, at the price of larger
        updates.
      </p>

      <h3 className="pt-2 text-lg">Exercises</h3>
      <ol className="list-decimal space-y-3 pl-5">
        <Exercise rating="10" answer={<p>D_x(y) = 2 and D_x(z) = min(7, 2 + 1) = 3, through y.</p>}>
          In the three-router network, what does x's table hold after one round?
        </Exercise>
        <Exercise
          rating="M20"
          answer={
            <p>
              If every table is correct and x forwards to v for y, then D(x) = c(x,v) + D(v) &gt; D(v), since c is positive. Going round a
              loop of next hops the estimate would strictly fall at every step and return to its starting value, which is impossible.
            </p>
          }
        >
          Prove that once every table is correct, no forwarding loop can exist. Where does the argument need positive costs?
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              Z − 3 for any Z from 6 to 59: the climb runs from 6 up to Z, then z switches to its direct link and y follows. For Z = 20 that
              is 17 updates. Set it in the settings under Go deeper and read the count from the chart, or from the trace.
            </p>
          }
        >
          In the bad-news scenario, change the cost of x–z from 50 to Z. How many updates to y's and z's routes to x follow the rise?
        </Exercise>
        <Exercise
          rating="M25"
          answer={
            <p>
              No. If z routes to x through y it reports infinity to y, so y cannot pick z; if z routes directly, its offer is genuine. A
              loop of two needs each to offer the other a route through itself, which is exactly what is poisoned. A loop of three needs no
              such offer, which is why the loop-of-three scenario still counts.
            </p>
          }
        >
          With poisoned reverse, can two adjacent routers ever form a loop of next hops after a change? Can three?
        </Exercise>
        <Exercise
          rating="25"
          answer={
            <p>
              The longest cheapest path in the loop of three has 2 links, so any infinity of 3 or more keeps every real route reachable;
              with infinity 3 every offer through the loop already costs 3 or more, so the tables settle one round after the failure. RIP
              makes the same trade with 16 and a 15-hop limit.
            </p>
          }
        >
          What is the smallest infinity that keeps the loop-of-three network correct before the failure, and how fast does it then settle?
          (The lab checks your answer.)
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              2m − n + 1 = 2(n − 1) − n + 1 = n − 1: on a tree no LSA is ever dropped, because each router hears it exactly once. On the
              complete graph, m = n(n − 1)/2, so it is (n − 1)², and a cold start costs n(n − 1)².
            </p>
          }
        >
          How many messages does flooding one LSA cost on a tree of n routers? On the complete graph?
        </Exercise>
        <Exercise
          rating="M25"
          answer={
            <p>
              Before the failure a routes to d through b, so 1 + 1 &lt; 3. Afterwards b's only route is through a. A loop needs both, so it
              forms exactly when c(a,b) + c(b,d) &lt; c(a,d); with c(a,b) + c(b,d) &gt; c(a,d) a already goes direct and nothing points
              back. This is the loop-free alternate inequality of RFC 5286 with a as the alternate for b. (A tie leaves it to the
              tie-break.)
            </p>
          }
        >
          In the microloop scenario, for which starting costs does the loop form? (The lab checks one answer.)
        </Exercise>
      </ol>
    </Layer>
  )
}

export function RoutingFrontier() {
  return (
    <Layer id="routing-frontier" layer="Frontier" title="What real routing protocols do instead">
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>RIP.</b> RFC 2453 is this tool's distance vector with timers: a full table every 30 seconds, a route dropped after 180 seconds
          without news, split horizon with poisoned reverse, and triggered updates delayed by a random 1 to 5 seconds so that one change
          does not set off a storm. Infinity is 16.
        </li>
        <li>
          <b>OSPF and IS-IS.</b> Link state as deployed (RFC 2328; ISO 10589 with RFC 1195). Link-state advertisements carry sequence
          numbers and ages so old news cannot overwrite new, are flooded reliably and refreshed every 30 minutes, and large networks are
          split into areas so that each router holds only part of the map.
        </li>
        <li>
          <b>Loop-free distance vector.</b> DUAL (Garcia-Luna-Aceves, 1993), the core of EIGRP (RFC 7868), only switches to a neighbour
          whose reported cost is below its own last best, a feasibility condition that rules out loops at every instant; when no neighbour
          qualifies it asks them all and waits. Babel (RFC 8966) and DSDV (Perkins and Bhagwat, 1994) use sequence numbers for the same end.
        </li>
        <li>
          <b>Path vector.</b> BGP (RFC 4271) advertises the whole list of networks a route passes through, so a router rejects any route
          that already contains itself. That kills count to infinity but not slow convergence: Labovitz, Ahuja, Bose and Jahanian (2000)
          measured minutes to settle after a route was withdrawn, as routers explore ever longer paths.
        </li>
        <li>
          <b>Costs that depend on load.</b> If a link's cost is its current traffic, link state oscillates: everyone moves to the cheap
          path, which becomes dear. The ARPANET met this after its 1980 move to link state (McQuillan, Richer and Rosen) and damped it with
          a revised metric (Khanna and Zinky, 1989).
        </li>
        <li>
          <b>Repair before convergence.</b> IP fast reroute precomputes a loop-free alternate neighbour for each destination (RFC 5286), so
          a router can switch in milliseconds while the protocol is still converging.
        </li>
        <li>
          <b>Central computation.</b> Software-defined networks gather the map at a controller that computes routes and installs them, as in
          Google's B4 (Jain et al., 2013). Consistent updates then become the hard problem: moving every switch to the new routes without a
          transient loop.
        </li>
      </ul>
    </Layer>
  )
}

export function RoutingInternals() {
  return (
    <Layer id="routing-internals" layer="Internals" title="How the simulation works">
      <p>
        The model is about 1,000 lines of Rust (crates/netsim/src/routing.rs, plus its tests), compiled to WebAssembly and called with JSON
        in and out, like the other tools. Its lettered steps are the names in the trace: D0 initialise, D1 receive, D2 recompute, D3
        advertise, T1 update timer, T2 time out; F1 originate an LSA, F2 flood it, F3 discard a copy, F4 run Dijkstra on a router's own map;
        L1 change a link, L2 lose a message; and K1 to K3 for Dijkstra on the true network.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          <b>Discrete events in integer microseconds.</b> Arrivals and link changes sit in one queue. Messages sent at one instant all
          arrive before anyone answers them, so with no jitter the exchange runs in exact rounds. Jitter is drawn from a seeded generator,
          and messages on one link never overtake one another.
        </li>
        <li>
          <b>Triggered updates, and optionally RIP's timers.</b> A router sends a neighbour its vector when what it would tell that
          neighbour differs from what it told it last; a cold start counts as a change. With an update period it also sends its whole vector
          every period (with jitter, each interval is the period plus or minus a sixth, as RFC 2453 asks), triggered updates can be turned
          off, and an entry not repeated within the timeout becomes unreachable.
        </li>
        <li>
          <b>Ties do not flap.</b> When two neighbours offer the same cost, a router keeps its current next hop if it is among them;
          otherwise the lowest-numbered one wins. Dijkstra, given a tie in step K2, adds the lowest-numbered router.
        </li>
        <li>
          <b>Link state, flooded.</b> Each LSA carries its origin, a sequence number and the origin's links. A router keeps the newest LSA
          from each origin, passes a new one to every neighbour but the sender, and runs Dijkstra on its own map, using a link between two
          other routers only if both of their LSAs list it (RFC 2328, Section 16.1). When a link comes up its two ends send each other the
          LSAs they hold, as OSPF's database exchange does.
        </li>
        <li>
          <b>The truth for comparison.</b> Between any two link changes the model also runs Dijkstra from every router on the true costs,
          and the page marks each table entry that disagrees.
        </li>
        <li>
          <b>Checked against the sources.</b> The tests reproduce Dijkstra's table for the six-router network of Kurose and Ross, the
          three-router exchange, the 47 updates of bad news and the three of poisoned reverse, the count to 16 of RFC 2453, the loop of
          three that poisoned reverse misses, the hop bound of Theorem 2, and agreement with Dijkstra on 40 random networks with failures
          and repairs, for both algorithms. For link state they check the 2m − n + 1 messages of Theorem 5 and the one-delay microloop; for
          the timers, the count to 16 at two periods a step and the split-horizon loop that lasts until the timeout. The scenario notes, the
          tour and the labs are tested against the runs they describe.
        </li>
      </ol>
      <h3 className="pt-2 text-lg">Simplifications</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          A router learns of a failure on its own link at once. Timers are off unless set in the settings under Go deeper; when on,
          triggered updates are not rate-limited, and there is no garbage-collection or hold-down timer.
        </li>
        <li>
          Each distance-vector router keeps the last vector heard from every neighbour, the textbook model; RIP keeps only its best route.
          This is why, under plain split horizon, a stale offer survives until the timeout.
        </li>
        <li>
          Link state has no ageing, refresh or acknowledgement of LSAs; flooding is reliable because only a failing link loses messages.
          Dijkstra runs the moment an LSA arrives, with no SPF delay, and a router uses its own links before the database exchange ends.
        </li>
        <li>Costs are symmetric and fixed between scripted changes; there is no load-dependent cost.</li>
        <li>A message in flight on a link that fails is lost; messages are otherwise never lost or corrupted.</li>
      </ul>
      <h3 className="pt-2 text-lg">References</h3>
      <ul className="space-y-1 text-[0.95rem]">
        <li>R. Bellman. On a routing problem. Quarterly of Applied Mathematics 16, 1958.</li>
        <li>L. R. Ford and D. R. Fulkerson. Flows in Networks. Princeton, 1962.</li>
        <li>E. W. Dijkstra. A note on two problems in connexion with graphs. Numerische Mathematik 1, 1959.</li>
        <li>D. Bertsekas and R. Gallager. Data Networks, 2nd ed., Chapter 5. Prentice Hall, 1992.</li>
        <li>
          J. M. McQuillan, I. Richer and E. C. Rosen. The new routing algorithm for the ARPANET. IEEE Trans. Communications 28(5), 1980.
        </li>
        <li>A. Khanna and J. Zinky. The revised ARPANET routing metric. SIGCOMM 1989.</li>
        <li>
          P. Francois and O. Bonaventure. Avoiding transient loops during the convergence of link-state routing protocols. IEEE/ACM ToN
          15(6), 2007.
        </li>
        <li>J. J. Garcia-Luna-Aceves. Loop-free routing using diffusing computations. IEEE/ACM ToN 1(1), 1993.</li>
        <li>C. E. Perkins and P. Bhagwat. Highly dynamic destination-sequenced distance-vector routing (DSDV). SIGCOMM 1994.</li>
        <li>C. Labovitz, A. Ahuja, A. Bose and F. Jahanian. Delayed Internet routing convergence. SIGCOMM 2000.</li>
        <li>S. Jain et al. B4: experience with a globally-deployed software defined WAN. SIGCOMM 2013.</li>
        <li>J. F. Kurose and K. W. Ross. Computer Networking: A Top-Down Approach, 8th ed., Sections 5.2 to 5.3. Pearson, 2021.</li>
        <li>
          RFC 2453 (RIP 2), 2328 (OSPF 2), 1195 (IS-IS for IP), 7868 (EIGRP), 8966 (Babel), 4271 (BGP 4), 5286 (loop-free alternates), 5715
          (loop-free convergence).
        </li>
      </ul>
    </Layer>
  )
}
