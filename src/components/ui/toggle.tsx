"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Toggle as TogglePrimitive } from "radix-ui"

// The site's quiet control: hairline edge, ink text; the pressed option has an ink edge and the code ground.
const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-sm border border-transparent text-sm whitespace-nowrap hover:bg-accent disabled:pointer-events-none disabled:text-muted-foreground aria-pressed:border-foreground aria-pressed:bg-muted data-[state=on]:border-foreground data-[state=on]:bg-muted [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-border bg-transparent",
      },
      size: {
        default: "h-9 min-w-9 px-2.5",
        sm: "h-8 min-w-8 px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 min-w-10 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
