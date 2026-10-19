import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Platform } from '../../domain/platform.js'
import { archKey, detached, runFile } from './common.js'

export const win32: Platform = {
  os: 'win32',
  exe: (name) => (name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`),
  runtimeKey: () => `win32-${archKey()}`,
  // Without SystemRoot, Node and Rust binaries fail at crypto and DNS; the
  // rest is where Windows programs find the user's folders, temp and tools.
  sessionEnvKeys: [
    'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS',
    'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
    // Claude Code on Windows runs its shell through Git Bash.
    'CLAUDE_CODE_GIT_BASH_PATH',
  ],
  // Windows programs don't read LANG.
  fallbackLang: null,
  // Not `start`: cmd would read the & in a URL's query as a command separator.
  openUrl: (url) => detached('rundll32', ['url.dll,FileProtocolHandler', url]),
  // explorer exits 1 even when it opened the window.
  revealFile: (file) => runFile('explorer.exe', [`/select,${file}`]).catch(() => {}),
  switchDirLink(target, link) {
    // A junction can't be renamed over another: unlink (the junction only, never
    // what it points at), then create. A crash in between leaves no link, which
    // the runtime reads as "damaged" and repairs on the next start.
    try { fs.unlinkSync(link) } catch { /* not there */ }
    fs.symlinkSync(path.resolve(target), link, 'junction')
  },
  // A file symlink needs admin rights or Developer Mode.
  linksFiles: false,
  minimalEnv() {
    const env: Record<string, string> = {}
    for (const key of ['SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT']) {
      const value = process.env[key]
      if (value) env[key] = value
    }
    const root = env.SystemRoot ?? 'C:\\Windows'
    env.PATH = [path.join(root, 'System32'), root].join(path.delimiter)
    return env
  },
  tarBin: () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'),
  // npm.cmd can't be started without a shell: run npm's own script with this node.
  npm: () => ({ program: process.execPath, args: [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] }),
  toolDirs: [],
  // Authenticode checks are not wired up yet: the checksum is the check.
  verifyCodeSignature: async () => {},
}
