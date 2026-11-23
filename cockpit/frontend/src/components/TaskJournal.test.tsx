// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('@/lib/queries', () => ({ useAddTaskEntry: () => ({ mutate: () => {}, isPending: false, error: null }), engramQuery: () => ({}) }));
vi.mock('@/stores/useTeamStore', () => ({ useWritable: () => ({ writable: true, reason: null }) }));

import type { Engram } from '@/lib/types';

import { journalGist, TaskJournal } from './task-sections';

afterEach(cleanup);

const entry = (id: string, kind: 'note' | 'change', text: string, at: string) => ({ id, kind, text, at, author: 'lasse', stage: null });
const engram = {
  id: 'task-1', type: 'task', status: 'active', title: 'x', content: '', updated_at: '2026-11-23T10:48:00Z',
  entries: [
    entry('e1', 'note', '### Handoff\nResult: Fix PRs are open.\nNext: merge', '2026-11-23T10:42:00Z'),
    entry('e2', 'note', '### Handoff\nResult: #171 and #298 are merged.\nNext: confirm the deploys', '2026-11-23T10:48:00Z'),
    entry('e3', 'change', 'waiting on lasse', '2026-11-23T10:48:30Z'),
  ],
} as unknown as Engram;

describe('journalGist', () => {
  it('takes the newest note, skips change entries, and uses a heading as its label', () => {
    expect(journalGist([{ kind: 'change', text: 'waiting on lasse' }, { kind: 'note', text: '### Handoff\nResult: merged.\nNext: deploy' }]))
      .toEqual({ head: 'Handoff', text: 'merged. · Next: deploy' });
    expect(journalGist([{ kind: 'note', text: 'Plain note' }])).toEqual({ head: null, text: 'Plain note' });
    expect(journalGist([{ kind: 'change', text: 'x' }])).toBeNull();
  });
});

describe('TaskJournal foldable', () => {
  it('starts folded to one line and opens with the composer inside', () => {
    render(<MemoryRouter><TaskJournal engram={engram} relationHref={(id) => id} foldable /></MemoryRouter>);
    const toggle = screen.getByRole('button', { name: /Journal · 3 entries/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Handoff: #171 and #298 are merged.');
    expect(screen.queryByLabelText('New journal entry')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('New journal entry')).toBeTruthy();
  });

  it('is open with no toggle where it is not foldable', () => {
    render(<MemoryRouter><TaskJournal engram={engram} relationHref={(id) => id} /></MemoryRouter>);
    expect(screen.getByLabelText('New journal entry')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Journal/ })).toBeNull();
  });
});
