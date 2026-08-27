import * as cordis from '../../packages/ui-voice/node_modules/@deepseek-ai/cordis/lib/index.js'
import * as uiSlots from '../../packages/ui-voice/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js'

interface LoaderModule {
  readonly ConversationNodeAssembler: new (...args: any[]) => any
  readonly createSnapshotStore: (...args: any[]) => any
}

let loaded: LoaderModule | undefined
const modules: Record<string, unknown> = {
  '@deepseek-ai/cordis': cordis,
  '@deepseek-ai/dsh-client-ui-slots': uiSlots,
}

Object.assign(window, {
  __ModuleLoader__: {
    load(input: { factory: (require: (id: string) => unknown) => LoaderModule }) {
      loaded = input.factory((id) => {
        const dependency = modules[id]
        if (dependency === undefined) throw new Error(`unknown client-runtime test dependency: ${id}`)
        return dependency
      })
    },
  },
})

await import('../../packages/ui-voice/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js')

if (loaded === undefined) throw new Error('dsh-client-runtime browser module did not register')

export const ConversationNodeAssembler = loaded.ConversationNodeAssembler
export const createSnapshotStore = loaded.createSnapshotStore
