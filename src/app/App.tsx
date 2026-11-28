import { Suspense, useEffect, useState } from "react"

import { TOOLS } from "@/net-visual/tools"

const route = () => window.location.hash.slice(1).split("?")[0]

/**
 * A stand-alone host for the tools, for development and for checking them in
 * a browser. The website mounts the tool components directly instead.
 */
export function App() {
  const [id, setId] = useState(route)

  useEffect(() => {
    const on = () => setId(route())
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])

  const tool = TOOLS.find((t) => t.id === id)

  return (
    <div className="mx-auto max-w-[calc(58rem+2*var(--site-gutter))] px-(--site-gutter) pb-(--site-space-8)">
      <header className="nv-bar">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <a href="#" className="text-sm text-foreground no-underline sm:text-lg">
            Networks you can take apart
          </a>
          <div className="flex items-start gap-3">
            <details className="font-sans text-sm">
              <summary className="cursor-pointer py-1 text-link">The six tools</summary>
              <nav aria-label="Tools">
                <ul className="mt-1 space-y-1">
                  {TOOLS.map((t) => (
                    <li key={t.id}>
                      {t.id === id ? (
                        <span aria-current="page">
                          {t.title} <span className="text-muted-foreground">(this page)</span>
                        </span>
                      ) : (
                        <a href={`#${t.id}`}>{t.title}</a>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            </details>
          </div>
        </div>
      </header>

      <main className="pt-(--site-space-4)">
        {tool ? (
          <>
            <h1 className="mb-(--site-space-2) text-[length:var(--site-step-title-narrow)] leading-tight tracking-(--site-tracking-title) sm:text-3xl">
              {tool.title}
            </h1>
            <p className="mb-(--site-space-4) max-w-(--site-measure) [font-variant-numeric:lining-nums]">{tool.lead}</p>
            <Suspense fallback={<p className="font-sans text-sm text-muted-foreground">Loading…</p>}>
              <tool.Component />
            </Suspense>
          </>
        ) : (
          <Index />
        )}
      </main>
    </div>
  )
}

function Index() {
  return (
    <div className="max-w-(--site-measure) space-y-6">
      <h1 className="text-[length:var(--site-step-title-narrow)] leading-tight sm:text-3xl">Networks you can take apart</h1>
      <p>
        Each tool runs a real, deterministic simulation compiled from Rust. You can stop time, step back, drop or delay a single packet,
        change the protocol's rules, and compare what happens with the formula that predicts it. Every state can be shared as a link.
      </p>
      <ol className="space-y-4">
        {TOOLS.map((t, i) => (
          <li key={t.id}>
            <a href={`#${t.id}`} className="text-lg">
              {i + 1}. {t.title}
            </a>
            <p className="text-base">{t.summary}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}
