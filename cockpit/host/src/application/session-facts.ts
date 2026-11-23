import type { SessionFacts } from '../domain/push-notice.js'
import type { NotificationInput } from '../notifications.js'
import type { SessionLedger } from '../session-ledger.js'
import type { TurnTracker } from '../turn-state.js'
import { turnNotice } from './turn-notice.js'

export interface SessionFactsDeps {
  ledger: Pick<SessionLedger, 'get' | 'list'>
  turns: Pick<TurnTracker, 'get'>
  /** A project's name in its space; undefined when the registry does not know it. */
  projectName(spaceId: string | null, projectId: string | null): string | undefined
}

/** What a push about this session needs to know; null for a session the ledger does not know. */
export function sessionFacts(deps: SessionFactsDeps, sessionId: string): SessionFacts | null {
  const entry = deps.ledger.get(sessionId)
  if (!entry) return null
  const state = deps.turns.get(sessionId)?.state ?? 'idle'
  const notice = turnNotice(deps, { sessionId, state, since: '' })
  return {
    sessionId, spaceId: entry.spaceId ?? null, jobId: entry.jobId ?? null, title: notice.title,
    project: deps.projectName(entry.spaceId ?? null, entry.projectId) ?? null, state, attention: entry.attention, resultAt: entry.resultAt,
    ...(notice.batch ? { batch: notice.batch } : {}), ...(notice.silent ? { silent: true } : {}),
  }
}

/** A notice about a session names its project, unless the producer already did. */
export function withProject(deps: Pick<SessionFactsDeps, 'ledger' | 'projectName'>, input: NotificationInput): NotificationInput {
  if (input.project || !input.sessionId) return input
  const entry = deps.ledger.get(input.sessionId)
  const project = entry && deps.projectName(entry.spaceId ?? null, entry.projectId)
  return project ? { ...input, project } : input
}
