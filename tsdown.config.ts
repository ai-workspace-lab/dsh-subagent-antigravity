import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'lib',
  dts: true,
  sourcemap: true,
  clean: true,
  unbundle: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: [/^@deepseek-ai\//],
})
