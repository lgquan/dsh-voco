import type { UserConfig } from 'tsdown'
import { clientBundle } from './tsdown.client.ts'

/**
 * The repository root is the public @flowingspring/dsh-voco package.
 * Internal workspace packages remain source/build dependencies, while every
 * artifact shipped to npm is emitted into this package's root lib/ directory.
 */
const serverPlugins: UserConfig = {
  name: '@flowingspring/dsh-voco/plugins',
  entry: {
    'plugins/llm-tool-call-compat': 'packages/llm-tool-call-compat/src/index.ts',
    'plugins/voice': 'packages/voice/src/index.ts',
    'plugins/voice-local': 'packages/voice-local/src/index.ts',
    'plugins/voice-assistant': 'packages/voice-assistant/src/index.ts',
    'plugins/voice-web': 'packages/voice-web/src/index.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  noExternal: [/^@flowingspring\//],
}

export default clientBundle('@flowingspring/dsh-voco', [
  'packages/voice-app/src/index.ts',
  'packages/voice-app/src/invariant.ts',
], {
  companions: [serverPlugins],
  clientEntry: {
    source: 'packages/ui-voice/src/client/index.ts',
    emitted: 'packages/ui-voice/lib/types/client/index.js',
  },
})
