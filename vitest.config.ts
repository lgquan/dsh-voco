import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-runtime/client': fromRoot('./tests/shims/dsh-client-runtime.client.ts'),
      '@lgquan/dsh-voice': fromRoot('./packages/voice/src/index.ts'),
      '@lgquan/dsh-voice-assistant': fromRoot('./packages/voice-assistant/src/index.ts'),
      '@lgquan/dsh-voice-web': fromRoot('./packages/voice-web/src/index.ts'),
      '@lgquan/dsh-client-ui-voice': fromRoot('./packages/ui-voice/src/index.ts'),
    },
  },
})
