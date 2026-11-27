<p align="center"><img src="docs/banner.png" alt="Pixel art: bees carry packets between two sunflowers in a field" width="100%"></p>

# Networking visualisers

Six explorable network simulations for teaching, from reliable data transfer to HTTP/3, tested against textbook formulas. Rust/WebAssembly and React.

[MIT licence](LICENSE)

Each tool runs a real,
deterministic model written in Rust and compiled to WebAssembly, and draws it
with React. You can stop time, step backwards, drop or delay one packet, change
the protocol's rules, and compare the measured result with the formula that
predicts it. Every state, including your edits, fits in a shareable link.

![The reliable data transfer tool: a Go-Back-N run drawn as a sequence diagram](docs/screenshot.png)

## Results

- **Six tools**, from reliable data transfer up to DNS and HTTP, each built on a seeded
  simulation that gives the same run for the same seed.
- **86 model tests** check the simulations against the formulas and figures students are taught.
  Stop-and-wait utilisation lands within 4% of its closed form, TCP utilisation within 0.02 of the
  sawtooth formula, and slotted ALOHA on G e^(-G).
- Distance vector agrees with Dijkstra on 40 random networks with failures. The textbook
  count-to-infinity example counts up, and poisoned reverse stops it.
- One lost packet stalls every HTTP/2 stream but only one HTTP/3 stream, as the theory says.

**Stack:** Rust compiled to WebAssembly through a plain C interface (no wasm-bindgen), React and
TypeScript, Vite, KaTeX for the maths.

## The idea

Most protocol animations play a fixed script. A student can watch one, but
cannot ask "what if this ACK were lost?" or "why does the formula say 0.84
when the run gives 0.44?". Here the animation is a view of a trace. A seeded
discrete-event simulation computes the trace, so every question gets an
honest answer, and the same seed always gives the same run.

Each tool aims at five layers of understanding:

1. **Intuition**: a guided tour through textbook scenarios.
2. **Mechanics**: a sequence diagram, state views and an event trace, all on
   one clock you can scrub. You edit packets by clicking on them.
3. **Analysis**: formulas computed live from your settings and set against
   the simulation, with proofs and rated exercises.
4. **Frontier**: where the idea goes in current systems, with references.
5. **Internals**: the Rust source shown as a literate program, with the step
   behind the current event highlighted.

## Tools

| Tool | Model | Checked against | Layers |
| --- | --- | --- | --- |
| Reliable data transfer | Stop-and-wait, Go-Back-N, Selective Repeat, or any mix of their four rules, on a channel that loses, delays and reorders | The stop-and-wait closed form (within 4%); the lossless window bound (within 1%); Kurose and Ross Fig. 3.16, 3.22, 3.26 and 3.27; the sequence-number condition N ≤ 2^(k−1) | all five |
| TCP congestion control | Up to four flows through one bottleneck: Tahoe, Reno, NewReno, CUBIC, and the retransmission timer | RFC 6298 timer values; NewReno surviving the losses that stall Reno; the sawtooth utilisation formula (within 0.02); the Mathis square-root law (within 8%); the CUBIC curve; fair sharing and round-trip unfairness | all five |
| Routing | Distance vector (triggered updates, poisoned reverse) and link state, with cost changes and failures | Kurose and Ross Fig. 5.3 and 5.7; agreement with Dijkstra on 40 random networks; count to infinity, and poisoned reverse failing on a loop of three (RFC 2453) | all five |
| Queueing and delay | The four delays, M/M/1, M/D/1, priority, token and leaky buckets, weighted fair queueing | Little's law; Pollaczek-Khinchine; Cobham's priority formula; the Parekh-Gallager delay bound | all five |
| Link layer and wireless | ALOHA, Ethernet CSMA/CD, Wi-Fi CSMA/CA with RTS/CTS, learning switches, spanning tree, CRC and Hamming codes | G e^(-G) and G e^(-2G); 802.3 back-off; the hidden and exposed terminals; textbook spanning-tree recovery times; catalogue CRC check values | all five |
| Naming and the web | DNS (iterative and recursive, caching, TTLs) and HTTP/1.0, 1.1, 2 and 3 | The textbook HTTP response-time formulas; head-of-line blocking in HTTP/2 against HTTP/3; the renewal formula for the cache hit ratio | all five |

The Lab tab poses tasks and checks your answer against the simulation in the
browser. No server is involved.

For teaching, every tool has three more actions. "Copy link to this moment"
stores the settings, your packet edits and the clock in the URL. "SVG" and
"TikZ" export the sequence diagram up to the current moment as a figure; the
TikZ file is a standalone document that compiles with `pdflatex`. "Present"
puts the tool full screen and larger, without the article.

## How it works

- `crates/netsim` is the simulation library: a SplitMix64 generator, an event
  queue with integer microsecond times and stable tie-breaking, and one module
  per tool. Each transmission always draws exactly two random numbers, so
  editing one packet never changes the luck of the others.
- `crates/netsim-wasm` exposes the library through a plain C ABI with three
  functions: `nv_alloc`, `nv_free` and `nv_call`. A request is JSON
  `{tool, op, params}`. The reply is a little-endian u32 length followed by
  JSON `{ok}` or `{error}`. wasm-bindgen is not needed.
- `src/net-visual/core` holds the typed TypeScript API (`netsim.ts`), a lazy
  loader (`load.ts`), share links (`share.ts`) and each tool's types, presets,
  tour and labs.
- `src/net-visual/components` holds the shared pieces: the transport
  controls, the sequence diagram, the line chart, the RFC-style header
  diagram, the literate source view, the lab panel, the figure exporters and
  the teacher actions.
- `src/app` is a small stand-alone host, used for development and browser
  checks.

## Run it

Requires Rust with the `wasm32-unknown-unknown` target, `wasm-opt` (Binaryen)
and Node 22 or later.

```sh
npm install
npm run wasm      # build src/net-visual/core/netsim.wasm
npm run dev       # http://localhost:5173
npm run build     # wasm, type check and production bundle in dist/
```

## Test

```sh
npm test          # Rust model tests, then Node tests that load the real wasm
npm run lint      # eslint, prettier, clippy, rustfmt
```

The Rust tests check each model against its closed form or the textbook
figure it reproduces. The Node tests load the compiled module, run every
preset and lab start state through it, check that the guided tour stops where
its text says, and compile an exported TikZ figure when `pdflatex` is present.

## Mounting in the website

The tools are designed for an Astro site with React, Tailwind v4 and
shadcn/ui, using the same `@/components/ui/*` and `@/lib/utils` aliases and
the same CSS tokens (`--chart-1` to `--chart-6`, `--link`, `--destructive`,
the CM Web fonts and the `.dark` class).

1. Copy `src/net-visual/` into the site's `src/`. Keep `core/netsim.wasm`
   beside `core/load.ts`. The loader finds it with
   `new URL("./netsim.wasm", import.meta.url)`, so Vite bundles it as an
   asset, and nothing runs at import time.
2. Make sure the site has the shadcn components used here (button, select,
   tabs, toggle-group, switch) plus `katex`, `radix-ui` and `lucide-react`.
3. Mount a tool on a page as a client-only island:

   ```astro
   ---
   import { RdtTool } from "@/net-visual"
   ---
   <RdtTool client:only="react" />
   ```

   Share links use the URL hash (`#rdt?s=...`), so they work on any route.
4. Rebuild the module after changing the Rust with `npm run wasm` here, then
   copy `netsim.wasm` again.

## Status

Working, as of 26 November 2026. See [STATUS.md](STATUS.md).

## Licence

MIT. See [LICENSE](LICENSE).
