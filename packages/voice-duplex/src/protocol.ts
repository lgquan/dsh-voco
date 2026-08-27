/** Raw JSON protocol helpers for ByteDance Duplex. @module @wayneyu430227/dsh-voice-duplex/protocol */
import { Buffer } from 'node:buffer'
import {
  VoiceCommandCallId,
  VoiceTaskId,
  type TaskCommandCall,
  type TaskCommandResult,
  type VoiceConversationItem,
} from '@wayneyu430227/dsh-voice'

/** One provider JSON object before normalization. */
export type RawEvent = Record<string, unknown>

/** Result of validating one provider-native orchestration call. */
export type DecodedTaskCommand =
  | { readonly kind: 'call'; readonly call: TaskCommandCall }
  | { readonly kind: 'rejected'; readonly callId: VoiceCommandCallId; readonly result: TaskCommandResult }

const TASK_COMMAND_NAMES = new Set(['realtime_delegation', 'send_task_message', 'cancel_task'])

/**
 * Build the only function schemas exposed to a Duplex frontend Agent.
 * @returns fresh provider tool records.
 */
export function duplexTaskCommandTools(): RawEvent[] {
  return [
    {
      type: 'function',
      name: 'realtime_delegation',
      description: 'Delegate one clear request to the background dsh Agent and receive asynchronous status and completion messages.',
      parameters: objectSchema({
        input: stringSchema('Self-contained request for the background Agent.'),
        transcript_delta: stringSchema('Recent relevant voice transcript that resolves references in the request.'),
      }, ['input']),
    },
    {
      type: 'function',
      name: 'send_task_message',
      description: 'Send a correction or additional instruction to the exact running dsh task.',
      parameters: objectSchema({
        delegation_id: stringSchema('Delegation id returned by realtime_delegation.'),
        message: stringSchema('Correction or additional instruction.'),
      }),
    },
    {
      type: 'function',
      name: 'cancel_task',
      description: 'Cancel the exact running dsh task only after explicit user intent.',
      parameters: objectSchema({ delegation_id: stringSchema('Delegation id returned by realtime_delegation.') }),
    },
  ]
}

/**
 * Validate one Duplex function-call completion event.
 * @param event - raw provider event.
 * @returns valid calls and typed rejections for calls that have an id.
 */
export function decodeTaskCommandCalls(event: RawEvent): DecodedTaskCommand[] {
  if (event.type !== 'response.function_call_arguments.done') return []
  const items = Array.isArray(event.items) ? event.items : event.call_id === undefined ? [] : [event]
  return items.map((item) => {
    if (!isRecord(item)) throw new TypeError('Duplex function-call item must be an object')
    const rawCallId = requiredString(item.call_id, 'call_id')
    const callId = VoiceCommandCallId(rawCallId)
    const name = requiredString(item.name, 'name')
    if (!TASK_COMMAND_NAMES.has(name)) {
      return rejected(callId, `unsupported Duplex task command "${name}"`)
    }
    let args: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(typeof item.arguments === 'string' && item.arguments !== '' ? item.arguments : '{}')
      if (!isRecord(parsed)) throw new TypeError('arguments must be a JSON object')
      args = parsed
    } catch (error) {
      return rejected(callId, `invalid ${name} arguments: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return { kind: 'call', call: { id: callId, command: decodeCommand(name, args) } }
    } catch (error) {
      return rejected(callId, error instanceof Error ? error.message : String(error))
    }
  })
}

/**
 * Build a native Duplex function-call output item.
 * @param callId - provider call identity.
 * @param result - typed bridge result.
 * @returns conversation item accepted by `conversation.item.create`.
 */
export function taskCommandResultItem(callId: VoiceCommandCallId, result: TaskCommandResult): RawEvent {
  const output = result.kind === 'accepted'
    ? { kind: result.kind, delegation_id: result.taskId }
    : result
  return {
    role: 'tool',
    call_id: callId,
    content: [{ type: 'input_text', text: JSON.stringify(output) }],
  }
}

/** Build one historical text message accepted by `conversation.item.create`. */
export function conversationTextCreateItem(item: VoiceConversationItem): RawEvent {
  return {
    type: 'message',
    role: item.role,
    content: [{
      type: item.role === 'user' ? 'input_text' : 'output_text',
      text: item.text,
    }],
  }
}

/**
 * Build one in-place text replacement for a provider conversation item.
 * @param itemId - provider question identity.
 * @param text - complete replacement text, including any original transcript that must survive.
 * @returns item accepted by `conversation.item.update`.
 */
export function conversationTextUpdateItem(itemId: string, text: string): RawEvent {
  return {
    id: itemId,
    content: [{ type: 'input_text', text }],
  }
}

/**
 * Decode one provider frame as a JSON record.
 * @param frame - WebSocket frame.
 * @returns decoded record.
 */
export function decodeEvent(frame: Buffer | ArrayBuffer | Buffer[]): RawEvent {
  const text = Array.isArray(frame)
    ? Buffer.concat(frame).toString('utf8')
    : Buffer.isBuffer(frame) ? frame.toString('utf8') : Buffer.from(new Uint8Array(frame)).toString('utf8')
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Duplex server event must be a JSON object')
  return value as RawEvent
}

/**
 * Encode microphone PCM.
 * @param audio - PCM bytes.
 * @returns append event.
 */
export function audioAppend(audio: Uint8Array): RawEvent {
  return { type: 'input_audio_buffer.append', audio: Buffer.from(audio).toString('base64') }
}

/**
 * Read provider text from its compatible response fields.
 * @param event - raw event.
 * @returns trimmed text.
 */
export function eventText(event: RawEvent): string {
  for (const key of ['delta', 'transcript', 'text']) {
    const value = event[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * Read a nested provider error.
 * @param value - raw error.
 * @returns display message.
 */
export function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    const message = (value as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return value === undefined ? 'Duplex error' : JSON.stringify(value)
}

function decodeCommand(name: string, args: Record<string, unknown>): TaskCommandCall['command'] {
  switch (name) {
    case 'realtime_delegation': {
      assertKeys(args, ['input'], name, ['transcript_delta'])
      const transcriptDelta = args.transcript_delta === undefined
        ? undefined
        : requiredText(args.transcript_delta, 'transcript_delta')
      return {
        type: 'realtime_delegation',
        input: requiredText(args.input, 'input'),
        ...(transcriptDelta === undefined ? {} : { transcriptDelta }),
      }
    }
    case 'send_task_message':
      assertKeys(args, ['delegation_id', 'message'], name)
      return {
        type: 'send_task_message',
        taskId: VoiceTaskId(requiredText(args.delegation_id, 'delegation_id')),
        message: requiredText(args.message, 'message'),
      }
    case 'cancel_task':
      assertKeys(args, ['delegation_id'], name)
      return { type: 'cancel_task', taskId: VoiceTaskId(requiredText(args.delegation_id, 'delegation_id')) }
    default: throw new TypeError(`unsupported Duplex task command "${name}"`)
  }
}

function rejected(callId: VoiceCommandCallId, message: string): DecodedTaskCommand {
  return { kind: 'rejected', callId, result: { kind: 'rejected', code: 'invalid_command', message } }
}

function objectSchema(properties: Record<string, RawEvent>, required = Object.keys(properties)): RawEvent {
  return { type: 'object', additionalProperties: false, properties, required }
}

function stringSchema(description: string): RawEvent {
  return { type: 'string', minLength: 1, description }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`Duplex function call requires ${field}`)
  return value
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`)
  return value.trim()
}

function assertKeys(
  args: Record<string, unknown>,
  expected: readonly string[],
  name: string,
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(args).sort()
  const wanted = [...expected].sort()
  const allowed = new Set([...wanted, ...optional])
  if (wanted.some(key => !Object.hasOwn(args, key)) || actual.some(key => !allowed.has(key))) {
    const suffix = optional.length === 0 ? '' : `; optional ${[...optional].sort().join(', ')}`
    throw new TypeError(`${name} arguments must contain ${wanted.join(', ')}${suffix}`)
  }
}
