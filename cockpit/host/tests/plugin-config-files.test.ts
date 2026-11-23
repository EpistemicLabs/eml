import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// What the plugins write for a session to start with: a runtime agent's mcp.json (its space's plugin
// servers in place of its agent.json list) and Codex's one config.toml (each space's servers off,
// a session switching on its own). paths.ts reads the home at import time — set it first.
const home = mkdtempSync(join(tmpdir(), 'cockpit-plugin-config-files-'))
process.env.EML_COCKPIT_HOME = home

const { writeRuntimeFiles } = await import('../src/infrastructure/providers/claude/isolation.js')
const codex = await import('../src/infrastructure/providers/codex/index.js')
const { CODEX_CONFIG_DIR } = await import('../src/paths.js')

afterAll(() => rmSync(home, { recursive: true, force: true }))

const host = { mcpUrl: 'http://127.0.0.1:60000/mcp', hooksUrl: 'http://127.0.0.1:60000/hooks', mcpToken: 'space-mcp-token' }
const lookup = { type: 'stdio' as const, command: 'lookup-mcp', args: [], env: { KEY: 'placeholder' } }

describe('a runtime agent\'s session files', () => {
  it('get the space\'s plugin servers in place of the agent.json list', () => {
    const configDir = join(home, 'agents', 'nova', 'claude-config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(home, 'turn-hook.json'), '{}')
    const problems: string[] = []
    const runtime = {
      id: 'nova', configDirs: { claude: configDir }, tempDir: join(home, 'agents', 'nova', 'tmp'), chrome: false,
      // A list naming a server with no definition: the plugin servers replace it, so it is never read.
      record: { agentId: 'nova', mcpServers: ['undefined-server'], skills: [], tempDir: join(home, 'agents', 'nova', 'tmp'), harnesses: {} },
      problem: () => null, setProblem: (why: string) => { problems.push(why) },
    }
    writeRuntimeFiles(runtime, 'space-1', join(home, 'turn-hook.json'), host, { lookup })
    expect(problems).toEqual([])
    const mcp = JSON.parse(readFileSync(join(configDir, 'spaces', 'space-1', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['eml_brain', 'lookup'])
    expect(mcp.mcpServers.lookup).toEqual(lookup)
  })
})

describe('Codex\'s plugin servers', () => {
  it('writes nothing where Codex is not set up', () => {
    codex.writeCodexPluginServers({ a: { lookup } })
    expect(existsSync(join(CODEX_CONFIG_DIR, 'config.toml'))).toBe(false)
  })

  it('replaces the plugin tables an earlier write left and leaves the rest of config.toml alone', () => {
    mkdirSync(CODEX_CONFIG_DIR, { recursive: true })
    writeFileSync(join(CODEX_CONFIG_DIR, 'config.toml'), 'check_for_update_on_startup = false\n\n[mcp_servers.eml_brain]\nurl = "http://127.0.0.1:1/mcp"\n')
    codex.writeCodexPluginServers({ a: { lookup, other: { ...lookup, command: 'other-mcp' } } })
    let config = readFileSync(join(CODEX_CONFIG_DIR, 'config.toml'), 'utf8')
    expect(config).toContain('[mcp_servers.lookup]')
    expect(config).toContain('[mcp_servers.other]')
    codex.writeCodexPluginServers({ a: { lookup } })
    config = readFileSync(join(CODEX_CONFIG_DIR, 'config.toml'), 'utf8')
    expect(config).toContain('[mcp_servers.lookup]')
    expect(config).not.toContain('[mcp_servers.other]')
    expect(config).toContain('[mcp_servers.eml_brain]')
    expect(config).toContain('check_for_update_on_startup = false')
  })
})
