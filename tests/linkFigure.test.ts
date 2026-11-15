// The link-layer figures: every scenario draws at desktop and phone widths,
// at several moments, without NaN, and exports to SVG and TikZ.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { PRESETS, linkDuration, runLink, type LinkParams, type LinkRun } from "../src/net-visual/core/link.ts"
import { createNetsim } from "../src/net-visual/core/netsim.ts"
import { alohaFigure, caFigure, cdFigure } from "../src/net-visual/tools/link/linkFigures.ts"
import { clipY, figSvg, figTikz, type ShapeFigure } from "../src/net-visual/tools/link/shapes.ts"

const sim = await createNetsim(await readFile(new URL("../src/net-visual/core/netsim.wasm", import.meta.url)))

function draw(p: LinkParams, r: LinkRun, t: number, w: number): ShapeFigure {
  if (p.mode === "aloha" && r.mode === "aloha") return alohaFigure(p.aloha, r.run, t, w)
  if (p.mode === "csmacd" && r.mode === "csmacd") return cdFigure(p.cd, r.run, t, w)
  if (p.mode === "csmaca" && r.mode === "csmaca") return caFigure(p.ca, r.run, t, w)
  return null
}

test("every scenario's figure is finite and inside its box", () => {
  for (const pr of PRESETS) {
    const r = runLink(sim, pr.params)
    const end = linkDuration(pr.params, r)
    for (const w of [640, 360]) {
      for (const t of [0, end * 0.1, end * 0.5, end]) {
        const fig = draw(pr.params, r, t, w)
        if (!fig) continue
        assert.equal(fig.w, w, pr.id)
        assert.ok(fig.h > 0 && Number.isFinite(fig.h), pr.id)
        const json = JSON.stringify(fig.shapes)
        assert.ok(!json.includes("null") && !json.includes("NaN"), `${pr.id} at ${t}, width ${w}`)
        const svg = figSvg({ ...fig, caption: pr.title })
        assert.ok(!svg.includes("NaN") && svg.startsWith("<svg") && svg.endsWith("</svg>"), pr.id)
        const tikz = figTikz({ ...fig, caption: pr.title })
        assert.ok(!tikz.includes("NaN") && tikz.includes("\\end{tikzpicture}"), pr.id)
      }
    }
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
