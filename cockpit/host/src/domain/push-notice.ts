import type { NotificationInput, NotificationKind } from '../notifications.js'
import type { TurnState } from './agent-provider.js'
import type { WorkerStatus } from './session-attention.js'

/** What the host knows of a session once its turn state has settled. */
export interface SessionFacts {
  sessionId: string
  spaceId: string | null
  jobId: string | null
  /** Its name, as the lists show it; null when it has none yet. */
  title: string | null
  project: string | null
  state: TurnState
  attention: { kind: WorkerStatus; reason: string | null; at: string } | null
  resultAt: string | null
  /** The size of the batch of workers this one closes. */
  batch?: number
  /** Others of its batch still work. */
  silent?: boolean
}

/**
 * What a session's settled state tells the user, as the review section shows
 * it: Needs you (a question, a failure, waiting), Check this, or a new result.
 * `key` names the state told, so the same state is never told twice.
 */
export function sessionNotice(facts: SessionFacts): { input: NotificationInput; key: string } | null {
  if (facts.state !== 'waiting' && facts.state !== 'done') return null
  const attention = facts.attention
  let kind: NotificationKind
  let body: string
  let since: string
  if (attention && (attention.kind === 'question' || attention.kind === 'failed')) {
    kind = attention.kind
    body = attention.reason ?? (kind === 'failed' ? 'Something went wrong' : 'Waiting for you')
    since = attention.at
  } else if (facts.state === 'waiting') {
    kind = 'question'
    body = 'Waiting for you'
    since = 'waiting'
  } else if (attention?.kind === 'review') {
    kind = 'review'
    body = attention.reason ?? 'Ready to check'
    since = attention.at
  } else if (facts.resultAt && !facts.silent) {
    kind = 'done'
    body = (attention?.kind === 'done' ? attention.reason : null) ?? (facts.batch && facts.batch > 1 ? `All ${facts.batch} workers finished` : 'Finished')
    since = facts.resultAt
  } else {
    return null
  }
  return {
    input: { kind, title: facts.title ?? '', body, project: facts.project ?? undefined, jobId: facts.jobId, sessionId: facts.sessionId, spaceId: facts.spaceId },
    key: `${kind}:${since}`,
  }
}

const WORD: Record<NotificationKind, string> = {
  question: 'Needs you', failed: 'Needs you', review: 'Check this', done: 'New result', missed: 'Missed run', paused: 'Job paused',
}

/** iOS shows about four lines on the lock screen; a push message also has to stay well under 4 KB. */
const BODY_LIMIT = 180

/**
 * The message a device shows, in the Declarative Web Push format: Safari can
 * show it without the service worker, other browsers hand it to the worker.
 */
export function pushMessage(input: NotificationInput, origin: string): { web_push: 8030; notification: { title: string; body: string; tag: string; navigate: string } } {
  const name = input.title.trim() || (input.sessionId ? 'Session' : 'Job')
  const title = `${WORD[input.kind]} · ${name}${input.project ? ` (${input.project})` : ''}`
  const body = input.body.length > BODY_LIMIT ? `${input.body.slice(0, BODY_LIMIT - 1)}…` : input.body
  const tag = input.sessionId ? `session:${input.sessionId}` : input.jobId ? `job:${input.jobId}` : 'cockpit'
  const navigate = `${origin}/${input.sessionId ? `?session=${encodeURIComponent(input.sessionId)}` : ''}`
  return { web_push: 8030, notification: { title, body, tag, navigate } }
}
