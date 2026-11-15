import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { sourceLine } from "../../components/ToolFrame"
import { MODES, PRESETS, type WebMode } from "../../core/dns"
import { HTTP_PRESETS, type HttpMode } from "../../core/http"

export type AnyMode = WebMode | HttpMode

const ALL: { id: string; mode: AnyMode; title: string; source: string }[] = [...PRESETS, ...HTTP_PRESETS]

/** The mode an example belongs to, so a pick from the other half of the page can swap panels. */
export const modeOf = (id: string): AnyMode | undefined => ALL.find((q) => q.id === id)?.mode

/**
 * "Try another example": every example on the page, the naming ones and the
 * web ones, grouped under the plain name of what each group shows.
 */
export function WebPicker({ id, value, onPick }: { id: string; value: string; onPick(id: string): void }) {
  const info = ALL.find((q) => q.id === value)
  return (
    <div className="space-y-2">
      <label className="block text-lg" htmlFor={id}>
        Try another example
      </label>
      <Select value={value || "custom"} onValueChange={onPick}>
        <SelectTrigger
          id={id}
          className="h-auto min-h-9 w-full max-w-xl text-left whitespace-normal [&_[data-slot=select-value]]:line-clamp-none"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODES.map((m) => (
            <SelectGroup key={m.id}>
              <SelectLabel>{m.title}</SelectLabel>
              {ALL.filter((q) => q.mode === m.id).map((q) => (
                <SelectItem key={q.id} value={q.id}>
                  {q.title}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          <SelectItem value="custom" disabled>
            Your own setup
          </SelectItem>
        </SelectContent>
      </Select>
      {info && <p className="font-sans text-sm text-muted-foreground">{sourceLine(info.source)}</p>}
    </div>
  )
}
