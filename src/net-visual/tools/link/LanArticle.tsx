// The article for the LAN and coding modes: learning switches, the spanning
// tree, CRCs and Hamming codes, in the same five layers as the rest of the site.
import type { ReactNode } from "react"

import { Tex } from "../../components/Tex"
import { Exercise, Layer } from "../rdt/RdtArticle"

function Try({ id, onLoad, children }: { id: string; onLoad(id: string): void; children: ReactNode }) {
  return (
    <button type="button" className="font-sans text-sm text-[var(--link)] underline underline-offset-2" onClick={() => onLoad(id)}>
      {children}
    </button>
  )
}

export function LanIntro({ onLoad }: { onLoad(id: string): void }) {
  return (
    <Layer id="lan-intuition" layer="Intuition" title="Joining links into a LAN, and trusting what crosses them">
      <p>
        Once each station has a link of its own, the question is no longer who may talk but where a frame should go. A <em>switch</em> (a
        bridge, in the standard's word) answers by listening. Every frame carries its source address, so each one that arrives says where
        its sender lives: out of the port it came in on. The switch writes that down. When a frame comes for a host it has heard from, it
        sends the frame out of that one port; for a host it has not heard from, it sends a copy out of every port and lets the right host
        pick it up. Nobody configures the table. It fills itself from ordinary traffic and forgets entries that go quiet.
      </p>
      <p>
        That works only if there is exactly one path between any two hosts. Add a second cable for safety and a flooded frame goes round the
        loop for ever, copying itself at every switch, because an Ethernet frame has no hop count to run out. The{" "}
        <em>spanning tree protocol</em> keeps the spare cable but switches it off. The bridges elect a root, each finds its cheapest path to
        it, and every port not on one of those paths stops forwarding data. When a link fails, a blocked port takes over, after a deliberate
        wait.
      </p>
      <p>
        Bits on a link also get damaged. A <em>cyclic redundancy check</em> treats the frame as one long binary number and appends the
        remainder of dividing it by an agreed divisor. The receiver divides again: a nonzero remainder means damage. A <em>Hamming code</em>{" "}
        goes further and arranges its parity bits so that the pattern of failed checks spells out the position of a single bad bit, which
        can then be flipped back.
      </p>

      <h3 className="pt-2 text-lg">Misconceptions this tool is built to correct</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>“A switch needs to be told where the hosts are.”</b> It learns from source addresses, so the first frame to an unknown host is
          flooded. The reply teaches every switch on its path, and from then on frames take one path.{" "}
          <Try id="learn" onLoad={onLoad}>
            Watch the tables fill.
          </Try>
        </li>
        <li>
          <b>“A switch always passes a frame on.”</b> If the destination sits on the same port the frame came in on, as behind a hub, the
          frame has already reached it. The switch drops it, and the rest of the LAN never sees it.{" "}
          <Try id="filter" onLoad={onLoad}>
            Filtering behind a hub.
          </Try>
        </li>
        <li>
          <b>“A redundant link just gives frames a second route.”</b> Without the spanning tree, one broadcast becomes a storm: the copies
          double with every hop, and they never stop.{" "}
          <Try id="storm" onLoad={onLoad}>
            One broadcast, four switches.
          </Try>{" "}
          <Try id="storm-stp" onLoad={onLoad}>
            The same LAN with the tree.
          </Try>
        </li>
        <li>
          <b>“The spanning tree finds the best path between every pair.”</b> It builds one tree, rooted at whichever bridge has the lowest
          ID, which may be the slowest box in the building. Two bridges side by side may talk through the root, and blocked links carry no
          data at all.{" "}
          <Try id="stp-converge" onLoad={onLoad}>
            Five bridges converge.
          </Try>
        </li>
        <li>
          <b>“When a link breaks, the spare takes over at once.”</b> Classic 802.1D waits two forward delays, 30 s, before a blocked port
          forwards. If the failure is silent, the bridges first wait for the old information to age out, up to 20 s more.{" "}
          <Try id="stp-fail" onLoad={onLoad}>
            A sensed failure.
          </Try>{" "}
          <Try id="stp-silent" onLoad={onLoad}>
            A silent one.
          </Try>
        </li>
        <li>
          <b>“A CRC catches every error.”</b> It catches every burst up to r bits and every error a well-chosen generator was designed for.
          But an error pattern that is itself a multiple of the generator leaves the remainder unchanged and passes.{" "}
          <Try id="crc-missed" onLoad={onLoad}>
            Three flipped bits, accepted.
          </Try>
        </li>
        <li>
          <b>“An error-correcting code can only help.”</b> A Hamming code corrects one error. Given two, it confidently flips a third bit
          and hands over wrong data without a warning. One more parity bit (SECDED) turns that into a reported error.{" "}
          <Try id="hamming-double" onLoad={onLoad}>
            Two errors, made worse.
          </Try>{" "}
          <Try id="secded" onLoad={onLoad}>
            Two errors, reported.
          </Try>
        </li>
      </ul>
    </Layer>
  )
}

export function LanMechanics() {
  return (
    <Layer id="lan-mechanics" layer="Mechanics" title="Tables, trees, remainders and syndromes">
      <h3 className="text-lg">The learning switch</h3>
      <p>
        For every frame that arrives on port p<sub>in</sub> with source s and destination d, a switch first sets T[s] = p<sub>in</sub> with
        the time (step S2). It then looks up d (S3). If T[d] = p<sub>in</sub> it filters; if T[d] is another port it forwards out of that
        port alone; if d is unknown or the broadcast address, it floods out of every port except p<sub>in</sub>. An entry not refreshed
        within the ageing time is removed (S6); 802.1D's default is 300 s. Hubs repeat signals and learn nothing (S8). The model's steps are
        the comments in lan.rs, shown under Go deeper.
      </p>
      <h3 className="pt-2 text-lg">The spanning tree</h3>
      <p>
        Each bridge has an ID: a 16-bit priority (default 32768), then its MAC address, compared as one number. Bridges exchange{" "}
        <em>configuration BPDUs</em> carrying a vector (root ID, cost to the root, sender's bridge ID, sender's port), and compare vectors
        field by field, lower being better. A bridge starts as its own root (B1). Whoever believes it is root sends a BPDU every hello time
        (B2); every other bridge relays what arrives on its root port out of its designated ports with its own cost added (B6).
      </p>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <b>Root bridge:</b> the lowest bridge ID anyone has heard of.
        </li>
        <li>
          <b>Root port</b> (one per non-root bridge): the port with the least cost to the root, which is the cost heard there plus that
          port's own cost. Ties go to the lower sender bridge ID, then the lower sender port ID (B4).
        </li>
        <li>
          <b>Designated port</b> (one per link): the end offering the better vector to that link. All of the root's ports are designated
          (B5).
        </li>
        <li>
          <b>Alternate ports:</b> everything else. They block data but keep listening to BPDUs.
        </li>
      </ul>
      <p>
        A port whose role allows forwarding does not start at once. It spends a forward delay (15 s) <em>listening</em>, in case the tree is
        still changing, then another <em>learning</em> addresses without forwarding, and only then forwards (B9). Information heard on a
        port expires after max age (20 s) less the age it already had (B8). That is how a bridge notices a failure it cannot sense.
      </p>
      <h3 className="pt-2 text-lg">The CRC</h3>
      <p>
        Read a k-bit message as a polynomial M(x) with coefficients in GF(2), where 1 + 1 = 0, so addition and subtraction are both XOR.
        With a generator G(x) of degree r, the sender computes
      </p>
      <Tex display>{`M(x)\\,x^r = Q(x)\\,G(x) + R(x),\\qquad \\deg R < r,`}</Tex>
      <p>
        by long division in which each step XORs G under the leftmost remaining 1 (C2). It sends T(x) = M(x)x<sup>r</sup> + R(x), which G
        divides exactly (C3). If the channel adds an error E(x), the receiver's remainder is E(x) mod G(x) (C5). It is zero exactly when G
        divides E.
      </p>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          A single error is E = x<sup>i</sup>, which any G with two or more terms fails to divide.
        </li>
        <li>
          A burst of length b ≤ r is x<sup>i</sup>B(x) with deg B = b − 1 &lt; r. If G has a constant term, G is coprime to x<sup>i</sup>,
          so it would have to divide B, which is impossible.
        </li>
        <li>If (x + 1) divides G, every multiple of G has an even number of terms, so every odd-weight error is caught.</li>
      </ul>
      <h3 className="pt-2 text-lg">The Hamming code</h3>
      <p>
        Number the positions of a codeword from 1 to n = 2<sup>r</sup> − 1. The positions 1, 2, 4, … hold parity, and the data fills the
        rest (H1). Parity bit 2<sup>i</sup> makes even the count of 1s among positions whose binary number has bit i set (H2). A single
        error at position j fails exactly the checks of j's binary digits, so the failed checks, read as a binary number, give j: the{" "}
        <em>syndrome</em> (H5, H6). Any two codewords differ in at least three places, so one error can be corrected. An overall parity bit
        at position 0 raises the distance to four (SECDED, H3). A nonzero syndrome with even overall parity then means two errors, which are
        reported rather than "corrected" (H7).
      </p>
    </Layer>
  )
}

export function LanAnalysis() {
  return (
    <Layer id="lan-analysis" layer="Analysis" title="How fast storms grow, how long trees take, and what codes guarantee">
      <h3 className="text-lg">Storms</h3>
      <p>
        In the four-switch scenario every switch has three switch neighbours and one host. The first switch floods a broadcast to three
        switches. Each copy that reaches a switch leaves again on its two other switch links and to its host. So the copies on switch links
        go 3, 6, 12, 24, …, doubling every hop, while every host receives a fresh copy each hop. The model's running total of transmissions
        is 1, 4, 13, 31, 67, 139, 283, 571. With a spanning tree, three ports block, one per independent loop (|L| − |N| + 1 = 6 − 4 + 1
        among the switches). The broadcast then costs 10 transmissions and stops: one on each of the three tree links and four host links,
        and one into each blocked port, where it is dropped. C's reply to A, sent once every switch has learned A, takes 3 more.
      </p>
      <h3 className="pt-2 text-lg">Convergence</h3>
      <p>
        Roles settle as fast as BPDUs cross the LAN, in tens of milliseconds in the five-bridge scenario. Forwarding waits for the timers:
      </p>
      <Tex
        display
      >{`T_{\\text{sensed}} = 2\\,T_{\\text{fwd}} = 30\\ \\text{s},\\qquad T_{\\text{silent}} \\le T_{\\text{max age}} + 2\\,T_{\\text{fwd}} = 50\\ \\text{s}.`}</Tex>
      <p>
        In the silent scenario the outage is about 46 s, not 50 s. B3's copy of the root's news was already a second old when it arrived, so
        it expired about 17 s after the cut. 802.1D's timers come from a worst case of seven bridges across the LAN, with a BPDU taking up
        to a second per bridge: max age must outlast news crossing the LAN, and the forward delay must let the old tree's ports stop before
        the new tree's start.
      </p>
      <h3 className="pt-2 text-lg">What a CRC guarantees</h3>
      <p>
        With r check bits and a generator that has a constant term, every burst of length at most r is detected. Of the bursts of length
        exactly r + 1, which have both ends fixed at 1 and r − 1 free bits inside, only the one equal to G is missed: a fraction 2
        <sup>−(r−1)</sup>. Of longer bursts, a fraction 2<sup>−r</sup> is missed. The chart under Go deeper counts these by brute force for
        the chosen generator. For CRC-32 that is about one long burst in 4.3 billion. Some guarantees depend on the frame length: CRC-32
        catches every error of up to three bits only in frames shorter than about 11,450 bytes (Koopman, 2002).
      </p>
      <h3 className="pt-2 text-lg">What a Hamming code buys</h3>
      <p>With bits flipped independently with probability q, a (7,4) block is decoded wrongly when two or more bits flip:</p>
      <Tex display>{`P_{\\text{wrong}} = 1 - (1-q)^7 - 7q(1-q)^6 \\approx 21q^2,`}</Tex>
      <p>
        against 4q for four bits sent bare. At q = 10<sup>−3</sup> that is about 2 × 10<sup>−5</sup> instead of 4 × 10<sup>−3</sup>, for 75%
        more bits. SECDED's 8 bits report every double error, so the data comes out wrong without warning only with three or more errors:
        all 56 triple errors and 14 of the 70 quadruple ones, about 56q<sup>3</sup>.
      </p>

      <h3 className="pt-2 text-lg">Exercises</h3>
      <ol className="list-decimal space-y-3 pl-5">
        <Exercise
          rating="10"
          answer={
            <p>
              The first frame from each host to someone not yet heard from is flooded. Once every host has sent at least one frame, every
              switch on every path knows every host, so nothing is flooded until an entry ages out.
            </p>
          }
        >
          In a LAN of switches with no loops, when does flooding stop?
        </Exercise>
        <Exercise
          rating="15"
          answer={
            <p>
              The frame arrived on port 2 and the table says the destination is on port 2. The destination shares that segment, behind a
              hub, so it has the frame already. Sending it back would deliver it twice, and sending it anywhere else would waste those
              links.
            </p>
          }
        >
          A switch's table lists C on port 2, and a frame for C arrives on port 2. What does the switch do, and why?
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              B1 is root (lowest MAC, equal priorities). Root ports: B2 and B5 straight to B1, cost 4. B3 via B2, at 4 + 4 = 8, against 19
              direct. B4 via B5, at 8 (via B3 would be 12). Designated ends: B2 on B2–B3. B3 on B3–B4, a tie at cost 8 broken by B3's lower
              ID. B5 on B4–B5. B2 on B2–B5, cost 4 each, again by ID. B1 on B1–B3. The blocked ports are B4's toward B3, B5's toward B2 and
              B3's toward B1, three ports for 7 − 5 + 1 = 3 loops.
            </p>
          }
        >
          In the five-bridge scenario, with the costs shown in the picture, work out the root, every root port, and which three ports block.
          Then check against the list of each bridge's ports under Go deeper.
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              Lower one of B4's priorities, for example to 4096: the root is decided before cost is considered. The lab "Choose the root"
              asks for this. Every root port then points toward B4, and the costs are recomputed from it.
            </p>
          }
        >
          How would you make B4 the root without touching any cable or cost?
        </Exercise>
        <Exercise
          rating="15"
          answer={
            <p>
              11010110110000 divided by 10011 leaves 1110, so the frame is 11010110111110. Its remainder is zero. Step through "Long
              division by hand" to check each subtraction.
            </p>
          }
        >
          Compute the CRC of 1101011011 with G(x) = x<sup>4</sup> + x + 1.
        </Exercise>
        <Exercise
          rating="25"
          answer={
            <p>
              If (x + 1) divides G(x), then G(1) = 0, so every multiple E(x) = A(x)G(x) has E(1) = 0. But E(1) counts the flipped bits mod
              2. An odd-weight error has E(1) = 1, so it cannot be a multiple of G.
            </p>
          }
        >
          Prove that a generator with x + 1 as a factor detects every error that flips an odd number of bits.
        </Exercise>
        <Exercise
          rating="15"
          answer={
            <p>
              Data 1011 goes in positions 3, 5, 6 and 7. p1 covers bits 3, 5 and 7 (1, 0, 1), so p1 = 0. p2 covers 3, 6 and 7 (1, 1, 1), so
              p2 = 1. p4 covers 5, 6 and 7 (0, 1, 1), so p4 = 0. The codeword is 0110011. Flipping bit 5 fails checks 1 and 4: syndrome 101
              = 5.
            </p>
          }
        >
          Encode 1011 with the (7,4) Hamming code, flip bit 5, and find the syndrome.
        </Exercise>
        <Exercise
          rating="25"
          answer={
            <p>
              Errors at i and j give syndrome i ⊕ j. That is nonzero, and it is a valid position, because every number from 1 to 7 is one.
              The plain decoder flips that third bit. SECDED's overall parity is even after two flips, so it reports instead.
            </p>
          }
        >
          Why does a plain (7,4) Hamming decoder always make two errors worse?
        </Exercise>
      </ol>
    </Layer>
  )
}

export function LanFrontier() {
  return (
    <Layer id="lan-frontier" layer="Frontier" title="Faster trees, no trees, and stronger codes">
      <p>
        <b>Rapid spanning tree.</b> 802.1w (2001, folded into 802.1D-2004) replaces the timers with a handshake. A designated port proposes,
        the bridge below agrees once it has blocked its other ports, and the link forwards within a round trip. Alternate ports are kept as
        ready-made backups for the root port, so most failures are repaired in well under a second. 802.1s (MSTP) runs several trees, so
        different VLANs can use different links.
      </p>
      <p>
        <b>Beyond trees.</b> A tree wastes every blocked link. Shortest Path Bridging (802.1aq) and TRILL (RFC 6325) run IS-IS, a link-state
        routing protocol, between switches, so frames take shortest paths and traffic can spread over equal-cost paths. TRILL adds a hop
        count to the frame, the one thing whose absence makes storms possible. Most large data centres went further and route IP all the way
        to the rack, leaving Ethernet only on single links.
      </p>
      <p>
        <b>Choosing CRCs.</b> Standard polynomials were often chosen by habit. Castagnoli's searches (1993) and Koopman's exhaustive
        evaluations found generators with better distance at practical frame lengths. CRC-32C, from that work, protects iSCSI, SCTP and ext4
        metadata, and has its own instruction in modern processors. Stone and Partridge (2000) found that end-to-end checks still catch
        errors no link CRC saw, introduced inside routers and hosts rather than on the wire.
      </p>
      <p>
        <b>Correction everywhere.</b> Server memory uses SECDED codes, typically Hsiao's (72,64) variant, and "chipkill" codes that survive
        a whole failed chip. Reed–Solomon codes, which correct whole bytes, protect CDs, QR codes and DSL. 100 Gb/s Ethernet and faster
        links use Reed–Solomon forward error correction because retransmitting is too slow. Wi-Fi from 802.11n, 10GBASE-T and 5G data
        channels use LDPC codes, and 5G control channels use polar codes, both close to the Shannon limit.
      </p>
    </Layer>
  )
}

export function LanInternals() {
  return (
    <Layer id="lan-internals" layer="Internals" title="How the models work, and what they leave out">
      <p>
        Three more Rust modules, compiled to WebAssembly with the rest. Each is a pure function from settings to a complete trace, which the
        page replays.
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>lan.rs</b> is an event simulation in microseconds. Each copy of a frame takes one hop time per link, and switches act on
          arrival. It stops at a cap on transmissions, which is how a storm ends.
        </li>
        <li>
          <b>stp.rs</b> runs 802.1D's port information, role selection and state machines as events in milliseconds, and also computes the
          tree directly from shortest paths with the same tie-breaks. The tests check that the protocol reaches the direct answer, that the
          forwarding links form a spanning tree, and that each link has exactly one designated port.
        </li>
        <li>
          <b>coding.rs</b> does the long division on bit strings and checks itself against the published check values of CRC-8, CRC-16
          (CCITT-FALSE) and CRC-32 for "123456789". It counts undetected errors by enumerating every pattern. For Hamming codes it decodes
          every error pattern of up to four bits, and the tests check that every single error is corrected, every double is detected under
          SECDED, and the minimum distance is 3, or 4 with SECDED.
        </li>
      </ul>
      <h3 className="pt-2 text-lg">Simplifications</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          Every link is point to point and loses nothing. The only shared segments are behind hubs. Frames have no length, only a hop time.
        </li>
        <li>
          In the switch mode the blocked ports come from the direct computation of the tree, with switches ranked in list order. They are
          the ports a converged spanning tree would block; the switch mode does not run the protocol.
        </li>
        <li>Ageing times are microseconds rather than 802.1D's 300 s, so entries expire within a run.</li>
        <li>
          There are no topology change notifications, so tables are not flushed early after a change, and port priorities are fixed: a
          port's ID is its number. Message age rises by exactly one second per bridge.
        </li>
        <li>
          The standard CRCs in the table use their published start values, bit reflection and final XOR. The worked division uses the plain
          form, which starts from zero, so it matches CRC-8 directly but not CRC-32.
        </li>
        <li>
          Bit errors are chosen by hand or enumerated exhaustively. There is no random channel, and the block-error chart assumes
          independent errors, which real channels, prone to bursts, do not give.
        </li>
      </ul>
      <h3 className="pt-2 text-lg">References</h3>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>R. Perlman, “An algorithm for distributed computation of a spanning tree in an extended LAN”, ACM SIGCOMM, 1985.</li>
        <li>IEEE 802.1D-1998 (MAC bridges, Clauses 7 and 8) and IEEE 802.1D-2004 (rapid reconfiguration).</li>
        <li>W. W. Peterson and D. T. Brown, “Cyclic codes for error detection”, Proceedings of the IRE 49(1), 1961.</li>
        <li>R. W. Hamming, “Error detecting and error correcting codes”, Bell System Technical Journal 29(2), 1950.</li>
        <li>
          M. Y. Hsiao, “A class of optimal minimum odd-weight-column SEC-DED codes”, IBM Journal of Research and Development 14(4), 1970.
        </li>
        <li>
          G. Castagnoli, S. Bräuer and M. Herrmann, “Optimization of cyclic redundancy-check codes with 24 and 32 parity bits”, IEEE
          Transactions on Communications 41(6), 1993.
        </li>
        <li>R. N. Williams, “A painless guide to CRC error detection algorithms”, 1993.</li>
        <li>P. Koopman, “32-bit cyclic redundancy codes for Internet applications”, IEEE/IFIP DSN, 2002.</li>
        <li>
          P. Koopman and T. Chakravarty, “Cyclic redundancy code (CRC) polynomial selection for embedded networks”, IEEE/IFIP DSN, 2004.
        </li>
        <li>J. Stone and C. Partridge, “When the CRC and TCP checksum disagree”, ACM SIGCOMM, 2000.</li>
        <li>J. F. Kurose and K. W. Ross, Computer Networking: A Top-Down Approach, 8th edition, Pearson, 2021, Sections 6.2 and 6.4.</li>
        <li>A. S. Tanenbaum and D. J. Wetherall, Computer Networks, 5th edition, Pearson, 2011, Sections 3.2 and 4.8.</li>
      </ul>
    </Layer>
  )
}
