import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectOwnerOnly } from './helpers/owner-only.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-brain-space-test-'))
process.env.EML_COCKPIT_HOME = home

const TOKEN = 'eml_testprefix_testsecret'
const HOOK_TOKEN = 'hooktoken0123456789'
const HOOK_URL = 'http://127.0.0.1:4318/api/hook'
const SPACE_ID = 'fe2dcdfb-0000-4bb3-a3b4-d5261f93e165'



describe('brain spaces', () => {
  let mods: {
    writeIsolationFiles: typeof import('../src/infrastructure/providers/claude/isolation.js')['writeIsolationFiles']
    openBrainSpace: typeof import('../src/brain-space.js')['openBrainSpace']
    BrainSpaces: typeof import('../src/brain-space.js')['BrainSpaces']
    shellLine: typeof import('../src/infrastructure/providers/shared.js')['shellLine']
    TITLE_COMMAND: string
    CONFIG_DIR: string
    EML_HOOK_DIR: string
  }

  beforeAll(async () => {
    const isolation = await import('../src/infrastructure/providers/claude/isolation.js')
    const space = await import('../src/brain-space.js')
    const paths = await import('../src/paths.js')
    const { shellLine } = await import('../src/infrastructure/providers/shared.js')
    const { TITLE_COMMAND } = await import('../src/session-greeting.js')
    mods = { ...isolation, ...space, shellLine, TITLE_COMMAND, CONFIG_DIR: paths.CONFIG_DIR, EML_HOOK_DIR: paths.EML_HOOK_DIR }
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('removes the pre-spaces files that carried the token, and the host\'s hooks from the user settings.json', () => {
    mkdirSync(mods.CONFIG_DIR, { recursive: true })
    mkdirSync(mods.EML_HOOK_DIR, { recursive: true })
    const settings = join(mods.CONFIG_DIR, 'settings.json')
    const legacy = [join(mods.CONFIG_DIR, 'mcp.json'), join(mods.EML_HOOK_DIR, 'config'), join(mods.CONFIG_DIR, 'hook-curl.conf')]
    for (const file of legacy) writeFileSync(file, 'stale')
    // What the host wrote there before spaces: its EML hooks naming the cli.js of the version
    // installed back then (gone after an update) and the removed eml/config, and the turn-state
    // curl hooks — with the token in the URL (≤ 0.17.1) or via hook-curl.conf (0.17.2, 0.17.3).
    const staleCli = join(mods.CONFIG_DIR, '..', 'app', 'versions', '0.17.3', 'node_modules', '@engramprotocol', 'mcp-server', 'dist', 'cli.js')
    const emlCommand = (hook: string) => ({ type: 'command', command: `'/usr/bin/node' '${staleCli}' hook ${hook} --config '${join(mods.EML_HOOK_DIR, 'config')}'`, timeout: 15 })
    const curlOld = { type: 'command', command: "curl -sS -m 3 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:4317/api/hook?k=0123456789abcdef' >/dev/null 2>&1 || true", timeout: 5, async: true }
    const curlNew = { type: 'command', command: `curl -sS -m 3 -K '${join(mods.CONFIG_DIR, 'hook-curl.conf')}' -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:4317/api/hook' >/dev/null 2>&1 || true`, timeout: 5, async: true }
    // What Claude Code wrote itself since: the model, a permission, a hook of its own — one in its
    // own entry, one appended to the host's matcher group (as /hooks does).
    const ownCommand = { type: 'command', command: 'echo done' }
    writeFileSync(settings, JSON.stringify({
      model: 'opus',
      skipDangerousModePermissionPrompt: true,
      permissions: { allow: ['Bash(git status)'] },
      hooks: {
        SessionStart: [{ hooks: [emlCommand('session-start')] }],
        UserPromptSubmit: [{ hooks: [curlOld] }, { hooks: [emlCommand('user-prompt-submit')] }],
        Stop: [{ hooks: [curlNew, ownCommand] }, { matcher: 'x', hooks: [ownCommand] }],
        Notification: [{ hooks: [curlNew] }],
      },
    }), { mode: 0o600 })

    const isolation = mods.writeIsolationFiles(HOOK_URL, HOOK_TOKEN)

    expect(isolation.configDir).toBe(mods.CONFIG_DIR)
    expect(readFileSync(isolation.turnHookConfig, 'utf8')).toContain(HOOK_TOKEN)
    for (const file of legacy) expect(existsSync(file)).toBe(false)
    // The host's commands are gone, Claude Code's own settings and hooks stay, the mode is kept.
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
      model: 'opus',
      skipDangerousModePermissionPrompt: true,
      permissions: { allow: ['Bash(git status)'] },
      hooks: { Stop: [{ hooks: [ownCommand] }, { matcher: 'x', hooks: [ownCommand] }] },
    })
    expectOwnerOnly(settings)

    // A file holding nothing but the host's own writes goes entirely.
    writeFileSync(settings, JSON.stringify({ skipDangerousModePermissionPrompt: true, hooks: { SessionStart: [{ hooks: [emlCommand('session-start')] }] } }))
    mods.writeIsolationFiles(HOOK_URL, HOOK_TOKEN)
    expect(existsSync(settings)).toBe(false)

    // A settings.json Claude Code wrote itself is left untouched, byte for byte — so is one that is not JSON.
    for (const own of [JSON.stringify({ permissions: { allow: ['Bash(git status)'] }, hooks: { Stop: [{ hooks: [ownCommand] }] } }), 'null', '{ not json']) {
      writeFileSync(settings, own)
      mods.writeIsolationFiles(HOOK_URL, HOOK_TOKEN)
      expect(readFileSync(settings, 'utf8')).toBe(own)
    }
  })

  it('gives a space its own session files, owner-only, with the token only in env and the hook config', () => {
    const isolation = mods.writeIsolationFiles(HOOK_URL, HOOK_TOKEN)
    const space = mods.openBrainSpace({
      id: SPACE_ID, name: 'Main', brainName: 'atlas', main: true, url: 'http://127.0.0.1:60000', token: TOKEN,
      turnHookConfig: isolation.turnHookConfig,
    })

    expect(space.files.mcpConfig).toBe(join(mods.CONFIG_DIR, 'spaces', SPACE_ID, 'mcp.json'))
    expect(space.files.settings).toBe(join(mods.CONFIG_DIR, 'spaces', SPACE_ID, 'settings.json'))
    expect(space.files.emlConfig).toBe(join(mods.EML_HOOK_DIR, 'spaces', SPACE_ID, 'config'))
    for (const file of Object.values(space.files)) expectOwnerOnly(file)

    const mcp = JSON.parse(readFileSync(space.files.mcpConfig, 'utf8'))
    expect(mcp.mcpServers.eml_brain.env).toEqual({ EML_API_URL: 'http://127.0.0.1:60000', EML_API_TOKEN: TOKEN })
    expect(mcp.mcpServers.eml_brain.args.join(' ')).not.toContain(TOKEN)

    const settings = readFileSync(space.files.settings, 'utf8')
    expect(settings).not.toContain(TOKEN)
    expect(settings).not.toContain(HOOK_TOKEN)
    // The EML hooks read this space's config, the turn-state hooks the shared turn-hook config.
    // A path as a hook names it: bare in Claude Code's exec form (Windows), shell-quoted elsewhere.
    const quoted = (file: string) => (process.platform === 'win32' ? file : mods.shellLine({ program: file, args: [] }))
    const line = (hook: { command: string; args?: string[] }) => [hook.command, ...(hook.args ?? [])].join(' ')
    const hooks = JSON.parse(settings).hooks
    expect(line(hooks.SessionStart[0].hooks[0])).toContain(`--config ${quoted(space.files.emlConfig)}`)
    expect(line(hooks.Stop[0].hooks[0])).toContain(quoted(isolation.turnHookConfig))
    // The project block: a second SessionStart command for every source (no matcher);
    // the reminder then drops its working-directory guess.
    expect(hooks.SessionStart).toHaveLength(2)
    expect(hooks.SessionStart[1].matcher).toBeUndefined()
    expect(line(hooks.SessionStart[1].hooks[0])).toContain(`hook project-block --config ${quoted(space.files.emlConfig)}`)
    expect(hooks.UserPromptSubmit).toHaveLength(2)
    expect(line(hooks.UserPromptSubmit[1].hooks[0])).toMatch(/user-prompt-submit .*--no-cwd-nudge$/)

    expect(readFileSync(space.files.emlConfig, 'utf8')).toContain(`EML_API_TOKEN=${TOKEN}`)

    // A greeted session names itself without a permission prompt: exactly the greeting's command is allowed.
    expect(JSON.parse(settings).permissions.allow).toEqual([`Bash(${mods.TITLE_COMMAND} *)`])
  })

  it('resolves a space by id and falls back to main', () => {
    const isolation = mods.writeIsolationFiles(HOOK_URL, HOOK_TOKEN)
    const open = (id: string, name: string) => mods.openBrainSpace({
      id, name, brainName: name, main: true, url: 'http://127.0.0.1:60000', token: TOKEN,
      turnHookConfig: isolation.turnHookConfig,
    })
    const main = open(SPACE_ID, 'Main')
    const spaces = new mods.BrainSpaces(main)

    expect(spaces.list().map((s) => s.name)).toEqual(['Main'])
    expect(spaces.get(SPACE_ID)).toBe(main)
    expect(spaces.resolve(SPACE_ID)).toBe(main)
    expect(spaces.resolve(undefined)).toBe(main)
    expect(spaces.resolve('no-such-space')).toBe(main)
  })
})
