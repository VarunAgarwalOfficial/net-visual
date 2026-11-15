import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// One quiet style from the site's tokens: an outlined control in the ink,
// the hairline rule as its edge, the small text size, no shadow, no
// movement. The filled ink button (default) is kept for the one main action
// per tool (Play). Focus is the site's ring, set in host.css.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-sm border border-transparent text-sm whitespace-nowrap select-none disabled:pointer-events-none disabled:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        outline: "border-border bg-background text-foreground hover:bg-accent aria-expanded:bg-accent",
        secondary: "border-foreground bg-background text-foreground",
        ghost: "text-foreground hover:bg-accent aria-expanded:bg-accent",
        destructive: "border-border bg-background text-foreground hover:bg-accent",
        link: "text-foreground underline decoration-link underline-offset-4",
      },
      size: {
        default: "h-9 gap-1.5 px-3",
        xs: "h-7 gap-1 px-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-1.5 px-3",
        icon: "size-9",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
