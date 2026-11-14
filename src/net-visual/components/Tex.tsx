import katex from "katex"
import { useMemo } from "react"

/** KaTeX, rendered to a string once per input. */
export function Tex({ children, display = false }: { children: string; display?: boolean }) {
  const html = useMemo(
    () => katex.renderToString(children, { displayMode: display, throwOnError: false, output: "htmlAndMathml" }),
    [children, display],
  )
  return display ? (
    <div className="overflow-x-auto overflow-y-hidden py-1" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span dangerouslySetInnerHTML={{ __html: html }} />
  )
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
