import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The EML hook commands an agent CLI stores must read the same across cockpit
 * and node updates: Codex trusts a hook by its exact text, and a path into
 * app/versions/<v> stops existing two updates later.
 */

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-hook-paths-test-'))
process.env.EML_COCKPIT_HOME = home

describe('hook paths', () => {
  let paths: typeof import('../src/paths.js')
  let shared: typeof import('../src/infrastructure/providers/shared.js')

  beforeAll(async () => {
    paths = await import('../src/paths.js')
    shared = await import('../src/infrastructure/providers/shared.js')
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('addresses a file of an installed version through app/current', () => {
    const versions = join(home, 'app', 'versions')
    const cli = join(versions, '0.17.6', 'node_modules', '@engramprotocol', 'mcp-server', 'dist', 'cli.js')
    mkdirSync(join(cli, '..'), { recursive: true })
    writeFileSync(cli, '')
    symlinkSync(join('versions', '0.17.6'), join(home, 'app', 'current'))
    expect(paths.stableAppPath(cli)).toBe(join(home, 'app', 'current', 'node_modules', '@engramprotocol', 'mcp-server', 'dist', 'cli.js'))
    // The link resolves to the same file.
    expect(lstatSync(paths.stableAppPath(cli)).isFile()).toBe(true)
    // Outside app/versions (a checkout, a dev cockpit) the path stays as it is.
    expect(paths.stableAppPath('/somewhere/eml/packages/mcp-server/dist/cli.js')).toBe('/somewhere/eml/packages/mcp-server/dist/cli.js')
    expect(paths.stableAppPath(join(versions, 'not-a-version', 'x.js'))).toBe(join(versions, 'not-a-version', 'x.js'))
    expect(paths.stableAppPath(join(versions, '0.17.6'))).toBe(join(versions, '0.17.6'))
  })

  it('keeps <home>/bin/node pointing at this host\'s node, and names it in the hook command', () => {
    const link = shared.ensureHookNode()
    expect(link).toBe(join(home, 'bin', 'node'))
    expect(readlinkSync(link)).toBe(process.execPath)
    // A stale link (node moved) is replaced on the next boot.
    rmSync(link)
    symlinkSync('/old/cellar/node', link)
    shared.ensureHookNode()
    expect(readlinkSync(link)).toBe(process.execPath)

    const command = shared.emlHookEntry('session-start', "'/x/config'").hooks[0].command
    expect(command.startsWith(`'${link}' `)).toBe(true)
    expect(command).not.toContain(process.execPath)
    expect(command).toContain(`'${paths.HOOK_MCP_CLI_JS}' hook session-start --config '/x/config'`)
  })
})
