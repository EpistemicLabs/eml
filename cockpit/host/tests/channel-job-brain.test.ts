import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-job-brain-test-'))
process.env.EML_COCKPIT_HOME = home

const { writeSpaceFiles, writeLimitedMcpConfig } = await import('../src/infrastructure/providers/claude/isolation.js')
const { channelJobProfile } = await import('../src/domain/tool-profile.js')
const { MCP_SESSION_HEADER, MCP_TOKEN_HEADER } = await import('../src/infrastructure/providers/shared.js')

const SPACE = 'fe2dcdfb-0000-4bb3-a3b4-d5261f93e165'
const host = { mcpUrl: 'http://127.0.0.1:60000/mcp', hooksUrl: 'http://127.0.0.1:60000/hooks', mcpToken: 'space-mcp-token' }
const bridge = { type: 'stdio', command: 'node', args: ['channel-bridge-mcp.cjs'], env: { CHANNEL_BRIDGE_JOB_ID: 'job-1' } }

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('a limited channel job reaches its brain through the host endpoint', () => {
  it('keeps the space\'s brain entry as it is (endpoint, space token, the session\'s own id) next to the bridge, and nothing else of the space', () => {
    const runtime = { id: 'test-agent', configDir: join(home, 'agents', 'test-agent', 'claude-config'), mcpServers: { gmail: { command: 'gmail-mcp' } } }
    const files = writeSpaceFiles(SPACE, join(home, 'turn-hook.json'), host, runtime)
    const profile = channelJobProfile(null, [])
    const file = writeLimitedMcpConfig(files.mcpConfig, 'session-1', profile.mcpServers, { channel_bridge: bridge })

    const written = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(Object.keys(written.mcpServers).sort()).toEqual(['channel_bridge', 'eml_brain'])
    expect(written.mcpServers.eml_brain).toEqual({
      type: 'http',
      url: host.mcpUrl,
      // The endpoint picks the space by this token and checks the session against the ledger (brain-mcp.ts).
      headers: { [MCP_TOKEN_HEADER]: host.mcpToken, [MCP_SESSION_HEADER]: '${COCKPIT_SESSION_ID}' },
    })
    expect(written.mcpServers.channel_bridge).toEqual(bridge)
    // Beside the space's own file, in the agent's folder, owner-only.
    expect(file).toBe(join(runtime.configDir, 'spaces', SPACE, 'mcp-session-1.json'))
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
