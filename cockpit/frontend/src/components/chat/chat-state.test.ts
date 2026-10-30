import { describe, expect, it } from 'vitest';

import { EMPTY_CHAT, currentModelOption, groupItems, matchCommands, reduceChat, statusLine, type ChatEvent, type ChatState } from './chat-state';

const fold = (events: ChatEvent[], from: ChatState = EMPTY_CHAT): ChatState =>
  events.reduce((state, event, index) => reduceChat(state, event, index + 1), from);

const tool = (toolId: string): ChatEvent => ({ kind: 'tool_call', toolId, name: 'Bash', toolKind: 'execute', title: `Run ${toolId}`, input: {} });

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
