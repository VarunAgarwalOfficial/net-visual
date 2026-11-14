import { useMemo, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import type { Netsim } from "../../core/netsim"
import { fmt, protocolName, sweepRdt, type RdtParams, type RdtRun } from "../../core/rdt"
import { LineChart, type Series } from "../../components/LineChart"
import { Tex, texNum } from "../../components/Tex"

/** A numbered section in the article, with its layer named in the margin. */
export function Layer({ id, layer, title, children }: { id: string; layer: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className="nv-prose mt-14 max-w-[72ch] space-y-4 border-t border-border pt-8 [.nv-present_&]:hidden"
    >
      <p className="font-sans text-xs tracking-wide text-muted-foreground uppercase">{layer}</p>
      <h2 id={`${id}-h`} className="text-2xl">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** Knuth's rating: 00 immediate, 10 a minute, 20 a quarter hour, 30 hours, 40 a project; M needs mathematics. */
export function Exercise({ rating, children, answer }: { rating: string; children: ReactNode; answer: ReactNode }) {
  return (
    <li className="space-y-1">
      <p>
        <span className="mr-2 font-sans text-sm text-muted-foreground tabular-nums">[{rating}]</span>
        {children}
      </p>
      <details className="text-[0.95rem]">
        <summary className="cursor-pointer font-sans text-sm text-[var(--link)]">Answer</summary>
        <div className="mt-1 border-l-2 border-border pl-3">{answer}</div>
      </details>
    </li>
  )
}

export function RdtIntro() {
  return (
    <Layer id="rdt-intuition" layer="Intuition" title="Why a reliable channel needs only four ideas">
      <p>
        A network loses, delays and reorders packets. A reliable transfer protocol turns that channel into one where every message arrives
        once, in order. Four mechanisms suffice: a <em>sequence number</em> so the receiver can tell new data from old, an{" "}
        <em>acknowledgement</em> so the sender learns what arrived, a <em>timer</em> so silence is noticed, and <em>retransmission</em> to
        repair what was lost. Every protocol here, and TCP after it, is a choice of how to combine them.
      </p>
      <p>
        The diagram above is a time-sequence diagram: time runs down, the sender is on the left, the receiver on the right. Each packet is
        drawn as the band its bits occupy on the wire, so the band is thick when the packet takes long to transmit and steep when it crosses
        a short distance. Stop-and-wait sends one packet and waits; on a fast long link the band is a hairline and nearly all the time is
        spent waiting. Pipelining (Go-Back-N and Selective Repeat) keeps up to <Tex>N</Tex> packets in flight to fill that waiting time;
        they differ in what happens after a loss.
      </p>
      <p>
        Start the guided tour, or pick a scenario and press play. Click any packet and press <kbd>D</kbd> to drop it; the rest of the run is
        recomputed, and the change is kept in the link you share.
      </p>
      <h3 className="pt-2 text-lg">Misconceptions this tool is built to correct</h3>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <b>“A Go-Back-N receiver keeps the packets after a gap.”</b> It discards them: its window is one packet wide. Load the Go-Back-N
          scenario and watch packets 3, 4 and 5 arrive and be thrown away.
        </li>
        <li>
          <b>“Selective Repeat needs only N sequence numbers.”</b> It needs 2N. The Fig. 3.27 scenario shows a resent packet 0 delivered as
          message 4.
        </li>
        <li>
          <b>“The timeout should equal the round-trip time.”</b> It must exceed the longest round trip, including both transmission times
          and any queueing, or the sender resends packets that were never lost (the premature-timeout scenario).
        </li>
        <li>
          <b>“A larger window always helps.”</b> Past <Tex>{"1 + 2a"}</Tex> packets the link is already full; with losses, a larger window
          makes each Go-Back-N timeout throw away more.
        </li>
        <li>
          <b>“If the window is safe, sequence numbers can never be confused.”</b> The proofs below assume the channel does not reorder. On
          the reordering scenario, an old copy can arrive after its number has been reused; real protocols bound the packet lifetime (TCP's
          maximum segment lifetime) for this reason.
        </li>
      </ul>
    </Layer>
  )
}

export function RdtAnalysis({ sim, p, run }: { sim: Netsim; p: RdtParams; run: RdtRun }) {
  const th = run.theory
  const T = run.totals
  const ms = (us: number) => texNum(us / 1000, 3)
  const a = (p.prop_us + p.jitter_us / 2) / th.t_data_us
  const protocol = protocolName(p)

  const sweepBase = useMemo(
    () => ({ ...p, loss_ack: 0, jitter_us: 0, messages: Math.min(600, Math.max(p.messages, 300)), window: Math.max(p.window, 2) }),
    // The sweep depends on everything except the loss rate and the protocol it varies itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.window, p.data_bytes, p.ack_bytes, p.rate_bps, p.prop_us, p.timeout_us, p.seed, p.messages],
  )
  const [sweepOn, setSweepOn] = useState(false)
  const rows = useMemo(() => {
    if (!sweepOn) return []
    const losses = Array.from({ length: 21 }, (_, i) => i * 0.025)
    return sweepRdt(sim, sweepBase, losses)
  }, [sim, sweepBase, sweepOn])

  const series: Series[] = rows.length
    ? [
        {
          id: "sr-sim",
          label: `Selective Repeat, simulated (N = ${sweepBase.window})`,
          color: "var(--chart-2)",
          kind: "dots",
          points: rows.map((r) => [r[0], r[3]]),
        },
        { id: "sr-th", label: "Selective Repeat, bound", color: "var(--chart-2)", kind: "line", points: rows.map((r) => [r[0], r[6]]) },
        {
          id: "gbn-sim",
          label: `Go-Back-N, simulated (N = ${sweepBase.window})`,
          color: "var(--chart-1)",
          kind: "dots",
          points: rows.map((r) => [r[0], r[2]]),
        },
        {
          id: "gbn-th",
          label: "Go-Back-N, Stallings",
          color: "var(--chart-1)",
          kind: "line",
          dashed: true,
          points: rows.map((r) => [r[0], r[5]]),
        },
        { id: "sw-sim", label: "Stop-and-wait, simulated", color: "var(--chart-3)", kind: "dots", points: rows.map((r) => [r[0], r[1]]) },
        { id: "sw-th", label: "Stop-and-wait, exact", color: "var(--chart-3)", kind: "line", points: rows.map((r) => [r[0], r[4]]) },
      ]
    : []

  return (
    <Layer id="rdt-analysis" layer="Analysis" title="How fast can it go?">
      <p>
        The numbers below are computed from the settings you are running, and the measured value comes from the run above. Change a setting
        and both move.
      </p>
      <div className="overflow-x-auto rounded-sm border border-border p-4">
        <Tex
          display
        >{`t = \\frac{L}{R} = \\frac{${p.data_bytes * 8}\\ \\text{bits}}{${texNum(p.rate_bps, 4)}\\ \\text{b/s}} = ${ms(th.t_data_us)}\\ \\text{ms}, \\qquad a = \\frac{d}{t} = ${texNum(a, 3)}`}</Tex>
        <Tex
          display
        >{`E[S] = \\Bigl(\\frac{1}{q} - 1\\Bigr)T + t + 2d + t_{\\text{ack}} = ${ms(th.slot_us)}\\ \\text{ms}, \\qquad q = (1-p_d)(1-p_a) = ${texNum(th.q_success, 3)}`}</Tex>
        <Tex
          display
        >{`U \\le \\min\\Bigl(1 - p_d,\\ \\frac{N t}{E[S]}\\Bigr) = \\min(${texNum(th.link_bound, 3)},\\ ${texNum(th.window_bound, 3)}) = ${texNum(th.bound, 3)}`}</Tex>
        <p className="mt-2 font-sans text-sm">
          {protocol}, N = {p.window}: measured utilisation <b className="tabular-nums">{fmt(T.utilisation)}</b>
          {T.finished ? "" : " (the run hit its time limit)"}, bound <b className="tabular-nums">{fmt(th.bound)}</b>. Stallings' formulas
          give {fmt(th.stallings_sw)} for stop-and-wait, {fmt(th.stallings_gbn)} for Go-Back-N and {fmt(th.stallings_sr)} for Selective
          Repeat. To fill the link takes <Tex>{`N \\ge (t + 2d + t_{\\text{ack}})/t = ${texNum(th.window_to_fill, 3)}`}</Tex>.
        </p>
      </div>

      <h3 className="pt-2 text-lg">Theorem 1 (the window bound)</h3>
      <p>
        Call the time from a message's first transmission to the arrival of the acknowledgement that frees it the message's{" "}
        <em>slot time</em> <Tex>S</Tex>. The window holds at most <Tex>N</Tex> messages, so by Little's law (Little, 1961) the long-run rate
        at which messages complete is at most <Tex>{"N / E[S]"}</Tex>, and the fraction of time the link carries new data is at most{" "}
        <Tex>{"N t / E[S]"}</Tex>. Independently, a fraction <Tex>p_d</Tex> of transmissions is lost, so at most <Tex>1 - p_d</Tex> of the
        link's time can carry data that arrives.
      </p>
      <p>
        <em>Proof of the slot time.</em> An attempt succeeds when both the packet and its acknowledgement survive, with probability{" "}
        <Tex>q</Tex>. The number of failed attempts is geometric with mean <Tex>{"1/q - 1"}</Tex>; each costs one timeout <Tex>T</Tex>,
        because the timer starts with the transmission. The successful attempt costs <Tex>{"t + 2d + t_{\\text{ack}}"}</Tex>. For
        stop-and-wait <Tex>N = 1</Tex>, the window is the whole protocol, and the bound is exact; the test suite checks the simulation
        against it to 4%. For a pipeline the bound is tight with no loss (checked to 1%) but loose with loss, for a reason worth seeing: a
        message holds its place in the window not until its own acknowledgement but until every message before it is acknowledged. One loss
        stalls the window for a timeout while later, already acknowledged messages sit in it. Selective Repeat avoids resending them; it
        does not avoid waiting for them. ∎
      </p>

      <h3 className="pt-2 text-lg">Theorem 2 (how many sequence numbers)</h3>
      <p>
        With <Tex>k</Tex>-bit sequence numbers on a channel that does not reorder, Selective Repeat is correct if and only if{" "}
        <Tex>{"N \\le 2^{k-1}"}</Tex>, and Go-Back-N if and only if <Tex>{"N \\le 2^k - 1"}</Tex>.
      </p>
      <p>
        <em>Proof.</em> Suppose the receiver expects message <Tex>r</Tex>, so its window is <Tex>{"[r, r + N_r - 1]"}</Tex>. Every message
        below <Tex>r</Tex> was received, so the sender has sent them all; but the acknowledgements may all be lost, so the sender's base can
        be as low as <Tex>r - N</Tex>, and it may resend any of <Tex>{"[r - N, r - 1]"}</Tex>. The receiver must tell these old messages
        from those in its window, so the <Tex>{"N + N_r"}</Tex> consecutive indices <Tex>{"[r - N, r + N_r - 1]"}</Tex> must have distinct
        residues mod <Tex>{"2^k"}</Tex>: <Tex>{"N + N_r \\le 2^k"}</Tex>. Selective Repeat has <Tex>{"N_r = N"}</Tex>, giving{" "}
        <Tex>{"2N \\le 2^k"}</Tex>; Go-Back-N has <Tex>{"N_r = 1"}</Tex>, giving <Tex>{"N \\le 2^k - 1"}</Tex>. Conversely, if the bound
        fails, losing every acknowledgement of one full window makes the resent message <Tex>r - N</Tex> arrive with the number of{" "}
        <Tex>{"r + N_r - 1"}</Tex> or less, inside the window; the Fig. 3.27 scenario is this construction with <Tex>k = 2</Tex>,{" "}
        <Tex>N = 3</Tex>. ∎
      </p>
      <p className="font-sans text-sm">
        Your settings: <Tex>{`k = ${p.seq_bits}`}</Tex>, so the largest safe window is <b>{th.safe_window}</b>; you have N = {p.window}
        {p.window > th.safe_window ? ", which can fail" : ", which is safe if the channel does not reorder"}.
        {T.misdelivered > 0 ? ` This run delivered ${T.misdelivered} message(s) wrongly.` : ""}
      </p>

      <h3 className="pt-2 text-lg">Utilisation against loss</h3>
      <p>
        Each dot is a complete simulated run at your link settings (window {sweepBase.window}, {sweepBase.messages} messages, no ACK loss or
        jitter); each line is the formula evaluated by the same Rust code. The stop-and-wait dots sit on their line, as Theorem 1 says they
        must. Both pipelines fall well below the window bound once packets are lost, because of the stalled window described above;
        Go-Back-N falls further, since every loss also throws away the rest of the window. Stallings' approximation for Go-Back-N assumes
        the timeout is one round trip; with your timeout of {(p.timeout_us / 1000).toFixed(0)} ms against a round trip of{" "}
        {((th.t_data_us + th.rtt_us + th.t_ack_us) / 1000).toFixed(1)} ms, each loss costs more than it allows.
      </p>
      {sweepOn ? (
        <LineChart
          title="Utilisation against data loss probability"
          series={series}
          xLabel="data loss probability p_d"
          yLabel="utilisation"
          xFormat={(x) => x.toFixed(2)}
          yFormat={(y) => y.toFixed(2)}
          xDomain={[0, 0.5]}
          yDomain={[0, 1]}
          height={300}
        />
      ) : (
        <Button variant="outline" onClick={() => setSweepOn(true)}>
          Run the sweep (63 simulations)
        </Button>
      )}

      <h3 className="pt-2 text-lg">Exercises</h3>
      <p className="font-sans text-sm text-muted-foreground">
        Ratings follow Knuth: 10 takes a minute, 20 a quarter of an hour, 30 an hour or more; M marks mathematics. The Lab tab checks five
        more against the simulation.
      </p>
      <ol className="list-decimal space-y-4 pl-5">
        <Exercise
          rating="10"
          answer={<p>8 μs out of 30.008 ms, U ≈ 0.00027. One 1000-byte packet per round trip is 267 kb/s on a 1 Gb/s link.</p>}
        >
          On the “Stop-and-wait across a continent” scenario, what fraction of the time is the sender transmitting? Check it against the
          measured value.
        </Exercise>
        <Exercise
          rating="15"
          answer={
            <p>
              The ACK is a duplicate of one already received; the sender is in a state where that ACK number is below its base, so S3
              ignores it. With no sequence numbers on ACKs the sender could not tell it apart from an ACK of the resent packet.
            </p>
          }
        >
          In the premature-timeout scenario the sender receives two ACKs numbered 1. Why is the second harmless, and what would go wrong if
          ACKs carried no number?
        </Exercise>
        <Exercise
          rating="M20"
          answer={
            <p>
              With N ≥ 1 + 2a the window never closes without loss. A loss costs Go-Back-N its whole outstanding window, about 1 + 2a packet
              times, so the expected time per delivered packet is t(1 + 2ap)/(1 − p), which gives U = (1 − p)/(1 + 2ap).
            </p>
          }
        >
          Derive Stallings' Go-Back-N formula <Tex>{"U = (1-p)/(1+2ap)"}</Tex> for a full window, and say which assumption the simulation
          violates at high loss.
        </Exercise>
        <Exercise
          rating="M25"
          answer={
            <p>
              Old copies can arrive at any time within the maximum lifetime Λ. In that time the sender can advance by up to Λ/t + N
              messages, so the numbers must not wrap within that span: 2^k ≥ N + N_r + Λ R / L. This is why TCP's 32-bit sequence space and
              the timestamp option (RFC 7323) matter at high rates.
            </p>
          }
        >
          Theorem 2 assumes no reordering. Suppose any packet may arrive up to Λ seconds after it was sent. Give a sufficient condition on{" "}
          <Tex>k</Tex>.
        </Exercise>
        <Exercise
          rating="30"
          answer={
            <p>
              Turning on buffering with cumulative ACKs and a single timer that resends one packet gives a protocol close to TCP without
              SACK: the receiver keeps out-of-order data but can only report the first gap, so the sender repairs one hole per timeout.
              Measure its utilisation against both named protocols on the lossy-pipe scenario.
            </p>
          }
        >
          Use the four rule switches to build a protocol that is neither Go-Back-N nor Selective Repeat. Which real protocol does it
          resemble, and where does it sit between the two?
        </Exercise>
      </ol>
    </Layer>
  )
}

export function RdtFrontier() {
  return (
    <Layer id="rdt-frontier" layer="Frontier" title="Where this goes in real systems">
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>Selective acknowledgements.</b> TCP's cumulative ACK is Go-Back-N's; the SACK option (RFC 2018) adds Selective Repeat's
          per-block reports, so the sender can repair several holes per round trip.
        </li>
        <li>
          <b>Loss detection by time, not count.</b> RACK-TLP (RFC 8985) declares a packet lost when a packet sent after it is acknowledged
          and a reordering window has passed, which replaces the duplicate-ACK threshold and handles the reordering channel above.
        </li>
        <li>
          <b>Never reuse a number.</b> QUIC (RFC 9000, RFC 9002) gives every transmission a new packet number, so the ambiguity in Theorem 2
          and the retransmission ambiguity in RTT measurement (Karn and Partridge, 1987) cannot arise; stream offsets carry the order.
        </li>
        <li>
          <b>Hybrid ARQ.</b> Cellular links (LTE, 5G NR) keep several stop-and-wait processes in parallel and combine a failed copy with its
          retransmission instead of discarding it, so a retransmission adds redundancy rather than repeating the packet.
        </li>
        <li>
          <b>No feedback at all.</b> Fountain codes (Byers, Luby, Mitzenmacher and Rege, 1998; Luby, 2002) let the sender emit an endless
          stream of coded packets, any sufficiently many of which reconstruct the data, for broadcast where per-receiver ACKs cannot work.
        </li>
        <li>
          <b>Proof.</b> The sliding-window protocol is a standard benchmark for verification; Badban et al. (2005) prove a general version
          correct in μCRL and PVS. Theorem 2 is the heart of such proofs.
        </li>
      </ul>
    </Layer>
  )
}

export function RdtInternals() {
  return (
    <Layer id="rdt-internals" layer="Internals" title="How the simulation works">
      <p>
        The model is about 700 lines of Rust (crates/netsim/src/rdt.rs), compiled to WebAssembly and called through a plain C interface: the
        page writes a JSON request into the module's memory, and the module returns JSON. The Source tab shows the code as a literate
        program; its lettered steps are the ones named in the trace, and the step behind the current event is shaded as you scrub.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          <b>Discrete events.</b> A priority queue holds link-free, arrival and timeout events in integer microseconds, with ties broken by
          insertion order, so a run is exactly reproducible.
        </li>
        <li>
          <b>Luck that does not shift.</b> A seeded SplitMix64 generator draws exactly two numbers per transmission (loss and jitter)
          whether or not they are used. When you drop or delay one packet, every later packet keeps its fate.
        </li>
        <li>
          <b>Edits name packets, not times.</b> An edit is keyed by kind, message number and copy (“the second copy of message 2”), so it
          survives other changes and travels in the share link.
        </li>
        <li>
          <b>The protocol is data.</b> Go-Back-N and Selective Repeat are two settings of four rules (receiver buffering, ACK meaning,
          timers, what to resend). The Setup tab edits the rules; the same code interprets them.
        </li>
        <li>
          <b>The model knows the truth.</b> Each packet carries its true message index beside the wire sequence number. The receiver never
          reads it; the model uses it to detect a message delivered as another (the red boxes).
        </li>
      </ol>
      <h3 className="pt-2 text-lg">Simplifications</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>Data flows one way; ACKs return on a separate link of the same rate. Neither link queues behind other traffic.</li>
        <li>
          Losses are independent coin flips. Corruption is not modelled separately: a corrupt packet is assumed caught by the checksum and
          dropped.
        </li>
        <li>Delay is propagation plus uniform jitter. The timeout is fixed; adaptive timeouts are in the TCP tool.</li>
        <li>The receiver delivers immediately and has unlimited buffer space, so there is no flow control.</li>
        <li>
          Time advances in whole microseconds, and transmission times round up, so at very high rates (40 bytes at 10 Gb/s is 32 ns) the
          simulation is slower than the formula.
        </li>
        <li>Utilisation counts each message's bits once, over the time to deliver them all.</li>
      </ul>
      <h3 className="pt-2 text-lg">References</h3>
      <ul className="space-y-1 text-[0.95rem]">
        <li>
          K. A. Bartlett, R. A. Scantlebury and P. T. Wilkinson. A note on reliable full-duplex transmission over half-duplex links. CACM
          12(5), 1969.
        </li>
        <li>N. V. Stenning. A data transfer protocol. Computer Networks 1(2), 1976.</li>
        <li>J. D. C. Little. A proof for the queuing formula L = λW. Operations Research 9(3), 1961.</li>
        <li>P. Karn and C. Partridge. Improving round-trip time estimates in reliable transport protocols. SIGCOMM 1987.</li>
        <li>D. Bertsekas and R. Gallager. Data Networks, 2nd ed., Section 2.4. Prentice Hall, 1992.</li>
        <li>W. Stallings. Data and Computer Communications, Chapter 7 and its appendix on performance.</li>
        <li>J. F. Kurose and K. W. Ross. Computer Networking: A Top-Down Approach, 8th ed., Section 3.4. Pearson, 2021.</li>
        <li>
          J. W. Byers, M. Luby, M. Mitzenmacher and A. Rege. A digital fountain approach to reliable distribution of bulk data. SIGCOMM
          1998.
        </li>
        <li>
          B. Badban, W. Fokkink, J. F. Groote, J. Pang and J. van de Pol. Verification of a sliding window protocol in μCRL and PVS. Formal
          Aspects of Computing 17, 2005.
        </li>
        <li>RFC 2018 (TCP SACK), RFC 8985 (RACK-TLP), RFC 9000 and RFC 9002 (QUIC transport and recovery).</li>
      </ul>
    </Layer>
  )
}
