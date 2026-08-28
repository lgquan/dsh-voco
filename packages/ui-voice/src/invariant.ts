/** Package invariant companion. @module @flowingspring/dsh-client-ui-voice/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'client-ui-voice-invariant'
export const inject = ['invariants']
/** No runtime invariant: the browser slot registration owns no cross-plugin mutable state. */
const install: InvariantInstaller = () => {}
/** Register invariant ownership. @param ctx - runtime context. @returns disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@flowingspring/dsh-client-ui-voice', install))
