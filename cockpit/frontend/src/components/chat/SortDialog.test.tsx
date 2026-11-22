// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SortDialog } from './SortDialog';
import { SortCard } from './SplitParts';
import { groupItems, sortOfTool } from './chat-state';

const posts: Array<Record<string, unknown>> = [];
beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ opId: 'x', linked: 1, created: 1, closed: 0 }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rows = [
  { when: 'Nov 19', topic: 'Task board mockup', summary: 'v3 → v4', today: 'Task, not linked', pick: 'sub' as const, taskId: 't-board' },
  { when: 'Nov 21', topic: 'Media viewer', today: 'Nothing', pick: 'spun' as const, brief: 'Goal: open files.' },
];

describe('sorting a drifted session', () => {
  it('shows the proposal as a table, takes changes, and applies', async () => {
    const onDone = vi.fn();
    render(<SortDialog sessionId="s1" rows={rows} onClose={() => {}} onDone={onDone} />);
    expect(screen.getByRole('table', { name: 'Topics' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['When', 'Topic', 'Today', 'Goes to']);
    fireEvent.change(screen.getByLabelText('Where Media viewer goes'), { target: { value: 'unrelated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ ok: true, opId: 'x', linked: 1, created: 1, closed: 0 }));
    expect(posts[0].rows).toEqual([
      { topic: 'Task board mockup', pick: 'sub', taskId: 't-board' },
      { topic: 'Media viewer', pick: 'unrelated', brief: 'Goal: open files.' },
    ]);
  });

  it('reads a propose_sort call as a sort card with its rows', () => {
    const tool = { type: 'tool', id: 't9', name: 'mcp__cockpit__propose_sort', input: { reason: '14 topics since Nov 16', rows: [{ topic: 'Media viewer', pick: 'park' }, { pick: 'keep' }] } } as never;
    expect(sortOfTool(tool)).toEqual({ rows: [{ topic: 'Media viewer', pick: 'keep' }], reason: '14 topics since Nov 16' });
    expect(groupItems([tool])[0]).toMatchObject({ kind: 'sort', id: 't9' });
  });

  it('keeps the card\'s choice once it is made', () => {
    const onSort = vi.fn();
    const { rerender } = render(<SortCard topics={14} reason="since Nov 16" result={null} onSort={onSort} onLater={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort topics…' }));
    expect(onSort).toHaveBeenCalled();
    rerender(<SortCard topics={14} reason="" result="Sorted: 1 linked, 1 created, 0 closed." onSort={onSort} onLater={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
  });
});
