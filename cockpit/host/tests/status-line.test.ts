import { describe, expect, it } from 'vitest'
import { firstSentence, statusLine, STATUS_LINE_MAX } from '../src/domain/status-line.js'

const AT = '2026-11-23T10:48:00.000Z'

describe('the status line of a task', () => {
  it('is the first sentence of the newest handoff\'s Result, with its Next', () => {
    const text = '### Handoff\nResult: #171 and #298 are merged and widget v1.111.0 is published; both deploys are still running. CI was green.\nChecked: CI\nNext: Atlas confirms both deploys and the live widget file.'
    expect(statusLine({ text, at: AT })).toEqual({
      now: '#171 and #298 are merged and widget v1.111.0 is published; both deploys are still running',
      next: 'Atlas confirms both deploys and the live widget file',
      at: AT,
    })
  })

  it('falls back to the note\'s first sentence when the note is no handoff', () => {
    expect(statusLine({ text: 'Mockup v1 published. Questions sent.', at: AT })).toEqual({ now: 'Mockup v1 published', next: null, at: AT })
    expect(statusLine({ text: '## Progress\n- Started the build. More later.', at: AT })?.now).toBe('Started the build')
  })

  it('is null without a note', () => {
    expect(statusLine(null)).toBeNull()
    expect(statusLine({ text: '   ', at: AT })).toBeNull()
  })

  it('cuts a long sentence at a word and marks the cut', () => {
    const long = `${'word '.repeat(40)}end.`
    const line = firstSentence(long)
    expect(line.length).toBeLessThanOrEqual(STATUS_LINE_MAX + 1)
    expect(line.endsWith('…')).toBe(true)
    expect(line).not.toMatch(/\s…$/)
  })

  it('keeps version numbers and decimals inside a sentence', () => {
    expect(firstSentence('Released v1.111.0 with 2.5x faster loads. Next step later.')).toBe('Released v1.111.0 with 2.5x faster loads')
  })
})

import { displayTitleOf } from '../src/domain/task-title.js'

describe('a display title from a name a person or a session gave', () => {
  it('keeps the words as written, on one line', () => {
    expect(displayTitleOf('  Builder dock long thread archive\nlistener preview AB test fix ')).toBe('Builder dock long thread archive listener preview AB test fix')
  })
  it('cuts at a word past 80 characters', () => {
    const t = displayTitleOf(`${'Long words '.repeat(12)}end`)!
    expect(t.length).toBeLessThanOrEqual(80)
    expect(t.endsWith('…')).toBe(true)
  })
  it('gives nothing for a kebab anchor or too little text', () => {
    expect(displayTitleOf('media-viewer')).toBeNull()
    expect(displayTitleOf('ab')).toBeNull()
  })
})
