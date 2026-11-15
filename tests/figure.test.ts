// The exported figures must open: the SVG must parse as XML-safe text and
// the TikZ must compile. The compile step runs only where pdflatex exists.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { chartSvg, chartTikz, ladderSvg, ladderTikz, type ChartFigure, type LadderFigure } from "../src/net-visual/components/figure.ts"
import { createNetsim } from "../src/net-visual/core/netsim.ts"
import { PRESETS, runDuration, runRdt } from "../src/net-visual/core/rdt.ts"

const sim = await createNetsim(readFileSync(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))
const run = runRdt(sim, PRESETS.find((p) => p.id === "sr-dilemma")!.params)
const fig: LadderFigure = {
  lanes: ["Sender", "Receiver"],
  flights: run.flights.map((f) => ({
    ...f,
    from: f.kind === "data" ? 0 : 1,
    label: f.kind === "data" ? `seq ${f.wire}${f.occurrence > 1 ? "′" : ""}` : `ACK ${f.wire}`,
    color: f.kind === "data" ? "var(--chart-1)" : "var(--chart-2)",
    alarm: f.fate.includes("wrong"),
  })),
  marks: [{ t: 50_000, lane: 0, text: "timeout" }],
  upTo: runDuration(run),
  caption: "Special characters: 100% & $5 #1 {a_b} <tag>",
}

test("the SVG export escapes text and uses concrete colours", () => {
  const svg = ladderSvg(fig)
  assert.ok(svg.includes("100% &amp; $5 #1 {a_b} &lt;tag&gt;"))
  assert.ok(!svg.includes("var(--"))
  assert.equal((svg.match(/<svg/g) ?? []).length, 1)
})

const hasLatex = spawnSync("pdflatex", ["--version"]).status === 0
test("the TikZ export compiles with pdflatex", { skip: !hasLatex && "pdflatex is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "nv-tikz-"))
  writeFileSync(join(dir, "fig.tex"), ladderTikz(fig))
  execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "fig.tex"], { cwd: dir, stdio: "pipe" })
  assert.ok(readFileSync(join(dir, "fig.pdf")).length > 1000)
})

const chart: ChartFigure = {
  xLabel: "time (s)",
  yLabel: "window (segments)",
  xFormat: (x) => (x / 1e6).toFixed(0),
  yFormat: (y) => y.toFixed(0),
  xDomain: [0, 3e6],
  yDomain: [0, 30],
  series: [
    { label: "Reno cwnd", color: "var(--chart-1)", points: [[0, 1], [1e6, 12], [2e6, 6], [3e6, 9]], step: true },
    { label: "Tahoe & 50% <cwnd>", color: "var(--chart-2)", points: [[0, 1], [1e6, 12], [1.2e6, 1]], dashed: true },
  ],
  refs: [{ y: 8, label: "ssthresh_0 = 8" }],
  caption: "A chart with 100% & $5 #1 {a_b}",
}

test("the chart SVG export escapes text and uses concrete colours", () => {
  const svg = chartSvg(chart)
  assert.ok(svg.includes("Tahoe &amp; 50% &lt;cwnd&gt;"))
  assert.ok(!svg.includes("var(--"))
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2)
})

test("the chart TikZ export compiles with pdflatex", { skip: !hasLatex && "pdflatex is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "nv-tikz-"))
  writeFileSync(join(dir, "chart.tex"), chartTikz(chart))
  execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "chart.tex"], { cwd: dir, stdio: "pipe" })
  assert.ok(readFileSync(join(dir, "chart.pdf")).length > 1000)
})
