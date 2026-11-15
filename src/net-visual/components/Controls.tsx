import { useId, type ComponentProps, type ReactNode } from "react"

import { Slider as SliderPrimitive } from "radix-ui"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/**
 * The site's slider, with the label passed to the thumb (the element that
 * carries role="slider"), which the shadcn wrapper does not do.
 */
export function LabelledSlider({
  className,
  label,
  labelledBy,
  valueText,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root> & { label?: string; labelledBy?: string; valueText?: string }) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative flex w-full touch-none items-center select-none data-disabled:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className="relative h-1 w-full grow overflow-hidden rounded-full bg-border">
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary select-none" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-valuetext={valueText}
        className="relative block size-3.5 shrink-0 rounded-full border-2 border-foreground bg-background select-none after:absolute after:-inset-2"
      />
    </SliderPrimitive.Root>
  )
}

/** A labelled slider with its value; `log` maps the track logarithmically. */
export function ParamSlider({
  label,
  value,
  min,
  max,
  step = 1,
  log = false,
  format = String,
  onChange,
}: {
  label: ReactNode
  value: number
  min: number
  max: number
  step?: number
  log?: boolean
  format?: (v: number) => string
  onChange(v: number): void
}) {
  const id = useId()
  const toTrack = (v: number) => (log ? Math.log(v) : v)
  const fromTrack = (v: number) => {
    const raw = log ? Math.exp(v) : v
    const snapped = log ? Number(raw.toPrecision(2)) : Math.round(raw / step) * step
    return Math.min(max, Math.max(min, Number(snapped.toPrecision(12))))
  }
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 font-sans text-sm">
      <label id={id} className="text-foreground">
        {label}
      </label>
      <span className="text-right text-muted-foreground tabular-nums lining">{format(value)}</span>
      <LabelledSlider
        className="col-span-2"
        labelledBy={id}
        valueText={format(value)}
        min={toTrack(min)}
        max={toTrack(max)}
        step={log ? (toTrack(max) - toTrack(min)) / 200 : step}
        value={[toTrack(value)]}
        onValueChange={([v]) => onChange(fromTrack(v))}
      />
    </div>
  )
}

/**
 * A rule that is either on or off. `name` is the stable accessible name (what
 * "on" means); the line under the label says what the current setting does.
 */
export function ParamSwitch({
  label,
  name,
  checked,
  onChange,
  on,
  off,
}: {
  label: string
  name: string
  checked: boolean
  onChange(v: boolean): void
  on: string
  off: string
}) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-3 font-sans text-sm">
      <label htmlFor={id}>
        {label}
        <span id={`${id}-now`} className="block text-xs text-muted-foreground">
          {checked ? on : off}
        </span>
      </label>
      <Switch id={id} aria-label={name} aria-describedby={`${id}-now`} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
