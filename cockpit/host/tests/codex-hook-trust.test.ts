import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexHookHash, hookEventKey, hooksSourcePath, trustOwnHooks, type CodexHooks } from '../src/infrastructure/providers/codex/hook-trust.js'
import { tableHeaders, tableLines } from '../src/infrastructure/providers/codex/toml.js'

// What `hooks/list` of codex-cli 0.172.0 reported as `currentHash` for these hooks.
const CODEX_HASHES: Array<[string, string | undefined, Record<string, unknown>, string]> = [
  // Shaped like the cockpit's own: a boot hook with a context limit, the async turn hook.
  ['SessionStart', undefined,
    { type: 'command', command: '/opt/cockpit/bin/node /opt/cockpit/app/mcp-server/dist/cli.js hook session-start --json', timeout: 15, additionalContextLimit: 20000 },
    'sha256:ada60e70ccb7a8dc485ff31b9d6d1d7c2d08ff0b3f2f5d37942d6c18793285da'],
  ['UserPromptSubmit', undefined,
    { type: 'command', command: '/opt/cockpit/bin/node /opt/cockpit/app/host/dist/turn-hook.js /opt/cockpit/codex-config/turn-hook.json', timeout: 5, async: true },
    'sha256:c42cdb37a47f439feaed66ff103817f041500009a3e5d3a60a48862bc5a2f71b'],
  ['SessionStart', undefined, { type: 'command', command: 'echo hi', timeout: 15 },
    'sha256:ef4545dfa2eddde0985dc3799305a823dd41385c5bc311ef275f93eb427df1ce'],
  // No timeout: Codex's default of 600 s is part of the hash.
  ['Stop', undefined, { type: 'command', command: 'echo a' },
    'sha256:f9b7a328de9c5845f5eed806f12f8f5adeba50ba82617690fd3f8ededeb12f90'],
  ['Stop', undefined, { type: 'command', command: 'echo b', timeout: 5 },
    'sha256:e63a70b14f7a9aa52cdfb8041216809d8cfbc75601d66df8c1c833c58a791b48'],
  // A matcher, a status message, quotes and a non-ASCII character.
  ['PreToolUse', 'Bash', { type: 'command', command: 'echo \'ü "q"\'', statusMessage: 'checking', timeout: 7 },
    'sha256:cb868a658514fd6d316016129f37fb6b755d5b682e54ebddbba2609674c088a4'],
  // Timeout 0 counts as 1.
  ['PostToolUse', undefined, { type: 'command', command: 'x', async: true, timeout: 0 },
    'sha256:f6d48c9f6f45f6e688370dc321fdfcbb27f04fbe81efc4df3ff619d65d1385a1'],
  // SessionEnd defaults to 1 s.
  ['SessionEnd', undefined, { type: 'command', command: 'echo end' },
    'sha256:45850818ac37352c413a1b5998816007fb7be904214afb35e02f4b66d14c787a'],
  ['PostToolUse', 'Bash', { type: 'command', command: 'p' },
    'sha256:30ddc6129d41f6f8a0198cab1b1a4088cf629f36de5c8adb5b2ea3e41d8b429a'],
  ['PermissionRequest', 'Bash', { type: 'command', command: 'q' },
    'sha256:bb43a95d92a09e4d524c1db04fa3ada610d8ae4b3eb8ca60a1ee4965b090400e'],
  ['SessionStart', 'startup', { type: 'command', command: 't' },
    'sha256:f1ed729612f05a1765b8659ff7e1dc8a57ae6d61cb32a0a8e1d6c4353d862fda'],
  // Codex drops a matcher on Stop.
  ['Stop', 'Bash', { type: 'command', command: 's' },
    'sha256:63fc69fb542a5d0940df0225d94ba51909d938cce7ef975e7e03666fdf14415f'],
]

const HOOKS_PATH = '/cockpit/codex-config/hooks.json'
const key = (rest: string) => `hooks.state."${HOOKS_PATH}:${rest}"`

const cockpitHooks = (bootCommand = 'node cli.js hook session-start --json'): CodexHooks => ({
  SessionStart: [
    { hooks: [{ type: 'command', command: bootCommand, timeout: 15, additionalContextLimit: 20000 }] },
    { hooks: [{ type: 'command', command: 'node cli.js hook project-block --json', timeout: 15, additionalContextLimit: 20000 }] },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'node turn-hook.js', timeout: 5, async: true }, { type: 'command', command: 'node cli.js hook stop', timeout: 15 }] }],
})

const hashOf = (config: string, rest: string) => /trusted_hash = "([^"]+)"/.exec((tableLines(config, key(rest)) ?? []).join('\n'))?.[1]

describe('Codex hook hash', () => {
  it.each(CODEX_HASHES)('is the one Codex reports (%s, matcher %s)', (event, matcher, handler, hash) => {
    expect(codexHookHash(event, matcher, handler)).toBe(hash)
  })

  it('names events as Codex does in a hook\'s key', () => {
    expect(hookEventKey('SessionStart')).toBe('session_start')
    expect(hookEventKey('UserPromptSubmit')).toBe('user_prompt_submit')
    expect(hookEventKey('Stop')).toBe('stop')
  })

  it('does not guess: a handler that is not a command, has a field it was not checked for, or a matcher on an unchecked event gets none', () => {
    expect(codexHookHash('Stop', undefined, { type: 'prompt', prompt: 'x' })).toBeNull()
    expect(codexHookHash('Stop', undefined, { type: 'command', command: 'x', shell: 'bash' })).toBeNull()
    expect(codexHookHash('UserPromptSubmit', 'x', { type: 'command', command: 'x' })).toBeNull()
  })
})

describe('trusting the cockpit\'s own hooks', () => {
  it('writes one trust table per hook, with its Codex hash', () => {
    const config = trustOwnHooks('model = "m"\n', HOOKS_PATH, cockpitHooks())
    expect(config.startsWith('model = "m"\n\n')).toBe(true)
    expect(tableHeaders(config)).toEqual([
      key('session_start:0:0'), key('session_start:1:0'), key('stop:0:0'), key('stop:0:1'),
    ])
    expect(hashOf(config, 'session_start:0:0')).toBe(codexHookHash('SessionStart', undefined, cockpitHooks().SessionStart[0].hooks[0]))
    expect(hashOf(config, 'stop:0:1')).toBe(codexHookHash('Stop', undefined, cockpitHooks().Stop[0].hooks[1]))
    expect(config).toContain(`[${key('stop:0:0')}]\ntrusted_hash = "sha256:`)
  })

  it('touches only its own file\'s entries: other hooks\' trust, folders and Codex\'s own state stay', () => {
    const before = [
      'model = "m"',
      '',
      '[projects."/work/a"]',
      'trust_level = "trusted"',
      '',
      '[hooks.state]',
      '',
      '[hooks.state."/work/a/.codex/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:project"',
      '',
      '[hooks.state."/cockpit/codex-config/hooks.json.bak:stop:0:0"]',
      'trusted_hash = "sha256:other-file"',
      '',
      '[tui]',
      'x = 1',
      '',
    ].join('\n')
    const after = trustOwnHooks(before, HOOKS_PATH, cockpitHooks())
    for (const kept of [
      '[projects."/work/a"]\ntrust_level = "trusted"',
      '[hooks.state."/work/a/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:project"',
      '[hooks.state."/cockpit/codex-config/hooks.json.bak:stop:0:0"]\ntrusted_hash = "sha256:other-file"',
      '[tui]\nx = 1',
      '[hooks.state]\n',
    ]) expect(after).toContain(kept)
    expect(tableHeaders(after).filter((h) => h.includes(`${HOOKS_PATH}:`))).toHaveLength(4)
  })

  it('is idempotent', () => {
    const once = trustOwnHooks('model = "m"\n', HOOKS_PATH, cockpitHooks())
    expect(trustOwnHooks(once, HOOKS_PATH, cockpitHooks())).toBe(once)
  })

  it('trusts a changed hook anew and drops the entries of hooks the file no longer has', () => {
    const before = trustOwnHooks('', HOOKS_PATH, cockpitHooks())
    const changed = cockpitHooks('node other-cli.js hook session-start --json')
    delete (changed as Record<string, unknown>).Stop
    const after = trustOwnHooks(before, HOOKS_PATH, changed)
    expect(hashOf(after, 'session_start:0:0')).toBe(codexHookHash('SessionStart', undefined, changed.SessionStart[0].hooks[0]))
    expect(hashOf(after, 'session_start:0:0')).not.toBe(hashOf(before, 'session_start:0:0'))
    expect(hashOf(after, 'session_start:1:0')).toBe(hashOf(before, 'session_start:1:0'))
    expect(tableHeaders(after)).toEqual([key('session_start:0:0'), key('session_start:1:0')])
  })

  it('keeps what else a hook\'s entry holds, such as the user switching it off, and finds it however Codex quoted it', () => {
    const before = `[hooks.state.'${HOOKS_PATH}:stop:0:1']\nenabled = false\ntrusted_hash = "sha256:old"\n`
    const after = trustOwnHooks(before, HOOKS_PATH, cockpitHooks())
    expect(after).not.toContain('sha256:old')
    expect(after).not.toContain(`'${HOOKS_PATH}`)
    expect(tableLines(after, key('stop:0:1'))?.filter(Boolean)).toEqual(['enabled = false', `trusted_hash = "${codexHookHash('Stop', undefined, cockpitHooks().Stop[0].hooks[1])}"`])
  })

  it('leaves a hook it cannot hash untrusted and keeps a trust Codex wrote for it', () => {
    const hooks: CodexHooks = { Stop: [{ hooks: [{ type: 'command', command: 'x', shell: 'bash' }] }] }
    const before = `[${key('stop:0:0')}]\ntrusted_hash = "sha256:by-codex"\n`
    expect(trustOwnHooks(before, HOOKS_PATH, hooks)).toBe(before)
    expect(trustOwnHooks('', HOOKS_PATH, hooks)).toBe('')
  })

  it('names hooks.json by its real path, as Codex does for a linked home', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-codex-hook-trust-'))
    try {
      mkdirSync(join(dir, 'real'))
      symlinkSync(join(dir, 'real'), join(dir, 'link'))
      expect(hooksSourcePath(join(dir, 'link'))).toBe(join(hooksSourcePath(join(dir, 'real'))))
      expect(hooksSourcePath(join(dir, 'link')).endsWith(join('real', 'hooks.json'))).toBe(true)
      expect(hooksSourcePath(join(dir, 'absent'))).toBe(join(dir, 'absent', 'hooks.json'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
