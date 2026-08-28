/** Package invariant companion. @module @flowingspring/dsh-voice-web/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'voice-web-invariant'
export const inject = ['invariants']
/** No runtime invariant: the WebSocket route registry owns uniqueness and teardown. */
const install: InvariantInstaller = () => {}
/** Register invariant ownership. @param ctx - runtime context. @returns disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@flowingspring/dsh-voice-web', install))
