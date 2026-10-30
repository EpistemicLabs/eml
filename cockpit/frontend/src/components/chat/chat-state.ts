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

export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
}

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  resolved: string | null;
}

export interface ModeOption {
  id: string;
  label: string;
  description: string;
}

export interface ShellTask {
  taskId: string;
  toolId: string | null;
  description: string;
  status: AgentTaskStatus;
}

export interface AgentTask {
  taskId: string;
  toolId: string | null;
  description: string;
  agentType: string | null;
  status: AgentTaskStatus;
  background: boolean;
  activity: string | null;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
}

export interface AgentTool {
  id: string;
  toolKind: ToolKind;
  title: string;
  status: ToolStatus;
}

export interface ToolServer {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error: string | null;
  scope: string | null;
  transport: 'web' | 'process' | null;
  toolCount: number;
}

export type ChatEvent =
  | { kind: 'settings'; model?: string | null; mode?: string }
  | { kind: 'capabilities'; models: ModelOption[]; modes: ModeOption[] }
  | { kind: 'commands'; commands: CommandInfo[] }
  | { kind: 'context'; usedTokens: number; maxTokens: number }
  | { kind: 'agent_task'; taskId: string; toolId?: string | null; description?: string; agentType?: string | null; status?: AgentTaskStatus; background?: boolean; activity?: string; tokens?: number; toolUses?: number; durationMs?: number }
  | { kind: 'shell_task'; taskId: string; toolId?: string | null; description?: string; status?: AgentTaskStatus }
  | { kind: 'agent_tool'; parentToolId: string; toolId: string; toolKind?: ToolKind; title?: string; status: ToolStatus }
  | { kind: 'conversation_reset'; conversationId: string }
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
  mode: string | null;
  models: ModelOption[];
  modes: ModeOption[];
  commands: CommandInfo[];
  context: { usedTokens: number; maxTokens: number } | null;
  agents: AgentTask[];
  /** Shells running in the background. */
  shells: ShellTask[];
  /** Tool calls inside subagents, by the call that started the subagent. */
  agentTools: Record<string, AgentTool[]>;
  /** The last turn ended in a failure; cleared by the next one. */
  failed: boolean;
}

export const EMPTY_CHAT: ChatState = {
  items: [], activity: 'idle', model: null, mode: null, models: [], modes: [], commands: [], context: null, agents: [], shells: [], agentTools: {}, failed: false,
};

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

/** Running subagents are over. `foregroundOnly`: a background one outlives the turn. */
function stopAgents(agents: AgentTask[], foregroundOnly: boolean): AgentTask[] {
  if (!agents.some((agent) => agent.status === 'running' && !(foregroundOnly && agent.background))) return agents;
  return agents.map((agent) => (agent.status === 'running' && !(foregroundOnly && agent.background) ? { ...agent, status: 'stopped' } : agent));
}

function reduceAgentTask(agents: AgentTask[], event: Extract<ChatEvent, { kind: 'agent_task' }>): AgentTask[] {
  const { kind: _kind, ...patch } = event;
  const index = agents.findIndex((agent) => agent.taskId === event.taskId);
  if (index >= 0) {
    const next = agents.slice();
    next[index] = { ...agents[index], ...patch };
    return next;
  }
  return [...agents, {
    toolId: null, description: 'Subagent', agentType: null, status: 'running', background: false,
    activity: null, tokens: null, toolUses: null, durationMs: null, ...patch,
  }];
}

function reduceShellTask(shells: ShellTask[], event: Extract<ChatEvent, { kind: 'shell_task' }>): ShellTask[] {
  const { kind: _kind, ...patch } = event;
  const index = shells.findIndex((shell) => shell.taskId === event.taskId);
  if (index >= 0) {
    const next = shells.slice();
    next[index] = { ...shells[index], ...patch };
    return next;
  }
  return [...shells, { toolId: null, description: 'Shell', status: 'running', ...patch }];
}

function reduceAgentTool(tools: Record<string, AgentTool[]>, event: Extract<ChatEvent, { kind: 'agent_tool' }>): Record<string, AgentTool[]> {
  const list = tools[event.parentToolId] ?? [];
  const index = list.findIndex((tool) => tool.id === event.toolId);
  if (index >= 0) {
    const next = list.slice();
    next[index] = { ...list[index], status: event.status };
    return { ...tools, [event.parentToolId]: next };
  }
  // A result without its call (the call was before this process): nothing to show it on.
  if (!event.title) return tools;
  return { ...tools, [event.parentToolId]: [...list, { id: event.toolId, toolKind: event.toolKind ?? 'other', title: event.title, status: event.status }] };
}

function unqueueFirst(items: ChatItem[]): ChatItem[] {
  const index = items.findIndex((item) => item.type === 'user' && item.queued);
  if (index < 0) return items;
  return replaceAt(items, index, { ...(items[index] as Extract<ChatItem, { type: 'user' }>), queued: false });
}

export function reduceChat(state: ChatState, event: ChatEvent, seq: number): ChatState {
  const { items } = state;
  switch (event.kind) {
    case 'settings':
      return {
        ...state,
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.mode !== undefined ? { mode: event.mode } : {}),
      };
    case 'capabilities':
      return { ...state, models: event.models, modes: event.modes };
    case 'commands':
      return { ...state, commands: event.commands };
    case 'context':
      return { ...state, context: { usedTokens: event.usedTokens, maxTokens: event.maxTokens } };
    case 'agent_task':
      return { ...state, agents: reduceAgentTask(state.agents, event) };
    case 'shell_task':
      return { ...state, shells: reduceShellTask(state.shells, event) };
    case 'agent_tool':
      return { ...state, agentTools: reduceAgentTool(state.agentTools, event) };
    case 'conversation_reset':
      return {
        ...state, agents: [], shells: [], agentTools: {}, context: null, failed: false,
        items: [{ type: 'notice', id: `s${seq}`, text: 'Started a new conversation.' }],
      };
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
        agents: event.reason === 'interrupted' ? stopAgents(state.agents, true) : state.agents,
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
      return { ...state, activity: 'idle', items: settleTools(items),
        agents: stopAgents(state.agents, false),
        shells: state.shells.map((shell) => (shell.status === 'running' ? { ...shell, status: 'stopped' } : shell)),
      };
    case 'usage':
      return state;
  }
}

export type RenderGroup =
  | { kind: 'item'; item: Exclude<ChatItem, { type: 'tool' }> }
  | { kind: 'tools'; id: string; tools: Array<Extract<ChatItem, { type: 'tool' }>> }
  | { kind: 'agent'; tool: Extract<ChatItem, { type: 'tool' }> };

/** Adjacent tool calls sit in one group; a failed one or a subagent breaks out, so it is never hidden in a summary. */
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
    } else if (item.toolKind === 'agent') {
      flush();
      groups.push({ kind: 'agent', tool: item });
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

/** The commands a draft is asking for: only while it is a bare `/word`. Name matches first, in the list's order. */
export function matchCommands(commands: CommandInfo[], draft: string): CommandInfo[] {
  const typed = /^\/(\S*)$/.exec(draft)?.[1];
  if (typed === undefined) return [];
  const query = typed.toLowerCase();
  const rank = (command: CommandInfo): number => {
    const name = command.name.toLowerCase();
    if (name.startsWith(query)) return 0;
    if (command.aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 1;
    return name.includes(query) ? 2 : 3;
  };
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter(({ rank: r }) => r < 3)
    .sort((a, b) => a.rank - b.rank)
    .map(({ command }) => command);
}

/** The option a session's model shows as: several can stand for one model, the first one speaks. */
export function currentModelOption(state: Pick<ChatState, 'model' | 'models'>): ModelOption | null {
  return state.models.find((option) => option.id === state.model || option.resolved === state.model) ?? null;
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
