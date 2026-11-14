// Loads the real WebAssembly module through the TypeScript API the page uses
// and checks presets and lab checks against the model.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { createNetsim } from "../src/net-visual/core/netsim.ts"
import { LABS, PRESETS, TOUR, runDuration, runRdt } from "../src/net-visual/core/rdt.ts"

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

test("the tour stops where its text says", () => {
  const at = (i: number) => {
    const run = runRdt(sim, PRESETS.find((p) => p.id === TOUR[i].preset)!.params)
    return { run, t: TOUR[i].at * runDuration(run) }
  }
  // "Watch the timer bar above packet 1 run out": before it has.
  const lost = at(2)
  const expiry = lost.run.events.find((e) => e.step === "S4")!
  assert.ok(lost.t < expiry.t && lost.run.events.some((e) => e.t <= lost.t && e.text.startsWith("transmit seq 1")))
  // "The red box is data delivered as the wrong message": after it arrives.
  const dilemma = at(TOUR.length - 1)
  assert.ok(dilemma.run.flights.some((f) => f.fate.includes("wrong") && f.t_arrive <= dilemma.t))
})
