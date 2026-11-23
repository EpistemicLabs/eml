import { describe, it, expect } from 'vitest'
import { pushMessage, sessionNotice, type SessionFacts } from '../src/domain/push-notice.js'

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  sessionId: 's1', spaceId: null, jobId: null, title: 'Push plan', project: 'eml',
  state: 'done', attention: null, resultAt: null, ...over,
})
const at = '2026-11-09T03:00:00.000Z'

describe('sessionNotice', () => {
  it('tells a question with the question itself', () => {
    const notice = sessionNotice(facts({ state: 'waiting', attention: { kind: 'question', reason: 'Own crypto or the web-push package?', at } }))
    expect(notice?.input).toEqual({ kind: 'question', title: 'Push plan', body: 'Own crypto or the web-push package?', project: 'eml', jobId: null, sessionId: 's1', spaceId: null })
  })

  it('tells a session that waits without having said why', () => {
    expect(sessionNotice(facts({ state: 'waiting' }))?.input).toMatchObject({ kind: 'question', body: 'Waiting for you' })
  })

  it('tells a failure, something to check and a new result', () => {
    expect(sessionNotice(facts({ state: 'waiting', attention: { kind: 'failed', reason: null, at } }))?.input.kind).toBe('failed')
    expect(sessionNotice(facts({ attention: { kind: 'review', reason: 'PR ready', at } }))?.input).toMatchObject({ kind: 'review', body: 'PR ready' })
    expect(sessionNotice(facts({ resultAt: at }))?.input).toMatchObject({ kind: 'done', body: 'Finished' })
    expect(sessionNotice(facts({ resultAt: at, batch: 3 }))?.input.body).toBe('All 3 workers finished')
  })

  it('tells nothing while it works, for a finished turn with nothing new, or while its batch still works', () => {
    expect(sessionNotice(facts({ state: 'working', attention: { kind: 'question', reason: null, at } }))).toBeNull()
    expect(sessionNotice(facts())).toBeNull()
    expect(sessionNotice(facts({ resultAt: at, silent: true }))).toBeNull()
  })

  it('keys a notice on the state it reports, so the same state is told once', () => {
    const first = sessionNotice(facts({ resultAt: at }))
    expect(sessionNotice(facts({ resultAt: at }))?.key).toBe(first?.key)
    expect(sessionNotice(facts({ resultAt: '2026-11-09T04:00:00.000Z' }))?.key).not.toBe(first?.key)
  })
})

describe('pushMessage', () => {
  const input = { kind: 'question' as const, title: 'Push plan', body: 'Which one?', project: 'eml', jobId: null, sessionId: 's 1', spaceId: null }

  it('says what it is, in which session and project, and opens that session', () => {
    expect(pushMessage(input, 'https://cockpit.example')).toEqual({
      web_push: 8030,
      notification: { title: 'Needs you · Push plan (eml)', body: 'Which one?', tag: 'session:s 1', navigate: 'https://cockpit.example/?session=s%201' },
    })
  })

  it('shortens a long body and falls back for a missing name or project', () => {
    const message = pushMessage({ ...input, kind: 'done', title: '', project: undefined, body: 'x'.repeat(400) }, 'https://cockpit.example')
    expect(message.notification.title).toBe('New result · Session')
    expect(message.notification.body).toHaveLength(180)
    expect(message.notification.body.endsWith('…')).toBe(true)
  })

  it('opens the cockpit for a job notice without a session', () => {
    const message = pushMessage({ ...input, kind: 'paused', sessionId: null, jobId: 'j1', title: 'Daily brief', project: undefined }, 'https://cockpit.example')
    expect(message.notification).toMatchObject({ title: 'Job paused · Daily brief', tag: 'job:j1', navigate: 'https://cockpit.example/' })
  })
})
