import type { Context } from '@deepseek-ai/cordis'

type ToolCallState = { id?: string; name?: string; type?: string }

/** Restore metadata omitted as empty strings by some OpenAI-compatible gateways. */
export function normalizeToolCallSseEvent(event: string, states: Map<number, ToolCallState>): string {
  if (!event.startsWith('data: ')) return event
  const payload = event.slice(6).trim()
  if (payload === '[DONE]') return event
  let value: unknown
  try { value = JSON.parse(payload) } catch { return event }
  if (typeof value !== 'object' || value === null) return event
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return event
  let changed = false
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    const delta = (choice as { delta?: unknown }).delta
    if (typeof delta !== 'object' || delta === null) continue
    const calls = (delta as { tool_calls?: unknown }).tool_calls
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (typeof call !== 'object' || call === null || typeof (call as { index?: unknown }).index !== 'number') continue
      const index = (call as { index: number }).index
      const state = states.get(index) ?? {}
      const id = (call as { id?: unknown }).id
      if (typeof id === 'string' && id.length > 0) state.id = id
      else if (state.id !== undefined && id === '') { (call as { id: string }).id = state.id; changed = true }
      const type = (call as { type?: unknown }).type
      if (typeof type === 'string' && type.length > 0) state.type = type
      else if (state.type !== undefined && type === '') { (call as { type: string }).type = state.type; changed = true }
      const fn = (call as { function?: unknown }).function
      if (typeof fn === 'object' && fn !== null) {
        const name = (fn as { name?: unknown }).name
        if (typeof name === 'string' && name.length > 0) state.name = name
        else if (state.name !== undefined && name === '') { (fn as { name: string }).name = state.name; changed = true }
      }
      states.set(index, state)
    }
  }
  return changed ? `data: ${JSON.stringify(value)}` : event
}

function wrapSseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const states = new Map<number, ToolCallState>()
  let pending = ''
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read()
      if (result.done) {
        pending += decoder.decode()
        if (pending.length > 0) controller.enqueue(encoder.encode(normalizeToolCallSseEvent(pending, states)))
        controller.close()
        return
      }
      pending += decoder.decode(result.value, { stream: true })
      const events = pending.split(/\r?\n\r?\n/)
      pending = events.pop() ?? ''
      if (events.length > 0) controller.enqueue(encoder.encode(events.map(event => normalizeToolCallSseEvent(event, states)).join('\n\n') + '\n\n'))
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

const INSTALLED = Symbol.for('lgquan.dsh-voco.tool-call-compat')

/** Install the gateway compatibility layer once for this Harness process. */
export function apply(_ctx?: Context): void {
  const global = globalThis as typeof globalThis & { [INSTALLED]?: boolean; fetch: typeof fetch }
  if (global[INSTALLED]) return
  const original = global.fetch.bind(globalThis)
  global.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const response = await original(input, init)
    if (!url.endsWith('/chat/completions') || response.body === null) return response
    const headers = new Headers(response.headers)
    // Rewritten SSE frames can have a different byte length than the gateway response.
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(wrapSseBody(response.body), { status: response.status, statusText: response.statusText, headers })
  }
  global[INSTALLED] = true
}

export const name = 'llm-tool-call-compat'
