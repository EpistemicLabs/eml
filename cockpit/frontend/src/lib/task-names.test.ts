import { describe, expect, it } from 'vitest';

import { originName, statusOrTurn, taskName, type BoardTask } from './task-board';

const NOW = Date.parse('2026-11-23T11:00:00Z');
const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 't1', spaceId: 's', spaceName: 'Main', project: 'acme', title: 'builder-dock-long-thread-archive-listener-preview-ab', status: 'active',
  parentId: null, originId: null, updatedAt: null, turn: 'agent_working', coverage: { ok: true, how: 'working' }, urgency: 0, important: false,
  onBoard: true, sessionIds: [], working: true, nextRunAt: null, delegate: 'atlas', ...patch,
});

describe('readable task names', () => {
  it('shows the display title, else the anchor as words', () => {
    expect(taskName(task({ displayTitle: 'Keep widget preview loads out of the A/B test' }))).toBe('Keep widget preview loads out of the A/B test');
    expect(taskName(task())).toBe('Builder dock long thread archive listener preview ab');
    expect(taskName(task({ displayTitle: '  ' }))).toBe('Builder dock long thread archive listener preview ab');
  });

  it('names the origin from the open tasks or the closed ancestors, in the same space', () => {
    const origin = task({ id: 'o', displayTitle: 'Widget A/B visibility test for embeds' });
    const spun = task({ id: 'c', originId: 'o' });
    expect(originName(spun, { tasks: [origin, spun], lineage: [] })).toBe('Widget A/B visibility test for embeds');
    expect(originName(spun, { tasks: [spun], lineage: [{ id: 'o', spaceId: 's', project: 'acme', title: 'old-origin', status: 'resolved', parentId: null, originId: null }] })).toBe('Old origin');
    expect(originName(spun, { tasks: [spun], lineage: [] })).toBeNull();
    expect(originName(task(), { tasks: [], lineage: [] })).toBeNull();
  });
});

describe('the line under a task\'s name on a card', () => {
  const line = { now: '#171 and #298 merged; deploys still running', next: 'confirm the deploys', at: '2026-11-23T10:48:00Z' };
  it('is where it stands when there is a status line', () => {
    expect(statusOrTurn(task({ statusLine: line }), NOW)).toBe(line.now);
  });
  it('stays the question when the task asked the viewer something', () => {
    expect(statusOrTurn(task({ statusLine: line, turn: 'needs_you', group: 'asked', waitingOn: { who: 'lasse', why: 'Add stock to the sync?' } as BoardTask['waitingOn'] }), NOW)).toBe('Add stock to the sync?');
  });
  it('falls back to whose turn it is without a status line', () => {
    expect(statusOrTurn(task(), NOW)).toBe('Atlas is working on it.');
  });
});
