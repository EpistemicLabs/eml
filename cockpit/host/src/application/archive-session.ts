/** What archiving needs to know about one session. */
export interface ArchiveFacts {
  sessionId: string
  parentSessionId: string | null
  /** In a turn right now: archiving would cut it off. */
  working: boolean
  /** Holds a question or a failure nobody has dealt with. */
  needsAnswer: boolean
}

export type ArchivePlan = { archive: string[] } | { blockedBy: string; reason: 'working' | 'needs-answer' }

/**
 * Archiving a session takes the workers it started with it. It waits while it or
 * one of them still works, or while a worker below it holds a question: those would
 * disappear unanswered. Its own open question is the user's to drop.
 */
export function planArchive(sessionId: string, sessions: ArchiveFacts[]): ArchivePlan {
  const self = sessions.find((session) => session.sessionId === sessionId)
  if (!self) return { archive: [] }
  if (self.working) return { blockedBy: sessionId, reason: 'working' }
  const archive = [sessionId]
  for (let i = 0; i < archive.length; i += 1) {
    for (const child of sessions) {
      if (child.parentSessionId !== archive[i] || archive.includes(child.sessionId)) continue
      if (child.working) return { blockedBy: child.sessionId, reason: 'working' }
      if (child.needsAnswer) return { blockedBy: child.sessionId, reason: 'needs-answer' }
      archive.push(child.sessionId)
    }
  }
  return { archive }
}
