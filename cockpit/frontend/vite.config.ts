import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { createRequire } from 'node:module'
import * as path from 'node:path'

const require = createRequire(import.meta.url)

// Lists the source files of every module in the build (JS and CSS) in dist/bundled-modules.json; the
// eml-cockpit build reads it for THIRD_PARTY_LICENSES.md (cockpit/host/scripts/third-party-licenses.mjs).
// Tailwind generates CSS from its own sources (preflight, utilities) without a module for them, so it
// is listed explicitly.
function bundledModules(): Plugin {
  return {
    name: 'bundled-modules',
    apply: 'build',
    generateBundle() {
      const files = new Set([require.resolve('tailwindcss/package.json')])
      for (const id of this.getModuleIds()) if (!id.startsWith('\0')) files.add(id.split('?')[0])
      this.emitFile({ type: 'asset', fileName: 'bundled-modules.json', source: JSON.stringify([...files].sort()) })
    },
  }
}

// The host serves the built dist/ in production. For `vite dev`, proxy the host's
// API + WS so the same-origin /api/brain, /api/pty and /ws/shell work.
const HOST = `http://127.0.0.1:${process.env.COCKPIT_PORT || 4318}`

export default defineConfig({
  plugins: [react(), tailwindcss(), bundledModules()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    proxy: {
      // The host only accepts secret-changing writes from its own origin.
      '/api': {
        target: HOST,
        configure: (proxy) => proxy.on('proxyReq', (req) => { if (req.getHeader('origin')) req.setHeader('origin', HOST) }),
      },
      '/ws': { target: HOST, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
