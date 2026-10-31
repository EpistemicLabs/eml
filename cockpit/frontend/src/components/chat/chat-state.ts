// The chat view's state as a pure fold over the host's events
// (host domain/session-runtime.ts). One source: a view is rebuilt from the log,
// never merged with anything else.

export type ToolStatus = 'running' | 'completed' | 'failed' | 'launched' | 'interrupted';
export type ToolKind = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'agent' | 'other';
export type Activity = 'idle' | 'working' | 'waiting';
export type RequestOutcome = 'allowed' | 'always' | 'denied' | 'answered' | 'cancelled';

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

export type ChatEvent =
  | { kind: 'ready'; model: string | null }
  | { kind: 'user_message'; id: string; text: string; queued: boolean }
  | { kind: 'text_delta'; blockId: string; delta: string }
  | { kind: 'text'; blockId: string; text: string }
  | { kind: 'thinking_delta'; blockId: string; delta: string }
  | { kind: 'thinking'; blockId: string; text: string }
  | { kind: 'tool_call'; toolId: string; name: string; toolKind: ToolKind; title: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; toolId: string; status: 'completed' | 'failed' | 'launched'; output: string }
  | { kind: 'permission_request'; requestId: string; toolId: string | null; toolName: string; title: string; input: Record<string, unknown>; reason: string | null; alwaysScope: string | null }
  | { kind: 'question'; requestId: string; questions: Question[] }
  | { kind: 'request_settled'; requestId: string; outcome: RequestOutcome }
  | { kind: 'activity'; state: Activity }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'turn_end'; reason: 'success' | 'interrupted' | 'error' }
  | { kind: 'compaction' }
  | { kind: 'history_end' }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'runtime_exit'; expected: boolean };

export type ChatItem =
  | { type: 'user'; id: string; text: string; queued: boolean }
  | { type: 'assistant'; id: string; text: string; streaming: boolean }
  | { type: 'thinking'; id: string; text: string; streaming: boolean }
  | { type: 'tool'; id: string; name: string; toolKind: ToolKind; title: string; input: Record<string, unknown>; status: ToolStatus; output: string }
  | { type: 'permission'; id: string; toolName: string; title: string; input: Record<string, unknown>; reason: string | null; alwaysScope: string | null; outcome: RequestOutcome | null }
  | { type: 'question'; id: string; questions: Question[]; outcome: RequestOutcome | null }
  | { type: 'notice'; id: string; text: string }
  | { type: 'error'; id: string; text: string }
  | { type: 'interrupted'; id: string };

export interface ChatState {
  items: ChatItem[];
  activity: Activity;
  model: string | null;
  /** The last turn ended in a failure; cleared by the next one. */
  failed: boolean;
}

export const EMPTY_CHAT: ChatState = { items: [], activity: 'idle', model: null, failed: false };

function indexOfItem(items: ChatItem[], type: ChatItem['type'], id: string): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].type === type && items[i].id === id) return i;
  }
  return -1;
}

function replaceAt(items: ChatItem[], index: number, item: ChatItem): ChatItem[] {
  const next = items.slice();
  next[index] = item;
  return next;
}

/** A turn is over: nothing in it runs any more, and queued messages are next. */
function settleTools(items: ChatItem[]): ChatItem[] {
  let next = items;
  items.forEach((item, index) => {
    if (item.type === 'tool' && item.status === 'running') {
      if (next === items) next = items.slice();
      next[index] = { ...item, status: 'interrupted' };
    } else if ((item.type === 'assistant' || item.type === 'thinking') && item.streaming) {
      if (next === items) next = items.slice();
      next[index] = { ...item, streaming: false };
    }
  });
  return next;
}

function unqueueFirst(items: ChatItem[]): ChatItem[] {
  const index = items.findIndex((item) => item.type === 'user' && item.queued);
  if (index < 0) return items;
  return replaceAt(items, index, { ...(items[index] as Extract<ChatItem, { type: 'user' }>), queued: false });
}

export function reduceChat(state: ChatState, event: ChatEvent, seq: number): ChatState {
  const { items } = state;
  switch (event.kind) {
    case 'ready':
      return { ...state, model: event.model };
    case 'user_message':
      return {
        ...state,
        failed: false,
        items: [...items, { type: 'user', id: event.id, text: event.text, queued: event.queued }],
      };
    case 'text_delta':
    case 'thinking_delta': {
      const type = event.kind === 'text_delta' ? 'assistant' : 'thinking';
      const index = indexOfItem(items, type, event.blockId);
      if (index < 0) return { ...state, items: [...items, { type, id: event.blockId, text: event.delta, streaming: true }] };
      const item = items[index] as Extract<ChatItem, { type: 'assistant' | 'thinking' }>;
      return { ...state, items: replaceAt(items, index, { ...item, text: item.text + event.delta }) };
    }
    case 'text':
    case 'thinking': {
      const type = event.kind === 'text' ? 'assistant' : 'thinking';
      const index = indexOfItem(items, type, event.blockId);
      const item = { type, id: event.blockId, text: event.text, streaming: false } as const;
      return { ...state, items: index < 0 ? [...items, item] : replaceAt(items, index, item) };
    }
    case 'tool_call':
      return {
        ...state,
        items: [...items, {
          type: 'tool', id: event.toolId, name: event.name, toolKind: event.toolKind, title: event.title,
          input: event.input, status: 'running', output: '',
        }],
      };
    case 'tool_result': {
      const index = indexOfItem(items, 'tool', event.toolId);
      if (index < 0) return state;
      const item = items[index] as Extract<ChatItem, { type: 'tool' }>;
      return { ...state, items: replaceAt(items, index, { ...item, status: event.status, output: event.output }) };
    }
    case 'permission_request':
      return {
        ...state,
        items: [...items, {
          type: 'permission', id: event.requestId, toolName: event.toolName, title: event.title,
          input: event.input, reason: event.reason, alwaysScope: event.alwaysScope, outcome: null,
        }],
      };
    case 'question':
      return { ...state, items: [...items, { type: 'question', id: event.requestId, questions: event.questions, outcome: null }] };
    case 'request_settled': {
      let index = indexOfItem(items, 'permission', event.requestId);
      if (index < 0) index = indexOfItem(items, 'question', event.requestId);
      if (index < 0) return state;
      const item = items[index] as Extract<ChatItem, { type: 'permission' | 'question' }>;
      return { ...state, items: replaceAt(items, index, { ...item, outcome: event.outcome }) };
    }
    case 'activity':
      return { ...state, activity: event.state };
    case 'turn_end': {
      const settled = unqueueFirst(settleTools(items));
      return {
        ...state,
        failed: event.reason === 'error',
        items: event.reason === 'interrupted' ? [...settled, { type: 'interrupted', id: `s${seq}` }] : settled,
      };
    }
    case 'history_end':
      return { ...state, items: settleTools(items) };
    case 'compaction':
      return { ...state, items: [...items, { type: 'notice', id: `s${seq}`, text: 'The conversation was compacted.' }] };
    case 'notice':
      return { ...state, items: [...items, { type: 'notice', id: `s${seq}`, text: event.text }] };
    case 'error':
      return { ...state, items: [...items, { type: 'error', id: `s${seq}`, text: event.message }] };
    case 'runtime_exit':
      // Whatever was running or asking went with the process; the status line must not stay stuck.
      return { ...state, activity: 'idle', items: settleTools(items) };
    case 'usage':
      return state;
  }
}

export type RenderGroup =
  | { kind: 'item'; item: Exclude<ChatItem, { type: 'tool' }> }
  | { kind: 'tools'; id: string; tools: Array<Extract<ChatItem, { type: 'tool' }>> };

/** Adjacent tool calls sit in one group; a failed one breaks out, so it is never hidden in a summary. */
export function groupItems(items: ChatItem[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let run: Array<Extract<ChatItem, { type: 'tool' }>> = [];
  const flush = () => {
    if (run.length > 0) groups.push({ kind: 'tools', id: run[0].id, tools: run });
    run = [];
  };
  for (const item of items) {
    if (item.type !== 'tool') {
      // A thinking block with nothing to show does not split a run of tools.
      if (item.type === 'thinking' && !item.text) continue;
      flush();
      groups.push({ kind: 'item', item });
    } else if (item.status === 'failed') {
      flush();
      groups.push({ kind: 'tools', id: item.id, tools: [item] });
    } else {
      run.push(item);
    }
  }
  flush();
  return groups;
}

/** The status line above the input; null when there is nothing to say. */
export function statusLine(state: ChatState): string | null {
  if (state.items.some((item) => (item.type === 'permission' || item.type === 'question') && item.outcome === null)) {
    return 'Waiting for your answer';
  }
  if (state.activity === 'waiting') return 'Waiting for your answer';
  if (state.activity === 'working') return 'Working…';
  if (state.failed) return 'The last turn failed';
  return null;
}
