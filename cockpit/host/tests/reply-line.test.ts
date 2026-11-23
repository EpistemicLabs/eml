import { describe, expect, it } from 'vitest'
import { replyLine } from '../src/domain/reply-line.js'

describe('replyLine', () => {
  it('takes the first line of plain text', () => {
    expect(replyLine('The fold is built.\nMore detail.')).toBe('The fold is built.')
  })

  it('skips headings, rules, bold labels, tables and code blocks', () => {
    const text = ['## Status', '---', '**What is done**', '| a | b |', '```ts', 'const x = 1', '```', '', 'Everything passes.'].join('\n')
    expect(replyLine(text)).toBe('Everything passes.')
  })

  it('drops list markers, quote marks and inline emphasis', () => {
    expect(replyLine('- **Fix:** run `npm test` again')).toBe('Fix: run npm test again')
    expect(replyLine('> 1. Quoted step')).toBe('Quoted step')
  })

  it('shortens a long line', () => {
    const line = replyLine('x'.repeat(300))!
    expect(line).toHaveLength(200)
    expect(line.endsWith('…')).toBe(true)
  })

  it('is null when nothing reads as text', () => {
    expect(replyLine('## Only a heading\n\n---')).toBeNull()
    expect(replyLine('')).toBeNull()
  })
})
