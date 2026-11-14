// Browser loader: fetches the module once, on first use, never at import time,
// so the components are safe to render on a server and hydrate later.
import { createNetsim, type Netsim } from "./netsim"

let pending: Promise<Netsim> | null = null

export function loadNetsim(): Promise<Netsim> {
  pending ??= fetch(new URL("./netsim.wasm", import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error(`netsim.wasm: HTTP ${response.status}`)
      return response.arrayBuffer()
    })
    .then(createNetsim)
  return pending
}
