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

## Next

1. TCP model in `crates/netsim/src/tcp.rs`: dumbbell, Tahoe, Reno, NewReno
   (RFC 5681, RFC 6582), RTO (RFC 6298), CUBIC (RFC 9438). Tests: RTO
   samples 100 then 200 ms give SRTT 112.5, RTTVAR 62.5, RTO 362.5; one drop
   recovers without timeout; two drops in a window separate Reno from
   NewReno; buffer at BDP keeps the link busy; CUBIC W(0) and W(K).
2. TCP tool UI: cwnd chart, ladder for flow 0, congestion FSM, queue,
   two-flow phase plane with Jain's index, equations, presets, labs, source.
3. Routing tool if time allows.
4. Critic's pass at 1440 and 390, light and dark; fresh screenshots.
