# Status

Working, as of 28 November 2026.

- Tested: `make check` builds the site from the committed `netsim.wasm`, then runs the Rust and Node tests, in CI.
- Next: the TikZ test needs `pdflatex`, which CI does not have, so it is skipped there.
