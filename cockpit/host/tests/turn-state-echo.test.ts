import { describe, expect, it } from 'vitest'
import { askPhrase, checkPhrase, stateEcho, type TaskStateFacts } from '../src/domain/turn-state-echo.js'
import { localTime } from '../src/domain/schedule.js'

const ZONE = 'Asia/Bangkok'
const NOW = Date.parse('2026-11-25T08:00:00Z')
const AT = '2026-11-27T03:00:00.000Z' // 10:00 in Bangkok
const local = (at: string) => localTime(at, ZONE)
const facts = (patch: Partial<TaskStateFacts> = {}): TaskStateFacts => ({ status: 'active', waits: [], schedule: null, outcome: 'none', zone: ZONE, now: NOW, people: { me: 'dev-user' }, ...patch })

describe('what the task holds after an end_turn call', () => {
  it('a wake-up the call set: the agent it is for checks back at the user\'s local time, and it is the next run', () => {
    const schedule = { at: AT, why: 'See whether Acme answered', by: 'atlas', by_session: 's1', time_zone: ZONE }
    expect(stateEcho(facts({ schedule, outcome: 'set' }))).toBe(
      `The task now — Lifecycle: open. Asks: none. Check: set, atlas checks back ${local(AT)}. Repeating: none. Next run: ${local(AT)}.`,
    )
    expect(local(AT)).toMatch(/10:00 \(Asia\/Bangkok\)$/)
  })

  it('a wake-up the call kept is named as kept, next to the owner\'s move', () => {
    const schedule = { at: AT, by: 'atlas', time_zone: ZONE }
    const waits = [{ who: 'dev-user', kind: 'do', why: 'Sign the form.', due: '2026-11-28' }]
    expect(stateEcho(facts({ schedule, outcome: 'kept', waits }))).toBe(
      `The task now — Lifecycle: open. Asks: dev-user's move: Sign the form (due 2026-11-28). Check: kept, atlas checks back ${local(AT)}. Repeating: none. Next run: ${local(AT)}.`,
    )
  })

  it('a wake-up the call removed, and a task that had none', () => {
    expect(stateEcho(facts({ outcome: 'removed' }))).toBe('The task now — Lifecycle: open. Asks: none. Check: removed, no wake-up. Repeating: none. Next run: none.')
    expect(stateEcho(facts({ outcome: 'none' }))).toBe('The task now — Lifecycle: open. Asks: none. Check: none. Repeating: none. Next run: none.')
  })

  it('a wake-up for a person is a reminder for them', () => {
    const schedule = { at: AT, why: 'Call the bank', by: 'dev-user', time_zone: ZONE }
    expect(stateEcho(facts({ schedule, outcome: 'kept' }))).toContain(`Check: kept, a reminder for dev-user at ${local(AT)}.`)
    expect(checkPhrase(schedule, ZONE, { me: 'dev-user' })).toBe(`a reminder for dev-user at ${local(AT)}`)
    // Without a by the agent checks back; without the owner known nobody's wake-up reads as a reminder.
    expect(checkPhrase({ at: AT }, ZONE, { me: 'dev-user' })).toBe(`the agent checks back ${local(AT)}`)
    expect(checkPhrase(schedule, ZONE)).toBe(`dev-user checks back ${local(AT)}`)
  })

  it('a wake-up for another owner of the task is a reminder too; one for an agent is not', () => {
    const people = { me: 'dev-user', owners: ['dev-user', 'kim'] }
    expect(checkPhrase({ at: AT, by: 'kim' }, ZONE, people)).toBe(`a reminder for kim at ${local(AT)}`)
    expect(checkPhrase({ at: AT, by: 'atlas' }, ZONE, people)).toBe(`atlas checks back ${local(AT)}`)
    expect(stateEcho(facts({ schedule: { at: AT, by: 'kim' }, outcome: 'set', people }))).toContain(`Check: set, a reminder for kim at ${local(AT)}.`)
  })

  it('names the repeating times in words with their zone, paused or ended, and the next run they give', () => {
    const schedule = { crons: ['0 8 * * 1-5'], time_zone: 'Asia/Makassar', paused: true }
    expect(stateEcho(facts({ schedule }))).toBe('The task now — Lifecycle: open. Asks: none. Check: none. Repeating: on weekdays at 08:00 (Asia/Makassar), paused. Next run: none.')
    const running = stateEcho(facts({ schedule: { crons: ['0 8 * * 1-5'], time_zone: 'Asia/Makassar' } }))
    expect(running).toContain('Repeating: on weekdays at 08:00 (Asia/Makassar).')
    // Wed 25 Nov 2026, 16:00 in Makassar: the next weekday 08:00 there is Thursday's, 07:00 in Bangkok.
    expect(running).toContain(`Next run: ${local('2026-11-26T00:00:00.000Z')}.`)
  })

  it('a closed task has no next run, whatever its schedule', () => {
    const schedule = { at: AT, by: 'atlas' }
    expect(stateEcho(facts({ status: 'resolved', schedule, outcome: 'kept' }))).toBe(`The task now — Lifecycle: closed (done). Asks: none. Check: kept, atlas checks back ${local(AT)}. Repeating: none. Next run: none.`)
    expect(stateEcho(facts({ status: 'planned' }))).toContain('Lifecycle: planned, not started.')
    expect(stateEcho(facts({ status: 'invalidated' }))).toContain('Lifecycle: closed (dropped).')
  })

  it('says each wait as a short phrase by its kind', () => {
    expect(askPhrase({ who: 'dev-user', kind: 'question', why: 'Ship it?' }, ZONE)).toBe('a question for dev-user: Ship it?')
    expect(askPhrase({ who: 'dev-user', kind: 'go', why: 'Start?' }, ZONE)).toBe("dev-user's go: Start?")
    expect(askPhrase({ who: 'dev-user', kind: 'stopped', why: 'No access.', due: '2026-11-28' }, ZONE)).toBe('stopped, for dev-user: No access')
    expect(askPhrase({ who: 'dev-user', kind: 'review', why: 'Read it.', due: AT }, ZONE)).toBe(`review for dev-user: Read it (due ${local(AT)})`)
    expect(askPhrase({ who: 'outside:Acme', kind: 'outside', why: 'Answers the offer.' }, ZONE)).toBe('waiting on Acme: Answers the offer')
    expect(askPhrase({ who: 'dev-user', kind: 'do' }, ZONE)).toBe("dev-user's move")
  })
})
