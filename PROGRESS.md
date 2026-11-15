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

- Routing extension: link state as a flooded model (LSAs with sequence
  numbers, flood to all but the sender, Dijkstra on each router's own map
  with the RFC 2328 two-way check, database exchange when a link comes up);
  RIP timers (period with RFC 2453 jitter, triggered updates on or off,
  timeout); simple split horizon as a third choice beside none and poisoned
  reverse. Rust tests: 2m - n + 1 LSAs per flood (90 on six routers), the
  one-delay microloop, link state against Dijkstra on 40 random networks,
  the count to 16 at two periods a step (last change 510.001 s), the split
  horizon loop lasting until the 180 s timeout. Page: four scenarios, three
  tour steps, a lab (make the microloop impossible), map card for link
  state, LSA boxes grouped per link, seconds axis and slower play with
  timers, Theorem 5 (flooding cost) and timer analysis in the article.
  Browser-checked at 1440 and 390, light and dark. Vault notes Link-state
  routing and Count to infinity updated. Commits from here on carry the
  session's Opus attribution, as the coordinator directed.

- Queueing model (crates/netsim/src/queue.rs): flows from Poisson, periodic
  or on-off sources, fixed or exponential sizes, through a token or leaky
  bucket (shaping or policing), router processing, a drop-tail output queue
  served FIFO, by strict priority (non-preemptive) or by WFQ with GPS
  virtual-time tags, then L/R onto the link and d/s along it; GPS runs
  beside every discipline. Rust tests on one seed each, tolerance four
  standard deviations measured over twenty seeds: M/M/1 W and L at rho 0.5
  (200k packets) and 0.8 (1M), Little's law to 1e-9 on the same runs, M/D/1
  against Pollaczek-Khinchine and at half the M/M/1 wait, Cobham's priority
  waits, exact conservation across disciplines, the four delays, token
  bucket output within r t + b over every interval (exact integers),
  leaky-bucket pacing, WFQ within L_max/R of GPS finish and within L_max of
  GPS service, the Parekh-Gallager delay bound for shaped flows.
- Queueing wasm and core: queue/run and queue/sweep with bounds (at most
  4 flows, 3000 traced packets each and 6000 in all, 100k per sweep point,
  token buckets at least one packet deep); core/queue.ts with theory,
  occupancy, cumulative curves, envelope excess and shares; 13 scenarios in
  three modes, 9 tour stops, 5 labs. tests/queue.test.ts checks every note's
  numbers, the tour moments and each lab's start and a solution.
- Queueing page (tools/queue): mode switcher (delay, shaping, scheduling)
  over the scenarios; the path drawn from the event trace (shaper buckets
  with tokens or held bytes, processing, the queue in the order the
  discipline will send it, the transmitter, packets on the wire as long as
  s L/R, delivered and dropped counts); a live equation card per mode (the
  four delays of the chosen packet, theory against measurement with
  Little's law, the arrival curve, WFQ against GPS); charts of occupancy,
  cumulative input and output against b + r t, and departure minus GPS
  finish; tabs for packets, trace, W against rho sweep, shaper, scheduler,
  setup, source and lab; SVG and TikZ export of the path and the chart.
  Article: misconceptions with Try buttons, mechanics by step letter,
  Theorems 1 to 6 (Little, M/M/1, Pollaczek-Khinchine, Cobham and
  conservation, the token bucket's arrival curve, Parekh-Gallager) with
  live numbers and eight rated exercises, frontier (bufferbloat, buffer
  sizing, RED, CoDel, PIE, SCFQ, DRR, WF2Q, fq_codel, DiffServ, network
  calculus, self-similar traffic, L4S), internals with simplifications.
- Queueing browser pass at 1440 and 390, light and dark: one-flow path
  figure cropped to its band; Try buttons scroll to the tool and focus it,
  and the article is memoised against a stable loader; the scheduling chart
  plots waits by start time so backlogged runs spread out; wide display
  equations wrap at 390; the sweep's axis fits the simulated dots.
- Vault notes for tool four: Queueing delay and M-M-1, Token bucket, Fair
  queueing, and a queueing section in the subject index.
- Tool 5 part A, link layer and wireless (medium access): Rust model
  `crates/netsim/src/link.rs` (pure and slotted ALOHA; CSMA/CD with 802.3
  carrier sense, jam and BEB; 802.11 DCF with frozen backoff, ACKs,
  RTS/CTS and the NAV) and `link/run` in the wasm crate. Sixteen Rust
  tests: slotted and pure ALOHA against the exact finite-station formulas
  at G = 0.25, 0.5, 1, 2 (tolerances 0.016 and 0.011, four seed standard
  deviations), detection within 2 tau and the minimum frame, BEB ranges
  1, 3, 7, 1023 and none after 16, CSMA/CD efficiency against
  1/(1 + 5a) and Metcalfe-Boggs (simulation higher because of capture),
  hidden-terminal loss 0.81 without RTS/CTS and 0.02 with it over 20
  seeds, NAV ending exactly at the ACK. `core/link.ts` with 12 presets,
  a 9-step tour and 4 labs; `tools/link/` with space-time, slot and map
  figures (SVG and TikZ), backoff and NAV views, live equations, sweeps,
  and the five-layer article. Browser-checked light, dark and phone.
- Vault notes for tool five part A: ALOHA and slotted ALOHA, CSMA-CD and
  exponential backoff, CSMA-CA, hidden and exposed terminals, and a
  medium-access section in the subject index.

## Next

1. Tool 5 part B, on the same Link layer and wireless page: switch
   learning and spanning tree, CRC and Hamming codes.
2. Tool 6, naming and the web: iterative and recursive DNS with caching
   and TTLs; HTTP/1.1, HTTP/2 and HTTP/3 with head-of-line blocking.
