// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { BoardTask } from '@/lib/task-board';

import { TaskRelated } from './TaskRelated';

const t = (patch: Partial<BoardTask>): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'task', status: 'active', parentId: null, updatedAt: null,
  turn: null, coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, hasSchedule: false, ...patch,
});
afterEach(cleanup);
const row = (name: RegExp) => screen.getAllByRole('treeitem').find((el) => name.test(el.getAttribute('aria-label') ?? ''))!;

describe('TaskRelated', () => {
  const top = t({ id: 'top', title: 'widget-ab-test' });
  const mid = t({ id: 'mid', title: 'preview-skews-readout', parentId: 'top', status: 'resolved' });
  const self = t({ id: 'self', title: 'builder-dock', originId: 'mid' });
  const tasks = [top, mid, self,
    t({ id: 'k1', title: 'emulator-test', originId: 'self', status: 'planned' }),
    t({ id: 'k2', title: 'release-widget', parentId: 'self', status: 'resolved' }),
  ];

  it('shows the direct origin, this task and its open children; the rest folds', () => {
    render(<TaskRelated task={self} board={{ tasks }} onOpen={() => {}} />);
    expect(row(/^Preview skews readout, Done, origin$/)).toBeTruthy();
    expect(screen.queryByText('Widget ab test')).toBeNull();
    expect(row(/^This task/).getAttribute('aria-selected')).toBe('true');
    expect(row(/^Emulator test, Parked, spun off$/).className).toContain('before:border-dashed');
    expect(screen.queryByText('Release widget')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '↑ 1 more up' }));
    expect(screen.getByText('Widget ab test')).toBeTruthy();
    fireEvent.click(row(/^1 done · show all 2$/).querySelector('[data-tree-row]')!);
    expect(screen.getByText('Release widget')).toBeTruthy();
  });

  it('opens the clicked task, and has no fold arrows', () => {
    const onOpen = vi.fn();
    render(<TaskRelated task={self} board={{ tasks }} onOpen={onOpen} />);
    fireEvent.click(row(/^Emulator test/).querySelector('[data-tree-row]')!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'k1' }));
    expect(document.querySelector('[data-tree-toggle]')).toBeNull();
  });

  it('says so in one line when there is nothing related', () => {
    render(<TaskRelated task={top} board={{ tasks: [top] }} onOpen={() => {}} />);
    expect(screen.getByText(/No parent, sub-tasks or spun-off tasks/)).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });
});
