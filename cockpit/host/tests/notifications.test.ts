import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotificationFeed, allOf, type NotificationInput } from '../src/notifications.js'

// What the cockpit tells its user waits under the bell until it is read,
// across restarts; a push channel would be one more notifier beside it.

const input = (title: string): NotificationInput => ({ kind: 'review', title, body: 'Run 1: done', jobId: null, sessionId: null, spaceId: null })

describe('notification feed', () => {
  it('keeps the newest first, counts unread, and survives a restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'feed-')), 'notifications.json')
    const feed = new NotificationFeed(file)
    const seen: string[] = []
    feed.on('notification', (item) => seen.push(item.title))
    feed.notify(input('first'))
    feed.notify(input('second'))
    expect(feed.list().map((item) => item.title)).toEqual(['second', 'first'])
    expect(seen).toEqual(['first', 'second'])
    feed.markRead([feed.list()[1].id])
    expect(feed.unread()).toBe(1)
    const again = new NotificationFeed(file)
    expect(again.unread()).toBe(1)
    again.markRead()
    expect(again.unread()).toBe(0)
  })

  it('tells every notifier it joins', () => {
    const told: string[] = []
    allOf({ notify: (n) => told.push(`a:${n.title}`) }, { notify: (n) => told.push(`b:${n.title}`) }).notify(input('x'))
    expect(told).toEqual(['a:x', 'b:x'])
  })
})
