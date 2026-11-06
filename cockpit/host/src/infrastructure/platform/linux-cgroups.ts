import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { noSessionMemory, type SessionLimits, type SessionMemory } from '../../domain/session-memory.js'

/**
 * Session ceilings with cgroup v2, under the systemd user unit (service.ts). The
 * unit has Delegate=yes, so its cgroup belongs to the host:
 *
 *   eml-cockpit-<port>.service/
 *     host/                 the host and everything it starts for itself
 *     session-<id>/         one session's process tree, memory.max + memory.swap.max
 *
 * A cgroup with children may hold no processes itself, so the host first moves
 * into host/, then turns the memory and pids controllers on for the children.
 * memory.oom.group stays off: at the ceiling the kernel kills the largest
 * process of the group, not the whole session. OOMPolicy=continue keeps systemd
 * from failing the unit when that happens. Stopping the unit still ends every
 * group (KillMode=control-group covers the whole subtree).
 */

export interface CgroupOptions {
  /** Where cgroup v2 is mounted. */
  mount?: string
  /** This process's /proc/self/cgroup. */
  selfCgroup?: () => string
  /** Whether systemd delegated the unit's cgroup (Delegate=yes); without it systemd may reset what the host sets. */
  delegated?: (unit: string) => boolean
  pid?: number
  log?: (line: string) => void
}

const CONTROLLERS = ['memory', 'pids']

const groupName = (sessionId: string) => `session-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`

function systemdDelegates(unit: string): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'show', unit, '--property=Delegate', '--value'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
    return out.toString().trim() === 'yes'
  } catch {
    return false
  }
}

/** The service's own cgroup, with the host moved into host/ and the controllers on for sessions; or why not. */
function setUp(opts: Required<Omit<CgroupOptions, 'log'>>): { root: string } | { why: string } {
  let line: string | undefined
  try { line = opts.selfCgroup().split('\n').find((l) => l.startsWith('0::')) } catch { /* no /proc */ }
  if (!line) return { why: 'no cgroup v2' }
  let rel = line.slice(3).trim()
  // Set up before (the host moved itself already): the service is one level up.
  if (path.posix.basename(rel) === 'host') rel = path.posix.dirname(rel)
  const unit = path.posix.basename(rel)
  if (!unit.endsWith('.service')) return { why: 'the host does not run as the autostart service' }
  if (!opts.delegated(unit)) return { why: `${unit} has no Delegate=yes; 'eml-cockpit service install' writes it` }
  const root = path.join(opts.mount, rel)
  try {
    const available = fs.readFileSync(path.join(root, 'cgroup.controllers'), 'utf8').split(/\s+/)
    const missing = CONTROLLERS.filter((c) => !available.includes(c))
    if (missing.length) return { why: `the ${missing.join(' and ')} controller is not available to the service` }
    const host = path.join(root, 'host')
    fs.mkdirSync(host, { recursive: true })
    // Everything in the service's own group moves, the brain server too if it started first.
    const procs = fs.readFileSync(path.join(root, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean)
    for (const pid of new Set([...procs, String(opts.pid)])) {
      try { fs.writeFileSync(path.join(host, 'cgroup.procs'), pid) } catch { /* exited meanwhile */ }
    }
    fs.writeFileSync(path.join(root, 'cgroup.subtree_control'), CONTROLLERS.map((c) => `+${c}`).join(' '))
    // Groups of sessions from before a restart of the host alone: empty ones go.
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('session-')) try { fs.rmdirSync(path.join(root, name)) } catch { /* still in use */ }
    }
    return { root }
  } catch (error) {
    return { why: `the service's cgroup can't be set up: ${(error as Error).message}` }
  }
}

export function cgroupSessionMemory(options: CgroupOptions = {}): SessionMemory {
  const log = options.log ?? (() => {})
  const setup = setUp({
    mount: options.mount ?? '/sys/fs/cgroup',
    selfCgroup: options.selfCgroup ?? (() => fs.readFileSync('/proc/self/cgroup', 'utf8')),
    delegated: options.delegated ?? systemdDelegates,
    pid: options.pid ?? process.pid,
  })
  if ('why' in setup) return noSessionMemory(setup.why)
  const { root } = setup
  const dir = (sessionId: string) => path.join(root, groupName(sessionId))

  return {
    unavailable: null,
    place(sessionId: string, pid: number, limits: SessionLimits): boolean {
      const group = dir(sessionId)
      try {
        fs.mkdirSync(group, { recursive: true })
        fs.writeFileSync(path.join(group, 'memory.max'), limits.memoryBytes === null ? 'max' : String(limits.memoryBytes))
        fs.writeFileSync(path.join(group, 'memory.swap.max'), limits.memoryBytes === null ? 'max' : String(limits.swapBytes))
        fs.writeFileSync(path.join(group, 'cgroup.procs'), String(pid))
        return true
      } catch (error) {
        log(`[memory] session ${sessionId} runs without a ceiling: ${(error as Error).message}`)
        return false
      }
    },
    oomKills(sessionId: string): number {
      try {
        const events = fs.readFileSync(path.join(dir(sessionId), 'memory.events'), 'utf8')
        return Number(events.match(/^oom_kill (\d+)$/m)?.[1] ?? 0)
      } catch {
        return 0
      }
    },
    release(sessionId: string): void {
      // A tool that outlived its session keeps the group (and its ceiling) until it ends; the next start reuses it.
      try { fs.rmdirSync(dir(sessionId)) } catch { /* still in use, or gone */ }
    },
  }
}
