import { describe, expect, it } from 'vitest'
import { VoiceCommandCallId, VoiceTaskId } from '@wayneyu430227/dsh-voice'
import {
  audioAppend,
  conversationTextCreateItem,
  conversationTextUpdateItem,
  decodeEvent,
  decodeTaskCommandCalls,
  duplexTaskCommandTools,
  errorMessage,
  eventText,
  taskCommandResultItem,
} from '@wayneyu430227/dsh-voice-duplex'

describe('Duplex protocol migration', () => {
  it('encodes PCM and decodes provider records', () => {
    expect(audioAppend(new Uint8Array([1, 2, 3]))).toEqual({ type: 'input_audio_buffer.append', audio: 'AQID' })
    expect(decodeEvent(Buffer.from('{"type":"session.created"}'))).toEqual({ type: 'session.created' })
    expect(() => decodeEvent(Buffer.from('[]'))).toThrow('JSON object')
  })

  it('normalizes transcription and error fields', () => {
    expect(eventText({ delta: ' hello ' })).toBe('hello')
    expect(eventText({ transcript: ' world ' })).toBe('world')
    expect(errorMessage({ message: 'bad' })).toBe('bad')
  })

  it('declares only the three frontend orchestration tools', () => {
    expect(duplexTaskCommandTools().map(tool => tool.name)).toEqual([
      'realtime_delegation', 'send_task_message', 'cancel_task',
    ])
  })

  it('validates native function calls and encodes typed results', () => {
    const decoded = decodeTaskCommandCalls({
      type: 'response.function_call_arguments.done',
      items: [
        {
          call_id: 'call-1',
          name: 'realtime_delegation',
          arguments: '{"input":"inspect repo","transcript_delta":"the voice package"}',
        },
        { call_id: 'call-2', name: 'send_task_message', arguments: '{"delegation_id":"task-1","message":"focus tests"}' },
        { call_id: 'call-3', name: 'cancel_task', arguments: '{"delegation_id":"task-1"}' },
      ],
    })
    expect(decoded).toEqual([
      {
        kind: 'call',
        call: {
          id: VoiceCommandCallId('call-1'),
          command: { type: 'realtime_delegation', input: 'inspect repo', transcriptDelta: 'the voice package' },
        },
      },
      { kind: 'call', call: { id: VoiceCommandCallId('call-2'), command: { type: 'send_task_message', taskId: VoiceTaskId('task-1'), message: 'focus tests' } } },
      { kind: 'call', call: { id: VoiceCommandCallId('call-3'), command: { type: 'cancel_task', taskId: VoiceTaskId('task-1') } } },
    ])
    expect(taskCommandResultItem(VoiceCommandCallId('call-1'), {
      kind: 'accepted', taskId: VoiceTaskId('task-1'),
    })).toEqual({
      role: 'tool',
      call_id: 'call-1',
      content: [{ type: 'input_text', text: '{"kind":"accepted","delegation_id":"task-1"}' }],
    })
    expect(conversationTextUpdateItem('question-1', 'question plus observation')).toEqual({
      id: 'question-1',
      content: [{ type: 'input_text', text: 'question plus observation' }],
    })
  })

  it('encodes restored user and assistant text with provider-native content roles', () => {
    expect(conversationTextCreateItem({ role: 'user', text: '继续刚才的话题' })).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '继续刚才的话题' }],
    })
    expect(conversationTextCreateItem({ role: 'assistant', text: '好，我们继续。' })).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '好，我们继续。' }],
    })
  })

  it('returns an invalid-command result without admitting malformed arguments', () => {
    expect(decodeTaskCommandCalls({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'cancel_task',
      arguments: '{"delegation_id":""}',
    })).toEqual([{
      kind: 'rejected',
      callId: VoiceCommandCallId('call-1'),
      result: { kind: 'rejected', code: 'invalid_command', message: 'delegation_id must be a non-empty string' },
    }])
  })
})
