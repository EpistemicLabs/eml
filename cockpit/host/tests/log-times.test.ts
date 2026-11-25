import { describe, it, expect } from 'vitest'
import { logTime, newestOfEach, stampLines, timeLines, withoutLogTime } from '../src/log-times.js'

const T = '2026-11-25T09:00:37Z'

describe('logTime', () => {
  it('is UTC to the second', () => {
    expect(logTime(new Date('2026-11-25T09:00:37.891Z'))).toBe(T)
  })
})

describe('stampLines', () => {
  it('puts the time before a line', () => {
    expect(stampLines('[board] refresh failed\n', T, true)).toEqual({ text: `${T} [board] refresh failed\n`, atLineStart: true })
  })

  it('puts it before every line of a text with several (a brain server\'s output arrives in one piece)', () => {
    expect(stampLines('[brain] one\ntwo\n', T, true).text).toBe(`${T} [brain] one\n${T} two\n`)
  })

  it('goes on in a line the text before left open, and says when it leaves one open itself', () => {
    const first = stampLines('half a ', T, true)
    expect(first).toEqual({ text: `${T} half a `, atLineStart: false })
    expect(stampLines('line\nnext', T, first.atLineStart)).toEqual({ text: `line\n${T} next`, atLineStart: false })
  })

  it('leaves an empty line empty', () => {
    expect(stampLines('a\n\nb\n', T, true).text).toBe(`${T} a\n\n${T} b\n`)
  })

  it('writes nothing for nothing', () => {
    expect(stampLines('', T, true)).toEqual({ text: '', atLineStart: true })
    expect(stampLines('', T, false)).toEqual({ text: '', atLineStart: false })
  })
})

describe('withoutLogTime', () => {
  it('gives the line without its time, and a line from before the times as it is', () => {
    expect(withoutLogTime(`${T} [board] refresh failed`)).toBe('[board] refresh failed')
    expect(withoutLogTime('[board] refresh failed')).toBe('[board] refresh failed')
  })
})

describe('newestOfEach', () => {
  it('keeps each text once, as the line it came with last', () => {
    expect(newestOfEach([
      '2026-11-25T09:00:00Z [board] refresh failed',
      '2026-11-25T09:00:05Z [push] persist failed',
      '2026-11-25T09:01:00Z [board] refresh failed',
      '[board] an old line without a time',
    ])).toEqual([
      '2026-11-25T09:00:05Z [push] persist failed',
      '2026-11-25T09:01:00Z [board] refresh failed',
      '[board] an old line without a time',
    ])
  })
})

describe('timeLines', () => {
  /** A stream that keeps what it is given, and calls back as a stream does. */
  function fakeStream() {
    const written: unknown[] = []
    const stream = {
      write(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
        written.push(chunk)
        const done = typeof encoding === 'function' ? encoding : cb
        if (typeof done === 'function') (done as () => void)()
        return true
      },
    }
    let at = Date.parse('2026-11-25T09:00:37.000Z')
    timeLines(stream as never, () => new Date(at))
    const write = stream.write as (chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => boolean
    return { write, text: () => written.join(''), written, tick: (ms: number) => { at += ms } }
  }

  it('puts the time before a line written as text', () => {
    const s = fakeStream()
    expect(s.write('[board] refresh failed\n')).toBe(true)
    expect(s.text()).toBe(`${T} [board] refresh failed\n`)
  })

  it('hands text on as text, also when it came as bytes', () => {
    const s = fakeStream()
    s.write(Buffer.from('[brain] started\n'))
    expect(s.written).toEqual([`${T} [brain] started\n`])
  })

  it('puts a character that arrives in two pieces together again', () => {
    const s = fakeStream()
    const bytes = Buffer.from('[brain] Küche & Co — ok\n')
    const cut = bytes.indexOf(0xc3) + 1 // inside the ü
    s.write(new Uint8Array(bytes.subarray(0, cut)))
    s.write(new Uint8Array(bytes.subarray(cut)))
    expect(s.text()).toBe(`${T} [brain] Küche & Co — ok\n`)
  })

  it('gives two writes that share a line one time, and the next line its own', () => {
    const s = fakeStream()
    s.write('[chat] starting ')
    s.tick(5000)
    s.write('worker 85f1bb7e\n')
    s.write('[chat] started\n')
    expect(s.text()).toBe(`${T} [chat] starting worker 85f1bb7e\n2026-11-25T09:00:42Z [chat] started\n`)
  })

  it('calls back, with and without an encoding in front', () => {
    const s = fakeStream()
    let called = 0
    s.write('a\n', () => { called++ })
    s.write('b\n', 'utf8', () => { called++ })
    s.write(Buffer.from('c\n'), () => { called++ })
    expect(called).toBe(3)
    expect(s.text()).toBe(`${T} a\n${T} b\n${T} c\n`)
  })
})
