import { describe, it, expect } from 'vitest'
import { callTool } from '../src/tools/_helpers'

// v0.20: tool output leaves an engram's rev out (decision engram-revision-counter),
// and only an engram's — a rev key in a user's own data stays.

const parsed = async (result: unknown) => JSON.parse((await callTool(async () => result)).content[0].text)

describe('callTool rev strip', () => {
  it('strips rev from engrams, at any depth', async () => {
    const engram = { id: 'e1', type: 'note', scope: 'global', rev: 3, content: 'x' }
    expect(await parsed(engram)).toEqual({ id: 'e1', type: 'note', scope: 'global', content: 'x' })
    expect(await parsed({ count: 1, engrams: [engram] })).toEqual({ count: 1, engrams: [{ id: 'e1', type: 'note', scope: 'global', content: 'x' }] })
  })

  it('keeps a rev key that is not an engram\'s: object metadata, an engram\'s app state', async () => {
    const user = { id: 'ada', name: 'Ada', metadata: { rev: 'B' } }
    expect(await parsed({ object: user })).toEqual({ object: user })
    const engram = { id: 'e2', type: 'note', scope: 'global', rev: 1, properties: { app: { rev: 'B' } } }
    expect(await parsed(engram)).toEqual({ id: 'e2', type: 'note', scope: 'global', properties: { app: { rev: 'B' } } })
  })
})
