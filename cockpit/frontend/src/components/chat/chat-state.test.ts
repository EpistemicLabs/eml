import { describe, expect, it } from 'vitest';

import { EMPTY_CHAT, currentModelOption, groupItems, keysToReveal, latestToolId, matchCommands, reduceChat, searchItems, sentMessages, statusLine, stepHistory, type ChatEvent, type ChatState } from './chat-state';

const fold = (events: ChatEvent[], from: ChatState = EMPTY_CHAT): ChatState =>
  events.reduce((state, event, index) => reduceChat(state, event, index + 1), from);

const tool = (toolId: string): ChatEvent => ({ kind: 'tool_call', toolId, name: 'Bash', toolKind: 'execute', title: `Run ${toolId}`, input: {} });

describe('background shells', () => {
  const started: ChatEvent = { kind: 'shell_task', taskId: 's', toolId: 't', description: 'npm run dev', status: 'running' };

  it('a shell outlives its turn and ends when it says so', () => {
    const state = fold([started, { kind: 'turn_end', reason: 'success' }]);
    expect(state.shells[0]).toMatchObject({ description: 'npm run dev', status: 'running' });
    expect(fold([{ kind: 'shell_task', taskId: 's', status: 'stopped' }], state).shells[0]).toMatchObject({ description: 'npm run dev', status: 'stopped' });
  });

  it('goes with the process', () => {
    expect(fold([started, { kind: 'runtime_exit', expected: true }]).shells[0].status).toBe('stopped');
  });
});

describe('subagents', () => {
  const started: ChatEvent = { kind: 'agent_task', taskId: 'a', toolId: 't', description: 'Look', status: 'running', background: false };

  it('merges a task\'s updates and tracks its tool calls under the call that started it', () => {
    const state = fold([
      started,
      { kind: 'agent_task', taskId: 'a', activity: 'Reading', tokens: 10 },
      { kind: 'agent_tool', parentToolId: 't', toolId: 'r', toolKind: 'read', title: 'Read /x', status: 'running' },
      { kind: 'agent_tool', parentToolId: 't', toolId: 'r', status: 'completed' },
      { kind: 'agent_tool', parentToolId: 't', toolId: 'unknown', status: 'completed' },
    ]);
    expect(state.agents[0]).toMatchObject({ description: 'Look', activity: 'Reading', tokens: 10, status: 'running' });
    expect(state.agentTools.t).toEqual([{ id: 'r', toolKind: 'read', title: 'Read /x', status: 'completed' }]);
  });

  it('an interrupt stops the foreground ones, a process exit all of them', () => {
    const background: ChatEvent = { kind: 'agent_task', taskId: 'b', status: 'running', background: true };
    const interrupted = fold([started, background, { kind: 'turn_end', reason: 'interrupted' }]);
    expect(interrupted.agents.map((agent) => agent.status)).toEqual(['stopped', 'running']);
    expect(fold([{ kind: 'runtime_exit', expected: false }], interrupted).agents.map((agent) => agent.status)).toEqual(['stopped', 'stopped']);
  });

  it('a subagent never disappears into a tool group', () => {
    const agent: ChatEvent = { kind: 'tool_call', toolId: 'g', name: 'Agent', toolKind: 'agent', title: 'Agent', input: {} };
    const groups = groupItems(fold([tool('1'), agent, tool('2')]).items);
    expect(groups.map((group) => group.kind)).toEqual(['tools', 'agent', 'tools']);
  });
});

describe('session settings', () => {
  it('a settings event changes only what it names', () => {
    const state = fold([{ kind: 'settings', model: 'm', mode: 'auto' }, { kind: 'settings', mode: 'plan' }]);
    expect(state).toMatchObject({ model: 'm', mode: 'plan' });
  });

  it('a new conversation clears the view but not what the session runs with', () => {
    const state = fold([{ kind: 'settings', model: 'm', mode: 'auto' }, tool('1'), { kind: 'conversation_reset', conversationId: 'c' }]);
    expect(state.items.map((item) => item.type)).toEqual(['notice']);
    expect(state).toMatchObject({ model: 'm', mode: 'auto' });
  });

  it('finds the model option by id or by what it stands for', () => {
    const models = [{ id: 'default', label: 'Default', description: '', resolved: 'claude-x' }, { id: 'x', label: 'X', description: '', resolved: 'claude-x' }];
    expect(currentModelOption({ model: 'claude-x', models })?.id).toBe('default');
    expect(currentModelOption({ model: 'other', models })).toBeNull();
  });
});

describe('keyboard helpers', () => {
  const user: ChatEvent = { kind: 'user_message', id: 'u', text: 'Find the Bug', queued: false };
  const result: ChatEvent = { kind: 'tool_result', toolId: '2', status: 'completed', output: 'a bug here' };
  const { items } = fold([user, tool('1'), tool('2'), result, { kind: 'text', blockId: 'a', text: 'done' }, tool('3')]);

  it('reveals a row with the group it is folded into', () => {
    expect(keysToReveal(items, '2')).toEqual(['group:1', '2']);
    expect(keysToReveal(items, '3')).toEqual(['3']);
    expect(keysToReveal(items, 'a')).toEqual([]);
  });

  it('finds the newest tool call', () => {
    expect(latestToolId(items)).toBe('3');
    expect(latestToolId([])).toBeNull();
  });

  it('searches titles, output and messages, also in folded rows, ignoring case', () => {
    expect(searchItems(items, 'BUG')).toEqual(['u', '2']);
    expect(searchItems(items, 'Run 3')).toEqual(['3']);
    expect(searchItems(items, '  ')).toEqual([]);
  });

  it('goes back through sent messages and out again', () => {
    expect(sentMessages(items)).toEqual(['Find the Bug']);
    expect(stepHistory(2, null, -1)).toBe(1);
    expect(stepHistory(2, 1, -1)).toBe(0);
    expect(stepHistory(2, 0, -1)).toBe(0);
    expect(stepHistory(2, 0, 1)).toBe(1);
    expect(stepHistory(2, 1, 1)).toBeNull();
    expect(stepHistory(2, null, 1)).toBeNull();
    expect(stepHistory(0, null, -1)).toBeNull();
  });
});

describe('images in messages', () => {
  it('keeps what came with a message, and leaves a message without words out of the recall list', () => {
    const { items } = fold([
      { kind: 'user_message', id: 'a', text: '', queued: false, images: [{ url: '/x.png' }] },
      { kind: 'user_message', id: 'b', text: 'hi', queued: false },
    ]);
    expect(items[0]).toMatchObject({ images: [{ url: '/x.png' }] });
    expect(items[1]).toMatchObject({ images: [] });
    expect(sentMessages(items)).toEqual(['hi']);
  });
});

describe('matchCommands', () => {
  const command = (name: string, aliases: string[] = []) => ({ name, description: '', argumentHint: '', aliases });
  const list = [command('review'), command('compact'), command('usage', ['cost']), command('recap')];
  const names = (draft: string) => matchCommands(list, draft).map((c) => c.name);

  it('lists everything for a lone slash and ranks name starts first', () => {
    expect(names('/')).toEqual(['review', 'compact', 'usage', 'recap']);
    expect(names('/re')).toEqual(['review', 'recap']);
    expect(names('/ac')).toEqual(['compact']);
    expect(names('/cost')).toEqual(['usage']);
  });

  it('is quiet once there is more than a bare word', () => {
    expect(names('hello')).toEqual([]);
    expect(names('/compact now')).toEqual([]);
    expect(names('/compact ')).toEqual([]);
  });
});

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
  const card = (requestId: string): ChatEvent => ({ kind: 'permission_request', requestId, toolId: null, toolName: 'Bash', title: 'Run', input: {}, reason: null, alwaysScope: null });

  it('folds calls, failed ones and thinking into one group', () => {
    const state = fold([
      tool('a'), { kind: 'thinking', blockId: 'x', text: 'hm' }, tool('b'),
      { kind: 'tool_result', toolId: 'b', status: 'failed', output: 'no' },
    ]);
    const groups = groupItems(state.items);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'tools', tools: [{ id: 'a' }, { id: 'x' }, { id: 'b' }] });
  });

  it('a settled card folds away whatever its outcome, a waiting one stays', () => {
    for (const outcome of ['allowed', 'always', 'denied', 'cancelled'] as const) {
      const state = fold([tool('a'), card('r'), { kind: 'request_settled', requestId: 'r', outcome }, tool('b')]);
      expect(groupItems(state.items)).toHaveLength(1);
    }
    expect(groupItems(fold([tool('a'), card('r'), tool('b')]).items)).toHaveLength(3);
  });

  it('answers, errors and notices stay open and split a run', () => {
    const state = fold([tool('a'), { kind: 'text', blockId: 't', text: 'answer' }, tool('b'), { kind: 'error', message: 'boom' }, tool('c')]);
    expect(groupItems(state.items).map((g) => g.kind)).toEqual(['tools', 'item', 'tools', 'item', 'tools']);
  });

  it('the tool row keeps the approval', () => {
    const state = fold([
      tool('a'),
      { kind: 'permission_request', requestId: 'r', toolId: 'a', toolName: 'Bash', title: 'Run', input: {}, reason: null, alwaysScope: null },
      { kind: 'request_settled', requestId: 'r', outcome: 'always' },
    ]);
    expect(state.items[0]).toMatchObject({ type: 'tool', approval: 'always' });
  });

  it('an empty thinking block does not split a run', () => {
    const state = fold([tool('a'), { kind: 'thinking', blockId: 'x', text: '' }, tool('b')]);
    expect(groupItems(state.items)).toHaveLength(1);
  });
});
