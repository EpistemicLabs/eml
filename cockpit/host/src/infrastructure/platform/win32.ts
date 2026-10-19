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
  // Authenticode checks are not wired up yet: the checksum is the check.
  verifyCodeSignature: async () => {},
}
