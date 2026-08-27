import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-runtime/client': fromRoot('./tests/shims/dsh-client-runtime.client.ts'),
      '@wayneyu430227/dsh-voice': fromRoot('./packages/voice/src/index.ts'),
      '@wayneyu430227/dsh-voice-assistant': fromRoot('./packages/voice-assistant/src/index.ts'),
      '@wayneyu430227/dsh-voice-duplex': fromRoot('./packages/voice-duplex/src/index.ts'),
      '@wayneyu430227/dsh-voice-web': fromRoot('./packages/voice-web/src/index.ts'),
      '@wayneyu430227/dsh-client-ui-voice': fromRoot('./packages/ui-voice/src/index.ts'),
    },
  },
})
