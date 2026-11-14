import { Suspense, useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
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
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border py-4">
        <a href="#" className="text-xl text-foreground no-underline">
          Networks you can take apart
        </a>
        <nav aria-label="Tools" className="flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-sm">
          {TOOLS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={t.id === id ? "page" : undefined} className={cn(t.id === id && "font-semibold")}>
              {t.title}
            </a>
          ))}
          <Button variant="ghost" size="icon-sm" aria-label={dark ? "Use light theme" : "Use dark theme"} onClick={() => setDark(!dark)}>
            {dark ? <Sun /> : <Moon />}
          </Button>
        </nav>
      </header>

      <main className="pt-6">
        {tool ? (
          <>
            <h1 className="mb-1 text-3xl">{tool.title}</h1>
            <p className="mb-6 max-w-[70ch] text-muted-foreground">{tool.summary}</p>
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
            <p className="font-sans text-xs text-muted-foreground">Layers: {t.layers.join(", ")}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}
