import { describe, it, expect } from 'vitest'
import { EmlApiError } from '@engramprotocol/mcp-server'
import { OPEN_TASKS_LIMIT, openTasks, taskById } from '../src/application/task-read.js'

const brainWith = (engrams: Record<string, unknown>) => {
  const asked: Array<{ path: string; query?: Record<string, unknown> }> = []
  return {
    asked,
    async get(path: string, query?: Record<string, unknown>) {
      asked.push({ path, ...(query ? { query } : {}) })
      if (path === '/list') return query?.status === 'planned' ? { engrams: [{ id: 'p1' }] } : query?.status === 'active' ? { engrams: [{ id: 'a1' }, { id: 'a2' }] } : {}
      const found = engrams[decodeURIComponent(path.slice('/engram/'.length))]
      if (found === undefined) throw new EmlApiError(404, { error: 'NOT_FOUND' }, 'not found')
      if (found instanceof Error) throw found
      return found
    },
  }
}

describe('one task by its id', () => {
  it('is the task as the brain has it, a closed one too, and one read without a type', async () => {
    const brain = brainWith({ 't 1': { id: 't 1', type: 'task', status: 'resolved' }, t2: { id: 't2', status: 'active' } })
    expect(await taskById(brain, 't 1')).toEqual({ id: 't 1', type: 'task', status: 'resolved' })
    expect(await taskById(brain, 't2')).toEqual({ id: 't2', status: 'active' })
    expect(brain.asked[0].path).toBe('/engram/t%201')
  })

  it('is null when the brain has none, and when the id names something that is no task', async () => {
    const brain = brainWith({ d1: { id: 'd1', type: 'decision', status: 'active' } })
    expect(await taskById(brain, 'gone')).toBeNull()
    expect(await taskById(brain, 'd1')).toBeNull()
  })

  it('throws what is not a 404: a brain that cannot be asked is not a task that is gone', async () => {
    const brain = brainWith({ t1: new EmlApiError(503, { error: 'MIGRATING' }, 'migrating'), t2: new Error('connect ECONNREFUSED') })
    await expect(taskById(brain, 't1')).rejects.toThrow('migrating')
    await expect(taskById(brain, 't2')).rejects.toThrow('connect ECONNREFUSED')
  })
})

describe('a space\'s open tasks', () => {
  it('are its planned and its active tasks, read as two lists up to the limit', async () => {
    const brain = brainWith({})
    expect(await openTasks<{ id: string }>(brain)).toEqual([{ id: 'p1' }, { id: 'a1' }, { id: 'a2' }])
    expect(brain.asked).toEqual([
      { path: '/list', query: { type: 'task', status: 'planned', limit: OPEN_TASKS_LIMIT } },
      { path: '/list', query: { type: 'task', status: 'active', limit: OPEN_TASKS_LIMIT } },
    ])
  })

  it('fails when a list does not come: half a list is not the open tasks', async () => {
    await expect(openTasks({ get: async () => { throw new Error('connect ECONNREFUSED') } })).rejects.toThrow('connect ECONNREFUSED')
  })
})
