import { useEffect, useState, type RefObject } from "react"
import { Download, Link2, Presentation } from "lucide-react"

import { Button } from "@/components/ui/button"
import { download, ladderSvg, ladderTikz, type LadderFigure } from "./figure"

/**
 * The actions every tool offers a teacher: a link to this exact moment, the
 * sequence diagram as a figure (SVG or TikZ), and a presentation mode that
 * puts the tool full screen, larger, without the article.
 */
export function ToolActions({
  name,
  link,
  figure,
  root,
}: {
  /** Short file name stem for exports, such as "rdt". */
  name: string
  link(): string
  figure(): LadderFigure
  root: RefObject<HTMLElement | null>
}) {
  const [copied, setCopied] = useState(false)
  const [present, setPresent] = useState(false)

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
      <span className="flex items-center gap-1" role="group" aria-label="Export the sequence diagram">
        <Button
          variant="outline"
          size="sm"
          title="The diagram up to now, as an SVG file"
          onClick={() => download(`${name}.svg`, ladderSvg(figure()), "image/svg+xml")}
        >
          <Download data-icon="inline-start" />
          SVG
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="The diagram up to now, as a standalone TikZ file for pdflatex"
          onClick={() => download(`${name}.tex`, ladderTikz(figure()), "application/x-tex")}
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
