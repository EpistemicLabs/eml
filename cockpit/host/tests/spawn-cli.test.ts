import { describe, it, expect } from 'vitest'
import { spawnAnswerLines } from '../src/spawn-answer.js'

// What cockpit-spawn (spawn-cli.ts) prints for the host's answer to POST /api/spawn.

describe('cockpit-spawn output', () => {
  it('a routed answer says no worker started and names the holding session, with its address when it has one', () => {
    const routed = { id: 's-holder', projectId: 'bp-ops', taskId: 't1', routed: true }
    expect(spawnAnswerLines({ ...routed, address: 'ops/s-holder' }, { open: false })).toEqual([
      'No worker started: task t1 already has its session s-holder, and a task has one session at a time. Your prompt went to that session as a message.',
      'Its address: ops/s-holder (for SendMessage and notify_when_idle).',
    ])
    expect(spawnAnswerLines(routed, { open: true })).toEqual([
      'No worker started: task t1 already has its session s-holder, and a task has one session at a time. Your prompt went to that session as a message.',
    ])
  })

  it('a queued worker says where it runs, its address and its task', () => {
    expect(spawnAnswerLines({ id: 'w1', projectId: 'bp-ops', address: 'ops/w1', taskId: 't2' }, { open: false })).toEqual([
      'Worker requested in project bp-ops — it runs without a pane and shows in the sidebar under this session. It starts as soon as the machine has room.',
      'Worker address: ops/w1 (for SendMessage and notify_when_idle).',
      'Its task: t2',
    ])
    expect(spawnAnswerLines({ id: 'w1', projectId: 'bp-ops' }, { open: true })).toEqual([
      'Worker requested in project bp-ops — it opens as a new pane next to this session; with no cockpit tab open, the host starts it on its own within seconds and it shows in the sidebar.',
    ])
  })
})
