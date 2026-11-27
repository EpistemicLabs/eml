// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const fx = vi.hoisted(() => ({ told: [] as string[], refuse: false }));
vi.mock('@/components/chat/ChatPane', () => ({ ChatPane: ({ composer }: { composer?: React.ReactNode }) => <div data-testid="chat-pane">{composer ?? <span>own input</span>}</div> }));
vi.mock('@/components/main-content/view/subcomponents/MainContentTabSwitcher', () => ({ default: ({ groups }: { groups: string[] }) => <div data-testid="switcher">{groups.join(',')}</div> }));
vi.mock('@/components/main-content/view/subcomponents/SessionStatusBar', () => ({ default: () => null }));
vi.mock('@/components/command-palette/openTask', () => ({ tellOnDesk: (text: string) => { fx.told.push(text); } }));
vi.mock('@/components/shell/view/TerminalPane', () => ({
  default: ({ onFallbackOff }: { onFallbackOff?: (message: string) => void }) => (
    <div data-testid="terminal"><button type="button" onClick={() => onFallbackOff?.('TERMINAL_FALLBACK_OFF')}>refuse</button></div>
  ),
}));

import { SessionChat } from './session-chat';

afterEach(() => { cleanup(); fx.told.length = 0; });

describe('SessionChat', () => {
  const session = { id: 's1', runtime: 'sdk' } as never;

  it('shows every session in its chat, with no view switch in its toolbar', () => {
    render(<SessionChat paneId="tasks" projectId="p" sessionId="s1" session={{ id: 's1', runtime: 'terminal' } as never} toolbar={{ onClosePane: () => {} }} />);
    expect(screen.getByTestId('chat-pane')).toBeTruthy();
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getByTestId('switcher').textContent).toBe('');
  });

  it('puts the composer in place of the input', () => {
    render(<SessionChat paneId="tasks" projectId="p" sessionId="s1" session={session} composer={<span>continue box</span>} />);
    expect(screen.getByTestId('chat-pane').textContent).toBe('continue box');
  });

  it('in the terminal fallback shows the terminal, labelled, with the way back to the chat', () => {
    const onBack = vi.fn();
    render(<SessionChat paneId="pane-1" projectId="p" sessionId="s1" session={session} terminalFallback={{ onBack }} />);
    expect(screen.getByTestId('terminal')).toBeTruthy();
    expect(screen.queryByTestId('chat-pane')).toBeNull();
    expect(screen.getByText('Terminal fallback')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('goes back to the chat with a notice when the host refuses the terminal', () => {
    const onBack = vi.fn();
    render(<SessionChat paneId="pane-1" projectId="p" sessionId="s1" session={session} terminalFallback={{ onBack }} />);
    fireEvent.click(screen.getByRole('button', { name: 'refuse' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(fx.told[0]).toMatch(/terminal fallback is off/);
  });
});
