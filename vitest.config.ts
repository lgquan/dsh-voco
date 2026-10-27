import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-store': fromRoot('./tests/shims/dsh-client-store.ts'),
      '@deepseek-ai/dsh-client-ui-conversation/client': fromRoot('./tests/shims/dsh-client-ui-conversation.client.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': fromRoot('./tests/shims/dsh-client-ui-primitives.ts'),
      '@flowingspring/dsh-voice': fromRoot('./packages/voice/src/index.ts'),
      '@flowingspring/dsh-voice-assistant': fromRoot('./packages/voice-assistant/src/index.ts'),
      '@flowingspring/dsh-voice-web': fromRoot('./packages/voice-web/src/index.ts'),
      '@flowingspring/dsh-client-ui-voice': fromRoot('./packages/ui-voice/src/index.ts'),
    },
  },
})
