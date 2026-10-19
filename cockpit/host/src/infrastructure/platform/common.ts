import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Platform } from '../../domain/platform.js'

/** Helpers the adapters share; posixBase is what macOS and Linux have in common. */

export const archKey = (): 'arm64' | 'x64' => {
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch
  throw new Error(`unsupported architecture: ${process.arch}`)
}

export const runFile = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
})

export const detached = (cmd: string, args: string[]) => {
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref() } catch { /* headless */ }
}

export const posixBase: Pick<Platform, 'exe' | 'sessionEnvKeys' | 'switchDirLink' | 'linksFiles' | 'minimalEnv' | 'tarBin' | 'npm' | 'toolDirs'> = {
  exe: (name) => name,
  sessionEnvKeys: [],
  switchDirLink(target, link) {
    const tmp = path.join(path.dirname(link), `.${path.basename(link)}-${randomBytes(4).toString('hex')}`)
    fs.symlinkSync(path.relative(path.dirname(link), target), tmp)
    fs.renameSync(tmp, link)
  },
  linksFiles: true,
  minimalEnv: () => ({ PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' }),
  // The npm next to this node (a launchd service's PATH may not have it), else PATH's.
  npm: () => {
    const beside = path.join(path.dirname(process.execPath), 'npm')
    return { program: fs.existsSync(beside) ? beside : 'npm', args: [] }
  },
  toolDirs: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'],
  // /bin/tar on a Linux without a merged /usr.
  tarBin: () => ['/usr/bin/tar', '/bin/tar'].find((bin) => fs.existsSync(bin)) ?? '/usr/bin/tar',
}

export const isMuslLinux = (): boolean => {
  try { return fs.readdirSync('/lib').some((n) => n.startsWith('ld-musl')) } catch { return false }
}
