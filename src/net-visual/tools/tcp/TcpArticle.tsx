import { useMemo, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { LineChart, type Series } from "../../components/LineChart"
import { Tex, texNum } from "../../components/Tex"
import type { Netsim } from "../../core/netsim"
import { mbps, packetRate, runOverview, type TcpParams, type TcpRun } from "../../core/tcp"
import { Exercise, Layer } from "../rdt/RdtArticle"

/** A button that loads a scenario, for claims the reader can check at once. */
function Try({ id, onLoad, children }: { id: string; onLoad(id: string): void; children: ReactNode }) {
  return (
    <button type="button" className="font-sans text-sm text-link" onClick={() => onLoad(id)}>
      {children}
    </button>
  )
}

export function TcpIntro({ onLoad }: { onLoad(id: string): void }) {
  return (
    <Layer id="tcp-intuition" layer="Intuition" title="How a sender finds a rate nobody tells it">
      <p>
        No router tells a TCP sender how fast to go. It learns from one signal: packets that do not arrive. The sender keeps a{" "}
        <em>congestion window</em>, the number of segments it may have in flight, and every acknowledgement that returns is a sign that a
        packet left the network and another may enter. So the window paces the sender by the rate at which its own packets drain through the
        slowest link, the <em>bottleneck</em>. Jacobson called this the ACK clock.
      </p>
      <p>
        Two rules move the window. When everything gets through, grow: double each round trip at first (slow start), then one segment per
        round trip (congestion avoidance). When a packet is lost, shrink: halve, or start again from one. Grow slowly and shrink fast, and
        flows sharing a link settle on a fair share without ever talking to each other. Everything in this tool is a refinement of those two
        rules: how a loss is noticed (three duplicate ACKs, or the timer), what to do while it is repaired, and, for CUBIC, how to grow on
        paths where one segment per round trip is far too slow.
      </p>
      <p>
        The top chart is the whole run: the window of every flow over time. The ladder below it is every packet of flow 1 near the moment
        you are looking at, and the state diagram lights up the rule the current event obeyed. Click the chart to jump; play to watch; click
        a segment and press <kbd>D</kbd> to drop it, and the run is recomputed.
      </p>

      <h3 className="pt-2 text-lg">Misconceptions this tool is built to correct</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>“Slow start is slow.”</b> It doubles the window every round trip: exponential growth, the fastest phase TCP has. It is slow
          only beside the older practice of sending a whole window at once.{" "}
          <Try id="kr" onLoad={onLoad}>
            Watch the first second.
          </Try>
        </li>
        <li>
          <b>“Three duplicate ACKs mean three packets were lost.”</b> They mean one hole and three later segments that arrived. The receiver
          repeats its cumulative ACK for each.{" "}
          <Try id="kr" onLoad={onLoad}>
            See segment 50.
          </Try>
        </li>
        <li>
          <b>“TCP halves its window after a loss.”</b> Only after a loss found by duplicate ACKs, and only in Reno and its descendants
          (CUBIC cuts to 0.7). Tahoe and any timeout go back to one segment, and several losses in one window can cost Reno more than one
          halving.{" "}
          <Try id="fall-floyd" onLoad={onLoad}>
            Three losses in one window.
          </Try>
        </li>
        <li>
          <b>“A bigger buffer gives more throughput.”</b> Once the buffer holds a bandwidth-delay product the link never idles; past that
          the buffer adds only delay, because a loss-based sender fills whatever it is given.{" "}
          <Try id="bufferbloat" onLoad={onLoad}>
            Bufferbloat.
          </Try>
        </li>
        <li>
          <b>“Flows sharing a link get equal shares.”</b> Only if their round trips are equal. A Reno flow adds a segment per round trip, so
          a longer path grows more slowly and gets less.{" "}
          <Try id="rtt-unfair" onLoad={onLoad}>
            50 ms against 150 ms.
          </Try>
        </li>
        <li>
          <b>“The timeout is about one round trip.”</b> RFC 6298 sets it to the smoothed round trip plus four deviations, with a floor of
          one second, and doubles it after each expiry. A timeout costs many round trips of silence, which is why fast retransmit exists.
        </li>
        <li>
          <b>“CUBIC is Reno with a bigger step.”</b> CUBIC's window is a function of time since the last loss, not of round trips; the time
          to regain the old maximum, K, is the same on every path.{" "}
          <Try id="cubic" onLoad={onLoad}>
            CUBIC against Reno.
          </Try>
        </li>
      </ul>

      <h3 className="pt-2 text-lg">Hard cases</h3>
      <p>These are scenarios where the textbook rule and the protocol disagree. Each is a preset; the ladder shows the mechanism.</p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>No buffer at all.</b> The fluid model says one Reno flow gets 3/4 of the link. The packet-level flow does far worse: two
          segments released by one ACK arrive back to back, and the second finds the link busy.{" "}
          <Try id="no-buffer" onLoad={onLoad}>
            Load it.
          </Try>
        </li>
        <li>
          <b>Phase effects.</b> With no randomness at all, the short-RTT flow can lose almost every race for the last buffer slot and get
          less than the long one (Floyd and Jacobson, 1992). Three milliseconds of jitter restore the textbook order.{" "}
          <Try id="phase" onLoad={onLoad}>
            Load it.
          </Try>
        </li>
        <li>
          <b>Several losses in one window.</b> Reno leaves fast recovery on the first new ACK, halves again for the next hole, and runs out
          of duplicate ACKs (Fall and Floyd, 1996).{" "}
          <Try id="fall-floyd" onLoad={onLoad}>
            Load it.
          </Try>
        </li>
      </ul>
    </Layer>
  )
}

/** Utilisation of one flow against the buffer: simulated runs and the sawtooth formula. */
function BufferSweep({ sim, p }: { sim: Netsim; p: TcpParams }) {
  const [on, setOn] = useState(false)
  const base = useMemo<TcpParams>(() => {
    // Enough sawtooth cycles to average over, but at most 60,000 packets per run.
    const duration = Math.round(Math.min(60e6, (60_000 / packetRate(p)) * 1e6))
    return {
      ...p,
      flows: [{ algo: "newreno", rtt_us: p.flows[0].rtt_us, start_us: 0 }],
      loss: 0,
      drop_every: 0,
      jitter_us: 0,
      drops: [],
      init_ssthresh: 1e9,
      duration_us: duration,
    }
  }, [p])
  const rows = useMemo(() => {
    if (!on) return []
    const tx = (8 * base.mss_bytes * 1e6) / base.rate_bps
    const P = (base.flows[0].rtt_us + tx) / tx
    const bs = [...new Set([0, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1, 1.25].map((f) => Math.round(f * P)))]
    return bs.map((b) => {
      const r = runOverview(sim, { ...base, buffer_pkts: b })
      return { b, measured: r.totals.utilisation, formula: r.theory.reno_utilisation }
    })
  }, [on, base, sim])
  if (!on)
    return (
      <Button variant="outline" onClick={() => setOn(true)}>
        Run the sweep ({10} simulations of {(base.duration_us / 1e6).toFixed(0)} s)
      </Button>
    )
  const series: Series[] = [
    { id: "sim", label: "simulated, one NewReno flow", color: "var(--foreground)", kind: "dots", points: rows.map((r) => [r.b, r.measured]) },
    { id: "th", label: "sawtooth formula", color: "var(--foreground)", kind: "line", points: rows.map((r) => [r.b, r.formula]) },
  ]
  return (
    <LineChart
      title="Utilisation against buffer size"
      series={series}
      xLabel="buffer B (packets)"
      yLabel="utilisation"
      xFormat={(x) => x.toFixed(0)}
      yFormat={(y) => y.toFixed(2)}
      xDomain={[0, Math.max(1, ...rows.map((r) => r.b))]}
      yDomain={[0, 1.02]}
      height={260}
    />
  )
}

export function TcpAnalysis({ sim, p, run }: { sim: Netsim; p: TcpParams; run: TcpRun }) {
  const th = run.theory
  const T = run.totals
  const f0 = T.flows[0]
  const P = th.bdp_pkts
  const W = th.pipe_pkts
  const rtt0 = p.flows[0].rtt_us + th.tx_us
  const ms = (us: number) => texNum(us / 1000, 2)
  const reno = p.flows.length === 1 && p.flows[0].algo !== "cubic"
  const ratio = th.mathis_bps > 0 ? f0.goodput_bps / th.mathis_bps : 0
  const wMathis = f0.loss_rate > 0 ? Math.sqrt(8 / (3 * f0.loss_rate)) : 0

  return (
    <Layer id="tcp-analysis" layer="Analysis" title="What the window buys: three laws and their limits">
      <p>
        Every number below is computed from the settings you are running; the measured values come from the run above, over its second half
        so that start-up does not count. Change a setting and both move.
      </p>
      <div className="overflow-x-auto rounded-sm border border-border p-4 max-sm:p-3 max-sm:[&_.katex-display]:text-[0.85em]">
        <Tex
          display
        >{`\\begin{aligned} t &= \\frac{\\mathit{MSS}}{R} = \\frac{${p.mss_bytes * 8}\\ \\text{b}}{${texNum(p.rate_bps, 4)}\\ \\text{b/s}} = ${ms(th.tx_us)}\\ \\text{ms}, \\\\ P &= \\frac{\\mathit{RTT}_0 + t}{t} = \\frac{${ms(rtt0)}}{${ms(th.tx_us)}} = ${texNum(P, 1)}\\ \\text{packets} \\end{aligned}`}</Tex>
        <p className="mt-2 font-sans text-sm">
          P is the bandwidth-delay product: the packets in flight when the link is busy and the queue is empty. Adding the buffer and the
          packet being sent, the path holds W = P + B + 1 = {W.toFixed(1)} before the next arrival is dropped.
        </p>
      </div>

      <h3 className="pt-2 text-lg">Theorem 1 (the sawtooth)</h3>
      <p>
        One Reno flow on a drop-tail buffer, with no other loss, has utilisation{" "}
        <Tex>{"U = \\dfrac{3W^2/8}{P(P - W/2) + (W^2 - P^2)/2}"}</Tex> when <Tex>{"W < 2P"}</Tex>, and <Tex>U = 1</Tex> when{" "}
        <Tex>{"W \\ge 2P"}</Tex>.
      </p>
      <p>
        <em>Proof.</em> In steady state the window climbs one segment per round trip from <Tex>W/2</Tex> to <Tex>W</Tex>, where the queue
        overflows, then halves. One cycle sends the area under the window, <Tex>{"\\sum w \\approx \\int_{W/2}^{W} w\\,dw = 3W^2/8"}</Tex>{" "}
        packets, counting one round trip per step. While <Tex>{"w < P"}</Tex> the round trip is the bare <Tex>{"\\mathit{RTT}_0 + t"}</Tex>,
        which is <Tex>P</Tex> packet times, and the step lasts <Tex>P</Tex> packet times; once <Tex>{"w \\ge P"}</Tex> the queue holds{" "}
        <Tex>{"w - P"}</Tex> packets and the round trip is <Tex>w</Tex> packet times. The cycle therefore lasts{" "}
        <Tex>{"P(P - W/2) + \\int_P^W w\\,dw = P(P - W/2) + (W^2 - P^2)/2"}</Tex> packet times, during which the link could have sent that
        many packets. If <Tex>{"W/2 \\ge P"}</Tex> the window never drops below the pipe and the link never idles. ∎
      </p>
      <p className="font-sans text-sm">
        {reno ? (
          <>
            Your settings: P = {P.toFixed(1)}, B = {p.buffer_pkts}, W = {W.toFixed(1)}. The formula gives{" "}
            <b className="tabular-nums">{th.reno_utilisation.toFixed(3)}</b>; this run measured{" "}
            <b className="tabular-nums">{T.utilisation.toFixed(3)}</b>
            {p.loss > 0 || p.drop_every > 0 || p.drops.length > 0 ? " (but it has other losses, which the theorem excludes)" : ""}. With B =
            0 the formula is the classic 3/4; the model does worse, for the reason in the no-buffer hard case. The Rust test suite checks
            the formula against 120-second runs for B = 5, 20, 41 and 84 to within 0.02.
          </>
        ) : (
          <>The theorem is for one Reno-family flow; load a single Reno flow to compare it with a run.</>
        )}
      </p>
      <BufferSweep sim={sim} p={p} />
      <p>
        The corollary is the rule of thumb for router buffers: one flow needs <Tex>{"B + 1 \\ge P"}</Tex>, a bandwidth-delay product of
        buffer, to keep the link busy (Villamizar and Song, 1994). Appenzeller, Keslassy and McKeown (2004) showed that <Tex>n</Tex> flows
        whose sawtooths are out of step need only about <Tex>{"P/\\sqrt{n}"}</Tex>, since their sum varies far less than any one of them. A
        buffer larger than <Tex>P</Tex> buys nothing but delay: the bufferbloat scenario.
      </p>

      <h3 className="pt-2 text-lg">Theorem 2 (the square-root law)</h3>
      <p>
        If one packet in <Tex>{"1/p"}</Tex> is lost, periodically, and every loss is repaired by fast retransmit, Reno's long-run rate is{" "}
        <Tex>{"X = \\dfrac{\\mathit{MSS}}{\\mathit{RTT}}\\sqrt{\\dfrac{3}{2p}}"}</Tex> (Mathis, Semke, Mahdavi and Ott, 1997).
      </p>
      <p>
        <em>Proof.</em> Between losses the window climbs from <Tex>W/2</Tex> to <Tex>W</Tex> in <Tex>W/2</Tex> round trips and sends{" "}
        <Tex>{"3W^2/8"}</Tex> packets, as above. Exactly one of them is lost, so <Tex>{"3W^2/8 = 1/p"}</Tex> and{" "}
        <Tex>{"W = \\sqrt{8/(3p)}"}</Tex>. The mean window is <Tex>3W/4</Tex>, sent once per round trip, which gives the law. ∎
      </p>
      {th.mathis_bps > 0 ? (
        <p className="font-sans text-sm">
          This run: p = {f0.loss_rate.toExponential(2)} (measured), mean round trip {(f0.mean_rtt_us / 1000).toFixed(1)} ms, so the law
          gives {mbps(th.mathis_bps)} and W ≈ {wMathis.toFixed(1)}; measured goodput {mbps(f0.goodput_bps)}, a ratio of{" "}
          <b className="tabular-nums">{ratio.toFixed(2)}</b>.
        </p>
      ) : (
        <p className="font-sans text-sm">This run has no loss outside the queue; load “The square-root law” to compare.</p>
      )}
      <p>
        The simulated rate falls short of the law, and by more when loss is frequent. The proof treats the halving as instant and the window
        as a real number. In the protocol the window does not grow during the round trip of fast recovery, Reno sends nothing new for the
        first half of that round trip while the duplicates deflate the backlog, and the window is counted in whole segments. Each costs
        about a fixed amount per cycle, and a cycle lasts only <Tex>W/2</Tex> round trips, so they weigh most when <Tex>W</Tex> is small,
        that is, when <Tex>p</Tex> is large. The Rust test checks that the ratio rises as <Tex>p</Tex> falls and lies between 0.92 and 1.05
        at <Tex>p = 0.001</Tex>. Padhye, Firoiu, Towsley and Kurose (1998) add timeouts, which matter at high loss
        {th.pftk_bps > 0 ? `; their formula gives ${mbps(th.pftk_bps)} here` : ""}.
      </p>

      <h3 className="pt-2 text-lg">Theorem 3 (round trips decide the share)</h3>
      <p>
        Two Reno flows that see the same loss rate get rates in the inverse ratio of their round trips: by Theorem 2,{" "}
        <Tex>{"X_1/X_2 = \\mathit{RTT}_2/\\mathit{RTT}_1"}</Tex>. The round trips include the shared queue, which narrows the gap between
        unequal paths; synchronised losses at a drop-tail queue widen it again: Lakshman and Madhow (1997) found rates falling as{" "}
        <Tex>{"\\mathit{RTT}^{-\\alpha}"}</Tex> with <Tex>\alpha</Tex> between 1 and 2.
      </p>
      {p.flows.length === 2 && T.flows[1].goodput_bps > 0 && (
        <p className="font-sans text-sm">
          This run: rates {mbps(T.flows[0].goodput_bps)} and {mbps(T.flows[1].goodput_bps)}, a ratio of{" "}
          <b className="tabular-nums">{(T.flows[0].goodput_bps / T.flows[1].goodput_bps).toFixed(2)}</b>; measured round trips{" "}
          {(T.flows[0].mean_rtt_us / 1000).toFixed(1)} and {(T.flows[1].mean_rtt_us / 1000).toFixed(1)} ms, inverse ratio{" "}
          <b className="tabular-nums">{(T.flows[1].mean_rtt_us / Math.max(1, T.flows[0].mean_rtt_us)).toFixed(2)}</b>. Jain's index is{" "}
          {T.jain.toFixed(3)}.
        </p>
      )}
      <p>
        Chiu and Jain (1989) explain why equal round trips converge at all. Draw the two rates as a point. Additive increase moves it along
        a 45-degree line, which keeps the difference between the rates; multiplicative decrease moves it toward the origin, which shrinks
        the difference by the same factor as the sum. Each cycle the point ends nearer the fairness line, and no other combination of linear
        increase and decrease does both. The phase plane above draws exactly this.
      </p>

      <h3 className="pt-2 text-lg">CUBIC's clock</h3>
      <p>
        After a loss at window <Tex>{"W_{\\max}"}</Tex>, CUBIC sets <Tex>{"W(t) = C(t - K)^3 + W_{\\max}"}</Tex> with <Tex>C = 0.4</Tex> and
        the window cut to <Tex>{"\\beta W_{\\max}"}</Tex>, <Tex>{"\\beta = 0.7"}</Tex>. Solving <Tex>{"W(0) = \\beta W_{\\max}"}</Tex> gives{" "}
        <Tex>{"K = \\sqrt[3]{W_{\\max}(1 - \\beta)/C}"}</Tex> seconds, with no round trip in it. Reno, by contrast, needs{" "}
        <Tex>{"W_{\\max}/2"}</Tex> round trips to regain its loss.
      </p>
      <p className="font-sans text-sm">
        For a loss at the full pipe of these settings (W = {W.toFixed(0)}): CUBIC's K = {th.cubic_k_s.toFixed(2)} s; Reno needs{" "}
        {((W / 2) * (rtt0 / 1e6)).toFixed(1)} s.
      </p>

      <h3 className="pt-2 text-lg">Exercises</h3>
      <p className="font-sans text-sm text-muted-foreground">
        Ratings follow Knuth: 10 takes a minute, 20 a quarter of an hour, 30 an hour or more; M marks mathematics. The Lab tab checks five
        more against the simulation.
      </p>
      <ol className="list-decimal space-y-4 pl-5">
        <Exercise
          rating="10"
          answer={
            <p>
              About 12 segments were in flight when the third duplicate ACK arrived; ssthresh is half of that. Tahoe and Reno agree on
              ssthresh and differ only in cwnd.
            </p>
          }
        >
          In “Tahoe and Reno after one loss”, why do both algorithms set ssthresh to 6?
        </Exercise>
        <Exercise
          rating="M15"
          answer={
            <p>
              With <Tex>B = 0</Tex>, <Tex>{"W = P + 1 \\approx P"}</Tex>; the window swings between <Tex>P/2</Tex> and <Tex>P</Tex>, never
              queues, and averages <Tex>3P/4</Tex>, so <Tex>{"U = 3/4"}</Tex>. Theorem 1 gives the same: the second term of the denominator
              vanishes and <Tex>{"(3P^2/8)/(P^2/2) = 3/4"}</Tex>.
            </p>
          }
        >
          Derive the 3/4 law for a bufferless link from Theorem 1, and say which step of the proof the no-buffer scenario breaks.
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              <Tex>{"B + 1 \\ge P"}</Tex>: with the defaults (10 Mb/s, 100 ms, 1500 bytes) P = 101.2/1.2 ≈ 84.3, so B = 84. The Lab task
              “The smallest buffer for 95%” asks for less.
            </p>
          }
        >
          What is the smallest buffer that keeps one Reno flow's link always busy? Express it in packets for the default path.
        </Exercise>
        <Exercise
          rating="M20"
          answer={
            <p>
              <Tex>{"K = \\sqrt[3]{418 \\times 0.3 / 0.4} = \\sqrt[3]{313.5} \\approx 6.8"}</Tex> s. Reno regains 209 segments at one per
              100 ms round trip: about 21 s. At 10 ms Reno would need 2.1 s, while K stays 6.8 s; this is why RFC 9438 keeps the
              Reno-friendly region.
            </p>
          }
        >
          Suppose a CUBIC flow on the CUBIC scenario's path loses a packet at W_max = 418, one bandwidth-delay product. How long do CUBIC
          and Reno take to regain the window after a loss? What changes on a 10 ms path?
        </Exercise>
        <Exercise
          rating="25"
          answer={
            <p>
              When an ACK carries cwnd across a whole number, the sender may release two segments at once. With no buffer the second finds
              the link busy and is dropped. With a window of a few segments there are rarely three later segments to make duplicate ACKs, so
              the timer, with its one-second floor, does the repair.
            </p>
          }
        >
          Explain from the ladder why the no-buffer scenario falls so far below 3/4.
        </Exercise>
        <Exercise
          rating="M30"
          answer={
            <p>
              The bare round trips are 51.2 and 151.2 ms; the queue adds its mean delay q to both, so Theorem 3 predicts{" "}
              <Tex>{"(151.2 + q)/(51.2 + q)"}</Tex>, which is 3 with no queue and about 1.9 with 60 ms of queue. Read q from the mean queue
              in the totals (each packet adds 1.2 ms) and compare with the measured ratio; synchronised drops make the measured one larger.
            </p>
          }
        >
          In “A longer round trip gets less”, predict the ratio of the two rates before running it, then account for the difference.
        </Exercise>
      </ol>
    </Layer>
  )
}

export function TcpFrontier() {
  return (
    <Layer id="tcp-frontier" layer="Frontier" title="What replaced, and is replacing, these rules">
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>Selective acknowledgements.</b> SACK (RFC 2018) lets the receiver report every block it holds, and the loss recovery of RFC
          6675 repairs several holes per round trip. The Fall and Floyd scenario was the case that motivated it.
        </li>
        <li>
          <b>Loss detection by time.</b> RACK-TLP (RFC 8985) marks a segment lost when one sent after it is acknowledged and a reordering
          window has passed, and sends a tail-loss probe instead of waiting for the timer. It has replaced the three-duplicate rule as
          Linux's default.
        </li>
        <li>
          <b>Proportional rate reduction.</b> PRR (RFC 6937) spreads the window reduction over the recovery round trip instead of sending
          nothing and then a burst, the pattern visible in this tool's fast recovery.
        </li>
        <li>
          <b>Leaving slow start before the loss.</b> HyStart++ (RFC 9406) watches the round trip during slow start and switches to a gentler
          growth when it rises, avoiding the mass loss at the end of slow start that the first scenario shows.
        </li>
        <li>
          <b>Model-based control.</b> BBR (Cardwell, Cheng, Gunn, Yeganeh and Jacobson, 2016) estimates the bottleneck rate and the bare
          round trip and paces at that rate, keeping the queue near empty instead of filling it; later versions add loss and ECN as signals.
          Delay-based ancestors include Vegas (Brakmo and Peterson, 1995); Copa (Arun and Balakrishnan, 2018) targets a delay directly.
        </li>
        <li>
          <b>The network helps.</b> Active queue management (CoDel, RFC 8289; FQ-CoDel, RFC 8290; PIE, RFC 8033) drops or marks before the
          buffer is full, which cures bufferbloat without new senders. ECN (RFC 3168) marks instead of dropping; L4S (RFC 9330 to 9332)
          gives scalable senders a shallow queue with fine-grained marks.
        </li>
        <li>
          <b>Fairness, rethought.</b> Briscoe (2007) argues that equal rates per flow are the wrong goal, since a user can open many flows;
          Ware, Mukerjee, Seshan and Sherry (2019) show that judging a new algorithm by fairness to Reno blocks good designs, and propose
          judging it by the harm it does to others.
        </li>
      </ul>
    </Layer>
  )
}

export function TcpInternals() {
  return (
    <Layer id="tcp-internals" layer="Internals" title="How the simulation works">
      <p>
        The model is about 1,600 lines of Rust (crates/netsim/src/tcp.rs), compiled to WebAssembly and called through a plain C interface
        with JSON in and out. The Source tab shows it as a literate program; its lettered steps (S1 send, Q1 arrive at the router, A2 open
        the window, D2 third duplicate, F1 to F5 fast recovery, T1 timeout, R1 to R4 the timer) are the names in the trace.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          <b>Discrete events in integer microseconds.</b> Arrivals at the router, the link finishing a packet, arrivals at the receiver and
          at the sender, timer expiries and the start of each flow sit in one priority queue, with ties broken by insertion order, so a run
          is exactly reproducible from its parameters.
        </li>
        <li>
          <b>Luck that does not shift.</b> Every packet that reaches the router draws one random number, whether or not random loss is on,
          and every transmission draws its jitter. Dropping one segment changes the rest of the run only through the protocol's response,
          never through the dice.
        </li>
        <li>
          <b>Edits name packets.</b> A scripted drop is “the second transmission of segment 34 of flow 1”, so it survives changes to the
          timing and travels in the share link.
        </li>
        <li>
          <b>A window of the trace at a time.</b> A long run has millions of events. The page runs the whole model once for the curves and
          totals, then again, stopping soon after the moment you are looking at, for the events and packets of a window around it. A Rust
          test checks that a window's events are exactly those of the full run.
        </li>
        <li>
          <b>Checked against the specifications.</b> The tests check the RTO arithmetic against RFC 6298 (including the order of the RTTVAR
          and SRTT updates, which changes the answer), cwnd on entering and leaving fast recovery against RFC 5681 and RFC 6582, CUBIC's
          curve and cut against RFC 9438, Theorem 1 to 0.02, the square-root law's trend, and fairness between equal and unequal flows. The
          scenario notes, the tour and the lab checks are tested against the runs they describe.
        </li>
      </ol>
      <h3 className="pt-2 text-lg">Simplifications</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Data flows one way. ACKs return on an uncongested path and are never lost; the receiver acknowledges every segment at once (no
          delayed ACKs) and has unlimited buffer, so the advertised window never limits the sender.
        </li>
        <li>
          Connections start already open (no handshake, no teardown) and always have data to send. All segments are one size, and windows
          are counted in whole segments.
        </li>
        <li>
          No SACK, no limited transmit (RFC 3042), no HyStart, no pacing. After a timeout the sender resends from the first unacknowledged
          segment, as BSD does.
        </li>
        <li>
          If the timer fires during fast recovery, ssthresh keeps the smaller of its value and half the data in flight (the inflated window
          would otherwise raise it); the RFCs leave this case open.
        </li>
        <li>
          The bottleneck is a drop-tail FIFO with no active queue management or ECN. Losses other than overflow are independent, periodic or
          scripted, and are applied at the bottleneck, so the ladder draws a lost segment cut off halfway by convention.
        </li>
        <li>Tahoe includes fast retransmit, as 4.3BSD-Tahoe did. CUBIC uses NewReno's loss recovery, since there is no SACK.</li>
        <li>The header in the Packet tab uses relative sequence numbers, a constant window and a stand-in payload for the checksum.</li>
      </ul>
      <h3 className="pt-2 text-lg">References</h3>
      <ul className="space-y-1 text-sm">
        <li>V. Jacobson. Congestion avoidance and control. SIGCOMM 1988.</li>
        <li>
          D.-M. Chiu and R. Jain. Analysis of the increase and decrease algorithms for congestion avoidance. Computer Networks and ISDN
          Systems 17, 1989.
        </li>
        <li>
          S. Floyd and V. Jacobson. On traffic phase effects in packet-switched gateways. Internetworking: Research and Experience 3, 1992.
        </li>
        <li>C. Villamizar and C. Song. High performance TCP in ANSNET. ACM CCR 24(5), 1994.</li>
        <li>K. Fall and S. Floyd. Simulation-based comparisons of Tahoe, Reno, and SACK TCP. ACM CCR 26(3), 1996.</li>
        <li>
          M. Mathis, J. Semke, J. Mahdavi and T. Ott. The macroscopic behavior of the TCP congestion avoidance algorithm. ACM CCR 27(3),
          1997.
        </li>
        <li>
          T. V. Lakshman and U. Madhow. The performance of TCP/IP for networks with high bandwidth-delay products and random loss. IEEE/ACM
          ToN 5(3), 1997.
        </li>
        <li>
          J. Padhye, V. Firoiu, D. Towsley and J. Kurose. Modeling TCP throughput: a simple model and its empirical validation. SIGCOMM
          1998.
        </li>
        <li>G. Appenzeller, I. Keslassy and N. McKeown. Sizing router buffers. SIGCOMM 2004.</li>
        <li>S. Ha, I. Rhee and L. Xu. CUBIC: a new TCP-friendly high-speed TCP variant. ACM SIGOPS OSR 42(5), 2008.</li>
        <li>J. Gettys and K. Nichols. Bufferbloat: dark buffers in the Internet. CACM 55(1), 2012.</li>
        <li>
          N. Cardwell, Y. Cheng, C. S. Gunn, S. H. Yeganeh and V. Jacobson. BBR: congestion-based congestion control. ACM Queue 14(5), 2016.
        </li>
        <li>B. Briscoe. Flow rate fairness: dismantling a religion. ACM CCR 37(2), 2007.</li>
        <li>
          R. Ware, M. K. Mukerjee, S. Seshan and J. Sherry. Beyond Jain's fairness index: setting the bar for the deployment of congestion
          control algorithms. HotNets 2019.
        </li>
        <li>J. F. Kurose and K. W. Ross. Computer Networking: A Top-Down Approach, 8th ed., Section 3.7. Pearson, 2021.</li>
        <li>
          RFC 9293 (TCP), 5681 (congestion control), 6582 (NewReno), 6298 (RTO), 9438 (CUBIC), 2018 and 6675 (SACK), 8985 (RACK-TLP), 6937
          (PRR), 9406 (HyStart++), 3168 (ECN), 8289, 8290 and 8033 (AQM), 9330 to 9332 (L4S), 1071 (checksum).
        </li>
      </ul>
    </Layer>
  )
}
