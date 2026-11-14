// Loads the real WebAssembly module through the TypeScript API the page uses
// and checks presets and lab checks against the model.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { createNetsim } from "../src/net-visual/core/netsim.ts"
import { LABS, PRESETS, runRdt } from "../src/net-visual/core/rdt.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))

test("textbook presets behave as the figures they cite", () => {
  const byId = Object.fromEntries(PRESETS.map((p) => [p.id, runRdt(sim, p.params)]))
  assert.ok(byId["gbn"].flights.some((f) => f.fate === "out of order"))
  assert.ok(byId["sr"].flights.some((f) => f.fate === "buffered"))
  assert.equal(byId["sr-dilemma"].totals.correct, false)
  for (const id of ["sw-clean", "sw-lost-packet", "sw-lost-ack", "sw-premature", "gbn", "sr"]) {
    assert.equal(byId[id].totals.correct, true, id)
  }
  // Kurose and Ross: U = (L/R) / (RTT + L/R) = 0.008 / 30.008 = 0.00027.
  assert.equal(byId["sw-continent"].theory.bound.toFixed(5), "0.00027")
})

test("lab checks reject the starting state and accept a solution", () => {
  for (const lab of LABS) {
    assert.equal(lab.check(lab.start, runRdt(sim, lab.start), sim).ok, false, lab.id)
  }
  const fill = LABS.find((l) => l.id === "fill")!
  const solved = { ...fill.start, window: 19 }
  assert.equal(fill.check(solved, runRdt(sim, solved), sim).ok, true)
  assert.throws(() => sim.call("rdt", "run", { ...fill.start, window: 0 }), /out of range/)
})
