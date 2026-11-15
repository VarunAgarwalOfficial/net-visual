# Progress

## Done

- Rust core `netsim` (seeded SplitMix64, event queue) and `netsim-wasm`
  (C ABI: `nv_alloc`, `nv_free`, `nv_call` with JSON in and out).
- RDT tool, all five layers: stop-and-wait, Go-Back-N and Selective Repeat as
  four switchable rules; ladder with click-to-edit packets, windows, trace,
  live equations, presets after K&R, tour, five labs, literate source with
  trace, sweep, share links. Browser-checked light, dark and phone.
- Teacher actions shared by all tools: copy link, SVG and TikZ export (TikZ
  compiles with pdflatex), presentation mode.
- TCP model `crates/netsim/src/tcp.rs` with `tcp/run` in the wasm crate:
  dumbbell of up to four flows, Tahoe, Reno, NewReno (RFC 5681, 6582),
  RTO (RFC 6298, Karn), CUBIC (RFC 9438). Seven tests: RFC 6298 numbers,
  single-loss recovery per RFC, Fall-Floyd three losses (Reno times out,
  NewReno does not), utilisation against the sawtooth closed form within
  0.02 for B = 5..BDP, Mathis ratio rising to within 5% as p falls, CUBIC
  W(0), W(K) and beta, Jain > 0.99 and RTT unfairness. Modelling choices:
  min RTO default 1 s (RFC 6298); a timeout during fast recovery keeps the
  smaller ssthresh (one reduction per loss episode); no SACK, no limited
  transmit, no HyStart.

- TCP tool, all five layers: window chart for every flow (ssthresh, a
  second algorithm dashed, BDP and BDP + B + 1 lines, fast-retransmit,
  timeout and drop marks) that seeks on click; ladder of flow 1 fed a
  window of the trace at a time; click-to-drop with D; RFC 9293 header with
  a verified RFC 1071 checksum; congestion state machine lit by the step
  each event took; dumbbell with the buffer at t; queue and SRTT/RTO
  charts; Chiu-Jain phase plane with Jain's index at t; CUBIC curve for the
  current epoch; live equations (RTT, cwnd/RTT against R, RTO, sawtooth,
  Mathis, CUBIC K); setup for every parameter; ten scenarios, tour, five
  labs, literate source; article with misconceptions and hard cases linked
  to scenarios, three theorems with proofs and live numbers, a buffer
  sweep, six rated exercises, frontier, internals, simplifications and
  references.
- Concept notes for the RDT and TCP tools written in the owner's vault
  (outside this repo), computer-networks folder: Bandwidth-delay product,
  Reliable data transfer, Stop-and-wait protocol, Sliding-window protocols,
  TCP retransmission timeout, TCP congestion control, AIMD and fairness,
  TCP sawtooth and buffer sizing, Mathis square-root law, CUBIC congestion
  control, and the map note Computer networks. The tools' articles keep
  only tool-specific material.

- Critic's pass on RDT and TCP at 1440 and 390, light and dark: long
  equations break into lines on a phone, ssthresh drawn to the end of the
  run, time ticks keep their decimals.
- Routing model `crates/netsim/src/routing.rs` with `routing/run`:
  distance vector (Bellman-Ford, triggered updates, optional poisoned
  reverse, an infinity, delay and jitter, scripted cost changes and
  failures) and Dijkstra from every source for each version of the
  network. Five tests: Dijkstra against K&R Fig. 5.3; synchronous rounds
  within the hop bound; DV agrees with Dijkstra on 40 random networks with
  jitter, failure and repair; count to infinity on K&R Fig. 5.7 and
  poisoned reverse stopping it; poisoned reverse failing on a loop of
  three (RFC 2453, 3.4.4). `core/routing.ts`: nine scenarios, tour, four
  labs, the Bellman-Ford terms replayed from the trace (tested against
  every table).

- Routing tool, all five layers: graph with every vector on the wire
  (poisoned and lost ones marked), next hops towards a chosen destination
  with forwarding loops in red, click-to-edit links (cost, fail, repair at
  t); Bellman-Ford card for any router with each term's source and time;
  tables, trace, Dijkstra step table over the graph, setup, literate source,
  four labs; staircase chart of every router's cost with the infinity line,
  in rounds when jitter is 0; nine scenarios after K&R and RFC 2453, tour,
  share links, SVG and TikZ of graph and chart; article with misconceptions,
  hard cases, four theorems with proofs and live numbers, five exercises,
  frontier (RIP, OSPF/IS-IS, DUAL, Babel, DSDV, BGP, LFA, SDN),
  internals, simplifications and references.
- Browser pass on routing at 1440 and 390, light and dark: graph text
  scales up on narrow screens, router labels move off their links, vectors
  drawn mid-link, chart infinity labelled.
- Keyboard: after an action removes the focused control (the link editor
  re-keyed or closed, a packet editor closed), focus returns to the tool,
  so Home and End move the clock instead of scrolling the page. All three
  tools. Routing screenshots retaken after the label fix.
- Vault notes for routing: Distance-vector routing, Count to infinity,
  Link-state routing; map note updated.

## Next

1. Link-state flooding as a model (LSAs with sequence numbers, transient
   loops while databases differ), so both algorithms run on the wire.
2. Periodic RIP timers (30 s updates, 180 s timeout) and split horizon
   without poison as options.
3. Further tools after routing: e.g. ARP and switching, or BGP policy.
