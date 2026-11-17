// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { OverviewTask } from '@/lib/tasks-overview';

// A task opened in the Tasks view: its panel and, next to it, the chat of the
// newest session on the task or one of its steps; tabs switch between them.

vi.mock('@/components/engram-detail', () => ({ EngramDetail: ({ id }: { id: string }) => <div>task panel {id}</div> }));
vi.mock('@/lib/engram-panel', () => ({ useEngramPanel: () => ({ hrefFor: (id: string) => `?engram=${id}` }) }));
vi.mock('@/components/chat/ChatPane', () => ({ ChatPane: ({ sessionId }: { sessionId: string }) => <div>chat {sessionId}</div> }));
vi.mock('@/components/standalone-shell/view/StandaloneShell', () => ({ default: ({ sessionId }: { sessionId: string }) => <div>terminal {sessionId}</div> }));

const { TaskWorkspace } = await import('./TaskWorkspace');

const task = { id: 't1', title: 'homepage-v4b', spaceId: 'main', spaceName: 'Main' } as OverviewTask;
const session = (id: string, taskId: string, lastActivity: string, extra: Partial<AllSession> = {}) =>
  ({ id, taskId, lastActivity, summary: `session ${id}`, spaceId: 'main', __projectId: 'p', runtime: 'sdk', ...extra }) as unknown as AllSession;

describe('the task workspace', () => {
  afterEach(cleanup);

  it('shows the task panel and the newest session of the task or its steps, and switches by tab', () => {
    const sessions = [
      session('old', 't1', '2026-11-17T08:00:00Z'),
      session('step', 's1', '2026-11-17T10:00:00Z', { runtime: 'terminal' } as Partial<AllSession>),
      session('other', 'x', '2026-11-17T11:00:00Z'),
      session('gone', 't1', '2026-11-17T12:00:00Z', { archivedAt: '2026-11-17T12:30:00Z' } as Partial<AllSession>),
    ];
    render(<TaskWorkspace task={task} stepIds={['s1']} sessions={sessions} spaces={[]} onClose={() => {}} />);
    expect(screen.getByText('task panel t1')).toBeTruthy();
    expect(screen.getByText('terminal step')).toBeTruthy();
    expect(screen.queryByText(/session other/)).toBeNull();
    expect(screen.queryByText(/session gone/)).toBeNull();
    fireEvent.click(screen.getByText('session old'));
    expect(screen.getByText('chat old')).toBeTruthy();
  });

  it('says so when no session works on the task, and closes', () => {
    const onClose = vi.fn();
    render(<TaskWorkspace task={task} stepIds={[]} sessions={[]} spaces={[]} onClose={onClose} />);
    expect(screen.getByText(/No session works on this task yet/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close the task'));
    expect(onClose).toHaveBeenCalled();
  });
});
