import * as cordis from '../../packages/ui-voice/node_modules/@deepseek-ai/cordis/lib/index.js'
import * as react from 'react'
import * as reactDom from '../../packages/ui-voice/node_modules/react-dom/index.js'
import * as jsxRuntime from 'react/jsx-runtime'
import * as zod from 'zod'
import * as clientStore from './dsh-client-store.ts'
import * as primitives from './dsh-client-ui-primitives.ts'
import * as uiSlots from '../../packages/ui-voice/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js'

interface ConversationModule {
  readonly ConversationNodeAssembler: new (...args: any[]) => any
}

let loaded: ConversationModule | undefined
const modules: Record<string, unknown> = {
  '@deepseek-ai/cordis': cordis,
  '@deepseek-ai/dsh-client-store': clientStore,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
  '@deepseek-ai/dsh-client-ui-slots': uiSlots,
  react,
  'react-dom': reactDom,
  'react/jsx-runtime': jsxRuntime,
  zod,
}

Object.assign(window, {
  __ModuleLoader__: {
    load(input: { factory: (require: (id: string) => unknown) => ConversationModule }) {
      loaded = input.factory((id) => {
        const dependency = modules[id]
        if (dependency === undefined) throw new Error(`unknown Conversation test dependency: ${id}`)
        return dependency
      })
    },
  },
})

await import('../../packages/ui-voice/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')

if (loaded === undefined) throw new Error('Conversation browser module did not register')

export const ConversationNodeAssembler = loaded.ConversationNodeAssembler
