#!/usr/bin/env node
// Build the eml-cockpit package: bundle the private building blocks (server, core)
// into dist/, copy the built frontend and the migrations next to it, compile the host.
//
// Layout produced (everything the published package needs):
//   dist/index.js     host entry (bin)          — tsc, ESM
//   dist/server.cjs   brain server + core       — esbuild, CJS, better-sqlite3 external
//   dist/core.cjs     core (provisioning)       — esbuild, CJS, better-sqlite3 external
//   ui/               frontend build            — copied from ../frontend/dist
//   migrations/       brain + control SQL       — copied from packages/core/migrations
// The SQL files sit next to dist/ so core's `__dirname/../migrations` resolves the
// same way inside the bundle as it does in the workspace checkout.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgRoot = (name) => path.dirname(require.resolve(`${name}/package.json`))

const server = pkgRoot('@engramprotocol/server')
const core = pkgRoot('@engramprotocol/core')
const frontend = pkgRoot('@engramprotocol/cockpit-frontend')

for (const p of ['dist', 'ui', 'migrations']) rmSync(path.join(HOST, p), { recursive: true, force: true })

const common = {
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  external: ['better-sqlite3'], logLevel: 'warning', sourcemap: false,
}
await build({ ...common, entryPoints: [path.join(server, 'dist', 'server.js')], outfile: path.join(HOST, 'dist', 'server.cjs') })
await build({ ...common, entryPoints: [path.join(core, 'dist', 'index.js')], outfile: path.join(HOST, 'dist', 'core.cjs') })

const uiDist = path.join(frontend, 'dist')
if (!existsSync(path.join(uiDist, 'index.html'))) throw new Error(`frontend not built: ${uiDist}`)
cpSync(uiDist, path.join(HOST, 'ui'), { recursive: true })
cpSync(path.join(core, 'migrations'), path.join(HOST, 'migrations'), { recursive: true })

execFileSync(require.resolve('typescript/bin/tsc'), ['-p', path.join(HOST, 'tsconfig.json')], { stdio: 'inherit' })
console.log('eml-cockpit: dist/ ui/ migrations/ ready')
