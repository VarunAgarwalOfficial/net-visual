import { useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface Lab<P> {
  id: string
  difficulty: 1 | 2 | 3
  title: string
  task: string
  hint: string
  start: P
}

const LEVEL = ["", "recall", "apply", "investigate"]

export function Difficulty({ level }: { level: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-sans text-xs text-muted-foreground">
      <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden>
        {[0, 1, 2].map((i) => (
          <circle key={i} cx={4 + i * 7} cy={4} r={3} fill={i < level ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1} />
        ))}
      </svg>
      {LEVEL[level]}
    </span>
  )
}

/**
 * Lab mode: a task, a starting state, a hint that does not give the answer,
 * and a check computed from the simulation in the page. Nothing leaves it.
 */
export function LabPanel<P>({
  labs,
  load,
  check,
}: {
  labs: Lab<P>[]
  load(start: P): void
  check(lab: Lab<P>): { ok: boolean; message: string }
}) {
  const [current, setCurrent] = useState<string | null>(null)
  const [hint, setHint] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const lab = labs.find((l) => l.id === current)

  if (!lab)
    return (
      <ol className="space-y-2">
        {labs.map((l) => (
          <li key={l.id}>
            <button
              className="w-full rounded-sm px-2 py-1.5 text-left hover:bg-muted"
              onClick={() => {
                setCurrent(l.id)
                setHint(false)
                setResult(null)
                load(l.start)
              }}
            >
              <span className="block">{l.title}</span>
              <Difficulty level={l.difficulty} />
            </button>
          </li>
        ))}
      </ol>
    )

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-serif text-base font-bold">{lab.title}</h4>
        <Difficulty level={lab.difficulty} />
      </div>
      <p className="text-sm">{lab.task}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setResult(check(lab))}>
          Check my answer
        </Button>
        <Button size="sm" variant="outline" onClick={() => setHint(!hint)} aria-expanded={hint}>
          {hint ? "Hide hint" : "Hint"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            load(lab.start)
            setResult(null)
          }}
        >
          Reset
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setCurrent(null)}>
          All tasks
        </Button>
      </div>
      {hint && <p className="text-sm text-muted-foreground italic">{lab.hint}</p>}
      {result && (
        <p role="status" className={cn("rounded-sm px-2 py-1.5 text-sm", result.ok ? "text-status-checked" : "text-foreground")}>
          <b>{result.ok ? "Correct. " : "Not yet. "}</b>
          {result.message}
        </p>
      )}
    </div>
  )
}
