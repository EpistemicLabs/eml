import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ListeningPort, Platform } from '../../domain/platform.js'

/** Helpers the adapters share; posixBase is what macOS and Linux have in common. */

export const archKey = (): 'arm64' | 'x64' => {
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch
  throw new Error(`unsupported architecture: ${process.arch}`)
}

export const runFile = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
})

export const detached = (cmd: string, args: string[]) => {
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref() } catch { /* headless */ }
}

export const posixBase: Pick<Platform, 'exe' | 'sessionEnvKeys' | 'switchDirLink' | 'linksFiles' | 'minimalEnv' | 'tarBin' | 'npm' | 'toolDirs' | 'listeningPorts'> = {
  exe: (name) => name,
  sessionEnvKeys: [],
  switchDirLink(target, link) {
    const tmp = path.join(path.dirname(link), `.${path.basename(link)}-${randomBytes(4).toString('hex')}`)
    fs.symlinkSync(path.relative(path.dirname(link), target), tmp)
    fs.renameSync(tmp, link)
  },
  linksFiles: true,
  minimalEnv: () => ({ PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' }),
  // The npm next to this node (a launchd service's PATH may not have it), else PATH's.
  npm: () => {
    const beside = path.join(path.dirname(process.execPath), 'npm')
    return { program: fs.existsSync(beside) ? beside : 'npm', args: [] }
  },
  toolDirs: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'],
  // /bin/tar on a Linux without a merged /usr.
  tarBin: () => ['/usr/bin/tar', '/bin/tar'].find((bin) => fs.existsSync(bin)) ?? '/usr/bin/tar',
  // lsof sees the user's own processes without root; a system without it lists none.
  listeningPorts: async () => {
    const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'].find((bin) => fs.existsSync(bin))
    if (!lsof) return null
    const listening = await stdout(lsof, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
    if (listening === null) return []
    const ports = parseLsofListening(listening)
    const pids = [...new Set(ports.map((p) => p.pid))]
    if (!pids.length) return []
    const [cwds, processes] = await Promise.all([
      stdout(lsof, ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']).then((out) => parseLsofCwd(out ?? '')),
      stdout('/bin/ps', ['-axo', 'pid=,ppid=,rss=,etime=,command=']).then((out) => parsePs(out ?? '')),
    ])
    const now = Date.now()
    return ports.map((p) => {
      const proc = processes.get(p.pid)
      return {
        ...p,
        cwd: cwds.get(p.pid) ?? null,
        startedAt: proc ? new Date(now - proc.elapsed * 1000).toISOString() : null,
        commandLine: proc?.command ?? null,
        memory: proc ? proc.rss * 1024 : null,
        ancestors: ancestorsOf(p.pid, processes),
      }
    })
  },
}

interface PsProcess {
  ppid: number
  /** Resident memory in KiB. */
  rss: number
  /** Seconds it runs. */
  elapsed: number
  command: string
}

/** `ps -axo pid=,ppid=,rss=,etime=,command=`: one process a line; etime is `[[dd-]hh:]mm:ss`. */
export function parsePs(output: string): Map<number, PsProcess> {
  const processes = new Map<number, PsProcess>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid, ppid, rss, days, hours, minutes, seconds, command] = match
    const elapsed = ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
    processes.set(Number(pid), { ppid: Number(ppid), rss: Number(rss), elapsed, command: command.trim() })
  }
  return processes
}

/** The chain of parents above `pid`, nearest first; stops at the first process or a loop. */
export function ancestorsOf(pid: number, processes: Map<number, Pick<PsProcess, 'ppid'>>): number[] {
  const chain: number[] = []
  let parent = processes.get(pid)?.ppid
  while (parent && parent > 1 && !chain.includes(parent)) {
    chain.push(parent)
    parent = processes.get(parent)?.ppid
  }
  return chain
}

/** A command's stdout; null when it did not run. lsof exits 1 when it found nothing. */
const stdout = (cmd: string, args: string[]) => new Promise<string | null>((resolve) => {
  execFile(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err && !out ? null : String(out)))
})

/**
 * `lsof -Fpcn` output: a `p<pid>` line, then `c<command>`, then one `n<address>:<port>`
 * line per socket. One port listened on over IPv4 and IPv6 is one entry per address.
 */
export function parseLsofListening(output: string): Array<Omit<ListeningPort, 'cwd' | 'startedAt' | 'commandLine' | 'memory' | 'ancestors'>> {
  const ports: Array<Omit<ListeningPort, 'cwd' | 'startedAt' | 'commandLine' | 'memory' | 'ancestors'>> = []
  const seen = new Set<string>()
  let pid = 0
  let command = ''
  for (const line of output.split('\n')) {
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') pid = Number(value)
    else if (field === 'c') command = value
    else if (field === 'n') {
      const at = value.lastIndexOf(':')
      const port = Number(value.slice(at + 1))
      const address = value.slice(0, at).replace(/^\[|\]$/g, '')
      const key = `${pid}:${address}:${port}`
      if (at < 0 || !Number.isInteger(port) || !pid || seen.has(key)) continue
      seen.add(key)
      ports.push({ port, address, pid, command })
    }
  }
  return ports.sort((a, b) => a.port - b.port)
}

/** `lsof -d cwd -Fpn` output: `p<pid>` then `n<folder>`. */
export function parseLsofCwd(output: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid = 0
  for (const line of output.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}

export const isMuslLinux = (): boolean => {
  try { return fs.readdirSync('/lib').some((n) => n.startsWith('ld-musl')) } catch { return false }
}
