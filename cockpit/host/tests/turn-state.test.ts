import { describe, expect, it } from 'vitest'
import { TurnTracker, type TurnEvent } from '../src/turn-state.js'

describe('TurnTracker.waitOn', () => {
  const working = () => {
    const tracker = new TurnTracker()
    const events: TurnEvent[] = []
    tracker.apply({ sessionId: 's1', state: 'working' })
    tracker.on('turn', (event: TurnEvent) => events.push(event))
    return { tracker, events }
  }
  const review = { name: 'review-changes', running: 3, done: 4 }

  it('carries the workflow runs a working session waits on beside its subagents, and leaves them out when there are none', () => {
    const { tracker, events } = working()
    const since = tracker.get('s1')?.since
    tracker.waitOn('s1', 2, [review])
    expect(tracker.get('s1')).toEqual({ state: 'working', since, helpers: 2, workflows: [review] })
    tracker.waitOn('s1', 0, [review])
    expect(tracker.get('s1')).toEqual({ state: 'working', since, workflows: [review] })
    tracker.waitOn('s1', 0, [])
    expect(tracker.get('s1')).toEqual({ state: 'working', since })
    expect(events.map((event) => [event.helpers, event.workflows])).toEqual([[2, [review]], [undefined, [review]], [undefined, undefined]])
  })

  it('says a run\'s progress, and nothing when nothing changed', () => {
    const { tracker, events } = working()
    tracker.waitOn('s1', 0, [review])
    tracker.waitOn('s1', 0, [{ ...review }])
    tracker.waitOn('s1', 0, [{ ...review, running: 2, done: 5 }])
    expect(events.map((event) => event.workflows)).toEqual([[review], [{ ...review, running: 2, done: 5 }]])
  })

  it('a session that is not working waits on nothing', () => {
    const tracker = new TurnTracker()
    tracker.waitOn('s1', 0, [review])
    expect(tracker.get('s1')).toBeUndefined()
    tracker.apply({ sessionId: 's1', state: 'done' })
    tracker.waitOn('s1', 0, [review])
    expect(tracker.get('s1')?.workflows).toBeUndefined()
  })
})
