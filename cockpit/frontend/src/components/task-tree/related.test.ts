import { describe, expect, it } from 'vitest';

import type { BoardTask, LineageTask } from '@/lib/task-board';

import { relatedOf } from './related';

const t = (patch: Partial<BoardTask>): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'task', status: 'active', parentId: null, updatedAt: null,
  turn: null, coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, hasSchedule: false, ...patch,
});

describe('relatedOf', () => {
  it('is null for a task with no origin and no children', () => {
    expect(relatedOf(t({ id: 'a' }), { tasks: [t({ id: 'a' }), t({ id: 'b' })] })).toBeNull();
  });

  it('walks up parents and origins, top first, including a closed ancestor from the lineage', () => {
    const top: LineageTask = { id: 'top', spaceId: 'main', project: 'acme', title: 'Top', status: 'resolved', parentId: null, originId: null };
    const mid = t({ id: 'mid', parentId: 'top' });
    const self = t({ id: 'self', parentId: null, originId: 'mid' });
    const r = relatedOf(self, { tasks: [mid, self], lineage: [top] })!;
    expect(r.origins.map((o) => o.id)).toEqual(['top', 'mid']);
    expect(r.origins[0].task).toBeUndefined();
    expect(r.origins[1].task).toBe(mid);
    expect(r.origins[1].rel).toBe('sub');
    expect(r.rel).toBe('spun');
  });

  it('lists sub-tasks and spun-off tasks, open ones with the person\'s turn first, done ones apart', () => {
    const self = t({ id: 'self' });
    const r = relatedOf(self, { tasks: [
      self,
      t({ id: 'parked', parentId: 'self', status: 'planned' }),
      t({ id: 'ask', originId: 'self', turn: 'needs_you', group: 'own' }),
      t({ id: 'run', parentId: 'self', turn: 'agent_working' }),
      t({ id: 'old', parentId: 'self', status: 'resolved' }),
      // A sub-task of another task that was spun off from self hangs under its parent, not here.
      t({ id: 'elsewhere', parentId: 'parked', originId: 'self' }),
      t({ id: 'other-space', spaceId: 'x', parentId: 'self' }),
    ] })!;
    expect(r.open.map((k) => k.id)).toEqual(['ask', 'run', 'parked']);
    expect(r.open.find((k) => k.id === 'ask')!.rel).toBe('spun');
    expect(r.done.map((k) => k.id)).toEqual(['old']);
  });

  it('stops at a loop in the data', () => {
    const a = t({ id: 'a', parentId: 'b' });
    const b = t({ id: 'b', parentId: 'a' });
    expect(relatedOf(a, { tasks: [a, b] })!.origins.map((o) => o.id)).toEqual(['b']);
  });
});
