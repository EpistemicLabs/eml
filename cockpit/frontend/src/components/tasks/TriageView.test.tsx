// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TriageView, type PendingTask } from './TriageView';

// Triage: each task a session made on its own, with where it came from, the
// cockpit's guess, and the user's merge, accept or close.

const item = (extra: Partial<PendingTask> = {}): PendingTask => ({
  id: 'pending-1', spaceId: 'main', spaceName: 'Main', title: 'lohmann-custom-tracking', content: 'Answer the request.',
  scope: 'project.lohmann', source: { kind: 'session', sessionId: 's1', sessionName: 'Email Lord' }, createdAt: new Date().toISOString(),
  entries: [], suggestion: { kind: 'merge', taskId: 'open-1', title: 'lohmann-onboarding-tracking' }, ...extra,
});

describe('the triage view', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows the task and the guess, and merges into it', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ item: {} })));
    vi.stubGlobal('fetch', fetch);
    const reload = vi.fn(async () => {});
    render(<TriageView items={[item()]} reload={reload} />);
    expect(screen.getAllByText('lohmann-custom-tracking').length).toBeGreaterThan(0);
    expect(screen.getByText('lohmann-onboarding-tracking')).toBeTruthy();
    fireEvent.click(screen.getByText('Merge into it'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/triage/pending-1');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'merge', taskId: 'open-1' });
  });

  it('accepts into its project or closes, and says why the cockpit refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Merge only into an open task' } }), { status: 409 })));
    render(<TriageView items={[item({ suggestion: null })]} reload={async () => {}} />);
    expect(screen.queryByText('Merge into it')).toBeNull();
    fireEvent.click(screen.getByText('Accept into lohmann'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Merge only into an open task'));
  });

  it('says so when nothing waits', () => {
    render(<TriageView items={[]} reload={async () => {}} />);
    expect(screen.getByText(/Nothing waits for triage/)).toBeTruthy();
  });
});
