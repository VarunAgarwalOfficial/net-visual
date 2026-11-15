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
- Tool 5 part B, on the same page: Rust models `lan.rs` (learning
  switches and hubs with flood, learn, filter, ageing and a loop cap),
  `stp.rs` (802.1D BPDUs, root and designated ports with tie-breaks,
  listening and learning, sensed and silent failures) and `coding.rs`
  (CRC by GF(2) long division; Hamming, SECDED and general (2^r - 1)
  codes), dispatched as the wasm tools `lan`, `stp` and `coding`.
  Seventeen Rust tests: forward, flood and filter; the storm grows
  without STP and stops with it; the STP result is a spanning tree,
  matches the direct shortest-path computation, and has one designated
  port per segment; recovery in 2 T_fwd sensed and up to max age plus
  2 T_fwd silent; check values 0xF4, 0x29B1 and 0xCBF43926; every burst
  up to r caught; an undetected error divisible by G; every single error
  corrected, every double detected under SECDED, d_min 3 and 4. The page
  now has 29 presets, 8 labs and a 17-stop tour; network, bridge,
  division and codeword figures (SVG and TikZ), table, port, property
  and syndrome tabs, live equations, and a second five-layer article
  placed first for these modes. Browser-checked at 1440 and 390, light
  and dark.
- Vault notes for tool five part B: Switch learning, Spanning tree
  protocol, Cyclic redundancy check, Hamming codes, and a switching and
  error-control section in the subject index.
- Coordinator check of tools four and five: Rust (66) and TS (46) tests,
  clippy and fmt rerun green; the TikZ export of every link mode compiles
  with pdflatex and renders as on screen; STP roles checked by hand
  against the tie-breaks; the hidden-terminal starvation under RTS/CTS is
  a 100 ms effect only (over 1 s the two flows share 395/184, 210/366,
  266/318 across seeds). Known phone limit: the CRC-8 "123456789"
  division (80-bit rows) fits 390 px but is too small to read there.
- Coordinator pass after tool six: Escape leaves present mode where full
  screen is refused; after choosing a scenario, Home, End and the side
  arrows drive the timeline instead of scrolling the page (all six tools,
  checked with real clicks); toggle groups no longer move focus on arrow
  keys. Stale shots retaken: link-crc-division-1440,
  web-dns-1440-light-cname (every referral labelled; the earlier gap was
  a full-page capture artefact), web-dns-1440-dark-ttl,
  queue-390-light-top. Hamming (15,11) at 390 is still unviewed.

- Tool 6 part A, "Naming and the web" (`#web`), DNS modes: Rust model
  `dns.rs` (stub and recursive resolvers, root, top-level and
  authoritative zones with per-hop RTTs; referrals with NS and glue;
  iterative or a recursive chain; stub and resolver caches with exact
  TTL expiry; RFC 2308 negative caching; CNAME chains across zones;
  Poisson clients; TTL changes), dispatched as the wasm tool `dns`, with
  `core/dns.ts`. Ten Rust tests: cold 100 ms = 10 + 30 + 40 + 20, warm
  and same-zone lookups exact; expiry exactly at insert + TTL; negative
  TTL min(3600, 300) = 300 s; iterative and recursive answers equal;
  hit ratio within 4 sigma of lambda T / (1 + lambda L + lambda T) at
  lambda T = 0.25, 1 and 5 (0.19982, 0.49968, 0.83303; the long run is
  ignored by default). Rust 76 (2 ignored) and TS 55 tests green. The
  page has three modes (resolution, shared cache, TTLs and change), 10
  presets, 4 labs and a 14-stop tour; a message ladder (SVG and TikZ),
  cache tables with TTLs counting down, live equations, a log-axis
  hit-ratio sweep, and the five-layer article. Browser-checked at 1440
  and 390, light and dark. `tools/web/` leaves room for the HTTP modes.
- Vault notes for tool six part A: DNS resolution, DNS caching and TTLs,
  and a naming section in the subject index.

- Tool 6 part B, HTTP modes on the same page: Rust model `http.rs`
  (wasm tool `http`, run and sweep with bounds) for HTTP/1.0 with up to
  k connections, persistent HTTP/1.1 with optional pipelining, HTTP/2 on
  one TCP connection with interleaved or sequential streams, and HTTP/3
  over QUIC; TCP, TLS 1.3, TLS early data, QUIC and QUIC 0-RTT setup;
  per-connection slow start and one halving per recovery period; loss
  found by packet threshold 3 or a 2-RTT timer (RFC 9002's time threshold
  and PTO abstracted, as stated on the page). Eight Rust tests: TTFB
  101.168 / 151.168 / 101.168 / 51.168 ms exactly; HTTP/1.0 952.8 ms and
  HTTP/1.1 552.8 ms equal to the textbook formulas, plus the parallel
  case; a pipelined 1 kB icon done after the 300 kB video; one scripted
  loss holding 4 HTTP/2 streams (553.68 ms) and 1 HTTP/3 stream
  (118.912 ms); tail loss by timer; byte conservation per object; seed
  determinism; sweep against single runs. Rust 84 (2 ignored) and TS 62
  tests green. Page: six modes in two groups (DNS, HTTP) with panels
  swapped by the switcher; 15 HTTP presets, 14 tour stops, 4 labs, all
  tested against their runs; streams view (arrived against delivered,
  held bars, loss lines), packet ladder, live equations (TTFB, both
  formulas, the bound, the hole, the pipelining wait, the setup table),
  PLT against RTT and against loss sweeps, objects table, setup with an
  object editor, source and labs; SVG and TikZ of both figures and the
  chart; five-layer article. Browser-checked at 1440 and 390, light and
  dark.
- Vault notes for tool six part B: HTTP persistent connections,
  Head-of-line blocking, QUIC and HTTP-3, and a web section in the
  subject index.

## Rework: self-explanatory, low stimulation (done)

Brief: one column read top to bottom; the tool's name and one plain
sentence; Play first; a card saying what just happened and why; live
readouts; everything deeper behind named disclosures, closed. No final
results before the first event. Palette and type unchanged.

Shared shell (done):
- `components/ToolFrame.tsx`: Disclosure (native details, lazy mount),
  ExampleIntro, StepCard, Readouts, TourCard, TourAndSharing (tour start
  plus ToolActions behind one disclosure, kept mounted for presentation
  mode), DeeperHeading, sourceLine, scrollBehavior (no smooth scroll under
  reduced motion).
- `timeline.ts`: `before` state, index -1 at load and after Start, so
  nothing shows as done at step 0.
- `Transport.tsx`: Play is the first, only filled button; other controls
  in words ("Back one event", "Next event", "Start", "End").
- `ToolActions.tsx`: three labelled rows, no bare icons, no truncation.
- `LineChart.tsx`: `upTo` prop (the part not yet reached is faint) and
  series labels on the lines in place of a separate legend.
- Article layers are closed disclosures with a one-line note each.
- `tools/index.ts` has a `lead` sentence per tool, shown under the h1.
- `host.css`: reduced motion stops all animation and transition.

Per tool, reading order: ExampleIntro, Transport, figure, StepCard, live
views, Readouts "So far", "Try another example" (picker after the
readouts so Play is the first focusable control), "Go deeper"
disclosures, TourAndSharing, "Read about it".

- [x] rdt: plain step sentences (`tools/rdt/plain.ts`), preset titles and
  notes rewritten, window view labelled in place, ladder labels in words.
- [x] tcp: plain step sentences (`tools/tcp/plain.ts`), preset titles,
  notes and tour words rewritten; the window chart is the picture (faint
  ahead of the clock, marks only up to it, labels on the chart); ladder,
  state diagram, queue and round-trip charts, phase plane, CUBIC curve,
  formulas and run averages behind disclosures. The chart's shaded band
  shows only while the sequence diagram is open.
- [x] routing: plain step sentences (`tools/routing/plain.ts`, built from
  each event's data: what changed, and why, with the sum spelled out);
  preset titles, notes, tour and lab words rewritten; graph labels read
  "cost N"; the caption is the legend; table shading and the selected
  router's ring only after the first event or a choice; Bellman-Ford card,
  cost chart, Dijkstra steps, totals, settings, trace, labs and source
  behind disclosures; tabs and the toolbar row removed.
- [x] queue: shell order; the three mode buttons became groups in the
  example picker; step card titles and reasons (`eventTitle`, `eventWhy`
  in QueueViews); "So far" readouts up to the clock (final totals moved
  to "What the whole run comes to"); chart, packet table, formulas, mode
  view, settings, trace, labs, source behind disclosures; preset titles
  and notes with abbreviations and symbols spelled out; figure labels in
  words (source, send, travel, first come first served).
- [x] link: shell order; the seven protocol buttons became groups in the
  example picker; captions name every mark (S1, #0, air, NAV, R/D/A,
  BPDU, link costs, bridge IDs, M(x), G(x), syndrome); formulas moved out
  of the ALOHA notes and chart titles; the ALOHA channel is empty before
  the first event; Transport takes `clock={false}` for the coding modes,
  which count steps, not time. Mode view, chart, formulas, totals,
  settings, trace, labs, source behind disclosures.
- [x] web: shell order for both panels (DNS in WebTool, HTTP in
  HttpPanel); the six mode buttons became one grouped picker
  (`WebPicker` in ModeSwitch.tsx) that swaps panels and loads the chosen
  example; the iterative/recursive switch sits under the picker and the
  HTTP picture switch under the picture; DNS, TTL, CNAME, stub, resolver,
  NXDOMAIN, SOA, TCP, TLS, SYN, QUIC, [1] named where they appear; the
  ladder is empty before the first event; long ladder labels wrap at
  390 px instead of being cut; "C1." codes gone from the step card.
- Smooth scrolls everywhere go through `scrollBehavior()`.
- The dev server must not run through /tmp/unsw-reorg/build: that wrapper
  holds a machine-wide lock for as long as the command runs. Start it with
  plain `nice npx vite --port 5391 --strictPort`.
- [x] impeccable detect on the changed .tsx and .css files: one advisory,
  the grid-line background of the optional blueprint theme (host.css,
  older than this rework, left as is because the palette stays). Final
  captures of all six tools on the committed code: no overflow, nothing
  wider than 390 px, no truncation on the first screen, nothing side by
  side at 1440, Play first focusable, no animation at load. Lint, tsc and
  tests (Rust 84 + 3, Node 62) pass.
- After the checks: a pick that swaps the web panels now hands focus to
  the new panel (arrow keys step again), and the HTTP pictures are empty
  before the first event. Checked by hand on web: shared HTTP link, tour,
  Present, SVG export, picks across panels.
- Known gaps left: the queue path figure is small at 390 px; in spanning
  tree mode the dashed "acted last" box marks the first event's bridge at
  load; HTTP ladder labels take two or three lines at 390 px; the DNS
  ladder is tall at 390 px.

Checks: `/tmp/nv-work/check.js` (overflow, truncation, side-by-side,
first focusable, animations) and `/tmp/nv-work/capture.sh <tool>` write
`/tmp/rebuild-shots/net-visual/load/<tool>/`. Dev server on port 5391.

## Second cold-read pass (ten items)

All six tools, one commit. The example paragraph is closed on arrival
behind "About this example" (after the picture, so Play stays first);
captions moved under their pictures; sections tightened to space-y-4.
Player: outlined Back, Next, Start, End in two unbreakable pairs; the
counter reads "Step N of M (a step is ...); time X of Y milliseconds" in
one unit per run (`runUnit`, `inUnit`, `timeIn` in timeline.ts); the speed
select says "normal speed" and so on. Empty pictures (rdt, ALOHA, DNS,
HTTP both views) draw their columns and rows with "Nothing sent yet" and
what Play will draw; queue no longer draws the t=0 packet before step 1.
Header: the theme icon became a named button ("Use dark colours"); the
current tool says "(this page)". Lining figures in tools, slashed zero
in data (host.css). Routing: cost labels described as next to the router,
blue arrows described, chosen destination said in words, graph height
capped. Terms explained in the leads (link layer, frame, distance vector,
link state, address) and preset titles (Reno/Tahoe, hop, ALOHA). The
checker also reports `picture.topOnFirstScreen` (first svg or canvas over
80 px in the tool's figure); true for all six at 390 and 1440.
Left: web's player counts seconds (the run is 4 s) while the ladder ticks
in milliseconds from each question; at 390 routing's, rdt's and web's
pictures start on the first screen but run past its bottom.

## Third cold-read pass (six items, last pass)

Routing: above the graph, a bold "Nothing has been exchanged yet: this
is the start" (at load) and the blue-arrow key; the destination's
neighbours are labelled "cost N, direct link"; "destination" sits right
of and below z, clear of the arrows; the method note and the cost ∞ and
link-number keys sit under the graph, then the destination chooser;
graph text scales up on phones (k = 760 / width, at most 2.3). Keys in
the pictures: queue ("Each blue block is one packet", link line names
rate and discipline), ALOHA (stations, colours, vulnerable window, air),
rdt (Ladder `legend` with `LadderKey` marks), DNS (glosses under the
column names, a name key above them on phones, a line-colour key under
the columns). Player: a sentence names the slider's round knob; the web
player counts milliseconds (`inMs`); routing's counter says what a round
is (`timeIs`). Phone layout: queue's path figure has a narrow layout;
TCP's chart shows its key top-left early in the run (`keyEarly`, notes
per series, on a plain ground) instead of line-end labels, and the
origin zeros are apart.
Terms glossed at first use: stop-and-wait, sequence number, ALOHA,
station, router, Mb/s, TCP, Reno/Tahoe after a loss, slow-start
threshold, acknowledgement, resolver, root, com, net. Header: one row,
tools in a closed "The six tools" list. Left: at 390 the routing, rdt,
web, TCP and link pictures still run past the first screen (their top
part and Play show together); the HTTP view at 390 and the blue "1" on
u-x in dark mode (not reproduced) were not examined further.

## Editorial restyle (site tokens)

Tokens: `src/styles/tokens/c-editorial-tokens.css`, copied verbatim from
the website (read-only there). `host.css` maps every style variable onto
them; light and dark follow `prefers-color-scheme` only.

Meaning colours, the same in all six tools (CSS name, site token):

| Meaning | Var | Token | Used for |
|---|---|---|---|
| got there | `--nv-ok` | `--site-mean-proved` (green) | delivered, ACK, answer, frame through, check passed |
| under way | `--nv-busy` | `--site-mean-open` (purple) | data packet in flight, sent-not-settled, kept awaiting, route arrows, referral |
| again / elsewhere | `--nv-again` | `--site-mean-measured` (amber) | duplicate ACK, resend, fast retransmit, CNAME alias, poisoned vector |
| lost / wrong | `--nv-bad` | `--site-mean-against` (red) | lost, collided, stale, loop, NXDOMAIN, blocked, wrong message |

Not meanings: "changed / current / selected" is the highlighter
(`--site-color-mark`) or a heavier ink stroke; identity (flows, stations,
protocols in a chart) is ink or muted with dash patterns, position and the
in-place label. The accent is only the link underline and the focus ring.

Removed: the light/dark/phosphor/blueprint themes and the colour toggle
(and its localStorage script), the CMU Sans/Mono/Serif-bold fonts, the
chart-1..6 palette, tw-animate, shadows, ring/translate transitions on
controls, the slashed zero, unused shadcn parts (badge, kbd, label,
separator, slider, tabs, tooltip).

Moved for the new type (Newsreader 20px body, 17px small, 36/44px title):
three sizes only (`text-xl` now the body step); header on one row at
390 (site name 17px there); header/lead spacing 8/16px; ladder lanes
start 62px down (lane names clear of the first label), its gutters and
the chart margins widened for 17px labels; window strip gutter 136px;
select triggers grow with wrapped text.

Colour words changed in sentences (the colour of the thing changed):
recorded per tool below.

- rdt: data band purple (under way), ACK green (got there), wrong
  delivery red; window strip boxes: waiting grey ground, sent and kept
  purple, acknowledged and handed over green, wrong red, numbers in page
  colour on solid boxes; sweep chart in ink (Selective Repeat,
  stop-and-wait) and muted (Go-Back-N), theory dashed. No colour words
  changed ("red cross", "red boxes" stay true).
- tcp: ladder data purple, ACK green, repeated ACK amber; window chart
  flows in ink and muted told apart by dash (solid, solid, 7-3, 2-3) and
  named at line ends, Tahoe comparison long-dashed ink, ssthresh short
  grey dashes; loss ticks and "timer ran out" red, fast retransmit amber;
  the ladder's stretch on the chart is the highlighter ground. Queue
  chart purple, its buffer line red. State machine: current state on the
  highlighter with ink outline, Tahoe's unused parts dashed in rule
  colour (no fading). Router view, phase plane and state machine are
  drawn at a fixed scale (13 units = 17px) and scroll sideways inside
  their own box on a phone. Early key wraps to the chart width; a chart
  with an early key is tall enough for all of it. No colour words changed.

- routing: next-hop arrows purple (the route being followed), loop
  arrows red, failed link dashed with a red ×, no fading; messages ink
  boxes, a poisoned one amber and dashed, a lost one grey and solid
  (still "faded"; dashed keeps meaning "cannot reach"); changed-table ring and changed table cells on the
  highlighter; the selected router has a thick ink outline (was the
  accent), the link editor is between two rules (was a tinted box). Cost
  chart routers in ink and muted, told apart by dash and name. Network
  text is at least 17px rendered: the drawing's margins grow with the
  labels, so at 390 the network itself draws smaller. Colour words
  changed: "blue arrow" and "thick blue arrow" to purple, "a blue
  outline" to "a thick outline".

- queue: sources told apart without colour: filled ink, filled grey,
  ink outline, grey outline (path blocks and table marks), the same as
  solid, solid, 7-3 and 2-3 dashes in line charts and dots, dots, rings,
  rings in dot charts; a selected packet gets an ink frame; shaper fill
  grey (no tint); "buffer full" and losses red; the selected table row
  on the highlighter; reference lines without fading. Path text one
  size, 12 units scaled to at least 17px; on a phone the packed layout
  puts "waiting in line" on its own row, widens to fit "arrived", sets
  the line under the picture in two rows when there are several sources,
  and lifts the link's label clear of the "+N more" count.
  Colour words changed: "Each blue block" to "Each filled block"; "coloured
  by the source" to "marked by the source" in the picture; "Each
  flow has its own colour" to "its own mark ... filled or outlined, in
  ink or grey".

- link: ALOHA/CSMA frames purple while sent, green when through, red
  when overlapped; CSMA/CD station dots ink, carrier bands purple (kept
  at 0.32 opacity so overlaps read), jam red (0.55); CSMA/CA range ring
  purple dashed, NAV grey ground with an ink dashed outline; STP port
  states forwarding green, learning/listening purple, blocking red,
  disabled muted; frame copies and BPDUs purple; root bridge a bold
  "root" label, not a fill. Code views: flipped bits red outline and
  text (no tint), covered bits on the highlighter. Charts in ink and
  muted with dashes and hollow/filled dots. Figures are laid out so 11
  units render at 17px (`figureWidth`, ShapeView `px` floor). Moved: the
  ALOHA key wraps and gains "a frame still being sent"; STP boxes grew
  to 76 units, enough for a ten-character ID; overlapping CSMA/CD "heard after" labels lift
  15 units. Colour words changed: ALOHA help ("purple while it is sent,
  green ... red ..."), switch help ("Each purple dot is one copy").
- web: DNS ladder query muted, referral purple, answer green, CNAME
  amber, NXDOMAIN/NODATA red; HTTP data packets purple, alternate
  objects thin and thick, arrivals ink, deliveries green. Charts ink and
  muted with dashes; formula curves dotted. DNS laid out at 12 units =
  17px, HTTP at 10. Moved: DNS internal width minimum 200, column names
  stagger on two levels at 390, column notes and the key wrap; HTTP
  stream names and sizes sit above each row on a phone, ladder gutters
  narrower there, loss label wraps. Colour words changed: "purple, a
  referral", "amber, an alias", "purple are referrals", "purple ones
  data packets".

Contrast (WCAG 2 relative luminance, computed from the token hexes by
`/tmp/nv-work/style/contrast.py`; AA text 4.5, graphics 3):

| Pair | Light | Dark |
|---|---|---|
| fg / bg | 15.08 | 13.83 |
| muted / bg | 5.91 | 7.06 |
| link / bg | 5.59 | 5.51 |
| ok / bg | 5.40 | 7.54 |
| again / bg | 4.92 | 7.80 |
| busy / bg | 5.77 | 7.28 |
| bad / bg | 6.10 | 6.81 |
| fg / mark | 12.55 | 9.39 |
| muted / mark | 4.92 | 4.80 |
| fg / code-bg | 13.77 | 12.38 |
| meaning / code-bg (lowest) | 4.49 (amber; no text is drawn so) | 6.09 |

| green / mark, amber / mark (light) | 4.497, 4.10 | 5.12, 5.30 |

Page colour on a solid meaning fill has the same ratio as the fill on
the page. Two meaning colours fall under 4.5 on a highlighted or
hovered row in light: green and amber on the highlighter, amber on the
code ground. host.css now sets text in those two colours in the ink on
`bg-mark`, `bg-muted` and a hovered `hover:bg-muted` row (the STP
bridge table's acting row was the one real case: "forwarding" in
green); the word still says it. Purple and red stay (4.6 or more).
Rule colour (1.35/1.41) is a separator only.

Text-box check (`/tmp/nv-work/style/textcheck.js`, run by
`textrun.sh` at load and after seeking to the middle of the run, 1440
light and 390 dark, and by `sweep.sh` at every Next step): every SVG
text in a picture must lie inside the picture (cut by any clip-path)
and must not intersect another text. `contrastcheck.js` measures every
rendered text (HTML colour on the first opaque ground; SVG fill on the
last filled shape under it, or its halo) and reports anything under
4.5. What the text check found and what moved:

- rdt/tcp ladder: lane names and the time unit were cut at the top of
  the scroller and "accepted"/"packet 0" at the now line were cut by
  the flights' clip. The unit and lane names now sit in a fixed header
  strip above the scroller; only the bands, lines and crosses are
  clipped, labels are drawn unclipped on a page-colour halo, and the
  now line is drawn under them.
- tcp window chart: two end-of-line labels ran off the plot at 390.
  Long labels wrap to two lines, are pushed apart and kept inside. The
  chart's own words (fast retransmit, packet lost, timer ran out, the
  two reference levels) moved from under the lines to over them, on a
  halo, and the now line is drawn under all labels.
- routing: message boxes covered link costs ("3" on "cost 10"),
  router labels and each other. Each message is placed beside its
  link by searching both sides and positions along it for a spot
  clear of costs, routers, router labels, other messages and the
  picture's edge, a little further out if need be; where none is clear
  it is drawn as a dot on its link without its label (or not drawn).
  Below 600px the network is stretched up to 2.3 times in height
  instead of scrolling sideways; flooding (link state) lets the picture
  grow to 80% of the window's height; LSAs going the same way on a link
  share one box ("u #1 +2"). The destination's word moves off any link
  cost.
- link: ALOHA ticks "11"/"14" overlapped "ms" (first tick now starts
  left-aligned) and the vulnerable-window note ran off the left at 390
  (wraps to two lines, kept inside). STP and switch pictures crowded at
  390 (IDs past the boxes, "4" on "D", port numbers on each other): the
  LAN pictures keep 720px and scroll sideways below it, parallel links
  sit 22 units apart, bridge boxes are 76 units wide; the ring round the
  bridge that acted last is drawn under its port markers.
- queue: clean; by eye, a lone "source" touched "process" at 390, so it
  goes above its block there. web: clean.

A sweep (`sweep.sh`: Next through the whole run, the text check at
every step) then found three more: the rdt ladder at 390 drew
"accepted" on the "150" tick at the end of the run (a tick's number
now gives way to a word left of the first lane; its grid line stays);
the tcp chart's "faint: the rest of the run" note ran into the "25"
tick at 390 (two lines on a narrow plot, on a halo); and the routing
presets with a flood of messages (link state, six routers with a
failure) put boxes on costs and each other.

After the fixes all six tools are clean at load and mid-run at both
widths (no clipped text, no overlaps, nothing under 4.5), as are Next
sweeps of rdt, tcp, queue and web (60 steps), all 13 routing presets
to the end at 390 and 1440, and the STP presets. What remains: at 390
some routing messages have no clear place and are drawn as a dot on
their link without their label (link state up to 6 at once, six
routers with a failure up to 2; none at 1440); LAN pictures keep 720px
and scroll sideways below it, so labels at the right edge are cut by
the scroll box until scrolled ("scrollEdge"); lines still pass behind
some halo'd labels (tcp "slow-start threshold", "packet lost"), which
the check does not count.

## Next

Only known gaps remain; all six tools are built.

1. The CRC-8 division figure is too small to read at 390 px (it fits).
2. HTTP model limits that a later pass could lift: losses on handshakes,
   requests and acknowledgements; a finite bottleneck buffer; RFC 9002's
   time threshold and PTO in place of the 2-RTT timer; per-frame and
   per-packet header overhead.
3. Small visual items: the two backoff labels on the CSMA/CD space-time
   diagram overlap on the right; the queueing scheduler chart exports
   lines where the page draws dots (the shared chart export has no dot
   kind); the occupancy chart is dense on long runs; a few link scenarios
   (storm with STP, ageing, filter, tie-break, burst, silent failure) and
   the labs' pass messages were tested but not viewed in a browser.
4. Model limits stated on each page: queueing has drop-tail only (no
   AQM), non-preemptive priority, a packet-counted buffer; CSMA/CA has no
   capture or rate adaptation; STP is 802.1D, not RSTP.
