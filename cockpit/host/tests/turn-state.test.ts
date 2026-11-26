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

describe('TurnTracker.commandsOn', () => {
  const tests = { description: 'Run the tests', since: '2026-02-01T11:00:00.000Z' }
  const build = { description: 'Build the app', since: '2026-02-01T11:30:00.000Z' }

  it('carries the commands a session runs through its state changes, and drops them once none runs', () => {
    const tracker = new TurnTracker()
    const events: TurnEvent[] = []
    tracker.apply({ sessionId: 's1', state: 'working' })
    tracker.on('turn', (event: TurnEvent) => events.push(event))
    tracker.commandsOn('s1', [tests])
    expect(tracker.get('s1')?.commands).toEqual([tests])
    // Its turn ends while the command runs: done, with the command still shown.
    tracker.apply({ sessionId: 's1', state: 'done' })
    expect(tracker.get('s1')).toMatchObject({ state: 'done', commands: [tests] })
    tracker.commandsOn('s1', [tests, build])
    tracker.commandsOn('s1', [build])
    tracker.commandsOn('s1', [])
    expect(tracker.get('s1')).toEqual({ state: 'done', since: tracker.get('s1')?.since })
    expect(events.map((event) => [event.state, event.commands])).toEqual([
      ['working', [tests]], ['done', [tests]], ['done', [tests, build]], ['done', [build]], ['done', undefined],
    ])
  })

  it('keeps what a working session waits on beside its commands, and says nothing when nothing changed', () => {
    const tracker = new TurnTracker()
    const events: TurnEvent[] = []
    tracker.apply({ sessionId: 's1', state: 'working' })
    tracker.waitOn('s1', 1)
    tracker.on('turn', (event: TurnEvent) => events.push(event))
    tracker.commandsOn('s1', [tests])
    tracker.commandsOn('s1', [{ ...tests }])
    expect(tracker.get('s1')).toMatchObject({ helpers: 1, commands: [tests] })
    tracker.waitOn('s1', 0)
    expect(tracker.get('s1')?.commands).toEqual([tests])
    expect(events).toHaveLength(2)
  })

  it('has no commands for a session it does not know, nor after the session is gone', () => {
    const tracker = new TurnTracker()
    tracker.commandsOn('s1', [tests])
    expect(tracker.get('s1')).toBeUndefined()
    tracker.apply({ sessionId: 's1', state: 'working' })
    tracker.commandsOn('s1', [tests])
    tracker.forget('s1')
    tracker.apply({ sessionId: 's1', state: 'working' })
    expect(tracker.get('s1')?.commands).toBeUndefined()
  })
})
