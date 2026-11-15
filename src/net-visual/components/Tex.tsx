import katex from "katex"
import { useLayoutEffect, useMemo, useRef } from "react"

/** KaTeX, rendered to a string once per input. */
export function Tex({ children, display = false }: { children: string; display?: boolean }) {
  const html = useMemo(
    () => katex.renderToString(children, { displayMode: display, throwOnError: false, output: "htmlAndMathml" }),
    [children, display],
  )
  return display ? <DisplayTex html={html} /> : <span dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * A display equation that fits its card: it shrinks to as little as 70% of
 * the text size, and past that scrolls sideways with a visible scrollbar.
 */
function DisplayTex({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.fontSize = ""
      const ratio = el.clientWidth / el.scrollWidth
      if (ratio < 1) el.style.fontSize = `${Math.max(0.7, ratio * 0.98)}em`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [html])
  return <div ref={ref} className="nv-tex-display overflow-x-auto overflow-y-hidden py-1" dangerouslySetInnerHTML={{ __html: html }} />
}

/** A number for TeX: fixed decimals, or scientific with \times 10^{k}. */
export function texNum(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return "\\infty"
  if (x === 0) return "0"
  const a = Math.abs(x)
  if (a >= 0.01 && a < 1e5) return x.toFixed(digits).replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m))
  const k = Math.floor(Math.log10(a))
  return `${(x / 10 ** k).toFixed(2)}\\times 10^{${k}}`
}
