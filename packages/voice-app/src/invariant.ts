/** Package invariant companion. @module @lgquan/dsh-voco/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'voco-invariant'
export const inject = ['invariants']
/** No runtime invariant: this package is a static patch-list carrier. */
const install: InvariantInstaller = () => {}
/** Register invariant ownership. @param ctx - runtime context. @returns disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@lgquan/dsh-voco', install))
