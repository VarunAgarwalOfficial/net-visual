import type { ReactNode } from "react"

import { Tex, texNum } from "../../components/Tex"
import type { Netsim } from "../../core/netsim"
import {
  ALOHA_SWEEP,
  CA_HIDDEN,
  CD_SWEEP,
  airUs,
  alohaExact,
  cdApprox,
  metcalfeBoggs,
  navFields,
  runCa,
  tauNs,
  RTS_BYTES,
  DATA_HEADER,
} from "../../core/link"
import { Exercise, Layer } from "../rdt/RdtArticle"
import { alohaSweeps, cached, cdSweep } from "./LinkViews"

/** A button that loads a scenario, for claims the reader can check at once. */
function Try({ id, onLoad, children }: { id: string; onLoad(id: string): void; children: ReactNode }) {
  return (
    <button type="button" className="font-sans text-sm text-[var(--link)] underline underline-offset-2" onClick={() => onLoad(id)}>
      {children}
    </button>
  )
}

export function LinkIntro({ onLoad }: { onLoad(id: string): void }) {
  return (
    <Layer id="link-intuition" layer="Intuition" title="Many stations, one medium">
      <p>
        A cable that every station taps, or the air around a radio, is a single channel: when two stations send at once, their signals add
        and a receiver can make out neither. Nobody is in charge, and each station knows only what it can hear. A <em>multiple access</em>{" "}
        protocol is the rule every station follows so that, between them, they still get frames through.
      </p>
      <p>
        The three modes above are three answers, each a response to the failures of the one before. <em>ALOHA</em> sends whenever it has a
        frame and repairs collisions afterwards; it wastes most of the channel but needs nothing from the medium. <em>CSMA/CD</em>, classic
        Ethernet, listens before sending and keeps listening while it sends, so a collision is cut short as soon as it is heard. Its one
        unavoidable weakness is that signals take time to travel: a station can hear silence and start just as someone else's frame is about
        to arrive. <em>CSMA/CA</em>, the 802.11 rule for Wi-Fi, cannot hear collisions at all, because a radio's own signal drowns
        everything else at its antenna, and because the collision that matters happens at the receiver, which may hear a station the sender
        cannot. So it works harder to avoid collisions, and it has every frame acknowledged.
      </p>
      <p>
        All three share one idea for what to do after a failure: wait a <em>random</em> time. Two stations that collided and then waited the
        same fixed time would collide again for ever. Randomness breaks the tie; making the range of the random wait grow with each failure
        lets a crowd spread itself out without anyone counting the crowd.
      </p>

      <h3 className="pt-2 text-lg">Misconceptions this tool is built to correct</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>“Slots only tidy up the timing.”</b> They halve the vulnerable window. Unslotted, a frame is lost if any other starts within
          one frame time before it or during it, a window of two frame times; slotted, only a frame in the same slot can hit it. The best
          throughput doubles, from 1/(2e) ≈ 18% to 1/e ≈ 37%.{" "}
          <Try id="slotted" onLoad={onLoad}>
            Slotted ALOHA.
          </Try>
        </li>
        <li>
          <b>“Offering more traffic gets more through.”</b> Past the peak, more attempts mean more collisions and fewer successes: pure
          ALOHA at G = 2 delivers a fifth of what it delivers at G = 0.5.{" "}
          <Try id="overload" onLoad={onLoad}>
            G = 2.
          </Try>
        </li>
        <li>
          <b>“Listening before sending prevents collisions.”</b> It prevents collisions with frames that have already arrived. A frame that
          is still on its way cannot be heard, so two stations a few microseconds of cable apart can both hear silence and both send.{" "}
          <Try id="cd-two" onLoad={onLoad}>
            Two stations.
          </Try>
        </li>
        <li>
          <b>“A sender always finds out about a collision.”</b> Only if it is still sending when the other signal reaches it, which can take
          a full round trip of the cable. A shorter frame finishes first and is counted as sent although it was destroyed. That is the whole
          reason for Ethernet's 64-byte minimum.{" "}
          <Try id="cd-short" onLoad={onLoad}>
            A frame too short.
          </Try>
        </li>
        <li>
          <b>“Ethernet collapses at a third of its capacity, like ALOHA.”</b> It does not: carrier sense removes most collisions and those
          left are cut short. With long frames on a short cable a busy shared Ethernet keeps the cable over 90% busy with good frames. The
          popular formula 1/(1 + 5a) is a rough approximation, and with binary exponential backoff the real figure is higher still.{" "}
          <Try id="cd-busy" onLoad={onLoad}>
            Six busy stations.
          </Try>
        </li>
        <li>
          <b>“Wireless stations detect collisions the way Ethernet does.”</b> A radio cannot hear others over its own transmitter, and the
          collision that matters is at the receiver, which the sender may not be able to hear. 802.11 learns of a loss only when the
          acknowledgement fails to arrive.{" "}
          <Try id="ca-hidden" onLoad={onLoad}>
            Hidden terminals.
          </Try>
        </li>
        <li>
          <b>“A waiting 802.11 station draws a new backoff every time the medium falls quiet.”</b> It keeps its count. While the medium is
          busy the count freezes, and it resumes where it stopped after the next DIFS of silence, so a station that has waited long is close
          to its turn.{" "}
          <Try id="ca-share" onLoad={onLoad}>
            Two stations share.
          </Try>
        </li>
        <li>
          <b>“RTS/CTS removes collisions.”</b> It moves them. RTS frames still collide, but an RTS lasts tens of microseconds where a data
          frame lasts more than a millisecond, and a few data frames are still lost when a CTS is missed.{" "}
          <Try id="ca-hidden-rts" onLoad={onLoad}>
            With RTS/CTS.
          </Try>
        </li>
        <li>
          <b>“A station must hear the whole exchange to keep out of its way.”</b> Hearing one frame is enough: each carries a duration
          field, and a node that hears only the RTS, or only the CTS, sets its NAV to end exactly with the ACK.{" "}
          <Try id="ca-nav" onLoad={onLoad}>
            The NAV.
          </Try>
        </li>
        <li>
          <b>“If I can hear another sender, my sending would harm it.”</b> Not if neither receiver can hear the other sender. Exposed
          terminals defer for nothing; carrier sense measures interference at the sender, but what matters is interference at the receiver.{" "}
          <Try id="ca-exposed" onLoad={onLoad}>
            Exposed terminals.
          </Try>
        </li>
      </ul>
    </Layer>
  )
}

export function LinkMechanics() {
  return (
    <Layer id="link-mechanics" layer="Mechanics" title="The three rules, step by step">
      <p>
        The trace names each step by its letter, and the Source tab shades the code behind it. Each model is a pure function of its settings
        and a seed: the same settings replay the same run.
      </p>
      <h3 className="pt-2 text-lg">ALOHA</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <b>A1, choose when to send.</b> Unslotted, each station alternates a frame with a silence of random length; slotted, it decides in
          each slot, with probability G/n, whether to send in it. The offered load G counts every attempt, new frame or retransmission.
        </li>
        <li>
          <b>A2, send.</b> The station sends without listening. If another frame is already on the air the two overlap.
        </li>
        <li>
          <b>A3, check for overlap.</b> A frame that overlapped any other, by however little, is lost, and so is the other. The receiver
          decodes the rest.
        </li>
      </ol>
      <h3 className="pt-2 text-lg">CSMA/CD (IEEE 802.3, Clause 4)</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <b>E1, sense the carrier.</b> A station with a frame listens. If the cable is quiet it waits the interframe gap, 96 bit times (9.6
          µs at 10 Mb/s), and sends; if a signal is passing it defers until the cable falls quiet, then waits the gap. Classic Ethernet is
          1-persistent: every waiting station goes the moment the gap ends.
        </li>
        <li>
          <b>E2, transmit.</b> The station sends and listens at the same time.
        </li>
        <li>
          <b>E3, detect the collision and jam.</b> If another signal arrives while it is sending, it stops the frame and sends a 32-bit jam
          so that every station involved hears the collision too.
        </li>
        <li>
          <b>E4, finish.</b> A frame that ends without the station hearing anything else is done. If it was garbled somewhere the station
          could not hear in time, nothing at this layer will notice.
        </li>
        <li>
          <b>E5, back off.</b> After the frame's nth collision the station picks K uniformly from {"{0, 1, …, 2^min(n, 10) − 1}"} and waits
          K slot times of 512 bit times (51.2 µs at 10 Mb/s), then starts again at E1. The range doubles with each collision up to the
          tenth, then stays at 1024 values. The slot is one minimum frame long, which is at least the worst round trip.
        </li>
        <li>
          <b>E6, give up.</b> After 16 attempts the frame is discarded and the error reported upwards.
        </li>
      </ol>
      <h3 className="pt-2 text-lg">CSMA/CA (IEEE 802.11 DCF)</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <b>W1, sense the medium.</b> A node treats the medium as busy while it hears any frame (physical carrier sense) and until its NAV
          runs out (virtual carrier sense).
        </li>
        <li>
          <b>W2, count down or freeze.</b> A node with a frame draws a backoff of 0 to CW slots (CW starts at 15). Once the medium has been
          idle for a DIFS (SIFS + 2 slots = 34 µs in 802.11a/g) it counts down one slot per idle slot; if the medium turns busy, it freezes
          the count and resumes after the next DIFS of silence.
        </li>
        <li>
          <b>W3, send.</b> When the count reaches zero the node sends its data frame, or with RTS/CTS a 20-byte RTS.
        </li>
        <li>
          <b>W4, receive.</b> A frame is decoded where nothing else overlaps it. Nodes it was not meant for set their NAV from its duration
          field. The receiver answers a SIFS (16 µs) later: CTS for an RTS, ACK for data. Only a SIFS separates the frames of an exchange,
          and every other node needs a DIFS before counting, so the exchange keeps the medium.
        </li>
        <li>
          <b>W5, data after CTS.</b> The sender, having its CTS, sends the data frame a SIFS later.
        </li>
        <li>
          <b>W6, time out and back off.</b> If the CTS or ACK does not come, the node doubles its window, CW ← 2CW + 1 (at most 1023), draws
          a new backoff and tries again. After seven attempts it drops the frame.
        </li>
        <li>
          <b>W7, delivered.</b> The ACK arrives: CW returns to 15, and the node draws a fresh backoff before its next frame, so a node with
          a queue cannot grab the medium straight back.
        </li>
        <li>
          <b>W8, exposed terminals.</b> Not a step of the protocol but of the measurement: the time a sender spent deferring to a frame it
          could safely have talked over.
        </li>
      </ol>
    </Layer>
  )
}

export function LinkAnalysis({ sim }: { sim: Netsim }) {
  const sw = alohaSweeps(sim)
  const cd = cdSweep(sim)
  const tau = tauNs(CD_SWEEP)
  const slot = Math.round((CD_SWEEP.slot_bits * 1e9) / CD_SWEEP.rate_bps)
  const hidden = cached(sim, "hidden", () => ({
    plain: runCa(sim, CA_HIDDEN).stats,
    rts: runCa(sim, { ...CA_HIDDEN, rts: true }).stats,
  }))
  const tData = airUs(CA_HIDDEN, CA_HIDDEN.payload_bytes + DATA_HEADER)
  const tRts = airUs(CA_HIDDEN, RTS_BYTES)
  const nav = navFields({ ...CA_HIDDEN, rts: true })
  const pick = [0.25, 0.5, 1, 2]
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`
  return (
    <Layer id="link-analysis" layer="Analysis" title="How much of the channel each rule delivers">
      <h3 className="text-lg">ALOHA: the vulnerable window</h3>
      <p>
        Let frames last one frame time and let attempts from a very large population arrive as a Poisson process, G per frame time. A frame
        starting at t survives if no other frame starts in (t − 1, t + 1): anything starting in the frame time before it is still on the air
        at t, anything starting during it overlaps its end. That window is two frame times, 2F, so
      </p>
      <Tex display>
        {
          "\\begin{aligned} S &= G \\cdot P(\\text{no other start in } 2F) \\\\ &= G e^{-2G} \\\\ \\frac{dS}{dG} &= (1 - 2G)e^{-2G} = 0 \\\\ &\\Rightarrow G = \\tfrac12,\\ S = \\tfrac{1}{2e} \\approx 0.184 \\end{aligned}"
        }
      </Tex>
      <p>
        Slots shrink the window to the slot itself, giving <Tex>{"S = Ge^{-G}"}</Tex>, at most <Tex>{"1/e \\approx 0.368"}</Tex> at G = 1.
        With n stations the formulas are exact only in the limit. The model's n stations each send with probability q = G/n per slot, so
        slotted throughput is exactly <Tex>{"G(1-q)^{n-1}"}</Tex>; unslotted, each alternates a frame with an exponential silence, which
        gives <Tex>{"G[(1-q)e^{-q/(1-q)}]^{n-1}"}</Tex>. Both tend to the Poisson forms as n grows. The test suite checks the simulation
        against them; with the S against G chart's fifty stations and 20,000 frame times per point (seed 1):
      </p>
      <div className="overflow-x-auto">
        <table className="w-full font-sans text-sm tabular-nums lining">
          <thead className="text-xs text-muted-foreground">
            <tr className="text-right">
              <th className="pr-2 text-left font-normal">G</th>
              <th className="pr-2 font-normal">slotted, simulated</th>
              <th className="pr-2 font-normal">exact, n = 50</th>
              <th className="pr-2 font-normal">pure, simulated</th>
              <th className="font-normal">exact, n = 50</th>
            </tr>
          </thead>
          <tbody>
            {pick.map((g) => {
              const s = sw.slotted.find((x) => x.g === g)
              const u = sw.pure.find((x) => x.g === g)
              return (
                <tr key={g} className="text-right">
                  <td className="pr-2 text-left">{g}</td>
                  <td className="pr-2">{s?.s.toFixed(4)}</td>
                  <td className="pr-2">{alohaExact(true, ALOHA_SWEEP.stations, g).toFixed(4)}</td>
                  <td className="pr-2">{u?.s.toFixed(4)}</td>
                  <td>{alohaExact(false, ALOHA_SWEEP.stations, g).toFixed(4)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p>The tests accept a difference of 0.016 slotted and 0.011 pure: four standard deviations of S measured over seeds 1 to 20.</p>

      <h3 className="pt-2 text-lg">CSMA/CD: the round trip and the minimum frame</h3>
      <p>
        Put A and B at the two ends of a cable whose one-way delay is τ. A starts at 0. Just before A's first bit reaches B, at τ − ε, B
        hears silence and starts too. B detects the collision almost at once, but its signal needs another τ to reach A, so A learns of it
        at 2τ − ε. For A to know, it must still be sending then:
      </p>
      <Tex display>{"\\frac{L_{\\min}}{R} \\ge 2\\tau \\quad\\Longleftrightarrow\\quad L_{\\min} \\ge 2\\tau R."}</Tex>
      <p>
        At 10 Mb/s 802.3 fixes the slot at 512 bits (51.2 µs), budgeting the round trip of a maximum network of 2.5 km with four repeaters,
        and the minimum frame at the same 512 bits, 64 bytes. The tests check that every detection in a busy one-second run comes within 2τ
        of the start and that a frame shorter than 2τR goes unnoticed.
      </p>
      <h3 className="pt-2 text-lg">CSMA/CD: efficiency</h3>
      <p>
        Let <Tex>{"a = \\tau / (L/R)"}</Tex>, the cable's delay measured in frame times. Each frame costs its own time plus the contention
        that precedes it. If N busy stations each send in a contention slot of 2τ with probability 1/N, a slot is won with probability{" "}
        <Tex>{"A = (1 - 1/N)^{N-1} \\to 1/e"}</Tex>, and the mean contention lasts about e slots. Counting the contention as e × 2τ ≈ 5.4τ
        per frame gives
      </p>
      <Tex display>{"E = \\frac{L/R}{L/R + 2e\\tau} = \\frac{1}{1 + 2ea} \\approx \\frac{1}{1 + 5a}."}</Tex>
      <p>
        Metcalfe and Boggs's own version counts (1 − A)/A wasted slots, each a full 512-bit slot, before the winning one. Neither is what
        binary exponential backoff does: it does not give every station the same chance. The station that just sent starts its next frame
        with K from {"{0, 1}"} while the others' ranges have doubled with each collision, so it tends to win again, the{" "}
        <em>capture effect</em>. Fewer slots are wasted, at the price of fairness. For ten busy stations on 2.5 km (τ ={" "}
        {texNum(tau / 1000, 1)} µs), 200 ms per point:
      </p>
      <div className="overflow-x-auto">
        <table className="w-full font-sans text-sm tabular-nums lining">
          <thead className="text-xs text-muted-foreground">
            <tr className="text-right">
              <th className="pr-2 text-left font-normal">frame</th>
              <th className="pr-2 font-normal">a</th>
              <th className="pr-2 font-normal">simulated</th>
              <th className="pr-2 font-normal">1/(1 + 5a)</th>
              <th className="font-normal">Metcalfe and Boggs</th>
            </tr>
          </thead>
          <tbody>
            {cd
              .filter((x) => [64, 128, 512, 1518].includes(x.frame_bytes))
              .map((x) => (
                <tr key={x.frame_bytes} className="text-right">
                  <td className="pr-2 text-left">{x.frame_bytes} bytes</td>
                  <td className="pr-2">{x.a.toFixed(3)}</td>
                  <td className="pr-2">{x.efficiency.toFixed(2)}</td>
                  <td className="pr-2">{cdApprox(x.a).toFixed(2)}</td>
                  <td>{metcalfeBoggs(10, (x.frame_bytes * 8 * 1e9) / CD_SWEEP.rate_bps, slot).toFixed(2)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p>
        The formulas agree with each other and with the simulation where it matters, for long frames (small a), and all say the same thing:
        efficiency depends on a, so a faster Ethernet must be either shorter or use longer frames. Gigabit Ethernet's half-duplex mode
        stretched the slot to 512 bytes for exactly this reason. Where they disagree, for short frames, the simulation is right about this
        model and the formulas are right about a fairer protocol.
      </p>

      <h3 className="pt-2 text-lg">CSMA/CA: hidden terminals and the NAV</h3>
      <p>
        A hidden terminal turns CSMA back into ALOHA. C cannot hear A, so any start of C's in the window (t − T, t + T) around the start of
        A's data frame of length T destroys it at B: an unslotted vulnerable window, here 2 × {tData} µs. RTS/CTS shrinks the window to the
        RTS, {tRts} µs: once B's CTS is out, C's NAV holds it for {nav.cts} µs, to the end of the ACK. In the hidden-terminal scenario (100
        ms, seed 1) data loss falls from {pct(hidden.plain.data_loss)} to {pct(hidden.rts.data_loss)}, while {pct(hidden.rts.rts_loss)} of
        RTS frames collide; over seeds 1 to 20 the loss without RTS/CTS never fell below 78% and with it never exceeded 3%. The price is the
        overhead of two extra frames and two SIFS per data frame, which is why real networks use RTS/CTS only above a size threshold.
      </p>
      <p>
        The duration fields follow from the exchange. An RTS announces everything after it,{" "}
        <Tex>{"3\\,\\text{SIFS} + T_{CTS} + T_{data} + T_{ACK}"}</Tex>; the CTS announces that minus its own SIFS and air time; the data
        frame announces SIFS + ACK. Each is set so that every NAV it causes ends when the ACK does, which the tests check exactly.
      </p>

      <h3 className="pt-2 text-lg">Exercises</h3>
      <ol className="list-decimal space-y-3 pl-5">
        <Exercise
          rating="10"
          answer={
            <p>
              Slotted: G e^(−G) at G = 0.5 is 0.303; pure peaks at 0.184, so slotted ALOHA at half its best load still beats pure ALOHA at
              its best.
            </p>
          }
        >
          Compare slotted ALOHA at G = 0.5 with pure ALOHA at its best.
        </Exercise>
        <Exercise
          rating="15"
          answer={
            <p>
              At G = 1 with many stations: e^(−1) ≈ 37% of slots carry exactly one frame, the same fraction are empty, and 1 − 2/e ≈ 26%
              hold collisions. Shorten that last fraction and S rises; that is what carrier sense does.
            </p>
          }
        >
          In slotted ALOHA at its peak, what fractions of slots are empty, successful and collided?
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              2τR = 2 × (1000 / 2×10⁸) × 10⁸ = 1000 bits = 125 bytes. Keeping 512-bit frames at 100 Mb/s allows a round trip of 5.12 µs,
              about 512 m of cable before any repeater delay; Fast Ethernet in half duplex limits a collision domain to about 205 m.
            </p>
          }
        >
          A 100 Mb/s bus is 1 km long and signals travel at 2 × 10⁸ m/s. What is the minimum frame for CSMA/CD, and what does that imply for
          keeping 64-byte frames?
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              After the first collision each picks from {"{0, 1}"}: they collide again with probability 1/2. After the second, from{" "}
              {"{0, …, 3}"}: probability 1/4. The chance of n further collisions in a row is 1/2 × 1/4 × … × 1/2ⁿ = 2^(−n(n+1)/2), which
              falls very fast.
            </p>
          }
        >
          Two stations have just collided for the first time. What is the probability that they collide again on their next attempt, and on
          the attempt after?
        </Exercise>
        <Exercise
          rating="25"
          answer={
            <p>
              The RTS duration is 3 × 16 + T_CTS + T_data + T_ACK. With the scenario's 6 Mb/s rate and 20 µs preamble: T_CTS = T_ACK = 20 +
              19 = 39 µs and T_data = {tData} µs, so NAV_RTS = {nav.rts} µs and NAV_CTS = {nav.cts} µs.
            </p>
          }
        >
          Compute the duration fields of the RTS and CTS for a 1000-byte payload (28 bytes of header) at 6 Mb/s.
        </Exercise>
        <Exercise
          rating="30"
          answer={
            <p>
              Exposed terminals: B → A and C → D with B and C in range. Moving B and C apart until they cannot hear each other frees both;
              but if A could then hear C, C's frames would collide with B's at A. The lab "Set the exposed terminals free" asks for exactly
              this placement.
            </p>
          }
        >
          Find a placement of four nodes in which both flows of the exposed-terminal scenario send at once without either losing frames, and
          explain why carrier sense at the sender cannot discover it.
        </Exercise>
      </ol>
    </Layer>
  )
}

export function LinkFrontier() {
  return (
    <Layer id="link-frontier" layer="Frontier" title="Where these rules went">
      <p>
        <b>Ethernet stopped colliding.</b> Twisted pair and switches gave each station a link of its own, and full-duplex operation (802.3x,
        1997) let both ends send at once. With no shared medium there is nothing to sense and no collision to detect; CSMA/CD survives in
        the standard for half-duplex links, but 10 Gb/s Ethernet and everything faster define full duplex only. Gigabit's half-duplex mode
        had to extend short frames with carrier extension to a 512-byte slot, the a problem from the efficiency analysis in practice, and
        was rarely deployed.
      </p>
      <p>
        <b>Ethernet's backoff was not quite fair.</b> Measurements in the 1980s showed that a busy shared Ethernet did far better than
        ALOHA-style analyses predicted, but also that a station sending back-to-back frames could hold the cable for long stretches, the
        capture effect seen in the six-station scenario. Proposals such as Molle's binary logarithmic arbitration method changed the backoff
        to share more evenly, and switching made the question moot.
      </p>
      <p>
        <b>Wi-Fi refines the DCF.</b> 802.11e's EDCA gives each traffic class its own waiting time (AIFS) and window, so voice frames count
        down from smaller numbers than bulk transfers. 802.11ax (Wi-Fi 6) lets the access point schedule uplink transmissions with trigger
        frames and OFDMA, replacing contention with polling when it is busy, and adds BSS colouring: a station may ignore a weak frame from
        a neighbouring network instead of deferring to it, a direct attack on the exposed-terminal problem. RTS/CTS remains, mostly for
        large frames and as protection for older stations that cannot decode newer modulations.
      </p>
      <p>
        <b>ALOHA lives on wherever stations are many and frames rare.</b> Cellular phones announce themselves on a random-access channel
        that works like slotted ALOHA; LoRaWAN devices send unslotted ALOHA; RFID readers resolve tags with framed slotted ALOHA. Satellite
        systems use variants such as contention resolution diversity slotted ALOHA, which sends each frame twice and cancels decoded copies
        out of collisions, pushing throughput well past 1/e.
      </p>
    </Layer>
  )
}

export function LinkInternals() {
  return (
    <Layer id="link-internals" layer="Internals" title="How the models work, and what they leave out">
      <p>
        The models are Rust (crates/netsim/src/link.rs) compiled to WebAssembly. Each is a pure function from parameters and a seed to a
        complete trace, which the page replays; the clock and the controls never change the run, only which moment of it is shown. Every
        random choice comes from a seeded generator, and each ALOHA station has a stream of its own, so changing one setting does not
        reshuffle unrelated draws.
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>ALOHA</b> draws all start times first. Unslotted stations alternate a frame with an exponential silence of mean n/G − 1 frame
          times, starting in the steady state, so S has the exact form in the analysis. Overlaps are then found by sorting starts.
        </li>
        <li>
          <b>CSMA/CD</b> is an event simulation in nanoseconds. Each station's tap counts the signals passing it: every transmission's
          leading edge reaches station j at its start plus |x_i − x_j|/v, and its trailing edge at its end plus the same. A station hears a
          collision when a leading edge arrives while it is sending. Efficiency is the fraction of the run the cable spent carrying frames
          that got through.
        </li>
        <li>
          <b>CSMA/CA</b> is an event simulation in microseconds. A node hears exactly the nodes within range. A frame is decoded by a node
          in range if that node is not sending and no other frame from a node it can hear overlaps it there. Backoff counts in whole slots;
          two nodes whose counters reach zero in the same slot cannot hear each other in time and collide. A receiver whose NAV is set does
          not answer an RTS, as the standard requires.
        </li>
      </ul>
      <h3 className="pt-2 text-lg">Simplifications</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          ALOHA's stations always have a frame, and G is fixed: the model shows the channel, not the feedback by which retransmissions raise
          G and can drive a real ALOHA network past its peak.
        </li>
        <li>
          Every overlap destroys every frame involved. Real receivers sometimes decode the stronger of two frames (capture), which ALOHA's
          analysis and this model ignore.
        </li>
        <li>
          The Ethernet is a single bus with no repeaters, every frame the same size, and no bit errors. Collision detection is instant when
          a signal arrives.
        </li>
        <li>
          The radio range is a sharp circle, the same for hearing and decoding, and signals cross it instantly. Real radios have a
          carrier-sense range larger than the decoding range, fading, capture and rate adaptation.
        </li>
        <li>
          802.11 is modelled without EIFS, fragmentation, beacons or power saving, at one rate (6 Mb/s, the 802.11a/g base rate) with 9 µs
          slots.
        </li>
        <li>
          At most twelve wireless nodes, and runs short enough to replay in the browser: the sweeps behind the charts are run without a
          trace.
        </li>
      </ul>
      <h3 className="pt-2 text-lg">References</h3>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          N. Abramson, “The ALOHA System: another alternative for computer communications”, AFIPS Fall Joint Computer Conference, 1970.
        </li>
        <li>
          L. G. Roberts, “ALOHA packet system with and without slots and capture”, ACM SIGCOMM Computer Communication Review 5(2), 1975
          (circulated 1972).
        </li>
        <li>
          R. M. Metcalfe and D. R. Boggs, “Ethernet: distributed packet switching for local computer networks”, Communications of the ACM
          19(7), 1976.
        </li>
        <li>
          L. Kleinrock and F. A. Tobagi, “Packet switching in radio channels, Part I: carrier sense multiple-access modes and their
          throughput-delay characteristics”, IEEE Transactions on Communications 23(12), 1975.
        </li>
        <li>
          F. A. Tobagi and L. Kleinrock, “Packet switching in radio channels, Part II: the hidden terminal problem in carrier sense
          multiple-access and the busy-tone solution”, IEEE Transactions on Communications 23(12), 1975.
        </li>
        <li>D. R. Boggs, J. C. Mogul and C. A. Kent, “Measured capacity of an Ethernet: myths and reality”, ACM SIGCOMM, 1988.</li>
        <li>
          P. Karn, “MACA: a new channel access method for packet radio”, ARRL/CRRL Amateur Radio Computer Networking Conference, 1990.
        </li>
        <li>V. Bharghavan, A. Demers, S. Shenker and L. Zhang, “MACAW: a media access protocol for wireless LANs”, ACM SIGCOMM, 1994.</li>
        <li>
          G. Bianchi, “Performance analysis of the IEEE 802.11 distributed coordination function”, IEEE Journal on Selected Areas in
          Communications 18(3), 2000.
        </li>
        <li>IEEE 802.3-2022, Clause 4 (Media Access Control); IEEE 802.11-2020, Clause 10 (MAC sublayer functional description).</li>
        <li>J. F. Kurose and K. W. Ross, Computer Networking: A Top-Down Approach, 8th edition, Pearson, 2021, Sections 6.3 and 7.3.</li>
        <li>A. S. Tanenbaum and D. J. Wetherall, Computer Networks, 5th edition, Pearson, 2011, Sections 4.2 and 4.4.</li>
      </ul>
    </Layer>
  )
}
