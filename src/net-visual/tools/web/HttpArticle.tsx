// The article for the HTTP modes: why HTTP changed four times, what each
// version costs in round trips, and where head-of-line blocking lives.
import { useMemo, type ReactNode } from "react"

import { Tex } from "../../components/Tex"
import { HTTP_PRESETS, MS, fmtNs, runHttp } from "../../core/http"
import type { Netsim } from "../../core/netsim"
import { Exercise, Layer } from "../rdt/RdtArticle"

function Try({ id, onLoad, children }: { id: string; onLoad(id: string): void; children: ReactNode }) {
  return (
    <button type="button" className="font-sans text-sm text-link underline underline-offset-2" onClick={() => onLoad(id)}>
      {children}
    </button>
  )
}

export function HttpIntro({ onLoad }: { onLoad(id: string): void }) {
  return (
    <Layer id="http-intuition" layer="Intuition" title="A page is many objects, and every round trip shows">
      <p>
        A web page is not one file. The browser fetches the HTML first, reads it, and finds it names a style sheet, scripts, fonts and
        images, often dozens of them. Each is a separate HTTP request and response. On a path with a 50 ms round trip, the bytes of a small
        page take a few milliseconds to send; the waiting takes hundreds. Almost all the history of HTTP is the history of removing round
        trips from that waiting.
      </p>
      <p>
        HTTP/1.0 opened a TCP connection for every object and closed it after one response, so each object paid a round trip to set up the
        connection and another to ask. HTTP/1.1 kept the connection open, saving the first of those. Browsers then opened several
        connections at once to fetch objects side by side. HTTP/2 put every request on one connection as interleaved <em>streams</em>, so
        nothing waits for a whole response ahead of it. HTTP/3 moved those streams onto QUIC, a transport that keeps each stream's bytes in
        order separately, and that sets up the connection and its encryption in a single round trip.
      </p>
      <p>
        The thread running through all of it is <em>head-of-line blocking</em>: data that has arrived but cannot be used because something
        ahead of it in a queue has not. Each version moved where that queue is. The tool's streams view makes it visible: for each object,
        the bytes that have reached the client and the bytes the browser has been allowed to have.
      </p>

      <h3 className="pt-2 text-lg">Misconceptions this tool is built to correct</h3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <b>"HTTP/2 got rid of head-of-line blocking."</b> It removed it from HTTP: no response waits for another to finish. But TCP still
          hands bytes to the browser in order, so one lost segment holds back every stream with data behind it until the retransmission
          arrives.{" "}
          <Try id="h2-loss" onLoad={onLoad}>
            Try it: one loss under HTTP/2
          </Try>{" "}
          and then{" "}
          <Try id="h3-loss" onLoad={onLoad}>
            the same loss under HTTP/3
          </Try>
          .
        </li>
        <li>
          <b>"HTTP/3 is faster because UDP is faster than TCP."</b> UDP is only an envelope; QUIC rebuilds reliability and congestion
          control on top of it, much as TCP does. What HTTP/3 saves is a round trip of setup and the cross-stream stalls, not raw speed.{" "}
          <Try id="quic-1rtt" onLoad={onLoad}>
            Compare QUIC's first byte
          </Try>{" "}
          with{" "}
          <Try id="tls-tcp" onLoad={onLoad}>
            TCP plus TLS 1.3
          </Try>
          .
        </li>
        <li>
          <b>"Persistent connections save bandwidth."</b> They send the same bytes. What they save is the handshake round trip per object,
          and the slow start a fresh connection begins with.{" "}
          <Try id="h11-persistent" onLoad={onLoad}>
            Try it
          </Try>
          .
        </li>
        <li>
          <b>"Pipelining solved HTTP/1.1's waiting."</b> Pipelined responses must come back in the order they were asked for, so one large
          response delays every small one behind it, and browsers never turned it on by default.{" "}
          <Try id="pipeline-hol" onLoad={onLoad}>
            Try it: an icon stuck behind a video
          </Try>
          .
        </li>
        <li>
          <b>"0-RTT is a free round trip."</b> The early request travels before the handshake has proved anything fresh, so an attacker who
          records it can send it again. Servers must accept 0-RTT only for requests that are safe to repeat.{" "}
          <Try id="quic-0rtt" onLoad={onLoad}>
            Try it
          </Try>
          .
        </li>
        <li>
          <b>"More connections are always faster."</b> Each one pays its own handshake and slow start, and they share the same bottleneck.
          Six connections beat one sequential connection, but one multiplexed connection beats six.{" "}
          <Try id="h11-six" onLoad={onLoad}>
            Try six connections
          </Try>{" "}
          against{" "}
          <Try id="h2-page" onLoad={onLoad}>
            HTTP/2
          </Try>
          .
        </li>
      </ul>
    </Layer>
  )
}

export function HttpMechanics() {
  return (
    <Layer id="http-mechanics" layer="Mechanics" title="Connections, requests, frames and packets, step by step">
      <p>
        Every event in the trace carries a lettered step, which is also a comment in the Rust source under Go deeper; the step behind the
        current moment is shaded there.
      </p>
      <ol className="list-none space-y-2 pl-0">
        <li>
          <b>C1. Open a connection.</b> TCP's handshake takes one round trip (SYN, SYN-ACK; the ACK can carry the request). TLS 1.3 adds a
          ClientHello and ServerHello exchange, one more round trip, unless a resumed session sends the request as early data. QUIC does
          both in its first exchange: the Initial packets carry the TLS handshake, so the request can follow after one round trip, or in the
          very first flight on resumption.
        </li>
        <li>
          <b>C2. Ask.</b> The browser asks for the base page, then, once it has arrived, for the objects it names. Under HTTP/1.x a
          connection carries one outstanding request unless pipelining is on; with it the client sends all its requests at once. Under
          HTTP/2 and HTTP/3 every request goes at once, each on its own stream: odd-numbered stream identifiers for client requests, a
          HEADERS frame for the request and the response headers, DATA frames for the body.
        </li>
        <li>
          <b>S1. Queue the responses.</b> An HTTP/1.1 server must answer requests on a connection in the order they arrived. An HTTP/2 or
          HTTP/3 server may interleave frames of different streams; this one sends one packet's worth from each stream in turn, the
          incremental behaviour of RFC 9218's priorities. The settings under Go deeper can switch it to sending each response whole.
        </li>
        <li>
          <b>S2. Send.</b> Each connection has its own congestion window. A new connection starts with ten packets (RFC 6928), grows by a
          packet for every acknowledgement in slow start, and halves on a loss. Every packet then queues at the bottleneck and takes its
          size over the rate to leave.
        </li>
        <li>
          <b>R1. Receive.</b> The client acknowledges at once and, if it can, hands the data to the browser. TCP can hand over only bytes
          that continue the connection's byte stream without a gap. QUIC numbers each STREAM frame by its offset within its own stream, so
          it can hand over anything that continues that stream, whatever else is missing.
        </li>
        <li>
          <b>L1. Declare lost.</b> When three packets sent after a missing one have been acknowledged, the sender declares it lost and
          resends it at once: TCP's fast retransmit after three duplicate acknowledgements, and QUIC's packet threshold. If fewer than three
          follow it, a timer two round trips after it was sent fires instead.
        </li>
        <li>
          <b>O1. Object complete</b> and <b>P1. Page complete.</b> An object is complete when its last byte is delivered; the page load time
          is when the last object completes. Under HTTP/1.0 the connection then closes; under HTTP/1.1 it stays for the next request.
        </li>
      </ol>
      <p>
        HTTP/2's frames carry a nine-byte header: length, type, flags and a stream identifier. Streams have their own flow-control windows
        as well as the connection's, so a slow consumer of one stream cannot stall the rest at the HTTP layer. None of that helps below it,
        where TCP sees only one byte stream. QUIC's packets are numbered afresh for every transmission, so a retransmission is never
        confused with the original (TCP's retransmission ambiguity), and acknowledgement frames can report many ranges at once.
      </p>
    </Layer>
  )
}

export function HttpAnalysis({ sim }: { sim: Netsim }) {
  const loss = useMemo(() => {
    const at = (id: string) => runHttp(sim, HTTP_PRESETS.find((p) => p.id === id)!.params.http).stats
    return { h2: at("h2-loss"), h3: at("h3-loss"), six: at("h11-six"), h2page: at("h2-page") }
  }, [sim])
  return (
    <Layer id="http-analysis" layer="Analysis" title="What a page costs in round trips, and what a loss costs each version">
      <p>
        Write RTT for the round-trip time, R for the bottleneck rate, L<sub>i</sub> for the size of object i (the base page is object 1) and
        N for the number of objects. Let h be the round trips of setup before the first request can leave: 1 for TCP, 2 for TCP with TLS
        1.3, 1 for TCP with TLS 0-RTT (TCP's own handshake remains), 1 for QUIC and 0 for QUIC with 0-RTT.
      </p>

      <h3 className="text-lg">Theorem 1 (time to first byte)</h3>
      <p>With no loss, the first byte of the base page reaches the client at</p>
      <Tex display>{`t_{\\text{first byte}} = (h + 1)\\,\\text{RTT} + \\frac{\\min(L_1, \\text{MSS})}{R}.`}</Tex>
      <p>
        <i>Proof.</i> The request leaves after h round trips and reaches the server half a round trip later; the first packet of the
        response is sent at once, takes its size over R to leave, and half a round trip to arrive. At RTT = 50 ms and 10 Mb/s the tool
        measures 101.168 ms for TCP and for QUIC, 151.168 ms for TCP with TLS 1.3, and 51.168 ms for QUIC with 0-RTT, exactly as the formula
        gives. ∎
      </p>

      <h3 className="text-lg">Theorem 2 (non-persistent and persistent connections)</h3>
      <p>
        If every object fits in the initial window and the connections are used one at a time, non-persistent HTTP/1.0 takes, and persistent
        HTTP/1.1 without pipelining takes,
      </p>
      <Tex
        display
      >{`T_{1.0} = \\sum_{i=1}^{N} \\Big((h + 1)\\,\\text{RTT} + \\frac{L_i}{R}\\Big), \\qquad T_{1.1} = h\\,\\text{RTT} + \\sum_{i=1}^{N} \\Big(\\text{RTT} + \\frac{L_i}{R}\\Big).`}</Tex>
      <p>
        <i>Proof.</i> Under HTTP/1.0 each object needs its own setup, a round trip for the request and its last byte, and its own
        transmission time; nothing overlaps because the next request waits for the previous response. Under HTTP/1.1 the setup happens once.
        Because each object fits in the initial window, no object waits for an acknowledgement before its last byte is sent. ∎ For nine
        objects totalling 66 kB at 50 ms and 10 Mb/s, both are exact in the tool: 952.8 ms and 552.8 ms. With k parallel connections and k ≥
        N − 1 the rest of the page costs one more setup and request after the base: (h + 1) RTT · 2 + Σ L<sub>i</sub>/R, which is 252.8 ms
        for the same page with eight connections.
      </p>

      <h3 className="text-lg">Theorem 3 (a lower bound on one connection)</h3>
      <Tex display>{`T \\;\\ge\\; (h + 2)\\,\\text{RTT} + \\sum_{i=1}^{N} \\frac{L_i}{R}.`}</Tex>
      <p>
        <i>Proof.</i> The setup takes h round trips; the base page needs a round trip before its names are known; the objects it names need
        at least one more; and every byte must cross the bottleneck once. ∎ HTTP/2 and HTTP/3 approach the bound when the page fits in a few
        windows: {fmtNs(loss.h2page.plt_ns)} for the small page with TLS (h = 2), against a bound of 4 × 50 + 52.8 = 252.8 ms; the rest is
        slow start, since the eight objects need more than one initial window. Six HTTP/1.1 connections take {fmtNs(loss.six.plt_ns)}{" "}
        because each pays its own handshakes and its own slow start.
      </p>

      <h3 className="text-lg">Theorem 4 (where a loss stalls)</h3>
      <p>
        Suppose one packet of stream s is lost and detected by the packet threshold. Under TCP every byte sent after it on the same
        connection, of any stream, is held until the retransmission arrives; under QUIC only later bytes of stream s are. The hole lasts
      </p>
      <Tex display>{`\\Delta \\approx \\text{RTT} + 3\\,\\frac{\\text{MSS}}{R} + q,`}</Tex>
      <p>
        where q is the queue at the bottleneck ahead of the retransmission. <i>Argument.</i> The third later packet arrives three
        transmission times after the lost one was due; its acknowledgement takes half a round trip back; the retransmission, sent at once,
        takes half a round trip forward after any queue. ∎ In the tool's scripted case, the same lost packet holds four streams for a total
        of {fmtNs(loss.h2.held_ns)} under HTTP/2 and one stream for {fmtNs(loss.h3.held_ns)} under HTTP/3. The page load times are{" "}
        {fmtNs(loss.h2.plt_ns)} and {fmtNs(loss.h3.plt_ns)}, and their gap of {((loss.h2.plt_ns - loss.h3.plt_ns) / MS).toFixed(0)} ms is
        exactly QUIC's saved handshake round trip: the last byte of the page was waiting for the same repair either way.
      </p>
      <p>
        That last point is worth stating plainly, because the sweep in the Handshakes mode shows it too. With one congestion controller per
        connection and the same algorithm on both, HTTP/2 and HTTP/3 lose about the same time to loss when the page load is measured at its
        last byte. What QUIC changes is when each <em>object</em> is usable: an image that arrived whole can be drawn, a script can run.
        Browsers render progressively, so held time is the more honest measure. Six HTTP/1.1 connections degrade less with loss in the sweep
        for a known reason: a loss halves only one of six windows, so together they back off less than one connection does, which is also
        why they are less fair to other traffic.
      </p>

      <h3 className="pt-2 text-lg">Exercises</h3>
      <ol className="list-decimal space-y-4 pl-5">
        <Exercise
          rating="10"
          answer={
            <p>
              L/R = 5000 × 8 / 10<sup>7</sup> = 4 ms. Non-persistent: 5 × (160 + 4) = 820 ms. Persistent: 80 + 5 × (80 + 4) = 500 ms.
            </p>
          }
        >
          A page of five 5 kB objects (base included) over plain TCP, RTT 80 ms, 10 Mb/s. How long under non-persistent HTTP/1.0 and under
          persistent HTTP/1.1, one request at a time?
        </Exercise>
        <Exercise
          rating="10"
          answer={
            <p>
              h = 2 for TCP with TLS 1.3: 300 ms plus the first packet's transmission time. h = 0 for QUIC 0-RTT: 100 ms plus the same. The
              0-RTT request may be replayed, so it should be one that is safe to repeat, such as a GET.
            </p>
          }
        >
          At RTT 100 ms, what is the time to first byte with TCP and TLS 1.3, and with QUIC resuming with 0-RTT? What does the second cost?
        </Exercise>
        <Exercise
          rating="15"
          answer={
            <p>
              The video takes 300 000 × 8 / 10<sup>7</sup> = 240 ms to transmit, and the icon's response may not start until it ends: about
              240 ms of pure waiting for a 1 kB object. On HTTP/2 with interleaving, the icon goes out in the first round of packets.
            </p>
          }
        >
          On one pipelined HTTP/1.1 connection at 10 Mb/s, a 300 kB video is asked for just before a 1 kB icon. How long does the icon wait
          for the video? What changes on HTTP/2?
        </Exercise>
        <Exercise
          rating="20"
          answer={
            <p>
              Under HTTP/2, all four: interleaving puts data of every active stream after the lost packet, and TCP holds it all. Under
              HTTP/3, one. With sequential sending the HTTP/2 hole would hold only the stream being sent and the ones after it, but those
              would be waiting anyway.
            </p>
          }
        >
          Four images are interleaved one packet each in turn and the third packet of one image is lost. How many streams stall under
          HTTP/2? Under HTTP/3? What if the server sent each image whole?
        </Exercise>
        <Exercise
          rating="25"
          answer={
            <p>
              k connections lose one packet: one window of k halves, so the aggregate falls by a fraction 1/(2k): 1/12 with six against 1/2
              for one. Under random loss the aggregate rate of k Reno flows is about k times that of one (the square-root law), so six
              connections take about six times the share of a single competing flow.
            </p>
          }
        >
          Why does a browser's six HTTP/1.1 connections slow down less under random loss than one HTTP/2 connection? What does that cost
          other users of the bottleneck?
        </Exercise>
      </ol>
    </Layer>
  )
}

export function HttpFrontier() {
  return (
    <Layer id="http-frontier" layer="Frontier" title="Headers, push, priorities, moving clients and tunnels">
      <p>
        <b>Header compression.</b> Requests repeat the same long headers, so HTTP/2 compresses them with HPACK (RFC 7541): a static table of
        common fields, a dynamic table both ends build as they go, and Huffman coding. The dynamic table relies on headers arriving in
        order, which TCP guarantees. QUIC does not, so HTTP/3 uses QPACK (RFC 9204): table updates travel on their own unidirectional
        stream, and a request that refers to an entry not yet received can wait for it, bounded by a limit on blocked streams the decoder
        announces. QPACK lets an encoder trade compression for freedom from head-of-line blocking.
      </p>
      <p>
        <b>Server push, and its retirement.</b> HTTP/2 let a server send a response before it was asked for, to save the round trip of the
        base page. In practice servers pushed objects the browser already had cached, and measured gains were small. Major browsers removed
        support, and the replacement is the 103 Early Hints status (RFC 8297), which tells the browser what to fetch while the server is
        still preparing the page. HTTP/3 kept push in the protocol, but it is rarely used.
      </p>
      <p>
        <b>Priorities.</b> HTTP/2's original dependency tree was complex and widely misimplemented; RFC 9113 deprecates it. RFC 9218
        replaces it with two parameters per request, an urgency from 0 to 7 and an incremental flag, carried in a Priority header and
        updated with a PRIORITY_UPDATE frame. Incremental responses can interleave, as this tool's default does; non-incremental ones are
        best sent whole, as its sequential schedule does.
      </p>
      <p>
        <b>Connection migration.</b> A TCP connection is named by its four addresses and ports, so a phone that moves from Wi-Fi to cellular
        loses it. A QUIC connection is named by connection identifiers the endpoints choose, so it survives a change of address: the new
        path is checked with PATH_CHALLENGE and PATH_RESPONSE frames before much is sent on it, and fresh identifiers keep an observer from
        linking the two paths (RFC 9000, Section 9).
      </p>
      <p>
        <b>MASQUE: tunnels over HTTP.</b> HTTP/3 can carry unreliable datagrams (RFC 9297), and CONNECT-UDP (RFC 9298) and CONNECT-IP (RFC
        9484) use them to proxy UDP flows and whole IP packets through an HTTP server. Privacy relays use this to hide a client's address
        from the sites it visits while the proxy cannot read the traffic.
      </p>
      <p>
        <b>Finding HTTP/3.</b> A browser first reaches a site over TCP and learns from an Alt-Svc header (RFC 7838) that HTTP/3 is on offer,
        or learns it before connecting from an HTTPS record in DNS (RFC 9460), which the DNS modes on this page can resolve. Networks that
        block UDP force a fall-back to TCP, so browsers race the two.
      </p>
      <p>
        <b>Open questions.</b> QUIC runs in user space, which lets it evolve quickly but costs more processor time per byte than kernel TCP
        with segmentation offload; batching and generic segmentation offload for UDP close much of the gap. Whether congestion control
        should be shared across a browser's connections to one host, and how 0-RTT should be limited in practice, are still debated.
      </p>
    </Layer>
  )
}

export function HttpInternals() {
  return (
    <Layer id="http-internals" layer="Internals" title="How the model works, and what it leaves out">
      <p>
        The simulation is a discrete-event model in Rust (crates/netsim/src/http.rs), compiled to WebAssembly and run in the page; the
        program under Go deeper shows the code. Time is counted in whole nanoseconds, so a run is exactly repeatable, and random loss draws
        from a generator seeded by the Seed slider. Every data packet goes through one queue at the bottleneck in the order it was sent,
        takes its size over the rate to leave, and arrives half a round trip later; its acknowledgement reaches the server half a round trip
        after that.
      </p>
      <p>
        Each connection keeps its own congestion window, starting at the initial window and growing by one packet per acknowledgement until
        the first loss, then by one packet per window. The client delivers to the browser in order per connection under TCP and in order per
        stream under QUIC, and records, for every packet, when it arrived and when it was delivered: the difference is the time it was held.
        The tests in the crate check that, with no loss, the time to first byte and the HTTP/1.0 and 1.1 page load times equal the formulas
        above to the nanosecond; that one scripted loss holds every HTTP/2 stream with later data but only one HTTP/3 stream; that a
        pipelined small response finishes after the large one ahead of it; that every byte is delivered once and in order; and that a seed
        fixes a run.
      </p>

      <h3 className="pt-2 text-lg">Simplifications</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>Only the server's data packets can be lost; handshakes, requests and acknowledgements always arrive.</li>
        <li>The bottleneck queue has no limit, so loss is random or scripted, never caused by overflow.</li>
        <li>A packet carries data of one object and no headers; frame, TLS record and QUIC packet overheads are left out.</li>
        <li>The client acknowledges every packet at once, with no delayed acknowledgements and no receive-window limit.</li>
        <li>
          Congestion control is a Reno-like slow start and additive increase, identical for TCP and QUIC, with one halving per recovery
          period (RFC 9002, Section 7.3.2); a fresh window for every new connection, with no shared or cached state.
        </li>
        <li>
          Loss detection uses a packet threshold of three for both transports. RFC 9002's time threshold of 9/8 of a round trip and its
          probe timeout are abstracted to a single timer that fires two round trips after a packet was sent, for losses with fewer than
          three packets after them; the retransmission is sent at once.
        </li>
        <li>Servers respond in no time, and the browser asks for every named object as soon as the base page is complete.</li>
        <li>0-RTT always succeeds: no rejected early data and no replay protection are modelled.</li>
      </ul>

      <h3 className="pt-2 text-lg">References</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>RFC 1945, Hypertext Transfer Protocol, HTTP/1.0 (1996).</li>
        <li>RFC 9110, HTTP Semantics; RFC 9112, HTTP/1.1 (2022).</li>
        <li>RFC 9113, HTTP/2 (2022); RFC 7541, HPACK (2015).</li>
        <li>RFC 9000, QUIC; RFC 9001, Using TLS to Secure QUIC; RFC 9002, QUIC Loss Detection and Congestion Control (2021).</li>
        <li>RFC 9114, HTTP/3; RFC 9204, QPACK (2022).</li>
        <li>RFC 8446, TLS 1.3 (2018), Section 8 on 0-RTT replay; RFC 8470, Using Early Data in HTTP (2018).</li>
        <li>RFC 9218, Extensible Prioritization Scheme for HTTP (2022); RFC 8297, 103 Early Hints (2017).</li>
        <li>RFC 9297, HTTP Datagrams; RFC 9298, Proxying UDP in HTTP (2022); RFC 9484, Proxying IP in HTTP (2023).</li>
        <li>RFC 5681, TCP Congestion Control (2009); RFC 6928, Increasing TCP's Initial Window (2013).</li>
        <li>J. F. Kurose and K. W. Ross, Computer Networking: A Top-Down Approach, Chapter 2.</li>
      </ul>
    </Layer>
  )
}
