# Mount the tools in a website

The tools are built for an Astro site with React, Tailwind v4 and shadcn/ui.
They use the `@/components/ui/*` and `@/lib/utils` aliases, the website's
pixel tokens (`src/styles/tokens/pixel-tokens.css`: the `--site-*` and
`--px-*` names) and the fonts in `public/fonts`. `src/styles/host.css` maps
the tokens onto the shadcn colour roles and the tools' meaning colours.

1. Copy `src/net-visual/` into the site's `src/`. Keep `core/netsim.wasm`
   beside `core/load.ts`. The loader finds it with
   `new URL("./netsim.wasm", import.meta.url)`, so Vite bundles it as an
   asset, and nothing runs at import time.
2. Make sure the site has the shadcn components used here (button, select,
   tabs, toggle-group, switch) plus `katex`, `radix-ui` and `lucide-react`.
3. Mount a tool on a page as a client-only island:

   ```astro
   ---
   import { RdtTool } from "@/net-visual"
   ---
   <RdtTool client:only="react" />
   ```

   Share links use the URL hash (`#rdt?s=...`), so they work on any route.
4. Rebuild the module after changing the Rust with `npm run wasm` here, then
   copy `netsim.wasm` again.

## Or copy the built page

`npm run build` writes a self-contained static site to `dist/`. Every path in
it is relative, so the folder works when copied to any address, such as
`/tools/net-visual/`. Pick a tool with the address hash, for example
`index.html#tcp`.
