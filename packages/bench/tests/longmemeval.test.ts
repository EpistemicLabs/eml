import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { describe, it, expect } from 'vitest'
import { splitTopLevelObjects, chronological, batches, recentSessions, bm25Sessions, stratifiedSample, LME_TYPES, type LmeQuestion } from '../src/longmemeval'

const question = (dates: string[]): LmeQuestion => ({
  question_id: 'q1', question_type: 'multi-session', question: '?', question_date: '2023/06/01 (Thu) 10:00', answer: 'a',
  haystack_dates: dates,
  haystack_sessions: dates.map(d => [{ role: 'user', content: `said on ${d}` }]),
})

describe('splitTopLevelObjects', () => {
  it('yields each element, also across chunk borders and with brackets and escapes in strings', async () => {
    const items = [
      { id: 'a', text: 'brace } and [ bracket', nested: [{ x: '"quoted"' }] },
      { id: 'b', text: 'backslash \\ then quote \\"', long: 'ü'.repeat(3 << 20) },
      { id: 'c', list: [[1, 2], { y: '{' }] },
    ]
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lme-split-')), 'data.json')
    fs.writeFileSync(file, JSON.stringify(items))
    const got: unknown[] = []
    const hash = crypto.createHash('sha256')
    await splitTopLevelObjects(file, hash, b => got.push(JSON.parse(b.toString('utf8'))))
    expect(got).toEqual(items)
    expect(hash.digest('hex')).toBe(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
  })
})

describe('history order', () => {
  const q = question(['2023/05/20 (Sat) 02:21', '2023/05/01 (Mon) 09:00', '2023/05/20 (Sat) 01:00'])

  it('sorts the sessions by date', () => {
    expect(chronological(q).map(s => s.split('\n')[0])).toEqual([
      '### Chat session, 2023/05/01 (Mon) 09:00',
      '### Chat session, 2023/05/20 (Sat) 01:00',
      '### Chat session, 2023/05/20 (Sat) 02:21',
    ])
  })

  it('batches in date order without splitting a session', () => {
    const one = chronological(q)[0].length
    const bs = batches(q, one + 1)
    expect(bs.flat()).toEqual(chronological(q))
    expect(bs.length).toBe(3)
  })

  it('recent-context keeps the newest sessions that fit, oldest first', () => {
    const all = chronological(q)
    expect(recentSessions(q, all[1].length + all[2].length)).toEqual([all[1], all[2]])
    expect(recentSessions(q, 1)).toEqual([])
  })

  it('bm25-context keeps the best-matching sessions that fit, in date order', () => {
    const hs = (contents: string[]): LmeQuestion => ({
      ...question(contents.map((_, i) => `2023/05/0${i + 1} (Mon) 10:00`)),
      question: 'Which guitar did I buy?',
      haystack_sessions: contents.map(c => [{ role: 'user' as const, content: c }]),
    })
    const h = hs(['I bought a red guitar today', 'the weather is nice', 'my guitar teacher is great', 'we talked about soup'])
    const all = chronological(h)
    const both = all[0].length + all[2].length
    expect(bm25Sessions(h, both)).toEqual([all[0], all[2]])
    expect(bm25Sessions(h, all[0].length)).toEqual([all[0]])
    expect(bm25Sessions(h, 1)).toEqual([])
  })
})

describe('stratifiedSample', () => {
  it('takes n per type, the same ids however the input is ordered', () => {
    const index = LME_TYPES.flatMap(t => Array.from({ length: 5 }, (_, i) => ({ question_id: `${t}-${i}`, question_type: t })))
    const a = stratifiedSample(index, 2)
    const b = stratifiedSample([...index].reverse(), 2)
    expect(a.length).toBe(LME_TYPES.length * 2)
    expect(a.map(q => q.question_id).sort()).toEqual(b.map(q => q.question_id).sort())
    expect(stratifiedSample(index, 3).map(q => q.question_id)).toEqual(expect.arrayContaining(a.map(q => q.question_id)))
  })
})
