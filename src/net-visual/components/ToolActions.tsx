import { useEffect, useState, type RefObject } from "react"
import { Download, Link2, Presentation } from "lucide-react"

import { Button } from "@/components/ui/button"
import { download } from "./figure"

/** One exportable figure: drawn from the run when asked, not copied from the screen. */
export interface ExportFigure {
  label: string
  /** File name stem, such as "rdt-ladder". */
  stem: string
  svg(): string
  tikz(): string
}

/**
 * The actions every tool offers a teacher: a link to this exact moment, the
 * tool's figures (SVG or TikZ), and a presentation mode that puts the tool
 * full screen, larger, without the article.
 */
export function ToolActions({ link, figures, root }: { link(): string; figures: ExportFigure[]; root: RefObject<HTMLElement | null> }) {
  const [copied, setCopied] = useState(false)
  const [present, setPresent] = useState(false)
  const [which, setWhich] = useState(0)
  const figure = figures[Math.min(which, figures.length - 1)]

  useEffect(() => {
    const el = root.current
    if (!el) return
    el.classList.toggle("nv-present", present)
    if (present && !document.fullscreenElement) el.requestFullscreen?.().catch(() => undefined)
    if (!present && document.fullscreenElement === el) document.exitFullscreen().catch(() => undefined)
  }, [present, root])

  useEffect(() => {
    // Leaving full screen with Escape also leaves presentation mode.
    const on = () => {
      if (!document.fullscreenElement) setPresent(false)
    }
    document.addEventListener("fullscreenchange", on)
    return () => document.removeEventListener("fullscreenchange", on)
  }, [])

  const share = async () => {
    const url = link()
    window.history.replaceState(null, "", url)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // No clipboard permission: the address bar now holds the link.
      setCopied(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={share}>
        <Link2 data-icon="inline-start" />
        {copied ? "Link copied" : "Copy link to this moment"}
      </Button>
      <span className="flex items-center gap-1" role="group" aria-label="Export a figure">
        {figures.length > 1 && (
          <select
            className="h-8 rounded-sm border border-input bg-background px-1 font-sans text-sm"
            aria-label="Figure to export"
            value={which}
            onChange={(e) => setWhich(Number(e.target.value))}
          >
            {figures.map((f, i) => (
              <option key={f.stem} value={i}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        <Button
          variant="outline"
          size="sm"
          title={`${figure.label} up to now, as an SVG file`}
          onClick={() => download(`${figure.stem}.svg`, figure.svg(), "image/svg+xml")}
        >
          <Download data-icon="inline-start" />
          SVG
        </Button>
        <Button
          variant="outline"
          size="sm"
          title={`${figure.label} up to now, as a standalone TikZ file for pdflatex`}
          onClick={() => download(`${figure.stem}.tex`, figure.tikz(), "application/x-tex")}
        >
          <Download data-icon="inline-start" />
          TikZ
        </Button>
      </span>
      <Button
        variant={present ? "secondary" : "outline"}
        size="sm"
        aria-pressed={present}
        title="Full screen and larger, without the article; Escape leaves"
        onClick={() => setPresent(!present)}
      >
        <Presentation data-icon="inline-start" />
        Present
      </Button>
    </div>
  )
}
