import { describe, it, expect } from 'vitest'
import { claudeHook, codexHook, powershellLine, shellLine, type HookCommand } from '../src/infrastructure/providers/shared.js'

// One hook, rendered for each CLI and OS: no shell syntax beyond quoting, so
// the same data runs in sh, Git Bash, PowerShell — or no shell at all.

const cmd: HookCommand = {
  program: 'C:\\Users\\Jane Doe\\node.exe',
  args: ['C:\\app\\current\\dist\\turn-hook.js', "it's", '--json'],
}

describe('hook commands', () => {
  it('quotes what a POSIX shell would read, and nothing else', () => {
    expect(shellLine({ program: '/Users/Jane Doe/bin/node', args: ["it's", 'hook', '--config', '/x/config'] }))
      .toBe(`'/Users/Jane Doe/bin/node' 'it'\\''s' hook --config /x/config`)
  })

  it('calls a quoted program in PowerShell, quoting literally', () => {
    expect(powershellLine(cmd)).toBe(`& 'C:\\Users\\Jane Doe\\node.exe' 'C:\\app\\current\\dist\\turn-hook.js' 'it''s' '--json'`)
  })

  it('gives Claude Code on Windows the exec form, without a shell', () => {
    expect(claudeHook(cmd, 'win32', { timeout: 5 })).toEqual({ type: 'command', command: cmd.program, args: cmd.args, timeout: 5 })
    expect(claudeHook(cmd, 'darwin')).toEqual({ type: 'command', command: shellLine(cmd) })
  })

  it('gives Codex a PowerShell line on Windows, a shell line elsewhere', () => {
    expect(codexHook(cmd, 'win32')).toEqual({ type: 'command', command: powershellLine(cmd) })
    expect(codexHook(cmd, 'linux', { async: true })).toEqual({ type: 'command', command: shellLine(cmd), async: true })
  })
})
