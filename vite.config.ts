import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// One id per build, baked into the bundle and written to /version.json, so that tabs left open for
// days can tell a newer version was deployed (src/lib/version.ts). Deploys run from the CLI without
// .git, so a timestamp stands in for a commit hash.
const BUILD_ID = String(Date.now())

const versionFile: Plugin = {
  name: 'version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: BUILD_ID }) })
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), versionFile],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  test: {
    environment: 'node',
  },
})
