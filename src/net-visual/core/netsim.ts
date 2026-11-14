// The boundary to the Rust models. The module exports three functions and
// imports nothing: nv_alloc, nv_free and nv_call (JSON in, JSON out).
// This file uses only erasable TypeScript so Node can run it in tests.

interface Exports {
  memory: WebAssembly.Memory
  nv_alloc(len: number): number
  nv_free(pointer: number, len: number): void
  nv_call(pointer: number, len: number): number
}

export interface Netsim {
  call<T>(tool: string, op: string, params?: unknown): T
}

export class NetsimError extends Error {}

export async function createNetsim(bytes: BufferSource): Promise<Netsim> {
  const { instance } = await WebAssembly.instantiate(bytes, {})
  const ex = instance.exports as unknown as Exports
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  return {
    call<T>(tool: string, op: string, params?: unknown): T {
      const request = encoder.encode(JSON.stringify({ tool, op, params: params ?? null }))
      const input = ex.nv_alloc(request.length)
      new Uint8Array(ex.memory.buffer, input, request.length).set(request)
      const output = ex.nv_call(input, request.length)
      ex.nv_free(input, request.length)
      const length = new DataView(ex.memory.buffer).getUint32(output, true)
      const text = decoder.decode(new Uint8Array(ex.memory.buffer, output + 4, length))
      ex.nv_free(output, length + 4)
      const reply = JSON.parse(text) as { ok?: T; error?: string }
      if (reply.error !== undefined) throw new NetsimError(reply.error)
      return reply.ok as T
    },
  }
}
