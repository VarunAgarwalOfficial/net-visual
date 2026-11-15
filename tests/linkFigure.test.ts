// The link-layer figures: every scenario draws at desktop and phone widths,
// at several moments, without NaN, and exports to SVG and TikZ.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { PRESETS, linkDuration, runLink, type LinkParams, type LinkRun } from "../src/net-visual/core/link.ts"
import { createNetsim } from "../src/net-visual/core/netsim.ts"
import { crcFigure, hammingFigure } from "../src/net-visual/tools/link/codeFigures.ts"
import { stpFigure, switchFigure } from "../src/net-visual/tools/link/lanFigures.ts"
import { alohaFigure, caFigure, cdFigure } from "../src/net-visual/tools/link/linkFigures.ts"
import { clipY, figSvg, figTikz, type ShapeFigure } from "../src/net-visual/tools/link/shapes.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))

function draw(p: LinkParams, r: LinkRun, t: number, w: number): ShapeFigure {
  // The event on screen at time t: the last one at or before it.
  const events: { t: number }[] = r.run.events
  let index = 0
  while (index + 1 < events.length && events[index + 1].t <= t) index++
  if (p.mode === "switch" && r.mode === "switch") return switchFigure(p.sw, r.run, t, index, w)
  if (p.mode === "stp" && r.mode === "stp") return stpFigure(p.stp, r.run, t, index, w)
  if (p.mode === "crc" && r.mode === "crc") return crcFigure(p.crc, r.run, index, w)
  if (p.mode === "hamming" && r.mode === "hamming") return hammingFigure(p.ham, r.run, index, w)
  if (p.mode === "aloha" && r.mode === "aloha") return alohaFigure(p.aloha, r.run, t, w)
  if (p.mode === "csmacd" && r.mode === "csmacd") return cdFigure(p.cd, r.run, t, w)
  if (p.mode === "csmaca" && r.mode === "csmaca") return caFigure(p.ca, r.run, t, w)
  throw new Error(`no figure for ${p.mode}`)
}

test("every scenario's figure is finite and inside its box", () => {
  for (const pr of PRESETS) {
    const r = runLink(sim, pr.params)
    const end = linkDuration(pr.params, r)
    for (const w of [640, 360]) {
      for (const t of [0, end * 0.1, end * 0.5, end]) {
        const fig = draw(pr.params, r, t, w)
        assert.equal(fig.w, w, pr.id)
        assert.ok(fig.h > 0 && Number.isFinite(fig.h), pr.id)
        const json = JSON.stringify(fig.shapes)
        assert.ok(!json.includes("null") && !json.includes("NaN"), `${pr.id} at ${t}, width ${w}`)
        const svg = figSvg({ ...fig, caption: pr.title })
        assert.ok(!svg.includes("NaN") && svg.startsWith("<svg") && svg.endsWith("</svg>"), pr.id)
        const tikz = figTikz({ ...fig, caption: pr.title })
        assert.ok(!tikz.includes("NaN") && tikz.includes("\\end{tikzpicture}"), pr.id)
        /* eslint-disable no-control-regex -- the test is for ASCII, which starts at \x00 */
        assert.ok(
          /^[\x00-\x7f]*$/.test(tikz),
          `${pr.id}: TikZ has characters pdflatex cannot set: ${[...new Set(tikz.replace(/[\x00-\x7f]/g, ""))].join(" ")}`,
        )
        /* eslint-enable no-control-regex */
      }
    }
  }
})

test("the coding figures keep one height through a run, so the page does not jump", () => {
  for (const pr of PRESETS.filter((q) => q.mode === "crc" || q.mode === "hamming")) {
    const r = runLink(sim, pr.params)
    const n = r.run.events.length
    const heights = new Set([0, Math.floor(n / 2), n - 1].map((i) => draw(pr.params, r, r.run.events[i].t, 640).h))
    assert.equal(heights.size, 1, pr.id)
  }
})

test("clipping a polygon to a band keeps it inside the band", () => {
  const sq: [number, number][] = [
    [0, -10],
    [10, -10],
    [10, 20],
    [0, 20],
  ]
  const c = clipY(sq, 0, 10)
  assert.ok(c.every(([, y]) => y >= 0 && y <= 10))
  assert.equal(c.length, 4)
  assert.deepEqual(clipY(sq, 30, 40), [])
})
