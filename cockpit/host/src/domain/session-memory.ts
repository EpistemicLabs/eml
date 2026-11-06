/**
 * A memory ceiling per session. Each session's process tree (the agent CLI, its
 * MCP servers, every tool it runs) gets a group of its own with a limit, so a
 * runaway process is stopped inside its session before it pushes the whole
 * machine out of memory. The kernel then kills the largest process of that
 * group, normally the runaway tool; the session itself carries on and sees the
 * tool fail.
 *
 * Domain layer: the interface only. Linux does it with cgroups under the
 * autostart service (infrastructure/platform/linux-cgroups.ts); elsewhere
 * sessions run without one.
 */

export interface SessionLimits {
  /** RAM a session's processes may use together; null: no ceiling. */
  memoryBytes: number | null
  /** Swap they may use on top of it. */
  swapBytes: number
}

export interface SessionMemory {
  /** Why sessions run without a ceiling here; null when they get one. */
  readonly unavailable: string | null
  /** Put a session's freshly started process into the session's group. False: it runs without a ceiling. */
  place(sessionId: string, pid: number, limits: SessionLimits): boolean
  /** How many processes the kernel has killed in the session's group for hitting its ceiling. */
  oomKills(sessionId: string): number
  /** The session's process is gone: remove its group once nothing runs in it. */
  release(sessionId: string): void
}

export function noSessionMemory(why: string): SessionMemory {
  return {
    unavailable: why,
    place: () => false,
    oomKills: () => 0,
    release: () => {},
  }
}

const GB = 1024 ** 3

/** "2 GB", "1.5 GB" */
export function formatBytes(bytes: number): string {
  return `${Number((bytes / GB).toFixed(1))} GB`
}

/** What a session shows when the kernel stopped one of its processes at the ceiling. */
export function ceilingNotice(kills: number, limits: SessionLimits): string {
  const ceiling = limits.memoryBytes === null ? 'its memory ceiling' : `its memory ceiling of ${formatBytes(limits.memoryBytes)}`
  const what = kills === 1 ? 'A process of this session was stopped' : `${kills} processes of this session were stopped`
  return `${what}: it hit ${ceiling}. The rest of the machine was not affected. Settings › Preferences › Sessions sets the ceiling.`
}
