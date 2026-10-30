import { describe, expect, it } from 'vitest';

import { EMPTY_CHAT, groupItems, reduceChat, statusLine, type ChatEvent, type ChatState } from './chat-state';

const fold = (events: ChatEvent[], from: ChatState = EMPTY_CHAT): ChatState =>
  events.reduce((state, event, index) => reduceChat(state, event, index + 1), from);

const tool = (toolId: string): ChatEvent => ({ kind: 'tool_call', toolId, name: 'Bash', toolKind: 'execute', title: `Run ${toolId}`, input: {} });

describe('reduceChat', () => {
  it('replaces streamed text with the complete block', () => {
    const state = fold([
      { kind: 'text_delta', blockId: 'a', delta: 'Hel' },
      { kind: 'text_delta', blockId: 'a', delta: 'lo' },
    ]);
    expect(state.items).toEqual([{ type: 'assistant', id: 'a', text: 'Hello', streaming: true }]);
    expect(fold([{ kind: 'text', blockId: 'a', text: 'Hello!' }], state).items)
      .toEqual([{ type: 'assistant', id: 'a', text: 'Hello!', streaming: false }]);
  });

  it('pairs a tool result with its call', () => {
    const state = fold([tool('t1'), { kind: 'tool_result', toolId: 't1', status: 'completed', output: 'ok' }]);
    expect(state.items[0]).toMatchObject({ type: 'tool', status: 'completed', output: 'ok' });
  });

  it('keeps a launched agent call apart from a finished one', () => {
    const state = fold([tool('t1'), { kind: 'tool_result', toolId: 't1', status: 'launched', output: '' }]);
    expect(state.items[0]).toMatchObject({ status: 'launched' });
  });

  it('a settled card stays as a row with its outcome', () => {
    const state = fold([
      { kind: 'permission_request', requestId: 'r', toolId: 't', toolName: 'Bash', title: 'Run x', input: {}, reason: null, alwaysScope: null },
      { kind: 'request_settled', requestId: 'r', outcome: 'denied' },
    ]);
    expect(state.items[0]).toMatchObject({ type: 'permission', outcome: 'denied' });
  });

  it('a stream that ends in an error is not left streaming', () => {
    const state = fold([
      { kind: 'text_delta', blockId: 'a', delta: 'par' },
      tool('t1'),
      { kind: 'error', message: 'boom' },
      { kind: 'turn_end', reason: 'error' },
    ]);
    expect(state.items[0]).toMatchObject({ streaming: false });
    expect(state.items[1]).toMatchObject({ status: 'interrupted' });
    expect(state.failed).toBe(true);
  });

  it('a process that dies does not leave the status stuck', () => {
    const state = fold([{ kind: 'activity', state: 'working' }, tool('t1'), { kind: 'runtime_exit', expected: false }]);
    expect(state.activity).toBe('idle');
    expect(statusLine(state)).toBeNull();
  });

  it('a queued message loses its mark when the turn before it ends', () => {
    const state = fold([
      { kind: 'user_message', id: 'u1', text: 'one', queued: false },
      { kind: 'user_message', id: 'u2', text: 'two', queued: true },
      { kind: 'turn_end', reason: 'success' },
    ]);
    expect(state.items[1]).toMatchObject({ queued: false });
  });

  it('says it is waiting while a card is open, even if the turn state lags', () => {
    const state = fold([{ kind: 'question', requestId: 'q', questions: [] }]);
    expect(statusLine(state)).toBe('Waiting for your answer');
  });
});

describe('groupItems', () => {
  it('folds adjacent calls into one group and lets a failed one break out', () => {
    const state = fold([
      tool('a'), tool('b'), tool('c'), tool('d'),
      { kind: 'tool_result', toolId: 'c', status: 'failed', output: 'no' },
    ]);
    const groups = groupItems(state.items);
    expect(groups.map((g) => (g.kind === 'tools' ? g.tools.map((t) => t.id) : []))).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('an empty thinking block does not split a run', () => {
    const state = fold([tool('a'), { kind: 'thinking', blockId: 'x', text: '' }, tool('b')]);
    expect(groupItems(state.items)).toHaveLength(1);
  });
});
