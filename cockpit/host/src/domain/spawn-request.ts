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
  /** 'job': a job's run (application/job-runner.ts) — unattended like a session's worker, also without a requester. */
  origin?: 'job'
  /** The job whose run this is (origin 'job'): what its session's channel tools act for. */
  jobId?: string
  createdAt: string
}

/** A session or a job asked for it: it runs unattended on the host, not in a tab the user opens. */
export function unattended(request: Pick<SpawnRequest, 'fromSessionId' | 'origin'>): boolean {
  return request.fromSessionId !== null || request.origin === 'job'
}
