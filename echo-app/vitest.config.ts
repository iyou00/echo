import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Vitest runs inside Electron's Node runtime so native SQLite matches the app.
    // Thread workers exit cleanly on Windows; fork workers regularly linger after passing.
    pool: 'threads',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
