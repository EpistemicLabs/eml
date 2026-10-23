import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, projectBlock, renderBrainStateMarkdown, TASK_INACTIVITY_DAYS } from '../src'
import {
  validTask, writes,
} from './fixtures'

// v0.19.1 — the task backlog (task task-backlog-computed): a planned task
// without movement for TASK_INACTIVITY_DAYS leaves the open-task lists of the
// boot, eml_show and the project block and is counted apart; eml_list still
// finds it, and any movement brings it back.

describe('task backlog', () => {
  let eml: EML
  const scope = 'project.p'

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    writes(eml).agents.store({ id: 'juno', name: 'Juno' })
    writes(eml).projects.create({ id: 'p', name: 'P' })
  })
  afterEach(() => { eml.close() })

  const rawDb = (): any => (eml.engrams as any).db
  const task = (title: string, status: 'planned' | 'active' = 'planned') => writes(eml).store(validTask({ title, scope, status }))
  const age = (id: string, days: number) => {
    const at = new Date(Date.now() - days * 86400_000).toISOString()
    rawDb().prepare('UPDATE engrams SET updated_at = ? WHERE id = ?').run(at, id)
    rawDb().prepare('UPDATE entries SET at = ? WHERE engram_id = ?').run(at, id)
  }
  const openTitles = () => eml.engrams.buildBrainState(scope).open_tasks.map(t => t.title)

  it('an idle planned task is backlog; an idle active one and a fresh planned one are not', () => {
    const idle = task('idle'); age(idle.id, TASK_INACTIVITY_DAYS + 1)
    const stuck = task('stuck', 'active'); age(stuck.id, 90)
    task('fresh')
    const state = eml.engrams.buildBrainState(scope)
    expect(state.open_tasks.map(t => t.title).sort()).toEqual(['fresh', 'stuck'])
    expect(state.open_tasks_total).toBe(2)
    expect(state.backlog_tasks).toBe(1)
    expect(eml.engrams.query({ type: 'task', scope, status: 'planned' }).map(t => t.title)).toContain('idle')
  })

  it('any movement brings it back', () => {
    const a = task('a'); age(a.id, 40)
    const b = task('b'); age(b.id, 40)
    expect(openTitles()).toEqual([])
    writes(eml).trackTask(a.id, { text: 'picked up again' })
    writes(eml).trackTask(b.id, { priority: 'high' })
    expect(openTitles().sort()).toEqual(['a', 'b'])
  })

  it('boot / eml_show and the project block name the backlog with the call that lists it', () => {
    const idle = task('idle'); age(idle.id, 40)
    task('fresh')
    const line = `- 1 in backlog (planned, no movement for ${TASK_INACTIVITY_DAYS} days) — eml_list type=task scope=${scope} status=planned`
    const show = renderBrainStateMarkdown(eml.engrams.buildBrainState(scope))
    expect(show).toContain('## Open tasks (1)')
    expect(show).toContain(line)
    const block = projectBlock(eml, 'p')!
    expect(block.markdown).toContain('## Open tasks (1)')
    expect(block.markdown).toContain(line)
    expect(block.markdown).not.toContain('idle')
  })

  it('a scope with only backlog still shows the section', () => {
    const idle = task('idle'); age(idle.id, 40)
    expect(projectBlock(eml, 'p')!.markdown).toContain('## Open tasks (0)\n- 1 in backlog')
  })
})
