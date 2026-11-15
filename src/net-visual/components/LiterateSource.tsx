import { useEffect, useMemo, useRef } from "react"

import { cn } from "@/lib/utils"
import { scrollBehavior } from "./ToolFrame"

interface Block {
  kind: "prose" | "code"
  lines: string[]
  first: number
}

const MARKER = /^\s*\/\/[/!]?\s*([A-Z]\d+)\.\s\[/

/** Brace depth at the start of each line, ignoring strings and char literals. */
function depths(lines: string[]): number[] {
  const out: number[] = []
  let depth = 0
  for (const line of lines) {
    out.push(depth)
    const code = line
      .replace(/\/\/.*$/, "")
      .replace(/"(?:\\.|[^"\\])*"/g, "")
      .replace(/'(?:\\.|[^'\\])'/g, "")
    for (const ch of code) {
      if (ch === "{") depth++
      else if (ch === "}") depth--
    }
  }
  out.push(depth)
  return out
}

/** Line ranges [start, end] of each lettered step in the source. */
export function stepRegions(lines: string[]): Map<string, [number, number]> {
  const depth = depths(lines)
  const markers: [string, number][] = []
  lines.forEach((l, i) => {
    const m = l.match(MARKER)
    if (m) markers.push([m[1], i])
  })
  const regions = new Map<string, [number, number]>()
  markers.forEach(([step, start], k) => {
    const nextMarker = k + 1 < markers.length ? markers[k + 1][1] : lines.length
    let end = nextMarker - 1
    if (lines[start].trim().startsWith("///")) {
      // A doc comment: the region is the function that follows.
      let i = start
      while (i < lines.length && lines[i].trim().startsWith("///")) i++
      const base = depth[i]
      let j = i
      while (j < lines.length && !(depth[j + 1] <= base && j > i)) j++
      end = Math.min(j, lines.length - 1)
    } else {
      // An inline comment: up to the next marker or the end of this block.
      const base = depth[start]
      for (let j = start + 1; j < nextMarker; j++) {
        if (depth[j + 1] < base) {
          end = j - 1
          break
        }
      }
    }
    regions.set(step, [start, end])
  })
  return regions
}

function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  lines.forEach((line, i) => {
    const comment = /^\s*\/\/[/!]?/.test(line)
    const kind = comment ? "prose" : "code"
    const text = comment ? line.replace(/^\s*\/\/[/!]?\s?/, "") : line
    const last = blocks[blocks.length - 1]
    if (last && last.kind === kind) last.lines.push(text)
    else blocks.push({ kind, lines: [text], first: i })
  })
  return blocks
}

function Prose({ lines }: { lines: string[] }) {
  const paragraphs = lines.join("\n").split(/\n\s*\n/)
  return (
    <>
      {paragraphs.map((p, i) => {
        const marker = p.match(/^([A-Z]\d+)\.\s(\[[^\]]+\])\s?/)
        const body = marker ? p.slice(marker[0].length) : p
        return (
          <p key={i} className="my-1 font-serif text-sm leading-snug">
            {marker && (
              <>
                <b className="lining">{marker[1]}.</b> <span>{marker[2]}</span>{" "}
              </>
            )}
            {body
              .split(/(`[^`]+`)/)
              .map((part, j) =>
                part.startsWith("`") ? <code key={j}>{part.slice(1, -1)}</code> : <span key={j}>{part.replace(/\n/g, " ")}</span>,
              )}
          </p>
        )
      })}
    </>
  )
}

/**
 * The model's Rust source as a literate program: comments set as prose, code
 * as code, and the lettered step that produced the current event highlighted.
 */
export function LiterateSource({ source, active, className }: { source: string; active: string | null; className?: string }) {
  const lines = useMemo(() => {
    const all = source.split("\n")
    const cut = all.findIndex((l) => l.startsWith("#[cfg(test)]"))
    return cut > 0 ? all.slice(0, cut) : all
  }, [source])
  const regions = useMemo(() => stepRegions(lines), [lines])
  const blocks = useMemo(() => toBlocks(lines), [lines])
  const box = useRef<HTMLDivElement>(null)
  const range = active ? regions.get(active) : undefined

  useEffect(() => {
    if (!range || !box.current) return
    const el = box.current.querySelector<HTMLElement>(`[data-line="${range[0]}"]`)
    if (el) box.current.scrollTo({ top: el.offsetTop - 24, behavior: scrollBehavior() })
  }, [range])

  const inRange = (i: number) => range !== undefined && i >= range[0] && i <= range[1]

  return (
    <div ref={box} className={cn("relative overflow-auto rounded-sm border border-border", className)}>
      {blocks.map((b) =>
        b.kind === "prose" ? (
          <div key={b.first} data-line={b.first} className={cn("px-3 py-1", inRange(b.first) && "bg-mark")}>
            <Prose lines={b.lines} />
          </div>
        ) : (
          <pre key={b.first} className="m-0 text-sm leading-[1.45]">
            {b.lines.map((l, k) => {
              const n = b.first + k
              return (
                <div key={n} data-line={n} className={cn("flex", inRange(n) && "bg-mark")}>
                  <span className="w-10 shrink-0 pr-2 text-right text-muted-foreground select-none" aria-hidden>
                    {n + 1}
                  </span>
                  <code className="whitespace-pre">{l || " "}</code>
                </div>
              )
            })}
          </pre>
        ),
      )}
    </div>
  )
}
