// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { BackgroundChip } from './Composer';
import { EMPTY_CHAT, reduceChat, type ChatEvent, type ChatState } from './chat-state';

const fold = (events: ChatEvent[]): ChatState => events.reduce((state, event, index) => reduceChat(state, event, index + 1), EMPTY_CHAT);

afterEach(cleanup);

describe('BackgroundChip', () => {
  it('shows nothing while nothing runs in the background', () => {
    const { container } = render(<BackgroundChip chat={EMPTY_CHAT} onStop={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('lists a workflow run with its phase and agents, and stops it by its task', () => {
    const stopped: string[] = [];
    const chat = fold([
      { kind: 'workflow_task', taskId: 'w1', toolId: 't1', name: 'review-changes', status: 'running' },
      { kind: 'workflow_task', taskId: 'w1', running: 3, done: 4, phase: 'Review' },
      { kind: 'agent_task', taskId: 'a1', toolId: 't2', description: 'Look', status: 'running', background: true },
    ]);
    render(<BackgroundChip chat={chat} onStop={(taskId) => stopped.push(taskId)} />);
    fireEvent.click(screen.getByRole('button', { name: /1 workflow · 4 agents/ }));
    expect(screen.getByText('review-changes')).toBeTruthy();
    expect(screen.getByText('Review · 3 running, 4 done')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop review-changes' }));
    expect(stopped).toEqual(['w1']);
  });
});
