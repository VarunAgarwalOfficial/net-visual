// Builds the Rust models to WebAssembly and places the module next to the
// TypeScript API that loads it. Uses wasm-opt when it is installed.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, statSync } from "node:fs"

const env = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4" }
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", env })

run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "netsim-wasm"])
const built = "target/wasm32-unknown-unknown/release/netsim_wasm.wasm"
const out = "src/net-visual/core/netsim.wasm"
let optimised = false
try {
  run("wasm-opt", ["-Os", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", built, "-o", out])
  optimised = true
} catch {
  copyFileSync(built, out)
}
if (!existsSync(out)) throw new Error("no wasm produced")
console.log(`${out}: ${statSync(out).size} bytes${optimised ? " (wasm-opt -Os)" : ""}`)
