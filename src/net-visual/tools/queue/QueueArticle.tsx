import { useMemo, type ReactNode } from "react"

import { Tex, texNum } from "../../components/Tex"
import type { Netsim } from "../../core/netsim"
import {
  bps,
  envelopeExcess,
  isSingleQueue,
  offered,
  propUs,
  releases,
  shares,
  theory,
  transUs,
  us,
  type QueueParams,
  type QueueRun,
} from "../../core/queue"
import { Exercise, Layer } from "../rdt/RdtArticle"
import { burstOf, lmax, shapedFlow } from "./QueueViews"

/** A button that loads a scenario, for claims the reader can check at once. */
function Try({ id, onLoad, children }: { id: string; onLoad(id: string): void; children: ReactNode }) {
  return (
    <button type="button" className="font-sans text-sm text-[var(--link)] underline underline-offset-2" onClick={() => onLoad(id)}>
      {children}
    </button>
  )
}

export function QueueIntro({ onLoad }: { onLoad(id: string): void }) {
  return (
    <Layer id="queue-intuition" layer="Intuition" title="Where the time goes, and why waiting dominates">
      <p>
        A packet crossing one hop is delayed four times. The router must look at it (<em>processing</em>: checking the header, looking up
        the output port). It must wait for the packets ahead of it on that port (<em>queueing</em>). It must be pushed onto the wire one bit
        at a time, which takes its length over the link's rate, <Tex>{"L/R"}</Tex> (<em>transmission</em>). And its bits must cross the
        distance at the speed of signals in the medium, <Tex>{"d/s"}</Tex> (<em>propagation</em>). Three of the four are fixed by hardware
        and geography. Queueing is the one that changes from packet to packet, from nothing to most of the delay, and it is the subject of
        nearly everything else here.
      </p>
      <p>
        Queues form because work arrives unevenly. A link that is busy 70% of the time is idle 30% of the time, but the idle stretches do
        not come when the bursts need them, and time the link spends idle can never be saved up for later. Queueing theory turns that
        observation into numbers: for random arrivals the wait grows as <Tex>{"\\rho/(1-\\rho)"}</Tex>, where <Tex>{"\\rho"}</Tex> is the
        fraction of time the link is busy, so it doubles between 50% and 67% load and is unbounded as the load approaches 100%.
      </p>
      <p>
        Two further tools act on queues rather than suffer them. A <em>shaper</em> at the edge of the network (a token bucket or a leaky
        bucket) limits how bursty a flow may be, so that whoever carries it can promise a delay. A <em>scheduler</em> at the output port
        decides who goes next: first come first served, the most urgent class first, or each flow in proportion to a weight. The three modes
        above follow that order.
      </p>

      <h3 className="pt-2 text-lg">Misconceptions this tool is built to correct</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>“A faster link gets the packet there sooner, whatever the distance.”</b> Rate shortens transmission, L/R; it does nothing to
          propagation, d/s. Across 2000 km a 1500-byte packet spends 1.2 ms going onto a 10 Mb/s wire and 10 ms crossing it; at 10 Gb/s the
          first falls to 1.2 µs and the second stays 10 ms.{" "}
          <Try id="four-delays" onLoad={onLoad}>
            Four delays.
          </Try>
        </li>
        <li>
          <b>“Queues only form when the link is overloaded.”</b> At 70% load the M/M/1 system holds 2.3 packets on average, and more than
          ten about 2% of the time. Randomness alone builds queues: what matters is that arrivals bunch, not that they exceed the rate.{" "}
          <Try id="mm1" onLoad={onLoad}>
            M/M/1 at 70%.
          </Try>
        </li>
        <li>
          <b>“Delay grows in proportion to load.”</b> It grows as <Tex>{"1/(1-\\rho)"}</Tex>. From 50% to 95% load the mean time in the
          system rises from 2 to 20 service times, ten times as much for less than twice the traffic.{" "}
          <Try id="heavy" onLoad={onLoad}>
            95% load.
          </Try>
        </li>
        <li>
          <b>“Only the average rate matters.”</b> The variability of the work matters too. With the same arrivals and the same mean packet
          size, equal sizes halve the wait in the queue (Pollaczek-Khinchine).{" "}
          <Try id="md1" onLoad={onLoad}>
            M/D/1.
          </Try>
        </li>
        <li>
          <b>“A bigger buffer is always better.”</b> A buffer cannot create capacity. Under overload it fills, and from then on every packet
          waits for the whole buffer to drain: the buffer's size, not the traffic, sets the delay. This is bufferbloat.{" "}
          <Try id="overload" onLoad={onLoad}>
            Overload.
          </Try>
        </li>
        <li>
          <b>“A token bucket caps the rate at r.”</b> It caps every interval of length t at <Tex>{"b + rt"}</Tex>: a flow that has been
          quiet may send b bytes at once. That is the point: r is the long-run rate, b the burst the network agrees to absorb.{" "}
          <Try id="token-shape" onLoad={onLoad}>
            Token bucket.
          </Try>
        </li>
        <li>
          <b>“Token bucket and leaky bucket are two names for one thing.”</b> A leaky bucket lets nothing out faster than r, ever; its
          bucket is a queue for packets. A token bucket's bucket stores permission, and lets a burst through at full speed.{" "}
          <Try id="leaky" onLoad={onLoad}>
            Leaky bucket.
          </Try>
        </li>
        <li>
          <b>“Priority makes the network faster.”</b> It moves waiting from one class to another; it cannot remove any. Kleinrock's
          conservation law makes this exact for work-conserving schedulers: a load-weighted average of the waits is the same under every
          order. Voice gains a lot here only because it is a tiny part of the load.{" "}
          <Try id="priority" onLoad={onLoad}>
            Priority.
          </Try>
        </li>
        <li>
          <b>“Fair queueing sends the flows' packets in turn.”</b> Round robin over packets favours flows with big packets. WFQ shares bytes
          in proportion to weight, so a flow of 100-byte packets sends fifteen of them for each 1500-byte packet of an equal-weight flow.{" "}
          <Try id="wfq-shares" onLoad={onLoad}>
            WFQ shares.
          </Try>
        </li>
        <li>
          <b>“A well-behaved flow is safe in a FIFO queue.”</b> FIFO shares the link in proportion to demand, so the flow that sends most
          gets most and everyone waits behind its backlog.{" "}
          <Try id="fifo-greedy" onLoad={onLoad}>
            FIFO and a greedy flow.
          </Try>{" "}
          <Try id="wfq-greedy" onLoad={onLoad}>
            WFQ and the same flow.
          </Try>
        </li>
      </ul>

      <h3 className="pt-2 text-lg">Hard cases</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>Policing instead of shaping.</b> The same token bucket that delays packets can drop them instead. Nothing is held, so the
          shaper adds no delay, but half of each burst is lost, and a TCP sender would read every loss as congestion.{" "}
          <Try id="token-police" onLoad={onLoad}>
            Load it.
          </Try>
        </li>
        <li>
          <b>Strict priority with a heavy urgent class.</b> In Setup, give voice 1000-byte packets at 900 a second and more of them: it now
          needs 90% of the link, and bulk gets only what voice leaves. Strict priority has no notion of a share.{" "}
          <Try id="priority" onLoad={onLoad}>
            Start from priority.
          </Try>
        </li>
        <li>
          <b>WFQ when a flow goes quiet.</b> A flow with nothing waiting is skipped, and its share goes to the others in proportion to their
          weights. Shorten flow c in the WFQ scenario and watch a and b speed up once it is done.{" "}
          <Try id="wfq-shares" onLoad={onLoad}>
            Start from WFQ.
          </Try>
        </li>
      </ul>
    </Layer>
  )
}

export function QueueMechanics() {
  return (
    <Layer id="queue-mechanics" layer="Mechanics" title="What happens to one packet, step by step">
      <p>
        The trace names each step by its letter, and the Source tab shades the code behind it. A packet's life is the same in every mode;
        the modes change which steps matter.
      </p>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <b>G1, generate.</b> Before the run, each flow draws its creation times (Poisson, periodic or bursts) and sizes from seeded random
          streams of its own, so changing the scheduler or the link replays exactly the same packets.
        </li>
        <li>
          <b>A1, arrive.</b> The packet is created at its source. With no shaper it leaves for the router at once.
        </li>
        <li>
          <b>B1, token bucket.</b> Tokens arrive at r and the bucket holds at most b bytes of them. A packet that finds enough tokens, with
          nobody held ahead of it, spends them and goes. Otherwise a shaper holds it in line until the tokens for its whole length have
          arrived; a policer drops it.
        </li>
        <li>
          <b>B2, leaky bucket.</b> The packet joins a queue of at most b bytes that drains at exactly r, so it leaves when every byte ahead
          of it and its own have drained. One that would overfill the bucket is dropped.
        </li>
        <li>
          <b>P1, process and join.</b> After the processing time the packet reaches the output queue. If the buffer is full it is dropped
          (drop-tail); otherwise it joins.
        </li>
        <li>
          <b>W1 and W2, fair-queueing bookkeeping.</b> Whatever the discipline, the model runs the fluid ideal, GPS, alongside, so every
          packet gets a finish tag and a GPS finishing time. W2 advances GPS's virtual time; W1 stamps the joining packet.
        </li>
        <li>
          <b>S1, choose and start.</b> When the link is free it takes the waiting packet that comes first: the earliest to join (FIFO), the
          most urgent class (priority), or the smallest finish tag (WFQ). The first bit goes onto the wire.
        </li>
        <li>
          <b>S2, last bit out.</b> L/R later the last bit is on the wire and the link takes the next packet.
        </li>
        <li>
          <b>R1, reach.</b> d/s after that the last bit arrives. The Packets tab lists each packet's four delays, and the card above the
          tabs adds them up.
        </li>
      </ol>
      <p>
        On the path, the queue is drawn with the next packet to go on the right, in the order the discipline will send them, so under
        priority or WFQ a packet that has just joined can appear ahead of older ones. The block in the transmitter shrinks as the packet's
        bits go out; on the wire each packet is a bar as long as the stretch of link its bits occupy, which is <Tex>{"s \\cdot L/R"}</Tex>{" "}
        metres. When that exceeds the link's length the packet's first bit arrives before its last has left.
      </p>
    </Layer>
  )
}

export function QueueAnalysis({ p, run }: { sim: Netsim; p: QueueParams; run: QueueRun; onLoad(id: string): void }) {
  const s = run.stats
  const th = theory(p)
  const single = isSingleQueue(p)
  const shaping = useMemo(() => {
    const k = shapedFlow(p)
    const f = p.flows[k]
    if (f.shaper.kind === "none") return null
    const b = burstOf(p, k)
    return { f, b, tight: envelopeExcess(releases(run, k), f.shaper.rate_bps) }
  }, [p, run])
  const m = lmax(p, run)
  const late = Math.max(0, ...run.packets.filter((q) => q.t_depart !== null).map((q) => q.t_depart! - q.gps_finish))
  const sh = useMemo(() => (p.flows.length > 1 ? shares(p, run) : null), [p, run])

  return (
    <Layer id="queue-analysis" layer="Analysis" title="Six results that explain the numbers">
      <h3 className="pt-2 text-lg">Theorem 1 (Little's law)</h3>
      <p>
        In any system that packets enter and leave, if over a long stretch of time the arrival rate is <Tex>{"\\lambda"}</Tex>, the mean
        time a packet spends inside is <Tex>{"W"}</Tex> and the time-average number inside is <Tex>{"L"}</Tex>, then{" "}
        <Tex>{"L = \\lambda W"}</Tex>. No assumption is made about the arrivals, the sizes or the order of service (Little, 1961).
      </p>
      <p>
        <em>Proof (for a run that starts and ends empty).</em> Draw, for each packet, a bar from the moment it enters to the moment it
        leaves. The area under the curve of the number inside, over the run of length <Tex>{"T"}</Tex>, is the total length of the bars,
        since at each instant the curve's height is the number of bars crossing it. The area is <Tex>{"L T"}</Tex>; the total length of n
        bars is <Tex>{"n W"}</Tex>. So <Tex>{"L T = n W"}</Tex>, and dividing by <Tex>{"T"}</Tex> with <Tex>{"\\lambda = n/T"}</Tex> gives
        the law. A run that does not end empty differs only by the bars cut off at the edges, which vanish relative to <Tex>{"T"}</Tex> when
        the system is stable (Stidham, 1974). ∎
      </p>
      <p className="font-sans text-sm">
        This run, counting from time zero until the last packet leaves the link: λ = {s.lambda_pps.toFixed(2)} per second, W ={" "}
        {us(s.system_us)}, so λW = {((s.lambda_pps * s.system_us) / 1e6).toFixed(4)}, and the measured time average is L = {s.l.toFixed(4)}.
        The equality is exact because this run ends empty; the Rust tests check it to nine digits.
      </p>

      <h3 className="pt-2 text-lg">Theorem 2 (M/M/1)</h3>
      <p>
        With Poisson arrivals at rate <Tex>{"\\lambda"}</Tex>, exponential service times of mean <Tex>{"1/\\mu"}</Tex>, one server and{" "}
        <Tex>{"\\rho = \\lambda/\\mu < 1"}</Tex>, the number in the system in equilibrium is geometric,{" "}
        <Tex>{"P(N = n) = (1-\\rho)\\rho^n"}</Tex>, so
      </p>
      <div className="flex flex-wrap justify-center gap-x-10">
        <Tex display>{"L = \\frac{\\rho}{1-\\rho},"}</Tex>
        <Tex display>{"W = \\frac{L}{\\lambda} = \\frac{1}{\\mu - \\lambda},"}</Tex>
        <Tex display>{"W_q = W - \\frac{1}{\\mu} = \\frac{\\rho}{\\mu - \\lambda}."}</Tex>
      </div>
      <p>
        <em>Proof.</em> Both distributions are memoryless, so the number in the system alone determines the future: it is a birth-death
        chain that goes up at rate <Tex>{"\\lambda"}</Tex> and, when positive, down at rate <Tex>{"\\mu"}</Tex>. In equilibrium the flow
        across the cut between n and n + 1 balances, <Tex>{"\\lambda\\, p_n = \\mu\\, p_{n+1}"}</Tex>, so <Tex>{"p_n = \\rho^n p_0"}</Tex>;
        the probabilities sum to 1 only if <Tex>{"\\rho < 1"}</Tex>, giving <Tex>{"p_0 = 1-\\rho"}</Tex>. The mean of this geometric
        distribution is <Tex>{"\\rho/(1-\\rho)"}</Tex>, and Little's law gives W. ∎
      </p>
      <p>
        Two readings matter in practice. Delay depends on the spare capacity <Tex>{"\\mu - \\lambda"}</Tex>, not on <Tex>{"\\mu"}</Tex>{" "}
        itself, which is why the buy-bandwidth lab gets a 40% cut in delay from a 20% faster link. And the probability that the link is busy
        is exactly <Tex>{"\\rho"}</Tex>, so utilisation and delay cannot be chosen separately.
      </p>
      <p className="font-sans text-sm">
        {single && th.w !== null ? (
          <>
            This run is {th.model} at ρ = {th.rho.toFixed(3)}: theory gives W = {us(th.w)} and L = {th.l!.toFixed(3)}; the run measured W ={" "}
            {us(s.system_us)} and L = {s.l.toFixed(3)} over {s.served} packets. The W against ρ tab runs up to a hundred thousand packets
            per load.
          </>
        ) : (
          <>
            This run is not a single Poisson queue (offered load {(100 * offered(p)).toFixed(0)}%), so the theorem does not apply to it
            directly; load the M/M/1 scenario to compare.
          </>
        )}
      </p>

      <h3 className="pt-2 text-lg">Theorem 3 (Pollaczek-Khinchine)</h3>
      <p>
        With Poisson arrivals and service times S of any distribution (M/G/1), served in order of arrival with <Tex>{"\\rho < 1"}</Tex>,
      </p>
      <Tex display>{"W_q = \\frac{\\lambda\\, E[S^2]}{2(1-\\rho)}."}</Tex>
      <p>
        <em>Proof (by mean values).</em> An arriving packet waits for the work already there: the remainder of the packet in service, plus
        everything queued. Poisson arrivals see time averages, so the expected number queued is <Tex>{"L_q = \\lambda W_q"}</Tex>, each
        needing <Tex>{"E[S]"}</Tex>, and the expected remainder of the packet in service is <Tex>{"R_0 = \\lambda E[S^2]/2"}</Tex> (the
        server is busy with probability <Tex>{"\\rho"}</Tex>, and a random moment falls in a service of length S with probability
        proportional to S, leaving on average half of it). So <Tex>{"W_q = R_0 + \\lambda W_q E[S] = R_0 + \\rho W_q"}</Tex>, and solving
        gives the formula. ∎
      </p>
      <p>
        For exponential service <Tex>{"E[S^2] = 2/\\mu^2"}</Tex> and the formula gives M/M/1's <Tex>{"\\rho/(\\mu(1-\\rho))"}</Tex>. For
        fixed service <Tex>{"E[S^2] = 1/\\mu^2"}</Tex>, so M/D/1 waits <Tex>{"W_q = \\rho/(2\\mu(1-\\rho))"}</Tex>: exactly half. The wait
        grows with the second moment, so a mix of small and large packets waits longer than packets all of the mean size. Kingman's
        approximation extends the picture to general arrivals:{" "}
        <Tex>{"W_q \\approx \\frac{\\rho}{1-\\rho} \\cdot \\frac{c_a^2 + c_s^2}{2} \\cdot E[S]"}</Tex>, with <Tex>{"c^2"}</Tex> the squared
        coefficients of variation of the gaps and the service times; Poisson arrivals have <Tex>{"c_a^2 = 1"}</Tex>.
      </p>

      <h3 className="pt-2 text-lg">Theorem 4 (priority and conservation)</h3>
      <p>
        With Poisson classes served by non-preemptive strict priority, class 1 most urgent, and{" "}
        <Tex>{"\\sigma_k = \\rho_1 + \\dots + \\rho_k"}</Tex>, the mean wait of class k is (Cobham, 1954)
      </p>
      <div className="flex flex-wrap justify-center gap-x-10">
        <Tex display>{"W_{q,k} = \\frac{R_0}{(1-\\sigma_{k-1})(1-\\sigma_k)},"}</Tex>
        <Tex display>{"R_0 = \\sum_i \\frac{\\lambda_i E[S_i^2]}{2}."}</Tex>
      </div>
      <p>
        <em>Proof sketch.</em> A class-k packet waits for the remainder <Tex>{"R_0"}</Tex> of whatever is in service, for the work of
        classes 1 to k already queued, and for the work of classes 1 to k − 1 that arrives while it waits. The same mean-value argument as
        in Theorem 3 gives <Tex>{"W_{q,k} = R_0 + \\sum_{i \\le k} \\rho_i W_{q,i} + \\sigma_{k-1} W_{q,k}"}</Tex>, and induction on k
        solves it. ∎
      </p>
      <p>
        Multiply each class's wait by its load and add: <Tex>{"\\sum_k \\rho_k W_{q,k} = \\rho R_0/(1-\\rho)"}</Tex>, which does not depend
        on the order of the classes. That is Kleinrock's conservation law, and it holds for every scheduler that never idles while work
        waits and does not choose by service time within a class: favouring one class must cost the others. The Rust tests check Cobham's
        formula for two classes to within 3%, and with equal packet sizes check that FIFO, priority and WFQ give exactly the same total
        wait.
      </p>

      <h3 className="pt-2 text-lg">Theorem 5 (the token bucket's arrival curve)</h3>
      <p>
        Whatever the source does, the bytes a token bucket with rate r and depth b releases in any interval <Tex>{"[s, t]"}</Tex> satisfy{" "}
        <Tex>{"A(s,t) \\le b + r(t-s)"}</Tex>.
      </p>
      <p>
        <em>Proof.</em> Every byte released spends a token. At s the bucket holds at most b tokens, and during the interval at most{" "}
        <Tex>{"r(t-s)"}</Tex> more arrive; tokens are never created any other way. So no more than <Tex>{"b + r(t-s)"}</Tex> bytes can be
        released. ∎
      </p>
      <p>
        Such a flow is called <Tex>{"(\\sigma, \\rho)"}</Tex>-constrained, with <Tex>{"\\sigma = b"}</Tex> and <Tex>{"\\rho = r"}</Tex>{" "}
        (Cruz, 1991). A server that guarantees the flow a rate <Tex>{"g \\ge r"}</Tex> then delays none of its bytes by more than{" "}
        <Tex>{"b/g"}</Tex>, because in the worst case the whole burst arrives at once and drains at g. A leaky bucket is the special case
        that admits a burst of only one packet.
      </p>
      <p className="font-sans text-sm">
        {shaping ? (
          <>
            This run: flow {shaping.f.name}'s {shaping.f.shaper.kind === "token" ? "token" : "leaky"} bucket at{" "}
            {bps(shaping.f.shaper.rate_bps)} released traffic that fits <Tex>{"b + rt"}</Tex> with b as small as {Math.ceil(shaping.tight)}{" "}
            bytes
            {shaping.b !== null ? `, against the guarantee of ${shaping.b}.` : "."} The Rust tests check every interval of a run in exact
            integers.
          </>
        ) : (
          <>No flow in this run has a shaper; load the token-bucket scenario to see the bound measured.</>
        )}
      </p>

      <h3 className="pt-2 text-lg">Theorem 6 (Parekh and Gallager)</h3>
      <p>
        GPS serves every flow with packets waiting at once, flow i at rate <Tex>{"R\\, w_i / \\sum_{j \\in B} w_j"}</Tex> over the set B of
        backlogged flows. It cannot be built, because a link sends one packet at a time, but it can be computed. WFQ (also called PGPS)
        sends whole packets in the order they would finish under GPS. If <Tex>{"F_p"}</Tex> is packet p's GPS finishing time and{" "}
        <Tex>{"\\hat F_p"}</Tex> its WFQ finishing time, then for every packet
      </p>
      <Tex display>{"\\hat F_p \\le F_p + \\frac{L_{\\max}}{R}."}</Tex>
      <p>
        <em>Proof sketch.</em> Take a busy period, which is the same in both systems since both are work-conserving. Let p leave WFQ, and
        let m be the last packet before p that WFQ sent with a later GPS finish than p, so that from m's start every packet WFQ sent up to p
        finishes in GPS no later than p. Those packets arrived after m began, otherwise WFQ would have chosen them instead; so GPS had to do
        all their work, and p's, after m began, and finished it by <Tex>{"F_p"}</Tex>. WFQ does the same work after m ends, so it finishes
        at most m's transmission time, at most <Tex>{"L_{\\max}/R"}</Tex>, later. If there is no such m, WFQ is never behind. ∎
      </p>
      <p>
        Two consequences follow. Each flow's bytes sent under WFQ never fall more than <Tex>{"L_{\\max}"}</Tex> behind its bytes under GPS,
        so shares track the weights to within a packet. And a flow shaped by a token bucket <Tex>{"(b, r)"}</Tex> and given weight enough
        that its guaranteed rate <Tex>{"g_i = R\\, w_i/\\sum_j w_j"}</Tex> is at least r has its delay bounded by{" "}
        <Tex>{"b/g_i + L_{\\max}/R"}</Tex>, whatever the other flows do. That pairing, a shaper at the edge and WFQ inside, is the basis of
        guaranteed service in the Internet's Integrated Services architecture (RFC 2212).
      </p>
      <p className="font-sans text-sm">
        This run: the largest packet is {m.L} bytes, so <Tex>{`L_{\\max}/R = ${texNum(m.us / 1000)}`}</Tex> ms. The latest any packet left
        behind its GPS finish is {us(late)}
        {p.discipline === "wfq"
          ? late <= m.us + 1e-6
            ? ", within the bound."
            : ", outside it."
          : `, under ${p.discipline === "fifo" ? "FIFO" : "priority"}, which offers no such bound.`}
        {sh &&
          ` Bytes shares up to ${us(sh.until)}: ${sh.share.map((x, k) => `${p.flows[k].name} ${(100 * x).toFixed(1)}%`).join(", ")}; the weights promise ${sh.fair.map((x) => `${(100 * x).toFixed(1)}%`).join(", ")}.`}
      </p>

      <h3 className="pt-2 text-lg">Exercises</h3>
      <ol className="list-decimal space-y-3 pl-5">
        <Exercise
          rating="10"
          answer={
            <p>
              L/R = 12,000 / 10⁷ = 1.2 ms; d/s = 2 × 10⁶ / 2 × 10⁸ = 10 ms. With the 20 µs of processing and no wait, the first packet
              reaches the far end at 11.22 ms, as the tour's second stop shows.
            </p>
          }
        >
          In the four-delays scenario, compute the first packet's transmission and propagation delays and the moment it arrives.
        </Exercise>
        <Exercise
          rating="15"
          answer={
            <p>
              Each packet needs 1.2 ms of link but they come 0.9 ms apart, so packet k joins at 0.9k ms and starts at 1.2k ms: it waits 0.3k
              ms. The sixth waits 1.5 ms. The queue grows without bound if the train goes on, because ρ = 1.2/0.9 &gt; 1.
            </p>
          }
        >
          In the same scenario, how long does the k-th packet wait, and what happens if the train never ends?
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              At ρ = 0.5, W = 2/μ; at 0.9, W = 10/μ; at 0.99, W = 100/μ. Going from 0.9 to 0.99 adds 10% more traffic and multiplies the
              delay by ten. Run the W against ρ tab to see the dots follow.
            </p>
          }
        >
          Compute the M/M/1 mean time in the system at ρ = 0.5, 0.9 and 0.99, in service times.
        </Exercise>
        <Exercise
          rating="M20"
          answer={
            <p>
              <Tex>{"E[S^2] = \\mathrm{Var}(S) + E[S]^2"}</Tex>, so <Tex>{"W_q = \\frac{\\rho E[S]}{2(1-\\rho)}(1 + c_s^2)"}</Tex>, where{" "}
              <Tex>{"c_s^2 = \\mathrm{Var}(S)/E[S]^2"}</Tex>. Exponential service has <Tex>{"c_s^2 = 1"}</Tex>, fixed has 0: the ratio is 2.
            </p>
          }
        >
          Write the Pollaczek-Khinchine formula in terms of the coefficient of variation of the service time, and read off the ratio of the
          M/M/1 and M/D/1 waits.
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              The burst is 10,000 bytes over 10 ms; the last packet arrives at 9.5 ms and must leave by 14.5 ms. By then the bucket must
              have supplied all 10,000 bytes: b + 2 × 10⁶/8 × 0.0145 = b + 3625 ≥ 10,000, so b ≥ 6375 bytes. Each earlier packet gives a
              weaker condition, so the last one decides. The lab checks it.
            </p>
          }
        >
          A source sends 20 packets of 500 bytes in 10 ms every 50 ms. What is the smallest bucket at r = 2 Mb/s that holds no packet longer
          than 5 ms?
        </Exercise>
        <Exercise
          rating="M25"
          answer={
            <p>
              R₀ = λ₁E[S₁²]/2 + λ₂E[S₂²]/2. With ρ₁ = 0.3 and ρ₂ = 0.4 of exponential service at 1 ms, R₀ = 0.7 ms; class 1 waits 0.7/0.7 =
              1 ms and class 2 waits 0.7/(0.7 × 0.3) = 3.33 ms. The load-weighted sum 0.3 × 1 + 0.4 × 3.33 = 1.63 ms equals ρR₀/(1 − ρ) =
              0.7 × 0.7/0.3 = 1.63 ms, as conservation requires.
            </p>
          }
        >
          Two Poisson classes with exponential service of mean 1 ms have loads 0.3 (urgent) and 0.4. Find each class's mean wait under
          non-preemptive priority and check the conservation law.
        </Exercise>
        <Exercise
          rating="25"
          answer={
            <p>
              Under GPS the three flows get 1/7, 2/7 and 4/7 of 8 Mb/s while all are backlogged, so a's 1500-byte packets finish every 10.5
              ms, b's 500-byte ones every 1.75 ms and c's 100-byte ones every 175 µs. WFQ sends in that order, so between two of a's packets
              it sends six of b's and sixty of c's: bytes in the ratio 1 : 2 : 4.
            </p>
          }
        >
          In the WFQ scenario, how many of b's and c's packets go between two consecutive packets of a, and why?
        </Exercise>
        <Exercise
          rating="M30"
          answer={
            <p>
              Under FIFO a flow's share is set by demand, so the polite flow gets 2.4/(2.4 + 16) of the link while the queue grows, about
              13%, far less than its 2.4 Mb/s, and its packets wait behind a backlog growing at 10.4 Mb/s. Under WFQ with equal weights its
              guaranteed rate is 4 Mb/s ≥ 2.4 Mb/s, and its packets are evenly spaced (b = one packet), so by Theorem 6 its delay is at most
              L/g + L_max/R = 2 ms + 1 ms. In the run no polite packet waits more than 1 ms, the time to finish one greedy packet already on
              the wire.
            </p>
          }
        >
          Explain the polite flow's waits in the two greedy-flow scenarios, and bound its delay under WFQ before running it.
        </Exercise>
      </ol>
      <p className="font-sans text-xs text-muted-foreground">
        Ratings follow Knuth: 10 takes a minute, 20 a quarter of an hour, 30 longer; M marks mathematics. Current link: L/R for{" "}
        {p.flows[0].size_bytes} bytes = {us(transUs(p.flows[0].size_bytes, p.rate_bps))}, d/s = {us(propUs(p))}.
      </p>
    </Layer>
  )
}

export function QueueFrontier() {
  return (
    <Layer id="queue-frontier" layer="Frontier" title="What happened to queues in the real Internet">
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>Bufferbloat.</b> Memory became cheap faster than links became fast, and home routers, modems and phones shipped with buffers
          holding seconds of traffic. TCP fills whatever buffer it is given before it sees a loss, so a single upload could add seconds of
          delay to everything else on the link (Gettys and Nichols, 2011). The overload scenario is the effect in miniature: the buffer, not
          the traffic, sets the delay.
        </li>
        <li>
          <b>How big should a buffer be?</b> The old rule was one bandwidth-delay product, so that a single TCP flow keeps the link busy
          while it recovers from a loss (Villamizar and Song, 1994). Appenzeller, Keslassy and McKeown (2004) showed that n desynchronised
          flows need only about <Tex>{"RTT \\cdot C/\\sqrt{n}"}</Tex>, which for a backbone link is a small fraction of the old rule.
        </li>
        <li>
          <b>Active queue management.</b> Drop-tail, the policy modelled here, signals congestion only when the buffer is full. RED (Floyd
          and Jacobson, 1993) drops early with a probability that grows with the average queue, but proved hard to tune. CoDel (Nichols and
          Jacobson, 2012; RFC 8289) watches instead how long packets have waited: if the minimum wait over a 100 ms interval stays above a 5
          ms target, it starts dropping, and drops more often the longer the condition lasts. PIE (RFC 8033) estimates the queueing delay
          from the departure rate and steers a drop probability towards a target delay with a controller.
        </li>
        <li>
          <b>Fair queueing, made cheap.</b> Exact WFQ needs GPS's virtual time, which is expensive to track. Self-clocked fair queueing
          (Golestani, 1994) uses the tag of the packet in service instead; deficit round robin (Shreedhar and Varghese, 1995) gives each
          queue a quantum of bytes per round in constant time per packet. WF²Q (Bennett and Zhang, 1996) only sends packets that have
          already started under GPS, which stops a flow running far ahead of its fluid share, a gap WFQ allows.
        </li>
        <li>
          <b>fq_codel.</b> The default queue discipline on most Linux distributions (set by systemd) and in OpenWrt combines the two ideas
          (RFC 8290): flows are hashed into many queues served by deficit round robin, each queue runs CoDel, and a queue that has just
          become active is served first, so short flows such as DNS lookups and game traffic overtake bulk transfers.
        </li>
        <li>
          <b>Traffic contracts.</b> Token buckets are how operators write down what a customer may send. RFC 2697 and RFC 2698 define
          two-bucket markers that colour packets green, yellow or red; Differentiated Services (RFC 2475) maps the colours to per-hop
          behaviours such as Expedited Forwarding, a strict-priority class for voice (RFC 3246).
        </li>
        <li>
          <b>Network calculus.</b> Theorem 5's arrival curves and the matching service curves of schedulers compose along a path, giving
          worst-case end-to-end delay bounds without any probability at all (Cruz, 1991; Le Boudec and Thiran, 2001). Time-Sensitive
          Networking for industrial Ethernet uses this kind of bound.
        </li>
        <li>
          <b>Real traffic is not Poisson.</b> Measured LAN and WAN traffic is bursty on every time scale, from milliseconds to hours
          (Leland, Taqqu, Willinger and Wilson, 1994; Paxson and Floyd, 1995), and file sizes are heavy-tailed. Queues under such traffic
          are longer than M/M/1 predicts at the same load, which is one reason networks are run well below full utilisation.
        </li>
        <li>
          <b>L4S.</b> Low Latency, Low Loss, Scalable throughput (RFC 9330 to RFC 9332) separates traffic from scalable congestion
          controllers into a shallow queue that marks packets with ECN at a sub-millisecond threshold, coupled to a classic queue so that
          the two share the link fairly.
        </li>
      </ul>
    </Layer>
  )
}

export function QueueInternals() {
  return (
    <Layer id="queue-internals" layer="Internals" title="How the simulation works, and what it leaves out">
      <p>
        The model is about 1,100 lines of Rust (crates/netsim/src/queue.rs, with its tests), compiled to WebAssembly and called with JSON in
        and out, like the other tools. It is a discrete-event simulation of one output port: a priority queue of timed events (arrive,
        tokens ready, join, finish sending, reach) processed in time order. The page then replays the recorded events; nothing on screen is
        computed by a second, separate model, except the formulas it compares against.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          <b>Integer microseconds.</b> All times are whole microseconds. Transmission times are rounded to the nearest microsecond, so very
          small packets on very fast links are slightly off. The M/M/1 tests use 8 Mb/s, where a byte takes exactly 1 µs, so only the
          rounding of sizes to whole bytes remains.
        </li>
        <li>
          <b>Exact token buckets.</b> Tokens are counted in bits times 10⁶, so refilling at r bits per second adds exactly r per microsecond
          and conformance to <Tex>{"b + rt"}</Tex> is checked without rounding. A token bucket requires fixed packet sizes and starts full.
        </li>
        <li>
          <b>GPS in floating point.</b> The fluid system runs beside every discipline with virtual time in bits per unit of weight, advanced
          at <Tex>{"R/\\sum w"}</Tex> over the backlogged flows and recomputed each time a flow empties. Its finishing times are therefore
          floating-point microseconds; the tests allow 10⁻⁶ µs of slack.
        </li>
        <li>
          <b>Seeded randomness.</b> Arrival times and sizes come from a fixed-seed generator, separate streams per flow, so a run is exactly
          repeatable and changing the scheduler sends the same packets. Exponential sizes are rounded to whole bytes, at least one.
        </li>
        <li>
          <b>Statistics.</b> Means are over delivered packets. L is the time average of the number in the system from time zero to the last
          departure, and λ is the number delivered over the same span, which is why Little's law holds exactly. The runs start empty, so
          short runs at high load understate the long-run mean: the warm-up is included.
        </li>
      </ol>
      <h3 className="pt-2 text-lg">Simplifications</h3>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>One output port and one link; the rest of the network is out of view, and nothing is lost or corrupted on the wire.</li>
        <li>
          Processing takes a fixed time per packet, and packets are processed in parallel, so processing never queues. Real routers have
          input queues too.
        </li>
        <li>The buffer counts packets, not bytes, and the only drop policy is drop-tail. There is no RED, CoDel or PIE in the model.</li>
        <li>Strict priority is non-preemptive: a packet on the wire is never interrupted, which is how real links behave.</li>
        <li>
          WFQ uses exact GPS virtual time rather than an approximation such as SCFQ or DRR; ties in finish tags go to the packet created
          first.
        </li>
        <li>On-off sources are deterministic: evenly spaced packets within each burst, fixed silences between.</li>
        <li>At most four flows and 6,000 packets per run, so the trace stays small enough to replay in the browser.</li>
      </ul>
      <h3 className="pt-2 text-lg">References</h3>
      <ul className="list-disc space-y-1 pl-5 text-[0.95rem]">
        <li>J. D. C. Little, “A proof for the queuing formula L = λW”, Operations Research 9(3), 1961.</li>
        <li>S. Stidham, “A last word on L = λW”, Operations Research 22(2), 1974.</li>
        <li>L. Kleinrock, Queueing Systems, Volume 1: Theory, Wiley, 1975; Volume 2: Computer Applications, 1976.</li>
        <li>A. Cobham, “Priority assignment in waiting line problems”, Operations Research 2(1), 1954.</li>
        <li>J. Turner, “New directions in communications (or which way to the information age?)”, IEEE Communications Magazine, 1986.</li>
        <li>R. L. Cruz, “A calculus for network delay”, Parts I and II, IEEE Transactions on Information Theory 37(1), 1991.</li>
        <li>A. Demers, S. Keshav and S. Shenker, “Analysis and simulation of a fair queueing algorithm”, ACM SIGCOMM, 1989.</li>
        <li>
          A. K. Parekh and R. G. Gallager, “A generalized processor sharing approach to flow control in integrated services networks: the
          single-node case”, IEEE/ACM Transactions on Networking 1(3), 1993.
        </li>
        <li>J.-Y. Le Boudec and P. Thiran, Network Calculus, Springer, 2001.</li>
        <li>K. Nichols and V. Jacobson, “Controlling queue delay”, ACM Queue 10(5), 2012; RFC 8289, RFC 8290, RFC 8033.</li>
        <li>J. F. Kurose and K. W. Ross, Computer Networking: A Top-Down Approach, Sections 1.4 and 4.2.</li>
      </ul>
    </Layer>
  )
}
