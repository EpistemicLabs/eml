// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';

// The review bar holds the keyboard: D, A, E, R and Esc act on it alone, a key
// never lands in an input by itself, and Esc does not reach the pane below.
// Answers go in the session's own input; the bar has none.

let sessions: AllSession[] = [];
vi.mock('@/components/sidebar/useAllSessions', () => ({ useAllSessions: () => ({ sessions, queued: [], refresh: () => {} }) }));
vi.mock('@/stores/useTurnStateStore', () => ({ useTurnStore: () => ({ turns: {} }) }));
const flow = vi.hoisted(() => ({
  stepReview: vi.fn(),
  endReview: vi.fn(),
  finishCurrent: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/review-flow', async (original) => ({ ...(await original<typeof import('@/lib/review-flow')>()), ...flow }));

const { ReviewBar } = await import('./ReviewBar');
const { returnToReviewBar, setReview } = await import('@/stores/useReviewStore');

const result = { id: 'a', spaceId: 'main', summary: 'First', attention: { kind: 'done', at: '2026-11-03T00:00:00Z' } } as unknown as AllSession;
const question = { id: 'q', spaceId: 'main', summary: 'Asks', attention: { kind: 'question', at: '2026-11-03T00:00:00Z', reason: 'Which one?' } } as unknown as AllSession;

const bar = () => screen.getByLabelText('Review');

describe('the review bar', () => {
  beforeEach(() => {
    Object.values(flow).forEach((fn) => fn.mockClear());
  });
  afterEach(() => {
    cleanup();
    act(() => setReview(null));
  });

  const open = (current: AllSession) => {
    sessions = [current, { ...result, id: 'b' }];
    act(() => setReview({ queue: [current.id, 'b'], index: 0, paneId: 'pane', ownsPane: true }));
    render(<ReviewBar paneId="pane" />);
  };

  it('takes the focus, and D, A and E act on it', () => {
    open(result);
    expect(document.activeElement).toBe(bar());
    fireEvent.keyDown(bar(), { key: 'd' });
    expect(flow.stepReview).toHaveBeenLastCalledWith(1, expect.anything(), expect.anything());
    fireEvent.keyDown(bar(), { key: 'a' });
    expect(flow.stepReview).toHaveBeenLastCalledWith(-1, expect.anything(), expect.anything());
    fireEvent.keyDown(bar(), { key: 'e' });
    expect(flow.finishCurrent).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a key pressed elsewhere', () => {
    open(result);
    fireEvent.keyDown(document.body, { key: 'd' });
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(flow.stepReview).not.toHaveBeenCalled();
    expect(flow.finishCurrent).not.toHaveBeenCalled();
  });

  it('ends on Escape without it reaching the pane', () => {
    open(result);
    const below = vi.fn();
    window.addEventListener('keydown', below);
    fireEvent.keyDown(bar(), { key: 'Escape' });
    window.removeEventListener('keydown', below);
    expect(flow.endReview).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  it('leaves Cmd and Ctrl to the browser', () => {
    open(result);
    fireEvent.keyDown(bar(), { key: 'd', ctrlKey: true });
    fireEvent.keyDown(bar(), { key: 'd', metaKey: true });
    expect(flow.stepReview).not.toHaveBeenCalled();
  });

  it('answers a question in the session\'s own input, on R', () => {
    open(question);
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(document.activeElement).toBe(bar());
    // The pane's chat input sits next to the bar, inside the same pane.
    const input = document.createElement('textarea');
    bar().parentElement!.appendChild(input);
    fireEvent.keyDown(bar(), { key: 'r' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(bar(), { key: 'e' });
    expect(flow.finishCurrent).not.toHaveBeenCalled();
    input.remove();
  });

  it('takes the keyboard back after a reply is sent from its pane', () => {
    open(result);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    act(() => returnToReviewBar('other-pane'));
    expect(document.activeElement).toBe(input);
    act(() => returnToReviewBar('pane'));
    expect(document.activeElement).toBe(bar());
    input.remove();
  });
});
