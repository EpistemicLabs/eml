// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import { toSessionTask } from '@/lib/session-task';
import type { SpaceInfo } from '@/stores/useSpaceStore';
import { YourTurnList } from './YourTurnList';

// Your turn: every session the round holds, next to the one on screen; a row
// says what it waits for and its task, and a click opens it. Only reads.

const main = { id: 'main', name: 'Main', main: true, agent: 'atlas', upgrade: null, shared: false, taskSystem: true } as SpaceInfo;
const asks = { id: 'q', spaceId: 'main', summary: 'Hero copy', taskId: 't1', attention: { kind: 'question', at: '2026-11-17T09:00:00Z', reason: 'Which headline?' } } as unknown as AllSession;
const other = { id: 'r', spaceId: 'main', summary: 'Report', attention: { kind: 'review', at: '2026-11-17T08:00:00Z', reason: 'Draft ready' } } as unknown as AllSession;

describe('the Your turn list', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows each session with its task and why it waits, and opens the one clicked', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 't1', title: 'homepage-v4b', content: 'Build it', status: 'active',
      properties: { waiting_on: { who: 'lasse', why: 'Ship the shorter headline?', since: '2026-11-17T09:01:00Z' } },
    })));
    vi.stubGlobal('fetch', fetch);
    const onPick = vi.fn();
    render(<YourTurnList items={[asks, other]} currentId="q" spaces={[main]} turns={{}} onPick={onPick} />);
    await waitFor(() => expect(screen.getByText('homepage-v4b')).toBeTruthy());
    expect(screen.getByText('Ship the shorter headline?')).toBeTruthy();
    expect(screen.getByText('Report')).toBeTruthy();
    expect(screen.getByText('Draft ready')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/brain/engram/t1', expect.anything());
    fireEvent.click(screen.getByText('Report'));
    expect(onPick).toHaveBeenCalledWith('r');
  });

  it('reads a task without waiting_on as nobody waiting', () => {
    expect(toSessionTask({ id: 't', title: null, content: 'Do the thing', status: 'planned', properties: { stage: 'ready' } }))
      .toEqual({ id: 't', title: 'Do the thing', status: 'planned', stage: 'ready', checkpoint: null, waitingOn: null });
  });
});
