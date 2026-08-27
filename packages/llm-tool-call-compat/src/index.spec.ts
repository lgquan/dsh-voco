import { describe, expect, it } from 'vitest'
import { normalizeToolCallSseEvent } from './index.js'

describe('normalizeToolCallSseEvent', () => {
  it('restores empty metadata from the first tool-call delta', () => {
    const states = new Map<number, { id?: string; name?: string; type?: string }>()
    const first = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"glob","arguments":""}}]}}]}'
    const second = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","type":"","function":{"name":"","arguments":"{\\"pattern\\":\\"*.md\\"}"}}]}}]}'
    expect(normalizeToolCallSseEvent(first, states)).toBe(first)
    expect(JSON.parse(normalizeToolCallSseEvent(second, states).slice(6))).toMatchObject({
      choices: [{ delta: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'glob' } }] } }],
    })
  })

  it('does not rewrite ordinary text events', () => {
    const event = 'data: {"choices":[{"delta":{"content":"hello"}}]}'
    expect(normalizeToolCallSseEvent(event, new Map())).toBe(event)
  })
})
