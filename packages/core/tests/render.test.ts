import { describe, it, expect } from 'vitest'
import { renderRecallMarkdown, renderBrainStateMarkdown } from '../src/render'

// v0.11 team-brains: recall/show surface authorship (ingested_by) and task assignee.
describe('render — authorship + assignee surfacing', () => {
  it('recall shows "by <handle>" when ingested_by present, omits when null', () => {
    const md = renderRecallMarkdown('q', [
      { id: 'e1', content: 'shared note', type: 'decision', significance: 'normal',
        scope: 'global', title: null, ingested_by: 'carol' } as any,
      { id: 'e2', content: 'legacy note', type: 'log', significance: 'normal',
        scope: 'global', title: null, ingested_by: null } as any,
    ])
    expect(md).toContain('id: e1 · by carol · eml_get for full content')
    expect(md).toContain('id: e2 · eml_get for full content')
    expect(md).not.toContain('e2 · by')
  })

  it('show renders task assignee (→) and status/log author (by)', () => {
    const md = renderBrainStateMarkdown({
      scope: 'project.x',
      current_status: [
        { id: 's1', content: 'v1 live', status: 'active', significance: 'normal',
          properties: {}, ingested_by: 'bob' } as any,
      ],
      open_tasks: [
        { id: 't1', status: 'active', title: 'ship-it', content: 'do the thing',
          significance: 'normal', properties: { assignee_id: 'carol', priority: 'high' } } as any,
      ],
      recent_logs: [
        { id: 'l1', title: 'session-1', content: 'worked on x',
          properties: {}, ingested_by: 'dave' } as any,
      ],
      recent_decisions: [],
      rules: [],
    } as any)
    expect(md).toContain('· by bob')
    expect(md).toContain('[high·active] → carol ship-it')
    expect(md).toContain('· by dave')
  })

  it('show renders a task\'s stage as [prio·status·stage], omitted when unset (v0.15)', () => {
    const base = { type: 'task', significance: 'normal', scope: 'project.x', status: 'active', ingested_by: null }
    const md = renderBrainStateMarkdown({
      scope: 'project.x', current_status: [], recent_decisions: [], recent_logs: [], rules: [], pending_reviews: [],
      open_tasks: [
        { ...base, id: 't1', title: 'staged', content: 'staged task', properties: { priority: 'high', stage: 'implementation' } },
        { ...base, id: 't2', title: 'plain', content: 'plain task', properties: { priority: 'low' } },
      ],
    } as any)
    expect(md).toContain('- [high·active·implementation] staged — staged task · t1')
    expect(md).toContain('- [low·active] plain — plain task · t2')
  })

  it('show renders a task\'s intent after the content preview, omitted when unset', () => {
    const base = { type: 'task', significance: 'normal', scope: 'project.x', status: 'active', ingested_by: null }
    const md = renderBrainStateMarkdown({
      scope: 'project.x', current_status: [], recent_decisions: [], recent_logs: [], rules: [], pending_reviews: [],
      open_tasks: [
        { ...base, id: 't1', title: 'why', content: 'do it', properties: { priority: 'high', intent: 'users see X' } },
        { ...base, id: 't2', title: 'plain', content: 'plain task', properties: { priority: 'low' } },
      ],
    } as any)
    expect(md).toContain('- [high·active] why — do it · intent: users see X · t1')
    expect(md).toContain('- [low·active] plain — plain task · t2')
  })
})
