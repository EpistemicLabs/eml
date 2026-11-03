// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';

// The review screen's bar holds the keyboard: D, A, E, R and Esc act on it alone,
// a key never lands in an input by itself, and Esc does not reach the session
// below. Answers go in the session's own input; a reply gives the keyboard back.

let sessions: AllSession[] = [];
vi.mock('@/components/sidebar/useAllSessions', () => ({ useAllSessions: () => ({ sessions, queued: [], refresh: () => {} }) }));
vi.mock('@/stores/useTurnStateStore', () => ({ useTurnStore: () => ({ turns: {} }) }));
// The session's own view: its input at the bottom.
vi.mock('@/components/chat/ChatPane', () => ({ ChatPane: () => <textarea aria-label="Message" /> }));
vi.mock('@/components/standalone-shell/view/StandaloneShell', () => ({ default: () => <div>terminal</div> }));
const flow = vi.hoisted(() => ({
  stepReview: vi.fn(),
  endReview: vi.fn(),
  finishCurrent: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/review-flow', async (original) => ({ ...(await original<typeof import('@/lib/review-flow')>()), ...flow }));

const { ReviewScreen } = await import('./ReviewScreen');
const { returnToReviewBar, setReview, REVIEW_PANE_ID } = await import('@/stores/useReviewStore');

const result = { id: 'a', spaceId: 'main', __projectId: 'p', runtime: 'sdk', summary: 'First', attention: { kind: 'done', at: '2026-11-03T00:00:00Z' } } as unknown as AllSession;
const question = { ...result, id: 'q', summary: 'Asks', attention: { kind: 'question', at: '2026-11-03T00:00:00Z', reason: 'Which one?' } } as unknown as AllSession;

const bar = () => screen.getByLabelText('Review');
const input = () => screen.getByLabelText('Message');

describe('the review screen', () => {
  beforeEach(() => {
    Object.values(flow).forEach((fn) => fn.mockClear());
  });
  afterEach(() => {
    cleanup();
    act(() => setReview(null));
  });

  const open = (current: AllSession) => {
    sessions = [current, { ...result, id: 'b' }];
    act(() => setReview({ queue: [current.id, 'b'], index: 0 }));
    render(<ReviewScreen />);
  };

  it('takes the focus, and D, A and E act on it', () => {
    open(result);
    expect(document.activeElement).toBe(bar());
    fireEvent.keyDown(bar(), { key: 'd' });
    expect(flow.stepReview).toHaveBeenLastCalledWith(1, expect.anything());
    fireEvent.keyDown(bar(), { key: 'a' });
    expect(flow.stepReview).toHaveBeenLastCalledWith(-1, expect.anything());
    fireEvent.keyDown(bar(), { key: 'e' });
    expect(flow.finishCurrent).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a key typed in the session\'s input', () => {
    open(result);
    fireEvent.keyDown(input(), { key: 'd' });
    fireEvent.keyDown(input(), { key: 'e' });
    expect(flow.stepReview).not.toHaveBeenCalled();
    expect(flow.finishCurrent).not.toHaveBeenCalled();
  });

  it('goes back to the desks on Escape without it reaching the session', () => {
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

  it('answers a question in the session\'s own input, and E does not archive it', () => {
    open(question);
    expect(screen.getByText(/Answer/)).toBeTruthy();
    fireEvent.keyDown(bar(), { key: 'r' });
    expect(document.activeElement).toBe(input());
    act(() => bar().focus());
    fireEvent.keyDown(bar(), { key: 'e' });
    expect(document.activeElement).toBe(input());
    expect(flow.finishCurrent).not.toHaveBeenCalled();
  });

  it('takes the keyboard back after a reply is sent from its input', () => {
    open(result);
    act(() => input().focus());
    act(() => returnToReviewBar('some-pane'));
    expect(document.activeElement).toBe(input());
    act(() => returnToReviewBar(REVIEW_PANE_ID));
    expect(document.activeElement).toBe(bar());
  });
});
