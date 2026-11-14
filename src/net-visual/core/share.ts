// Scenario links. The whole scenario (parameters, seed, the learner's edits
// to packets) and the step are written into the URL hash, so a link replays
// the same run anywhere. Nothing is sent to a server.

export function encodeState(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function decodeState<T>(text: string): T | null {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return null
  }
}

/** Reads `#tool?s=...` for this tool, if present. */
export function readHash<T>(tool: string): T | null {
  if (typeof window === "undefined") return null
  const match = window.location.hash.match(new RegExp(`^#${tool}\\?s=([\\w-]+)`))
  return match ? decodeState<T>(match[1]) : null
}

export function linkFor(tool: string, value: unknown): string {
  const url = new URL(window.location.href)
  url.hash = `${tool}?s=${encodeState(value)}`
  return url.toString()
}
