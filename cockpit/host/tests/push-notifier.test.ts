import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PushNotifier, notifySessions } from '../src/application/push-notifier.js'
import type { NotificationInput } from '../src/notifications.js'
import type { PushDevice } from '../src/push-store.js'
import type { SessionFacts } from '../src/domain/push-notice.js'

const device = (id: string): PushDevice => ({ id, endpoint: `https://push.example/${id}`, p256dh: 'k', auth: 'a', origin: 'https://cockpit.example', label: id, createdAt: '' })
const input = (over: Partial<NotificationInput> = {}): NotificationInput => ({ kind: 'question', title: 'Push plan', body: 'Which one?', jobId: null, sessionId: 's1', spaceId: null, ...over })

function setup(status: (device: PushDevice) => number = () => 201) {
  let now = 1_000_000
  const devices = [device('phone'), device('mac')]
  const sent: { device: string; message: unknown; urgency: string; topic: string }[] = []
  const forgotten: string[] = []
  const lines: string[] = []
  const notifier = new PushNotifier({
    devices: () => devices.filter((entry) => !forgotten.includes(entry.endpoint)),
    send: async (target, payload, options) => { sent.push({ device: target.id, message: JSON.parse(payload.toString()), urgency: options.urgency, topic: options.topic }); return status(target) },
    forget: (endpoint) => forgotten.push(endpoint),
    log: (line) => lines.push(line),
    now: () => now,
  })
  return { notifier, sent, forgotten, lines, tick: (ms: number) => { now += ms } }
}

describe('PushNotifier', () => {
  it('sends the message to every device, with the session to open on that device\'s cockpit', async () => {
    const { notifier, sent } = setup()
    await notifier.deliver(input())
    expect(sent.map((entry) => entry.device)).toEqual(['phone', 'mac'])
    expect(sent[0]).toMatchObject({ urgency: 'high', message: { notification: { title: 'Needs you · Push plan', navigate: 'https://cockpit.example/?session=s1' } } })
    expect(sent[0].topic).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('stays quiet about a session the user looked at within the last minute', async () => {
    const { notifier, sent, tick } = setup()
    notifier.watching(['s1'])
    tick(30_000)
    await notifier.deliver(input())
    expect(sent).toHaveLength(0)
    tick(31_000)
    await notifier.deliver(input())
    expect(sent).toHaveLength(2)
  })

  it('tells the same thing about the same session once within two minutes', async () => {
    const { notifier, sent, tick } = setup()
    await notifier.deliver(input())
    await notifier.deliver(input({ body: 'said again by its job' }))
    expect(sent).toHaveLength(2)
    await notifier.deliver(input({ kind: 'review' }))
    expect(sent).toHaveLength(4)
    tick(121_000)
    await notifier.deliver(input())
    expect(sent).toHaveLength(6)
  })

  it('forgets a device its push service says is gone, and logs ids and outcomes, never the text', async () => {
    const { notifier, forgotten, lines } = setup((target) => (target.id === 'mac' ? 410 : 201))
    await notifier.deliver(input())
    expect(forgotten).toEqual(['https://push.example/mac'])
    expect(lines.join('\n')).not.toContain('Which one?')
    expect(lines.join('\n')).not.toContain('Push plan')
    expect(lines.at(-1)).toMatch(/kind=question .*sent=1 gone=1 failed=0/)
  })

  it('never throws into the caller when sending fails', async () => {
    const notifier = new PushNotifier({
      devices: () => [device('phone')], send: async () => { throw new Error('offline') }, forget: () => {}, log: () => {}, now: () => 0,
    })
    expect(() => notifier.notify(input())).not.toThrow()
    await expect(notifier.deliver(input({ sessionId: 's2' }))).resolves.toEqual({ sent: 0, gone: 0, failed: 1 })
  })

  it('sends only to the device in use while the user works on one, and to all again once it went quiet', async () => {
    const { notifier, sent, tick } = setup()
    notifier.present('https://push.example/mac')
    await notifier.deliver(input())
    expect(sent.map((entry) => entry.device)).toEqual(['mac'])
    tick(91_000)
    await notifier.deliver(input({ sessionId: 's2' }))
    expect(sent.map((entry) => entry.device)).toEqual(['mac', 'phone', 'mac'])
  })

  it('stays quiet while the user works in a cockpit that gets no pushes itself', async () => {
    const { notifier, sent } = setup()
    notifier.present(null)
    await notifier.deliver(input())
    expect(sent).toHaveLength(0)
  })

  it('sends a test to one device only', async () => {
    const { notifier, sent } = setup()
    expect(await notifier.test('https://push.example/mac')).toBe('sent')
    expect(sent.map((entry) => entry.device)).toEqual(['mac'])
    expect(await notifier.test('https://push.example/unknown')).toBe('unknown')
  })
})

describe('notifySessions', () => {
  afterEach(() => { vi.useRealTimers() })

  const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
    sessionId: 's1', spaceId: null, jobId: null, title: 'Push plan', project: 'eml', state: 'waiting',
    attention: { kind: 'question', reason: 'Which one?', at: '2026-11-09T03:00:00.000Z' }, resultAt: null, ...over,
  })

  function wire(current: () => SessionFacts | null) {
    vi.useFakeTimers()
    const turns = new EventEmitter()
    const told: NotificationInput[] = []
    notifySessions({ turns, facts: current, notifier: { notify: (entry) => told.push(entry) } })
    return { told, turn: (state: string) => turns.emit('turn', { sessionId: 's1', state, since: '' }) }
  }

  it('tells a session\'s state once it has settled, and the same state only once', () => {
    let now = facts()
    const { told, turn } = wire(() => now)
    turn('waiting')
    expect(told).toHaveLength(0)
    vi.advanceTimersByTime(3_000)
    expect(told).toMatchObject([{ kind: 'question', body: 'Which one?', project: 'eml' }])
    turn('waiting')
    vi.advanceTimersByTime(3_000)
    expect(told).toHaveLength(1)
    now = facts({ state: 'done', attention: null, resultAt: '2026-11-09T03:05:00.000Z' })
    turn('done')
    vi.advanceTimersByTime(3_000)
    expect(told.map((entry) => entry.kind)).toEqual(['question', 'done'])
  })

  it('tells nothing when the session went back to work before it settled', () => {
    let now = facts()
    const { told, turn } = wire(() => now)
    turn('waiting')
    now = facts({ state: 'working' })
    turn('working')
    vi.advanceTimersByTime(3_000)
    expect(told).toHaveLength(0)
  })
})
