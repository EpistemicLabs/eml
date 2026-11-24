// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/components/chat/ChatPane', () => ({ ChatPane: ({ composer }: { composer?: React.ReactNode }) => <div data-testid="chat-pane">{composer ?? <span>own input</span>}</div> }));
vi.mock('@/components/chat/chat-store', () => ({ useSwitchBlocked: () => null }));
vi.mock('@/components/main-content/view/subcomponents/MainContentTabSwitcher', () => ({ default: ({ groups }: { groups: string[] }) => <div data-testid="switcher">{groups.join(',')}</div> }));
vi.mock('@/components/main-content/view/subcomponents/TerminalStatusBar', () => ({ default: () => null }));
vi.mock('@/components/standalone-shell/view/StandaloneShell', () => ({ default: () => <div data-testid="terminal" /> }));
vi.mock('@/lib/terminal-reclaim', () => ({ reclaimTerminal: () => {} }));

import { SessionChat } from './session-chat';

afterEach(cleanup);

describe('SessionChat with a composer', () => {
  const terminalSession = { id: 's1', runtime: 'terminal' } as never;

  it('stays in the chat view with the composer in place of the input, and offers no terminal switch', () => {
    render(<SessionChat paneId="tasks" projectId="p" sessionId="s1" session={terminalSession} view="terminal" toolbar={{ onClosePane: () => {} }} composer={<span>continue box</span>} />);
    expect(screen.getByTestId('chat-pane').textContent).toBe('continue box');
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getByTestId('switcher').textContent).toBe('');
  });

  it('without one, a terminal session shows its terminal and the switch', () => {
    render(<SessionChat paneId="tasks" projectId="p" sessionId="s1" session={terminalSession} toolbar={{ onClosePane: () => {} }} />);
    expect(screen.getByTestId('terminal')).toBeTruthy();
    expect(screen.getByTestId('switcher').textContent).toBe('session');
  });
});
