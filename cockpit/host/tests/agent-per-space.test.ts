import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, SessionSpace } from '../src/domain/agent-provider.js'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-agent-test-'))
process.env.EML_COCKPIT_HOME = home

const TOKEN = 'eml_testprefix_testsecret'
const SPACE = 'fe2dcdfb-0000-4bb3-a3b4-d5261f93e165'
const AGENT = 'test-agent'
const agentRoot = join(home, 'agents', AGENT)
const configDir = join(agentRoot, 'claude-config')
const mcpFile = join(configDir, 'spaces', SPACE, 'mcp.json')

function writeAgent(record: Record<string, unknown> = {}, definitions: Record<string, unknown> = { alpha: { command: 'a' }, beta: { command: 'b' } }) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(agentRoot, 'mcp-servers.json'), JSON.stringify({ mcpServers: definitions }))
  writeFileSync(join(agentRoot, 'agent.json'), JSON.stringify({
    agentId: AGENT, brainId: SPACE, mcpServers: ['alpha'], skills: [], tempDir: join(agentRoot, 'tmp'),
    harnesses: { claude: { configDir } }, ...record,
  }))
}

describe('a space with its own agent', () => {
  let provider: AgentProvider
  let mods: {
    openBrainSpace: typeof import('../src/brain-space.js')['openBrainSpace']
    isolation: typeof import('../src/infrastructure/providers/claude/isolation.js')
    turnHookConfig: string
    readSummary: typeof import('../src/infrastructure/providers/claude/session-summary.js')['transcriptPathFor']
    readCockpitConfig: typeof import('../src/config.js')['readCockpitConfig']
    sharedConfigDir: string
  }
  const open = (agentId?: string) => mods.openBrainSpace({
    id: SPACE, name: 'Test', brainName: 'main-agent', main: false, url: 'http://127.0.0.1:60000', token: TOKEN, turnHookConfig: mods.turnHookConfig,
    ...(agentId ? { agentId } : {}),
  })
  const sessionSpace = (space: ReturnType<typeof open>): SessionSpace => ({ id: space.id, url: space.url, token: space.token, files: space.files, agent: space.agent })
  const launchReq = (space: SessionSpace) => ({ sessionId: 'abc-1', address: 'eml-abc1', space, providerSessionId: null, resume: false, initialPrompt: null, unattended: false })

  beforeAll(async () => {
    const { createClaudeProvider } = await import('../src/infrastructure/providers/claude/index.js')
    const isolation = await import('../src/infrastructure/providers/claude/isolation.js')
    const { openBrainSpace } = await import('../src/brain-space.js')
    const paths = await import('../src/paths.js')
    const summary = await import('../src/infrastructure/providers/claude/session-summary.js')
    const config = await import('../src/config.js')
    provider = createClaudeProvider()
    provider.prepare({ hookUrl: 'http://127.0.0.1:60001/api/hook', hookToken: '0123456789abcdef', writableDirs: [] })
    mods = { openBrainSpace, isolation, turnHookConfig: paths.CLAUDE_TURN_HOOK_CONFIG, readSummary: summary.transcriptPathFor, readCockpitConfig: config.readCockpitConfig, sharedConfigDir: paths.CONFIG_DIR }
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('a space without an agent keeps today\'s arguments, environment and files exactly', () => {
    const space = open()
    expect(space.agent).toBeNull()
    expect(space.files.mcpConfig).toBe(join(mods.sharedConfigDir, 'spaces', SPACE, 'mcp.json'))
    const launch = provider.launch(launchReq(sessionSpace(space)))
    expect(launch.args).toEqual([
      '--mcp-config', space.files.mcpConfig,
      '--settings', space.files.settings, '--setting-sources', 'user,project,local',
      '--permission-mode', 'auto',
      '--name', 'eml-abc1',
      '--session-id', 'abc-1',
    ])
    expect(Object.keys(launch.env).sort()).toEqual([
      'CLAUDE_CODE_NO_FLICKER', 'CLAUDE_CONFIG_DIR', 'COCKPIT_SESSION_ADDRESS', 'DISABLE_AUTOUPDATER', 'PATH',
    ])
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(mods.sharedConfigDir)
    const mcp = JSON.parse(readFileSync(space.files.mcpConfig, 'utf8'))
    expect(Object.keys(mcp.mcpServers)).toEqual(['eml_brain'])
    expect(Object.keys(mcp.mcpServers.eml_brain.env)).toEqual(['EML_API_URL', 'EML_API_TOKEN'])
    expect(readFileSync(space.files.emlConfig, 'utf8')).not.toContain('EML_AGENT')
  })

  it('runs in the agent\'s folder, strict on MCP, connectors off, with its own temp folder', () => {
    writeAgent()
    const space = open(AGENT)
    expect(space.agent?.problem('claude')).toBeNull()
    const launch = provider.launch(launchReq(sessionSpace(space)))
    expect(launch.args.slice(0, 3)).toEqual(['--mcp-config', mcpFile, '--strict-mcp-config'])
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(launch.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    expect(launch.env.CLAUDE_CODE_TMPDIR).toBe(join(agentRoot, 'tmp'))
    expect(launch.env.TMPDIR).toBe(join(agentRoot, 'tmp'))
    expect(existsSync(join(agentRoot, 'tmp'))).toBe(true)
  })

  it('the MCP file holds exactly the allowed servers plus the brain, owner-only', () => {
    writeAgent()
    open(AGENT)
    const mcp = JSON.parse(readFileSync(mcpFile, 'utf8'))
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['alpha', 'eml_brain'])
    expect(statSync(mcpFile).mode & 0o777).toBe(0o600)
  })

  it('the session files name the agent: the host sets the identity, the brain keeps its name', () => {
    writeAgent()
    const space = open(AGENT)
    expect(space.brainName).toBe('main-agent')
    expect(readFileSync(space.files.emlConfig, 'utf8')).toContain(`EML_AGENT=${AGENT}\n`)
    expect(JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers.eml_brain.env.EML_AGENT).toBe(AGENT)
  })

  it('the token mode does not override the agent\'s login', () => {
    writeFileSync(join(home, 'claude-login'), 'sk-ant-oat01-testtesttesttesttesttest\n')
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ loginMode: 'token' }))
    try {
      writeAgent()
      expect(provider.launch(launchReq(sessionSpace(open(AGENT)))).env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      expect(provider.launch(launchReq(sessionSpace(open())))).toHaveProperty('env.CLAUDE_CODE_OAUTH_TOKEN')
    } finally {
      rmSync(join(home, 'claude-login'))
      rmSync(join(home, 'agents.json'))
    }
  })

  it('resume, trust, summary and transcripts use the agent\'s folder', () => {
    writeAgent()
    const space = open(AGENT)
    const agent = space.agent
    const ref = { sessionId: 'sess-a', providerSessionId: null, projectPath: '/work/p', greeted: null, agent }
    expect(provider.canResume(ref)).toBe(false)
    const transcript = mods.readSummary('/work/p', 'sess-a', configDir)
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'in the agent folder' } }) + '\n')
    expect(provider.canResume(ref)).toBe(true)
    expect(provider.canResume({ ...ref, agent: null })).toBe(false)
    expect(provider.summary(ref).summary).toBe('in the agent folder')
    provider.trustProject('/work/p', sessionSpace(space))
    const stored = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'))
    expect(stored.projects['/work/p'].hasTrustDialogAccepted).toBe(true)
    expect(stored.hasCompletedOnboarding).toBe(true)
    expect(JSON.parse(readFileSync(join(mods.sharedConfigDir, '.claude.json'), 'utf8')).projects['/work/p']).toBeUndefined()
    provider.deleteTranscript(ref)
    expect(existsSync(transcript)).toBe(false)
  })

  it('holds the skills to the list plus the managed ones, as copies', () => {
    writeAgent({ skills: ['mine'] })
    const skills = join(configDir, 'skills')
    mkdirSync(join(skills, 'mine'), { recursive: true })
    writeFileSync(join(skills, 'mine', 'SKILL.md'), 'mine')
    mkdirSync(join(skills, 'stray'), { recursive: true })
    writeFileSync(join(skills, 'stray', 'SKILL.md'), 'stray')
    const outside = mkdtempSync(join(tmpdir(), 'cockpit-skill-'))
    symlinkSync(outside, join(skills, 'linked'))
    open(AGENT)
    const left = readdirSync(skills)
    expect(left).toContain('mine')
    expect(left).toContain('consolidate')
    expect(left).not.toContain('stray')
    expect(left).not.toContain('linked')
    for (const name of left) expect(lstatSync(join(skills, name)).isSymbolicLink()).toBe(false)
    rmSync(outside, { recursive: true, force: true })
    rmSync(skills, { recursive: true, force: true })
  })

  it('copyAgentSkills copies a link\'s target, not the link', () => {
    const from = mkdtempSync(join(tmpdir(), 'cockpit-skill-src-'))
    const real = mkdtempSync(join(tmpdir(), 'cockpit-skill-real-'))
    writeFileSync(join(real, 'SKILL.md'), 'real')
    symlinkSync(real, join(from, 'one'))
    const target = mkdtempSync(join(tmpdir(), 'cockpit-skill-target-'))
    mods.isolation.copyAgentSkills(['one'], from, target)
    expect(lstatSync(join(target, 'skills', 'one')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(target, 'skills', 'one', 'SKILL.md'), 'utf8')).toBe('real')
    for (const dir of [from, real, target]) rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['a listed skill that is not there', { skills: ['absent'] }, undefined, /absent/],
    ['an allowed server without a definition', { mcpServers: ['gamma'] }, undefined, /gamma/],
    ['an allowed server claiming the brain\'s name', { mcpServers: ['eml_brain'] }, undefined, /eml_brain/],
    ['a record of another brain', { brainId: 'other' }, undefined, /another brain/],
  ])('refuses to start with %s', (_name, record, definitions, message) => {
    writeAgent(record, definitions)
    const space = open(AGENT)
    expect(space.agent?.problem('claude')).toMatch(message)
    expect(() => provider.launch(launchReq(sessionSpace(space)))).toThrow(message)
  })

  it('does not start, recreate or fall back when the folder or an MCP file goes', () => {
    writeAgent()
    const space = open(AGENT)
    const away = `${configDir}.away`
    renameSync(configDir, away)
    expect(space.agent?.problem('claude')).toMatch(/config folder .* is missing/)
    expect(() => provider.launch(launchReq(sessionSpace(space)))).toThrow(/never falls back/)
    provider.trustProject('/work/q', sessionSpace(space))
    expect(existsSync(configDir)).toBe(false)
    // Across a boot too: nothing recreates the folder.
    const reopened = open(AGENT)
    expect(existsSync(configDir)).toBe(false)
    expect(reopened.agent?.problem('claude')).toMatch(/is missing/)
    renameSync(away, configDir)

    rmSync(mcpFile)
    expect(space.agent?.problem('claude')).toMatch(/generated MCP file/)
    open(AGENT)
    expect(space.agent?.problem('claude')).toBeNull()
    rmSync(join(agentRoot, 'mcp-servers.json'))
    expect(space.agent?.problem('claude')).toMatch(/MCP file .* is missing/)
  })

  it('a bound agent whose record is gone refuses too: no folder is no reason for the shared config', () => {
    rmSync(agentRoot, { recursive: true, force: true })
    const space = open(AGENT)
    expect(space.agent?.problem('claude')).toMatch(/agent\.json is missing/)
    expect(() => provider.launch(launchReq(sessionSpace(space)))).toThrow(/agent\.json is missing/)
    expect(existsSync(agentRoot)).toBe(false)
  })

  it('removes the shared copy of the space\'s token files once the space has an agent', () => {
    open()
    expect(existsSync(join(mods.sharedConfigDir, 'spaces', SPACE))).toBe(true)
    writeAgent()
    open(AGENT)
    expect(existsSync(join(mods.sharedConfigDir, 'spaces', SPACE))).toBe(false)
  })

  it('reads the login state from the file, with no value in the answer', () => {
    writeAgent()
    expect(mods.isolation.agentLoginStatus(configDir).state).toMatch(/^none/)
    writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET-A', refreshToken: 'SECRET-R', expiresAt: 1_800_000_000_000 } }))
    const status = mods.isolation.agentLoginStatus(configDir)
    expect(status.state).toBe('stored')
    expect(status.expiresAt).toBe(new Date(1_800_000_000_000).toISOString())
    expect(JSON.stringify(status)).not.toContain('SECRET')
  })

  it('the cockpit config keeps a space\'s binding', async () => {
    writeFileSync(join(home, 'config'), JSON.stringify({ token: TOKEN, spaces: [{ token: 'eml_other', name: 'Test', agent: AGENT }, { token: 'eml_plain' }] }))
    const config = await mods.readCockpitConfig()
    expect(config?.spaces).toEqual([{ token: 'eml_other', name: 'Test', agent: AGENT }, { token: 'eml_plain' }])
  })
})
