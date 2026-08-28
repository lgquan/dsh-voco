import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../tsdown.client.ts'

/**
 * Internal workspace modules are bundled behind public dsh-voco subpaths.
 * DSH and third-party runtime packages stay external so their shared runtime
 * identities and normal dependency installation semantics are preserved.
 */
const serverPlugins: UserConfig = {
  name: '@flowingspring/dsh-voco/plugins',
  entry: {
    'plugins/llm-tool-call-compat': '../llm-tool-call-compat/src/index.ts',
    'plugins/voice': '../voice/src/index.ts',
    'plugins/voice-local': '../voice-local/src/index.ts',
    'plugins/voice-assistant': '../voice-assistant/src/index.ts',
    'plugins/voice-web': '../voice-web/src/index.ts',
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
  'lib/types/index.js',
  'lib/types/invariant.js',
], {
  companions: [serverPlugins],
  clientEntry: {
    source: '../ui-voice/src/client/index.ts',
    emitted: '../ui-voice/lib/types/client/index.js',
  },
})
