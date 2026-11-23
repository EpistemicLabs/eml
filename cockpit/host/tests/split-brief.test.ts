import { describe, it, expect } from 'vitest'
import { BRIEF_TURNS, briefPrompt, createSplitBrief, matchTask, parseBrief, turnsFrom, type TranscriptEvent } from '../src/application/split-brief.js'

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
      transcript: async (id) => (id === 's1' || id === 's2' ? transcript : null),
      facts: async (id) => (id === 's1' || id === 's2' ? { sessionTitle: 'Session review', taskTitle: null, projects: [{ id: 'p-ui', name: 'EML UI/UX' }], hasTask: true, openTasks: [{ id: 't-mv', title: 'media-viewer', project: 'ui' }] } : null),
      complete: async (id, prompt) => { if (id === 's2') throw new Error('not signed in'); prompts.push(prompt); return '{"title":"Media viewer","relation":"spun","projectId":"p-ui","brief":"Goal: open files."}' },
      today: () => '2026-11-22',
    })
    const context = { projects: [{ id: 'p-ui', name: 'EML UI/UX' }], hasTask: true, openTasks: [{ id: 't-mv', title: 'media-viewer', project: 'ui' }], matchTaskId: null }
    expect(await brief.write('s1', 'u2')).toEqual({ ok: true, draft: { title: 'Media viewer', relation: 'spun', projectId: 'p-ui', brief: 'Goal: open files.' }, context: { ...context, matchTaskId: 't-mv' } })
    expect(await brief.write('s2')).toEqual({ ok: false, reason: 'failed', message: 'not signed in', context })
    expect(prompts[0]).not.toContain('back to the sidebar')
    expect(await brief.write('nope')).toEqual({ ok: false, reason: 'unknown_session' })
    prompts.length = 0
    expect(await brief.context('s1', 'Media viewer')).toEqual({ ...context, matchTaskId: 't-mv' })
    expect(await brief.context('s1')).toEqual(context)
    expect(prompts).toEqual([])
  })
})

describe('an open task the topic already has', () => {
  const open = [
    { id: 't-fix', title: 'fix-ended-mail-test-lasse-job', project: 'mail-jobs' },
    { id: 't-new', title: 'new-mail-jobs', project: 'mail-jobs' },
    { id: 't-ui', title: 'media-viewer-mockup', project: 'ui' },
  ]
  it('is the one whose title shares most words with the topic', () => {
    expect(matchTask('Fix ended Mail test Lasse job', open)).toBe('t-fix')
    expect(matchTask('Media viewer', open)).toBe('t-ui')
  })
  it('is none when too little is shared', () => {
    expect(matchTask('Mail', open)).toBeNull()
    expect(matchTask('Pricing page copy', open)).toBeNull()
  })
})

describe('offering a split', () => {
  it('tells the agent nothing happened yet and the user decides', async () => {
    const { OFFER_SPLIT_ANSWER, OFFER_SPLIT_TOOL } = await import('../src/infrastructure/providers/claude/sdk-runtime.js')
    expect(OFFER_SPLIT_TOOL).toBe('offer_split')
    expect(OFFER_SPLIT_ANSWER).toMatch(/Nothing is split until they choose/)
    const { PROPOSE_SORT_ANSWER, PROPOSE_SORT_TOOL } = await import('../src/infrastructure/providers/claude/sdk-runtime.js')
    expect(PROPOSE_SORT_TOOL).toBe('propose_sort')
    expect(PROPOSE_SORT_ANSWER).toMatch(/Nothing changes until they apply/)
  })

  it('is part of what an attended task session reads, not an unattended one', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const task = { id: 't', title: 'session-review-ui', status: 'active', properties: {} } as never
    expect(taskContext(task, false)).toContain('call offer_split')
    expect(taskContext(task, false)).toContain('do not create a task for it yourself')
    expect(taskContext(task, false)).toContain('a task the user explicitly asks you to note, you create yourself')
    expect(taskContext(task, false, true)).not.toContain('offer_split')
  })
})
