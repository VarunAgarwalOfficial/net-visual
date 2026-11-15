import { Suspense, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { TOOLS } from "@/net-visual/tools"

const route = () => window.location.hash.slice(1).split("?")[0]

/**
 * A stand-alone host for the tools, for development and for checking them in
 * a browser. The website mounts the tool components directly instead.
 */
export function App() {
  const [id, setId] = useState(route)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))

  useEffect(() => {
    const on = () => setId(route())
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    try {
      localStorage.setItem("nv-theme", dark ? "dark" : "light")
    } catch {
      // Private browsing: the choice lasts for this page only.
    }
  }, [dark])

  const tool = TOOLS.find((t) => t.id === id)

  return (
    <div className="mx-auto max-w-[96rem] px-4 pb-24 sm:px-6">
      <header className="border-b border-border py-3 sm:py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <a href="#" className="text-xl text-foreground no-underline">
            Networks you can take apart
          </a>
          <nav aria-label="Tools" className="hidden flex-1 flex-wrap items-center justify-end gap-x-4 gap-y-1 font-sans text-sm sm:flex">
            {TOOLS.map((t) =>
              t.id === id ? (
                <span key={t.id} aria-current="page">
                  {t.title} <span className="text-muted-foreground">(this page)</span>
                </span>
              ) : (
                <a key={t.id} href={`#${t.id}`}>
                  {t.title}
                </a>
              ),
            )}
          </nav>
          <ThemeButton dark={dark} set={setDark} className="hidden sm:inline-flex" />
        </div>
        <div className="mt-1 flex items-start justify-between gap-3 sm:hidden">
          <details className="font-sans text-sm">
            <summary className="cursor-pointer text-link">The six tools</summary>
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
          <ThemeButton dark={dark} set={setDark} />
        </div>
      </header>

      <main className="pt-4">
        {tool ? (
          <>
            <h1 className="mb-1 text-3xl leading-tight">{tool.title}</h1>
            <p className="mb-4 max-w-[70ch] [font-variant-numeric:lining-nums]">{tool.lead}</p>
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

/** The colour scheme, named in words: it says what pressing it will do. */
function ThemeButton({ dark, set, className }: { dark: boolean; set(dark: boolean): void; className?: string }) {
  return (
    <Button variant="outline" size="sm" className={className} onClick={() => set(!dark)}>
      {dark ? "Use light colours" : "Use dark colours"}
    </Button>
  )
}

function Index() {
  return (
    <div className="max-w-[70ch] space-y-6">
      <h1 className="text-3xl">Networks you can take apart</h1>
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
            <p className="text-[0.98rem]">{t.summary}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}
