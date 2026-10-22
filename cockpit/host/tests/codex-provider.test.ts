import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AgentProvider, SessionSpace } from '../src/domain/agent-provider.js'
import { hasTable, removeTables, setTopLevelKey, tableKey, tomlString, upsertTables } from '../src/infrastructure/providers/codex/toml.js'
import { platform } from '../src/infrastructure/platform/index.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-codex-provider-test-'))
process.env.EML_COCKPIT_HOME = home
const codexHome = join(home, 'codex-config')
const BRAIN_TOKEN = 'eml_testprefix_testsecret'
const HOOK_TOKEN = '0123456789abcdef'

describe('config.toml tables', () => {
  it('replaces managed tables and leaves everything else as Codex wrote it', () => {
    const before = [
      'model = "some-model"',
      '',
      '[mcp_servers.eml_brain]',
      'command = "old"',
      '',
      '[mcp_servers.eml_brain.env]',
      'EML_API_URL = "http://old"',
      '',
      '[tui]',
      'screen_reader_detection_done = true',
      '',
      '[hooks.state."/x/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:abc"',
      '',
    ].join('\n')
    const after = upsertTables(before, [
      { header: 'mcp_servers.eml_brain', lines: ['command = "node"'] },
      { header: 'mcp_servers.eml_brain.env', lines: ['EML_API_URL = "http://new"'] },
    ])
    expect(after).not.toContain('old')
    expect(after).toContain('model = "some-model"\n')
    expect(after).toContain('[tui]\nscreen_reader_detection_done = true')
    expect(after).toContain('[hooks.state."/x/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"')
    expect(after).toContain('[mcp_servers.eml_brain]\ncommand = "node"\n\n[mcp_servers.eml_brain.env]\nEML_API_URL = "http://new"\n')
    expect(upsertTables(after, [
      { header: 'mcp_servers.eml_brain', lines: ['command = "node"'] },
      { header: 'mcp_servers.eml_brain.env', lines: ['EML_API_URL = "http://new"'] },
    ])).toBe(after)
  })

  it('sets a top-level key above the first table, once', () => {
    expect(setTopLevelKey('', 'check_for_update_on_startup', 'false')).toBe('check_for_update_on_startup = false\n')
    const withTable = setTopLevelKey('model = "m"\n\n[tui]\nx = 1\n', 'check_for_update_on_startup', 'false')
    expect(withTable).toBe('check_for_update_on_startup = false\nmodel = "m"\n\n[tui]\nx = 1\n')
    expect(setTopLevelKey(withTable, 'check_for_update_on_startup', 'false')).toBe(withTable)
    expect(setTopLevelKey('check_for_update_on_startup = true\n[tui]\n', 'check_for_update_on_startup', 'false'))
      .toBe('check_for_update_on_startup = false\n\n[tui]\n')
  })

  it('finds a table however Codex quoted its key', () => {
    const header = `projects.${tomlString('/work/a "b"\\c')}`
    expect(tableKey(header)).toEqual(['projects', '/work/a "b"\\c'])
    expect(tableKey(`projects . '/work/a "b"\\c'`)).toEqual(['projects', '/work/a "b"\\c'])
    expect(tableKey('mcp_servers.eml_brain.env')).toEqual(['mcp_servers', 'eml_brain', 'env'])
    expect(tableKey('projects."unterminated')).toBeNull()
    const literal = `[projects.'/work/a "b"\\c']\ntrust_level = "trusted"\n`
    expect(hasTable(literal, header)).toBe(true)
    expect(hasTable(literal, `projects.${tomlString('/work/other')}`)).toBe(false)
    // Replacing a table Codex wrote with another quoting leaves one table, not two.
    expect(upsertTables(literal, [{ header, lines: ['trust_level = "trusted"'] }]).split('trust_level').length).toBe(2)
  })

  it('removes a table and leaves the rest', () => {
    const text = 'model = "m"\n\n[a]\nx = 1\n\n[b]\ny = 2\n\n[c]\nz = 3\n'
    expect(removeTables(text, ['b'])).toBe('model = "m"\n\n[a]\nx = 1\n\n[c]\nz = 3\n')
    expect(removeTables(text, ['nope'])).toBe(text)
    expect(removeTables('[b]\ny = 2\n', ['b'])).toBe('')
  })

  it('starts an empty file and finds tables by name', () => {
    const text = upsertTables('', [{ header: `projects.${tomlString('/a "b"\\c')}`, lines: ['trust_level = "trusted"'] }])
    expect(text).toBe('[projects."/a \\"b\\"\\\\c"]\ntrust_level = "trusted"\n')
    expect(hasTable(text, 'projects."/a \\"b\\"\\\\c"')).toBe(true)
    expect(hasTable(text, 'projects."/other"')).toBe(false)
  })
})

// The space a session runs in; Codex gets its brain through the session env, not a file of its own.
const space: SessionSpace = {
  id: 'space-1', url: 'http://127.0.0.1:60000', token: BRAIN_TOKEN,
  files: {
    mcpConfig: join(home, 'claude-config', 'spaces', 'space-1', 'mcp.json'),
    settings: join(home, 'claude-config', 'spaces', 'space-1', 'settings.json'),
    emlConfig: join(home, 'eml', 'spaces', 'space-1', 'config'),
  },
}

describe('Codex provider', () => {
  let provider: AgentProvider
  const config = () => readFileSync(join(codexHome, 'config.toml'), 'utf8')

  beforeAll(async () => {
    const { createCodexProvider } = await import('../src/infrastructure/providers/codex/index.js')
    provider = createCodexProvider()
    // A config.toml from before brain spaces: the brain token in an env table.
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'config.toml'), `[mcp_servers.eml_brain.env]\nEML_API_URL = "http://old"\nEML_API_TOKEN = "${BRAIN_TOKEN}"\n`)
    provider.prepare({
      hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken: HOOK_TOKEN,
      writableDirs: [join(home, 'spawn-inbox'), join(home, 'tasks')],
    })
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('turns Codex\'s own update check off, the cockpit updates its copy', () => {
    expect(config().startsWith('check_for_update_on_startup = false\n')).toBe(true)
  })

  it('registers the brain MCP server with pre-approved tools, the brain forwarded from the session env — no token in the file', () => {
    expect(config()).toContain('[mcp_servers.eml_brain]\ncommand = "node"')
    expect(config()).toContain('env_vars = ["EML_API_URL", "EML_API_TOKEN"]')
    expect(config()).toContain('default_tools_approval_mode = "approve"')
    expect(config()).not.toContain('[mcp_servers.eml_brain.env]')
    expect(config()).not.toContain(BRAIN_TOKEN)
  })

  it('writes hooks whose text does not change between boots or spaces', () => {
    const read = () => readFileSync(join(codexHome, 'hooks.json'), 'utf8')
    const first = read()
    expect(first).not.toContain(HOOK_TOKEN)
    expect(Object.keys(JSON.parse(first).hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop'])
    // Codex reads plain output starting with "[" as JSON and cuts long context off — both handled in the hook entry.
    expect(JSON.parse(first).hooks.SessionStart[0].hooks[0]).toMatchObject({ additionalContextLimit: 20000 })
    // The project block, as for Claude: a second SessionStart command; the reminder then drops its cwd guess.
    expect(JSON.parse(first).hooks.SessionStart[1].hooks[0]).toMatchObject({ additionalContextLimit: 20000 })
    expect(JSON.parse(first).hooks.SessionStart[1].hooks[0].command).toMatch(/ '?hook'? '?project-block'? '?--json'?$/)
    // The EML hooks name no config: they read the space's from the session env (EML_HOOK_CONFIG).
    // (Quoted words: the PowerShell line on Windows.)
    expect(JSON.parse(first).hooks.UserPromptSubmit[1].hooks[0].command).toMatch(/ '?hook'? '?user-prompt-submit'? '?--json'? '?--no-cwd-nudge'?$/)
    // Stop: turn state, then the EML stop hook, which prints JSON itself (no --json).
    expect(JSON.parse(first).hooks.Stop[1].hooks[0].command).toMatch(/ '?hook'? '?stop'?$/)
    expect(first).not.toContain('--config')
    expect(JSON.parse(first).hooks.Stop[0].hooks[0]).toMatchObject({ async: true, command: expect.stringContaining('turn-hook.js') })
    provider.prepare({
      hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken: 'fedcba9876543210',
      writableDirs: [join(home, 'spawn-inbox'), join(home, 'tasks')],
    })
    expect(read()).toBe(first)
    expect(readFileSync(join(codexHome, 'turn-hook.json'), 'utf8')).toContain('fedcba9876543210')
  })

  it('delivers the EML skills and the cockpit\'s own, and lets the sandbox write where those need to', () => {
    const skills = readdirSync(join(codexHome, 'skills')).sort()
    expect(skills).toEqual(['brain-hygiene', 'checkpoint', 'consolidate', 'getting-started', 'report-issue', 'spawn-session', 'task-run'])
    expect(config()).toContain(`[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(join(home, 'spawn-inbox'))}, ${JSON.stringify(join(home, 'tasks'))}]`)
  })

  it('trusts a folder once and keeps a decision that is already there', () => {
    provider.trustProject('/work/project one')
    provider.trustProject('/work/project one')
    expect(config().split('[projects."/work/project one"]').length).toBe(2)
    writeFileSync(join(codexHome, 'config.toml'), `${config()}\n[projects."/work/untrusted"]\ntrust_level = "untrusted"\n`)
    provider.trustProject('/work/untrusted')
    expect(config()).toContain('[projects."/work/untrusted"]\ntrust_level = "untrusted"')
  })

  const launchArgs = (unattended: boolean, initialPrompt: string | null = null) =>
    provider.launch({ sessionId: 'c-1', space, providerSessionId: null, resume: false, initialPrompt, unattended }).args

  it('launches the cockpit\'s own binary in the isolated home, without a daemon, sandboxed with the reviewer', () => {
    const launch = provider.launch({ sessionId: 'c-1', space, providerSessionId: null, resume: false, initialPrompt: 'hello', unattended: false })
    expect(launch.bin).toBe(platform.linksFiles ? join(home, 'codex', 'bin', 'codex') : join(home, 'codex', 'current', 'bin', 'codex.exe'))
    expect(launch.args).toEqual([
      '--no-daemon', '--ask-for-approval', 'on-request', '--sandbox', 'workspace-write',
      '--config', 'approvals_reviewer="auto_review"', 'hello',
    ])
    expect(launch.env.CODEX_HOME).toBe(codexHome)
    expect(launch.env.PATH.split(delimiter)[0]).toBe(join(home, 'codex', ...(platform.linksFiles ? [] : ['current']), 'bin'))
    expect(launch.args.join(' ')).not.toContain('c-1')
    expect(launch.args.join(' ')).not.toContain(BRAIN_TOKEN)
  })

  it('hands the session its space\'s brain through the environment', () => {
    const { env } = provider.launch({ sessionId: 'c-1', space, providerSessionId: null, resume: false, initialPrompt: null, unattended: false })
    expect(env.EML_API_URL).toBe(space.url)
    expect(env.EML_API_TOKEN).toBe(space.token)
    expect(env.EML_HOOK_CONFIG).toBe(space.files.emlConfig)
  })

  const unattended = ['--no-daemon', '--ask-for-approval', 'on-request', '--sandbox', 'workspace-write', '--config', 'approvals_reviewer="auto_review"']

  it('runs an unattended session in the sandbox with the reviewer', () => {
    expect(launchArgs(true)).toEqual(unattended)
  })

  it('follows the user\'s permission settings — except where nobody is watching', () => {
    const sandboxed = ['--no-daemon', '--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']
    const network = ['--config', 'sandbox_workspace_write.network_access=true']
    expect(provider.settings?.read()).toEqual({ permissionMode: 'auto', sandboxNetwork: false })

    expect(provider.settings?.write({ permissionMode: 'ask' })).toBeNull()
    expect(launchArgs(false)).toEqual([...sandboxed, '--config', 'approvals_reviewer="user"'])

    expect(provider.settings?.write({ permissionMode: 'auto', sandboxNetwork: true })).toBeNull()
    expect(launchArgs(false)).toEqual([...sandboxed, '--config', 'approvals_reviewer="auto_review"', ...network])

    expect(provider.settings?.write({ permissionMode: 'off' })).toBeNull()
    expect(launchArgs(false)).toEqual(['--no-daemon', '--dangerously-bypass-approvals-and-sandbox'])
    // A worker keeps the sandbox and the reviewer whatever the user chose for their own sessions.
    expect(launchArgs(true)).toEqual([...unattended, ...network])

    expect(provider.settings?.write({ permissionMode: 'yolo' })).toMatch(/one of auto, ask, off/)
    expect(provider.settings?.write({ sandboxNetwork: 'yes' })).toMatch(/true or false/)
    expect(provider.settings?.write({ somethingElse: true })).toMatch(/unknown setting/)
    expect(provider.settings?.write({ permissionMode: 'auto', sandboxNetwork: false })).toBeNull()
  })

  it('is not set up until the user installs it, and says how', () => {
    expect(provider.runtime.version()).toBeNull()
    expect(provider.runtime.problem()).toBe('Codex for the cockpit is not set up yet.')
    expect(provider.runtime.problemHint).toContain('Set up now')
    expect(provider.runtime.state()).toMatchObject({ channel: 'latest', current: null, autoUpdate: true })
  })

  it('resumes by the id Codex assigned, once its rollout exists', () => {
    const session = { sessionId: 'c-3', providerSessionId: '01a1-codex-id', projectPath: null, greeted: null }
    expect(provider.canResume({ ...session, providerSessionId: null })).toBe(false)
    expect(provider.canResume(session)).toBe(false)
    mkdirSync(join(codexHome, 'sessions', '2026', '10', '12'), { recursive: true })
    writeFileSync(join(codexHome, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T12-00-00-01a1-codex-id.jsonl'), '')
    expect(provider.canResume(session)).toBe(true)
    expect(provider.launch({ ...session, space, resume: true, initialPrompt: null, unattended: false }).args.slice(0, 2)).toEqual(['resume', '01a1-codex-id'])
    provider.deleteTranscript(session)
    expect(provider.canResume(session)).toBe(false)
  })

  it('maps hooks to turn signals under the id Codex reports', () => {
    const hook = (event: string) => provider.turnSignal({ session_id: 'their-id', hook_event_name: event })
    expect(hook('UserPromptSubmit')).toEqual({ kind: 'turn', providerSessionId: 'their-id', state: 'working' })
    // The reviewer answers first — waiting only once it had its time. Not in ask mode.
    expect(hook('PermissionRequest')).toEqual({ kind: 'turn', providerSessionId: 'their-id', state: 'waiting', settleMs: 12000 })
    provider.settings?.write({ permissionMode: 'ask' })
    expect(hook('PermissionRequest')).toEqual({ kind: 'turn', providerSessionId: 'their-id', state: 'waiting' })
    provider.settings?.write({ permissionMode: 'auto' })
    expect(hook('PostToolUse')).toEqual({ kind: 'turn', providerSessionId: 'their-id', state: 'working' })
    expect(hook('Stop')).toEqual({ kind: 'turn', providerSessionId: 'their-id', state: 'done' })
    expect(hook('SessionStart')).toBeNull()
  })
})

describe('Codex rollout summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-codex-rollout-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const message = (timestamp: string, role: string, text: string) =>
    JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } })

  it('reads prompt, counts, model and context size; skips Codex\'s own context messages', async () => {
    const { readRolloutSummary } = await import('../src/infrastructure/providers/codex/session-summary.js')
    const file = join(dir, 'rollout-2026-10-12T12-00-00-abc.jsonl')
    writeFileSync(file, [
      JSON.stringify({ timestamp: '2026-10-12T04:00:00.000Z', type: 'session_meta', payload: { id: 'abc' } }),
      message('2026-10-12T04:00:01.000Z', 'developer', '<permissions instructions>…'),
      message('2026-10-12T04:00:01.000Z', 'user', '<environment_context>\n  <cwd>/x</cwd>'),
      JSON.stringify({ timestamp: '2026-10-12T04:00:02.000Z', type: 'turn_context', payload: { model: 'some-model' } }),
      message('2026-10-12T04:00:02.000Z', 'user', 'Fix the login bug\nand add a test'),
      JSON.stringify({ timestamp: '2026-10-12T04:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 16557, cached_input_tokens: 11008 } } } }),
      message('2026-10-12T04:00:05.000Z', 'assistant', 'Done.'),
      'not json',
      '',
    ].join('\n'))
    expect(readRolloutSummary(file, false)).toMatchObject({
      summary: 'Fix the login bug', aiTitle: null, messageCount: 2,
      lastMessageAt: '2026-10-12T04:00:05.000Z', model: 'some-model', contextTokens: 16557,
    })
    expect(readRolloutSummary(null, false).messageCount).toBe(0)
    expect(readRolloutSummary(join(dir, 'missing.jsonl'), false).summary).toBeNull()
  })

  it('skips the cockpit\'s greeting: the summary is the user\'s first prompt after it', async () => {
    const { readRolloutSummary } = await import('../src/infrastructure/providers/codex/session-summary.js')
    const { greetingPrompt } = await import('../src/session-greeting.js')
    const file = join(dir, 'rollout-2026-10-22T12-00-00-greeted.jsonl')
    writeFileSync(file, [
      message('2026-10-22T04:00:01.000Z', 'user', '<environment_context>\n  <cwd>/x</cwd>'),
      message('2026-10-22T04:00:02.000Z', 'user', greetingPrompt()),
      message('2026-10-22T04:00:03.000Z', 'assistant', 'Hi — what are we working on?'),
      message('2026-10-22T04:00:04.000Z', 'user', 'Fix the session titles'),
    ].join('\n'))
    expect(readRolloutSummary(file, true)).toMatchObject({ summary: 'Fix the session titles', messageCount: 3 })
    // A session from before the ledger recorded the greeting: recognised by its text.
    expect(readRolloutSummary(file, null).summary).toBe('Fix the session titles')
  })
})
