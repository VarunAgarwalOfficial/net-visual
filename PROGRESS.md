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

## Next

1. Routing tool if time allows.
2. Critic's pass at 1440 and 390, light and dark; fresh screenshots.
