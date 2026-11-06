import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `eml-cockpit agent create` on a home with agent brains: a new id gets its
// brain and takes the space over, an id the home has keeps its brain and gains
// the runtime, a home from before agent brains leaves the brain to the upgrade.

const home = mkdtempSync(join(tmpdir(), 'cockpit-agent-command-test-'))
process.env.EML_COCKPIT_HOME = home
process.env.COCKPIT_PORT = '1'
const require = createRequire(import.meta.url)
const core = require('@engramprotocol/core')

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('agent create', () => {
  let run: typeof import('../src/agent-command.js')['runAgentCommand']
  let read: typeof import('../src/config.js')['readCockpitConfig']
  const said = (fn: () => Promise<unknown>) => async () => {
    let text = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { text += String(chunk); return true })
    try { await fn() } finally { out.mockRestore() }
    return text
  }

  beforeAll(async () => {
    const { provisionBrain, provisionSpace } = await import('../src/provision.js')
    ;({ runAgentCommand: run } = await import('../src/agent-command.js'))
    ;({ readCockpitConfig: read } = await import('../src/config.js'))
    await provisionBrain({ userId: 'alex', userName: 'Alex Doe', agentId: 'juno', agentName: 'Juno' }, core)
    await provisionSpace('Life', { id: 'juno', name: 'Juno' }, { handle: 'alex', name: 'Alex Doe' }, core)
    await provisionSpace('Work', { id: 'juno', name: 'Juno' }, { handle: 'alex', name: 'Alex Doe' }, core)
  })

  it('a new id gets its agent brain and the space, the old agent keeps its brain', async () => {
    const text = await said(() => run(['agent', 'create', 'kira', '--space', 'Life'], core))()
    expect(text).toContain('agent kira: created and bound to space Life (0 MCP servers + the brain, 0 skills + the managed ones)')
    expect(text).toContain('space Life was bound to juno; it now runs as kira. juno keeps its brain.')
    const config = await read()
    expect(config?.agents?.map((a) => [a.id, a.runtime])).toEqual([['juno', undefined], ['kira', true]])
    expect(config?.spaces?.map((s) => [s.name, s.agent])).toEqual([['Life', 'kira'], ['Work', 'juno']])
    const record = JSON.parse(readFileSync(join(home, 'agents', 'kira', 'agent.json'), 'utf8'))
    expect(record).not.toHaveProperty('brainId')
  })

  it('an id the home has keeps its one brain and gains the runtime, with no rebind line', async () => {
    const before = (await read())?.agents?.find((a) => a.id === 'juno')?.token
    const text = await said(() => run(['agent', 'create', 'juno', '--space', 'Work'], core))()
    expect(text).toContain('agent juno: created and bound to space Work')
    expect(text).not.toContain('was bound to')
    const config = await read()
    expect(config?.agents).toHaveLength(2)
    expect(config?.agents?.find((a) => a.id === 'juno')).toMatchObject({ token: before, runtime: true })
  })

  it('status names the spaces that bind the agent', async () => {
    const text = await said(() => run(['agent', 'status', 'juno']))()
    expect(text).toContain('  spaces: Main, Work')
    expect(text).not.toContain('  brain:')
  })

  it('refuses an id whose folder exists, and leaves the config alone', async () => {
    const before = JSON.stringify(await read())
    await expect(run(['agent', 'create', 'kira', '--space', 'Work'], core)).rejects.toThrow(/already exists/)
    expect(JSON.stringify(await read())).toBe(before)
    expect(existsSync(join(home, 'agents', 'kira'))).toBe(true)
  })
})
