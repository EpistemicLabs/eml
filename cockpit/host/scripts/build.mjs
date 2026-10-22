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
//   THIRD_PARTY_LICENSES.md                     — notices for the code bundled into dist/ and ui/
// The SQL files sit next to dist/ so core's `__dirname/../migrations` resolves the
// same way inside the bundle as it does in the workspace checkout.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeThirdPartyLicenses } from './third-party-licenses.mjs'

const require = createRequire(import.meta.url)
const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgRoot = (name) => path.dirname(require.resolve(`${name}/package.json`))

const server = pkgRoot('@engramprotocol/server')
const core = pkgRoot('@engramprotocol/core')
const frontend = pkgRoot('@engramprotocol/cockpit-frontend')

for (const p of ['dist', 'ui', 'migrations', 'THIRD_PARTY_LICENSES.md']) rmSync(path.join(HOST, p), { recursive: true, force: true })

const common = {
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  external: ['better-sqlite3'], logLevel: 'warning', sourcemap: false, metafile: true,
}
const bundles = [
  await build({ ...common, entryPoints: [path.join(server, 'dist', 'server.js')], outfile: path.join(HOST, 'dist', 'server.cjs') }),
  await build({ ...common, entryPoints: [path.join(core, 'dist', 'index.js')], outfile: path.join(HOST, 'dist', 'core.cjs') }),
]
// esbuild metafile inputs are relative to the working directory.
const bundledFiles = bundles.flatMap((result) => Object.keys(result.metafile.inputs).map((input) => path.resolve(input)))

const uiDist = path.join(frontend, 'dist')
if (!existsSync(path.join(uiDist, 'index.html'))) throw new Error(`frontend not built: ${uiDist}`)
// bundled-modules.json is written by the frontend's vite config for this build only, not served.
const UI_MODULES = path.join(uiDist, 'bundled-modules.json')
if (!existsSync(UI_MODULES)) throw new Error(`frontend build has no bundled-modules.json: ${uiDist}`)
bundledFiles.push(...JSON.parse(readFileSync(UI_MODULES, 'utf8')))
cpSync(uiDist, path.join(HOST, 'ui'), { recursive: true, filter: (src) => src !== UI_MODULES })
const licensed = writeThirdPartyLicenses(bundledFiles, path.join(HOST, 'THIRD_PARTY_LICENSES.md'))
cpSync(path.join(core, 'migrations'), path.join(HOST, 'migrations'), { recursive: true })

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(HOST, 'tsconfig.json')], { stdio: 'inherit' })
console.log(`eml-cockpit: dist/ ui/ migrations/ ready, THIRD_PARTY_LICENSES.md for ${licensed} packages`)
