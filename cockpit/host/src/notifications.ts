/**
 * How the cockpit tells its user something when they are not looking: a job's
 * run that needs them, a run that failed, a job that paused itself. Everything
 * that tells goes through a Notifier; web push to the phone becomes its
 * implementation. Inside the cockpit the review section shows the same through
 * the sessions' own state (Needs you, Check this), so there is no feed here.
 */

export type NotificationKind = 'review' | 'question' | 'failed' | 'done' | 'missed' | 'paused'

export interface NotificationInput {
  kind: NotificationKind
  /** One line: the job's or session's name. */
  title: string
  /** What happened, as the user reads it. */
  body: string
  jobId: string | null
  /** The session that has the result, if any. */
  sessionId: string | null
  /** The brain space it belongs to; null = main. */
  spaceId: string | null
}

export interface Notifier {
  notify(input: NotificationInput): void
}

/** Until a push channel exists: nothing leaves the host. */
export const noNotifier: Notifier = { notify: () => {} }
