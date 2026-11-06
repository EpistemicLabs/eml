import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cgroupSessionMemory } from '../src/infrastructure/platform/linux-cgroups.js'
import { ceilingNotice } from '../src/domain/session-memory.js'

// A cgroup v2 tree is files: a plain folder stands in for it.
const UNIT = '/user.slice/user-1000.slice/user@1000.service/app.slice/eml-cockpit-4317.service'

describe('cgroup session memory', () => {
  let mount: string
  let root: string

  beforeEach(() => {
    mount = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-'))
    root = path.join(mount, UNIT)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'cgroup.controllers'), 'cpu memory pids\n')
    fs.writeFileSync(path.join(root, 'cgroup.procs'), '100\n101\n')
    fs.writeFileSync(path.join(root, 'cgroup.subtree_control'), '')
  })
  afterEach(() => { fs.rmSync(mount, { recursive: true, force: true }) })

  const open = (delegated = true, selfCgroup = `0::${UNIT}\n`) =>
    cgroupSessionMemory({ mount, selfCgroup: () => selfCgroup, delegated: () => delegated, pid: 100 })

  it('moves the host into host/ and turns the controllers on for the sessions', () => {
    const memory = open()
    expect(memory.unavailable).toBeNull()
    // A plain file keeps only the last write: the last process moved.
    expect(fs.readFileSync(path.join(root, 'host', 'cgroup.procs'), 'utf8')).toBe('101')
    expect(fs.readFileSync(path.join(root, 'cgroup.subtree_control'), 'utf8')).toBe('+memory +pids')
  })

  it('gives a session its group with the ceiling, and its process', () => {
    const memory = open()
    expect(memory.place('worker:a/b', 4242, { memoryBytes: 2 * 1024 ** 3, swapBytes: 512 * 1024 ** 2 })).toBe(true)
    const group = path.join(root, 'session-worker_a_b')
    expect(fs.readFileSync(path.join(group, 'memory.max'), 'utf8')).toBe(String(2 * 1024 ** 3))
    expect(fs.readFileSync(path.join(group, 'memory.swap.max'), 'utf8')).toBe(String(512 * 1024 ** 2))
    expect(fs.readFileSync(path.join(group, 'cgroup.procs'), 'utf8')).toBe('4242')
  })

  it('no ceiling set means no limit, swap included', () => {
    const memory = open()
    memory.place('s', 1, { memoryBytes: null, swapBytes: 512 })
    expect(fs.readFileSync(path.join(root, 'session-s', 'memory.max'), 'utf8')).toBe('max')
    expect(fs.readFileSync(path.join(root, 'session-s', 'memory.swap.max'), 'utf8')).toBe('max')
  })

  it('counts the kernel kills at the ceiling', () => {
    const memory = open()
    expect(memory.oomKills('s')).toBe(0)
    memory.place('s', 1, { memoryBytes: 1, swapBytes: 0 })
    fs.writeFileSync(path.join(root, 'session-s', 'memory.events'), 'low 0\nhigh 0\nmax 4\noom 2\noom_kill 2\noom_group_kill 0\n')
    expect(memory.oomKills('s')).toBe(2)
  })

  it('removes an empty group at release, and keeps one still in use', () => {
    const memory = open()
    memory.place('s', 1, { memoryBytes: 1, swapBytes: 0 })
    memory.release('s')
    expect(fs.existsSync(path.join(root, 'session-s'))).toBe(true)
    for (const file of fs.readdirSync(path.join(root, 'session-s'))) fs.rmSync(path.join(root, 'session-s', file))
    memory.release('s')
    expect(fs.existsSync(path.join(root, 'session-s'))).toBe(false)
  })

  it('without Delegate=yes it leaves the cgroup alone and says why', () => {
    const memory = open(false)
    expect(memory.unavailable).toContain('Delegate=yes')
    expect(fs.existsSync(path.join(root, 'host'))).toBe(false)
    expect(memory.place('s', 1, { memoryBytes: 1, swapBytes: 0 })).toBe(false)
  })

  it('outside a service, or without cgroup v2, there is no ceiling', () => {
    expect(open(true, '0::/user.slice/user-1000.slice/session-3.scope\n').unavailable).toContain('autostart service')
    expect(open(true, '12:memory:/foo\n').unavailable).toBe('no cgroup v2')
  })

  it('a host that set up already finds its service one level up', () => {
    open()
    expect(open(true, `0::${UNIT}/host\n`).unavailable).toBeNull()
  })

  it('a missing controller is named', () => {
    fs.writeFileSync(path.join(root, 'cgroup.controllers'), 'cpu pids\n')
    expect(open().unavailable).toContain('memory')
  })
})

describe('ceilingNotice', () => {
  it('names the ceiling and where to change it', () => {
    const text = ceilingNotice(1, { memoryBytes: 2 * 1024 ** 3, swapBytes: 0 })
    expect(text).toContain('A process of this session was stopped')
    expect(text).toContain('2 GB')
    expect(text).toContain('Settings')
  })
})
