import { describe, it, expect, afterAll } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedRuntime, type RuntimeSource } from '../src/infrastructure/providers/managed-runtime.js'

/**
 * The install engine both agent CLIs share, driven by a fake source: what it
 * delivers is a shell script that answers --version. Every way the source or
 * the binary can fail must leave `current` untouched and versions/ clean.
 */

const root = mkdtempSync(join(tmpdir(), 'cockpit-managed-runtime-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

interface FakeOptions {
  /** The version the channel names. */
  latest: string
  /** The version the delivered binary claims; defaults to the one asked for. */
  claims?: (version: string) => string
  /** The source refuses the download (checksum, signature). */
  refuse?: string
}

function fakeSource(opts: FakeOptions): RuntimeSource {
  return {
    label: 'Tool',
    logTag: 'tool-runtime',
    channel: 'stable',
    entry: 'bin/tool',
    latestVersion: async () => opts.latest,
    async fetch(version, dir) {
      if (opts.refuse) throw new Error(opts.refuse)
      mkdirSync(join(dir, 'bin'))
      const script = join(dir, 'bin', 'tool')
      writeFileSync(script, `#!/bin/sh\necho "tool ${opts.claims?.(version) ?? version}"\n`)
      chmodSync(script, 0o755)
    },
    selfTestEnv: () => ({ PATH: '/usr/bin:/bin' }),
    reportedVersion: (stdout) => stdout.trim().split(/\s+/).pop() ?? '',
  }
}

const runtimeIn = (name: string, source: RuntimeSource) =>
  new ManagedRuntime(join(root, name), 'tool', source, { installUnasked: true })

const stagingDirs = (dir: string) => {
  try { return readdirSync(join(dir, 'versions')).filter((n) => n.startsWith('.staging-')) } catch { return [] }
}

describe('managed runtime', () => {
  it('installs a version that verifies and answers --version, then runs it from bin/', async () => {
    const dir = join(root, 'ok')
    const runtime = runtimeIn('ok', fakeSource({ latest: '1.0.0' }))
    expect(runtime.currentVersion()).toBeNull()
    expect(runtime.problem()).toBe('Tool for the cockpit is not set up yet.')

    const state = await runtime.sync('install')
    expect(state.lastResult).toMatchObject({ outcome: 'installed', from: null, to: '1.0.0' })
    expect(runtime.currentVersion()).toBe('1.0.0')
    expect(runtime.problem()).toBeNull()
    expect(existsSync(join(dir, 'versions', '1.0.0', 'bin', 'tool'))).toBe(true)
    expect(existsSync(runtime.bin)).toBe(true)
    expect(stagingDirs(dir)).toEqual([])
  })

  it('keeps nothing when the source refuses the download (checksum or signature)', async () => {
    const dir = join(root, 'refused')
    const runtime = runtimeIn('refused', fakeSource({ latest: '1.0.0', refuse: 'checksum does not match the npm registry' }))
    const state = await runtime.sync('install')
    expect(state.lastResult).toMatchObject({ outcome: 'failed', to: '1.0.0' })
    expect(state.lastResult?.error).toContain('checksum does not match')
    expect(state.current).toBeNull()
    expect(runtime.currentVersion()).toBeNull()
    expect(runtime.problem()).toContain('checksum does not match')
    expect(existsSync(join(dir, 'versions', '1.0.0'))).toBe(false)
    expect(stagingDirs(dir)).toEqual([])
  })

  it('keeps nothing when the binary does not answer --version with the version it claims', async () => {
    const dir = join(root, 'liar')
    const runtime = runtimeIn('liar', fakeSource({ latest: '1.0.0', claims: () => '0.9.9' }))
    const state = await runtime.sync('install')
    expect(state.lastResult).toMatchObject({ outcome: 'failed', to: '1.0.0' })
    expect(state.lastResult?.error).toContain('self-test failed')
    expect(runtime.currentVersion()).toBeNull()
    expect(existsSync(join(dir, 'versions', '1.0.0'))).toBe(false)
    expect(stagingDirs(dir)).toEqual([])
  })

  it('keeps the running version when an update fails, and does not take a rolled-back version again', async () => {
    const dir = join(root, 'update')
    const opts: FakeOptions = { latest: '1.0.0' }
    const runtime = runtimeIn('update', fakeSource(opts))
    await runtime.sync('install')
    expect(runtime.currentVersion()).toBe('1.0.0')

    // A broken 1.1.0: 1.0.0 stays current, nothing of 1.1.0 remains.
    opts.latest = '1.1.0'
    opts.claims = (v) => (v === '1.1.0' ? 'garbage' : v)
    let state = await runtime.sync('update')
    expect(state.lastResult).toMatchObject({ outcome: 'failed', from: '1.0.0', to: '1.1.0' })
    expect(runtime.currentVersion()).toBe('1.0.0')
    expect(existsSync(join(dir, 'versions', '1.1.0'))).toBe(false)

    // A good 1.1.0 installs; 1.0.0 is kept for a rollback.
    opts.claims = undefined
    state = await runtime.sync('update')
    expect(state.lastResult).toMatchObject({ outcome: 'updated', from: '1.0.0', to: '1.1.0' })
    expect(runtime.currentVersion()).toBe('1.1.0')
    expect(existsSync(join(dir, 'versions', '1.0.0'))).toBe(true)

    // Rolling back marks 1.1.0 as skipped: the next check stays on 1.0.0.
    state = await runtime.rollback()
    expect(state).toMatchObject({ current: '1.0.0', previous: '1.1.0', skipVersion: '1.1.0' })
    expect(runtime.currentVersion()).toBe('1.0.0')
    state = await runtime.sync('update')
    expect(state.lastResult).toMatchObject({ outcome: 'up_to_date', to: '1.0.0' })
    expect(runtime.currentVersion()).toBe('1.0.0')

    // A newer version than the skipped one is taken.
    opts.latest = '1.2.0'
    state = await runtime.sync('update')
    expect(state.lastResult).toMatchObject({ outcome: 'updated', from: '1.0.0', to: '1.2.0' })
    expect(runtime.currentVersion()).toBe('1.2.0')
  })

  it('rejects a rollback when there is nothing to go back to', async () => {
    const runtime = runtimeIn('norollback', fakeSource({ latest: '1.0.0' }))
    await runtime.sync('install')
    await expect(runtime.rollback()).rejects.toThrow('no previous version')
  })
})
