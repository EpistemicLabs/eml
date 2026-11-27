// @vitest-environment jsdom
// A split onto a task that already has its session (lib/split.ts): the brief went to that session, so its pane comes
// forward or opens, and Undo of that split leaves the pane open. A split that started a session closes that session's
// pane on Undo.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const panes = vi.hoisted(() => ({
  paneHoldingSession: vi.fn<(id: string) => { id: string } | undefined>(),
  activatePane: vi.fn(),
  openInPane: vi.fn(),
  removePane: vi.fn(),
  getDeskOfPane: vi.fn(() => undefined),
}));
const split = vi.hoisted(() => ({ result: null as Record<string, unknown> | null, undoSplit: vi.fn(async () => ({ ok: true })) }));

vi.mock('@/stores/usePaneStore', () => panes);
vi.mock('@/stores/useSpaceStore', () => ({ useSpaces: () => [] }));
vi.mock('@/lib/task-board', () => ({ useTaskBoard: () => ({ data: undefined }), closeTask: vi.fn() }));
vi.mock('@/lib/split', async (importActual) => ({ ...(await importActual<typeof import('@/lib/split')>()), undoSplit: split.undoSplit }));
vi.mock('@/hooks/useCompactLayout', () => ({ useCompactLayout: () => false }));
vi.mock('@/components/main-content/view/subcomponents/TerminalStatusBar', () => ({ default: () => null }));
vi.mock('./useChatSocket', () => {
  const noop = () => {};
  return { useChatSocket: () => ({ start: noop, send: () => true, interrupt: noop, answer: noop, setMode: () => true, setModel: () => true, setEffort: noop, stopAgent: noop, reconnect: noop, takeOver: noop, restart: noop, askToolServers: noop, changeToolServer: noop, finishToolServerSignIn: noop }) };
});
vi.mock('./Composer', () => ({
  Composer: ({ onSend }: { onSend: (text: string, images: string[]) => boolean }) => <button type="button" onClick={() => onSend('/split', [])}>Split command</button>,
  ModelPicker: () => null,
  EffortPicker: () => null,
}));
vi.mock('./SplitDialog', () => ({
  SplitDialog: ({ onDone }: { onDone: (result: unknown) => void }) => <button type="button" onClick={() => onDone(split.result)}>Finish split</button>,
}));

import { ChatPane } from './ChatPane';

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const UNDO_UNTIL = new Date(Date.now() + 60_000).toISOString();

function splitOff(result: Record<string, unknown>) {
  split.result = { ok: true, opId: `op-${Math.random()}`, undoUntil: UNDO_UNTIL, title: 'Invoices', when: 'now', ...result };
  render(<QueryClientProvider client={new QueryClient()}><ChatPane paneId="p1" projectId="proj" sessionId="s-from" session={null} isActive /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Split command' }));
  fireEvent.click(screen.getByRole('button', { name: 'Finish split' }));
}

async function undo() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
}

describe('a split in the chat pane', () => {
  it('routed to the session the task had: brings that session\'s pane forward', async () => {
    panes.paneHoldingSession.mockReturnValue({ id: 'pane-holder' });
    splitOff({ sessionId: 's-holder', routed: true });
    expect(panes.activatePane).toHaveBeenCalledWith('pane-holder');
    expect(panes.openInPane).not.toHaveBeenCalled();
  });

  it('routed to a session no pane shows: opens it in a new pane', async () => {
    panes.paneHoldingSession.mockReturnValue(undefined);
    splitOff({ sessionId: 's-holder', routed: true });
    expect(panes.openInPane).toHaveBeenCalledWith({ surface: 'terminal', projectId: 'proj', sessionId: 's-holder' });
  });

  it('a split that started a session opens nothing itself (the queue opens it)', async () => {
    splitOff({ sessionId: 's-new' });
    expect(panes.activatePane).not.toHaveBeenCalled();
    expect(panes.openInPane).not.toHaveBeenCalled();
  });

  it('Undo of a routed split leaves the holder\'s pane open', async () => {
    panes.paneHoldingSession.mockReturnValue({ id: 'pane-holder' });
    splitOff({ sessionId: 's-holder', routed: true });
    await undo();
    expect(split.undoSplit).toHaveBeenCalledTimes(1);
    expect(panes.removePane).not.toHaveBeenCalled();
    expect(screen.getByText('Split of Invoices undone')).toBeTruthy();
  });

  it('Undo of a split that started a session closes that session\'s pane', async () => {
    panes.paneHoldingSession.mockReturnValue({ id: 'pane-new' });
    splitOff({ sessionId: 's-new' });
    await undo();
    expect(panes.paneHoldingSession).toHaveBeenCalledWith('s-new');
    expect(panes.removePane).toHaveBeenCalledWith('pane-new');
  });
});
