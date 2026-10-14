import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import * as path from 'node:path'

// The host serves the built dist/ in production. For `vite dev`, proxy the host's
// API + WS so the same-origin /api/brain, /api/pty and /ws/shell work.
const HOST = `http://127.0.0.1:${process.env.COCKPIT_PORT || 4318}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
