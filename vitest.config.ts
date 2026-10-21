import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@sparkelf/dsh-workbench-vault': fileURLToPath(new URL('./packages/workbench-vault/src/index.ts', import.meta.url)),
    },
  },
  // UI packages import their own `.module.css` from their entry point, so a test that pulls
  // in one component reaches a CSS file before any assertion runs. Node refuses that
  // extension because node_modules dependencies are externalized by default; inlining the
  // primitives package hands those imports to Vite instead. `css: false` keeps the
  // transform cheap, since the assertions read CSS as text rather than as a module.
  test: {
    css: false,
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
  },
})
