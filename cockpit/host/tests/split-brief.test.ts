import { describe, it, expect } from 'vitest'
import { BRIEF_TURNS, briefPrompt, createSplitBrief, parseBrief, turnsFrom, type TranscriptEvent } from '../src/application/split-brief.js'

const transcript: TranscriptEvent[] = [
  { kind: 'user_message', id: 'u1', text: 'remove the projects from the sidebar' },
  { kind: 'tool_call', id: 'tc' },
  { kind: 'text', blockId: 'a1:0', text: 'Done in version 4.' },
  { kind: 'text', blockId: 'a1:1', text: 'New session sits at the top.' },
  { kind: 'user_message', id: 'u2', text: 'how about viewing media in the cockpit? images, pdf' },
  { kind: 'text', blockId: 'a2:0', text: 'Files could open where they are mentioned.' },
  { kind: 'user_message', id: 'u3', text: 'back to the sidebar' },
]

describe('the split brief', () => {
  it('reads user and agent text up to the picked message, joining an agent\'s blocks', () => {
    expect(turnsFrom(transcript, 'a2')).toEqual([
      { role: 'user', text: 'remove the projects from the sidebar' },
      { role: 'assistant', text: 'Done in version 4.\nNew session sits at the top.' },
      { role: 'user', text: 'how about viewing media in the cockpit? images, pdf' },
      { role: 'assistant', text: 'Files could open where they are mentioned.' },
    ])
    expect(turnsFrom(transcript).at(-1)).toEqual({ role: 'user', text: 'back to the sidebar' })
  })

  it('keeps only the last turns and cuts long ones', () => {
    const many = Array.from({ length: BRIEF_TURNS + 5 }, (_, i) => ({ kind: 'user_message', id: `u${i}`, text: i === BRIEF_TURNS + 4 ? 'x'.repeat(3000) : `turn ${i}` }))
    const turns = turnsFrom(many)
    expect(turns).toHaveLength(BRIEF_TURNS)
    expect(turns[0].text).toBe('turn 5')
    expect(turns.at(-1)!.text.length).toBeLessThan(1600)
  })

  it('asks for JSON in the brief template, naming the projects to choose from', () => {
    const prompt = briefPrompt([{ role: 'user', text: 'media?' }], { sessionTitle: 'Session review', taskTitle: 'session-review-ui', projects: [{ id: 'p-ui', name: 'EML UI/UX' }], today: '2026-11-22' })
    expect(prompt).toContain('Answer with JSON only')
    expect(prompt).toContain('p-ui (EML UI/UX)')
    expect(prompt).toContain('Goal: one checkable sentence.')
    expect(prompt).toContain('[user] media?')
  })

  it('reads the answer tolerantly and drops a project it does not know', () => {
    expect(parseBrief('Sure:\n{"title":"Media viewer","relation":"unrelated","projectId":"p-x","brief":"Goal: open files."}', ['p-ui']))
      .toEqual({ title: 'Media viewer', relation: 'unrelated', projectId: null, brief: 'Goal: open files.' })
    expect(parseBrief('{"title":"T","relation":"sideways","projectId":"p-ui","brief":"b"}', ['p-ui'])).toMatchObject({ relation: 'spun', projectId: 'p-ui' })
    expect(parseBrief('no json here', [])).toBeNull()
    expect(parseBrief('{"title":"T","brief":""}', [])).toBeNull()
  })

  it('writes a draft from one model call', async () => {
    const prompts: string[] = []
    const brief = createSplitBrief({
      transcript: async (id) => (id === 's1' ? transcript : null),
      facts: async (id) => (id === 's1' ? { sessionTitle: 'Session review', taskTitle: null, projects: [{ id: 'p-ui', name: 'EML UI/UX' }] } : null),
      complete: async (_id, prompt) => { prompts.push(prompt); return '{"title":"Media viewer","relation":"spun","projectId":"p-ui","brief":"Goal: open files."}' },
      today: () => '2026-11-22',
    })
    expect(await brief.write('s1', 'u2')).toEqual({ ok: true, draft: { title: 'Media viewer', relation: 'spun', projectId: 'p-ui', brief: 'Goal: open files.' } })
    expect(prompts[0]).not.toContain('back to the sidebar')
    expect(await brief.write('nope')).toEqual({ ok: false, reason: 'unknown_session' })
  })
})
