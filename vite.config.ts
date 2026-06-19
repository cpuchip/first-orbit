/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Build stamp: the git short hash of the deployed commit, so the running page can
// declare exactly which build it is (GET /version is the deploy oracle). The
// Dockerfile sets VITE_GIT_SHA; local builds read git directly, then fall to 'dev'.
function buildSha(): string {
  const env = process.env.VITE_GIT_SHA
  if (env && env.trim()) return env.trim()
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}
const BUILD_SHA = buildSha()

export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
  },
  server: {
    port: 5173,
    // Same-origin /ws in code; in dev, proxy it to the Node game server on :8080.
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  plugins: [
    svelte(),
    {
      name: 'write-version-txt',
      apply: 'build',
      closeBundle() {
        try {
          writeFileSync(resolve(process.cwd(), 'dist/version.txt'), BUILD_SHA)
        } catch {
          /* dist may not exist on a failed build — ignore */
        }
      },
    },
  ],
  test: {
    include: ['**/*.test.ts'],
  },
})
