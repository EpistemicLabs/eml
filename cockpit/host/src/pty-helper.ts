import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * node-pty ships prebuilt `spawn-helper` binaries, but npm does not always
 * preserve their execute bit on extract → pty.spawn dies with "posix_spawnp
 * failed" (proven real in the isolation spike). Self-heal: ensure every prebuilt
 * helper is +x before the first spawn. Must run after every npm install.
 */
export function ensurePtyHelperExecutable(): void {
  const require = createRequire(import.meta.url)
  let ptyPkgDir: string
  try {
    ptyPkgDir = path.dirname(require.resolve('node-pty/package.json'))
  } catch {
    return // node-pty not resolvable here; spawn will surface the real error
  }
  const prebuilds = path.join(ptyPkgDir, 'prebuilds')
  if (!fs.existsSync(prebuilds)) return
  for (const platform of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, 'spawn-helper')
    try {
      if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) {
        fs.chmodSync(helper, 0o755)
      }
    } catch { /* best-effort */ }
  }
}
