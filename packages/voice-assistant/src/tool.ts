/** Agent-scoped tool for reporting one voice delegation. @module @lgquan/dsh-voice-assistant/tool */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { VoiceTaskId, type VoiceTaskEventType, type VoiceTaskMessageId } from '@lgquan/dsh-voice'

const VOICE_MESSAGE_SECTION_ORDER = 118

/** Validated input delivered by the Agent-scoped voice-message tool. */
export interface VoiceMessageInput {
  readonly delegationId: VoiceTaskId
  readonly channel: 'STATUS' | 'COMPLETE'
  readonly message: string
  readonly type?: VoiceTaskEventType
  readonly detail?: string
  readonly voiceHint?: string
}

/** Receipt returned to the coordinating text Agent. */
export interface VoiceMessageReceipt {
  readonly messageId: VoiceTaskMessageId
  readonly delivery: 'queued' | 'held_until_turn_end'
}

/**
 * Accept one backend message for the exact active voice delegation.
 * @param input - validated message and delegation identity.
 * @returns delivery receipt for the text Agent.
 */
export type VoiceMessageSender = (input: VoiceMessageInput) => VoiceMessageReceipt

/**
 * Install `send_voice_message` and its guidance into one delegated task Agent scope.
 * @param agentCtx - task-Agent context receiving the tool and guidance.
 * @param send - binding-owned message receiver.
 * @returns disposer that revokes both registrations.
 */
export function installVoiceMessageTool(agentCtx: Context, send: VoiceMessageSender): () => void {
  const disposeSection = agentCtx.systemPrompt.section({
    name: 'tool:send-voice-message',
    order: VOICE_MESSAGE_SECTION_ORDER,
    text: 'When a user message contains a <realtime_delegation> request or <realtime_delegation_update>, '
      + 'use send_voice_message with its delegation_id to keep the realtime voice assistant informed. '
      + 'Report structured events with type, detail, and voice_hint. Use progress for meaningful progress, '
      + 'warning or error for important conditions, question when user input is required, and result exactly '
      + 'once before a successful final turn ends. detail stays in the task trace; voice_hint is the natural '
      + 'conversational text shown in the Voice window and spoken aloud. Lead with the conclusion and adapt detail to the request: brief for simple outcomes, '
      + 'longer when complexity or the user requires it. Do not impose a character limit. Do not recite '
      + 'Markdown structure, code blocks, logs, command output, or exhaustive file lists; summarize those '
      + 'for speech while leaving the full report in the task UI. The voice assistant does not automatically '
      + 'see your transcript, tool output, or reasoning. '
      + 'A result is held until the turn actually succeeds. A question leaves the task waiting for a user reply. '
      + 'Reporting never ends your turn. Do not use '
      + 'this tool for ordinary requests without a realtime_delegation envelope.',
  })
  let disposeTool: () => void
  try {
    disposeTool = agentCtx.tools.register(defineTool({
      name: 'send_voice_message',
      description: 'Send a user-facing status or final result to the realtime voice assistant for the exact '
        + 'active delegation using type, detail, and voice_hint. Progress, warnings, errors, and questions '
        + 'may repeat when meaningful. result may be called once with a natural, conclusion-first spoken response whose detail adapts to the '
        + 'request without a fixed length cap. Summarize report-only formatting, code, logs, and file lists. '
        + 'COMPLETE is held until the Agent turn succeeds; it does '
        + 'not finish the turn. The voice assistant does not otherwise see this Agent transcript or tool output.',
      parameters: {
        delegation_id: {
          type: 'string',
          required: true,
          description: 'Exact delegation_id from the realtime_delegation request envelope.',
        },
        type: {
          type: 'string',
          enum: ['progress', 'result', 'warning', 'error', 'question'],
          description: 'Structured event type. Prefer this with detail and voice_hint.',
        },
        detail: {
          type: 'string',
          description: 'Complete technical or operational detail retained in the background task trace.',
        },
        voice_hint: {
          type: 'string',
          description: 'Natural spoken text shown verbatim in the Voice window and sent to TTS.',
        },
        channel: {
          type: 'string',
          enum: ['STATUS', 'COMPLETE'],
          description: 'Legacy compatibility field; use type instead.',
        },
        message: {
          type: 'string',
          description: 'Legacy compatibility field; use voice_hint instead.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            messageId: { type: 'string', required: true },
            delivery: {
              type: 'string',
              required: true,
              enum: ['queued', 'held_until_turn_end'],
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.delivery === 'queued'
            ? `voice status accepted as message ${value.messageId}`
            : `voice completion ${value.messageId} held until the turn succeeds`,
        }],
      },
      presentCall: args => ({
        card: 'generic',
        title: args.type === 'result' || args.channel === 'COMPLETE' ? 'Complete voice delegation' : 'Update voice delegation',
        kind: 'other',
        rawInput: args.detail ?? args.message ?? args.voice_hint,
      }),
      execute(args) {
        const type = args.type ?? (args.channel === 'COMPLETE' ? 'result' : 'progress')
        const message = (args.voice_hint ?? args.message ?? '').trim()
        const detail = (args.detail ?? args.message ?? message).trim()
        if (message === '') throw new Error('send_voice_message message must be non-empty')
        if (detail === '') throw new Error('send_voice_message detail must be non-empty')
        return Promise.resolve(send({
          delegationId: VoiceTaskId(args.delegation_id),
          channel: type === 'result' ? 'COMPLETE' : 'STATUS',
          message,
          type,
          detail,
          voiceHint: message,
        }))
      },
    }))
  } catch (error: unknown) {
    try {
      disposeSection()
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        'failed to register the voice-message tool and roll back its prompt guidance',
      )
    }
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [disposeTool, disposeSection]) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke voice-message tool and prompt registrations')
    }
  }
}
