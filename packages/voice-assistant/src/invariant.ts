/** Package invariant companion. @module @lgquan/dsh-voice-assistant/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'voice-assistant-invariant'
export const inject = ['invariants']
/** No runtime invariant: exact task-to-turn ownership is checked against live claimed-message events. */
const install: InvariantInstaller = () => {}
/** Register invariant ownership. @param ctx - runtime context. @returns disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@lgquan/dsh-voice-assistant', install))
