import { defineConfig, type UserConfig } from 'tsdown'

const ID = '@huanlin/dsh-plugin-terminal-extension-wait-for'

const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
]

const libConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  external: HOST_EXTERNALS,
}

export default defineConfig([libConfig])
