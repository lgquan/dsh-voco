/** Package invariant companion. @module @flowingspring/dsh-voice/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'voice-invariant'
export const inject = ['invariants']
/** No runtime invariant: selection and session ownership are checked on every public operation. */
const install: InvariantInstaller = () => {}
/** Register the package invariant owner. @param ctx - runtime context. @returns disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@flowingspring/dsh-voice', install))
