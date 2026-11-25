import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * How far a Workflow run is, read from its journal: the agents inside a workflow
 * come through the SDK as no task of their own, so this file is the only place
 * their progress shows. Claude Code writes it to
 * `<config>/projects/<cwd slug>/<session>/subagents/workflows/<runId>/journal.jsonl`,
 * one JSON object per line: `launched`, then per agent `started` (key, agentId,
 * label, phase) and later `result` or `failed` for the same key. A retried agent
 * starts again under its key.
 */

export interface WorkflowProgress {
  running: number
  done: number
  /** The phase of the agent started last; null before any. */
  phase: string | null
}

const POLL_MS = 1_000
const NEWLINE = 0x0a

/** Folds journal lines into progress. A line that is no journal entry is skipped. */
export class JournalFold {
  // Per agent key: whether it has finished (result or failed).
  private agents = new Map<string, boolean>()
  private phase: string | null = null

  add(line: string): void {
    let entry: { type?: unknown; key?: unknown; phase?: unknown }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      return
    }
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string') return
    if (entry.type === 'started') {
      this.agents.set(entry.key, false)
      if (typeof entry.phase === 'string' && entry.phase) this.phase = entry.phase
    } else if (entry.type === 'result' || entry.type === 'failed') {
      this.agents.set(entry.key, true)
    }
  }

  progress(): WorkflowProgress {
    let done = 0
    for (const finished of this.agents.values()) if (finished) done += 1
    return { running: this.agents.size - done, done, phase: this.phase }
  }
}

/** The folder Claude Code keeps a project's sessions in: every character but a letter or digit becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Where a session's workflow runs keep their folders. */
export function workflowsDir(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', projectSlug(cwd), sessionId, 'subagents', 'workflows')
}

/** The newest run folder in `dir` made at or after `since` (ms); null when there is none yet. */
export async function newestRunDir(dir: string, since: number): Promise<string | null> {
  let best: { path: string; at: number } | null = null
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      const info = await stat(path)
      const at = info.birthtimeMs || info.ctimeMs
      if (info.isDirectory() && at >= since && (!best || at > best.at)) best = { path, at }
    } catch { /* gone meanwhile */ }
  }
  return best?.path ?? null
}

/**
 * Follows one run's journal as it grows: each read takes only what was appended
 * since the last, and keeps a last line without its newline for the next read.
 * A journal not written yet is no error; one that shrank is read again from the start.
 */
export class WorkflowJournal {
  private dir: string | null = null
  private offset = 0
  private rest: Buffer = Buffer.alloc(0)
  private fold = new JournalFold()
  private last: WorkflowProgress = { running: 0, done: 0, phase: null }

  /** `locate`: the run's folder, or null while it cannot be found yet; asked until it answers. */
  constructor(private locate: () => Promise<string | null> | string | null) {}

  /** Reads what is new: the progress when it changed, else null. */
  async poll(): Promise<WorkflowProgress | null> {
    if (!this.dir) this.dir = await this.locate()
    if (!this.dir) return null
    let file: FileHandle
    try {
      file = await open(join(this.dir, 'journal.jsonl'), 'r')
    } catch {
      return null
    }
    try {
      const { size } = await file.stat()
      if (size < this.offset) {
        this.offset = 0
        this.rest = Buffer.alloc(0)
        this.fold = new JournalFold()
      }
      if (size > this.offset) {
        const chunk = Buffer.alloc(size - this.offset)
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset)
        this.offset += bytesRead
        this.take(chunk.subarray(0, bytesRead))
      }
    } finally {
      await file.close()
    }
    const progress = this.fold.progress()
    if (progress.running === this.last.running && progress.done === this.last.done && progress.phase === this.last.phase) return null
    this.last = progress
    return progress
  }

  private take(chunk: Buffer): void {
    const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk
    const end = data.lastIndexOf(NEWLINE)
    if (end < 0) {
      this.rest = data
      return
    }
    for (const line of data.subarray(0, end).toString('utf8').split('\n')) if (line.trim()) this.fold.add(line)
    this.rest = Buffer.from(data.subarray(end + 1))
  }
}

export interface JournalWatch {
  stop(): void
}

export interface JournalWatchRequest {
  locate: () => Promise<string | null> | string | null
  onProgress: (progress: WorkflowProgress) => void
  intervalMs?: number
}

/** Polls a run's journal until stopped; the runtime stops it at the run's end or its process's exit. */
export type JournalWatcher = (request: JournalWatchRequest) => JournalWatch

export const watchWorkflowJournal: JournalWatcher = ({ locate, onProgress, intervalMs = POLL_MS }) => {
  const journal = new WorkflowJournal(locate)
  let stopped = false
  let busy = false
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const progress = await journal.poll()
      if (progress && !stopped) onProgress(progress)
    } catch { /* the next tick tries again */ } finally {
      busy = false
    }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref()
  void tick()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
