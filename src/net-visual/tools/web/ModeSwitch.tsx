import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { MODES, type WebMode } from "../../core/dns"
import type { HttpMode } from "../../core/http"

export type AnyMode = WebMode | HttpMode

/** The page's six modes in two groups: naming (DNS) and the web (HTTP). */
export function ModeSwitch({ mode, onPick }: { mode: AnyMode; onPick(m: AnyMode): void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {(["naming", "http"] as const).map((g) => (
        <div key={g} className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-xs text-muted-foreground" id={`web-group-${g}`}>
            {g === "naming" ? "DNS" : "HTTP"}
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            aria-labelledby={`web-group-${g}`}
            value={MODES.some((m) => m.group === g && m.id === mode) ? mode : ""}
            onValueChange={(v) => v && onPick(v as AnyMode)}
            className="flex-wrap"
          >
            {MODES.filter((m) => m.group === g).map((m) => (
              <ToggleGroupItem key={m.id} value={m.id} className="px-3">
                {m.title}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ))}
    </div>
  )
}
