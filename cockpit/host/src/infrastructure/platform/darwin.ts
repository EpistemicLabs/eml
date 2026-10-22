import { execFile } from 'node:child_process'
import type { Platform } from '../../domain/platform.js'
import { archKey, detached, posixBase, runFile } from './common.js'

const output = (cmd: string, args: string[]) => new Promise<{ code: number; stderr: string }>((resolve) => {
  execFile(cmd, args, (err, _stdout, stderr) => resolve({ code: !err ? 0 : typeof err.code === 'number' ? err.code : 1, stderr: String(stderr) }))
})

export const darwin: Platform = {
  ...posixBase,
  os: 'darwin',
  runtimeKey: () => `darwin-${archKey()}`,
  // macOS pbcopy, which Claude Code copies through, reads non-UTF-8 input as Mac Roman.
  fallbackLang: 'en_US.UTF-8',
  openUrl: (url) => detached('open', [url]),
  revealFile: (file) => runFile('open', ['-R', file]),
  async verifyCodeSignature(bin, teamId, publisher) {
    const verify = await output('/usr/bin/codesign', ['--verify', '--strict', bin])
    if (verify.code !== 0) throw new Error(`code signature invalid: ${verify.stderr.trim().slice(0, 200)}`)
    const info = await output('/usr/bin/codesign', ['-dv', bin])
    if (!info.stderr.includes(`TeamIdentifier=${teamId}`)) throw new Error(`binary is not signed by ${publisher}`)
  },
}
