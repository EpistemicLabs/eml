import type { ProviderId } from './agent-provider.js'
import type { ToolProfile } from './tool-profile.js'

/** A request for a worker session (spawn-queue.ts holds them until someone takes one). */
export interface SpawnRequest {
  /** Also the worker's session id: the page opens the pane under it (spawn-api.ts returns the worker's address from it). */
  id: string
  /** Registry project id the worker runs in (`bp-<brain id>` or a folder id). */
  projectId: string
  prompt: string
  title: string | null
  /** The agent CLI the worker runs with (a provider id); unset → the user's default. */
  provider?: ProviderId
  /** The requesting session — the worker opens on its desk, next to its pane. */
  fromSessionId: string | null
  /** The brain space the worker runs in (the requester's). Absent = main (the host's own spawns, onboarding.ts). */
  spaceId?: string
  /**
   * 'replace-empty-desk' (first run, onboarding.ts): if the active desk holds
   * only its untouched starting terminal, the pane takes its place and the
   * cockpit switches to the desk. Default: added next to the requester.
   */
  placement?: 'append' | 'replace-empty-desk'
  /** Open a pane for it. Without this a worker a session asked for runs without one and shows under its parent. */
  open?: boolean
  /** An outside service may send the worker messages. */
  wakeable?: boolean
  /** What the worker may use; its limits hold only in the chat runtime or a host-started process. */
  toolProfile?: ToolProfile
  /**
   * 'job': a job's run (application/job-runner.ts); 'runner': a plan step the
   * task runner started (application/task-runner.ts). Both unattended like a
   * session's worker, also without a requester. 'split': a topic the user split
   * off a session (application/split-session.ts): their own session, not a
   * worker, though it remembers the session it came from. 'task': a session of
   * the user's own on a task, started from the page (a task row, Advance task).
   */
  origin?: 'job' | 'runner' | 'split' | 'task'
  /** The desk the page should open the pane on (a page id; the page falls back to the active desk). */
  deskId?: string
  /** The brain task the session works on from its first hook (task system). */
  taskId?: string
  /** The job whose run this is (origin 'job'): what its session's channel tools act for. */
  jobId?: string
  createdAt: string
}

/** A session or a job asked for it: it runs unattended on the host, not in a tab the user opens. */
/**
 * Whether a terminal session launches unattended: a worker does, and so does one opened with a prompt
 * (an outside command), except a topic the user split off, which is their own.
 */
export function launchesUnattended(session: { worker: boolean; initialPrompt: boolean; own: boolean }): boolean {
  return session.worker || (session.initialPrompt && !session.own)
}

/** The user's own session that the host still starts (a split, a session on a task): it opens in chat when chat is their view. */
export function ownStart(request: Pick<SpawnRequest, 'origin'>): boolean {
  return request.origin === 'split' || request.origin === 'task'
}

export function unattended(request: Pick<SpawnRequest, 'fromSessionId' | 'origin'>): boolean {
  if (request.origin === 'split' || request.origin === 'task') return false
  return request.fromSessionId !== null || request.origin === 'job' || request.origin === 'runner'
}
