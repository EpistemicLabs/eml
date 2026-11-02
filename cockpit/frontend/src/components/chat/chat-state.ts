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
  | { kind: 'user_message'; id: string; text: string; queued: boolean; images?: Array<{ url: string | null }> }
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
  | { kind: 'process'; state: 'stopped' | 'starting' }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'runtime_exit'; expected: boolean };

export type ChatItem =
  | { type: 'user'; id: string; text: string; queued: boolean; images: Array<{ url: string | null }> }
  | { type: 'assistant'; id: string; text: string; streaming: boolean }
  | { type: 'thinking'; id: string; text: string; streaming: boolean }
  | { type: 'tool'; id: string; name: string; toolKind: ToolKind; title: string; input: Record<string, unknown>; status: ToolStatus; output: string; approval?: RequestOutcome }
  | { type: 'permission'; id: string; toolId?: string | null; toolName: string; title: string; input: Record<string, unknown>; reason: string | null; alwaysScope: string | null; outcome: RequestOutcome | null }
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
  /** Whether a process runs the session. `unknown`: the host has not said yet, so the view still loads. */
  process: 'unknown' | 'stopped' | 'starting' | 'ready';
}

export const EMPTY_CHAT: ChatState = {
  items: [], activity: 'idle', model: null, mode: null, models: [], modes: [], commands: [], context: null, agents: [], shells: [], agentTools: {}, failed: false, process: 'unknown',
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

const SHOWS_IT_RUNS = new Set<ChatEvent['kind']>(['capabilities', 'text_delta', 'text', 'thinking_delta', 'thinking', 'tool_call', 'turn_end']);

export function reduceChat(state: ChatState, event: ChatEvent, seq: number): ChatState {
  const next = foldEvent(state, event, seq);
  return next.process === 'starting' && SHOWS_IT_RUNS.has(event.kind) ? { ...next, process: 'ready' } : next;
}

function foldEvent(state: ChatState, event: ChatEvent, seq: number): ChatState {
  const { items } = state;
  switch (event.kind) {
    case 'settings':
      return {
        ...state,
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.mode !== undefined ? { mode: event.mode } : {}),
      };
    case 'process':
      return { ...state, process: event.state };
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
    case 'user_message': {
      // The view shows a message from the moment it is sent; here it comes back from the host.
      const shown = indexOfItem(items, 'user', event.id);
      if (shown >= 0) {
        const item = items[shown] as Extract<ChatItem, { type: 'user' }>;
        return { ...state, failed: false, items: replaceAt(items, shown, { ...item, queued: event.queued, images: event.images ?? item.images }) };
      }
      return {
        ...state,
        failed: false,
        items: [...items, { type: 'user', id: event.id, text: event.text, queued: event.queued, images: event.images ?? [] }],
      };
    }
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
          type: 'permission', id: event.requestId, toolId: event.toolId, toolName: event.toolName, title: event.title,
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
      const settled = replaceAt(items, index, { ...item, outcome: event.outcome });
      // The tool row keeps the decision, for when it is opened.
      const toolIndex = item.type === 'permission' && item.toolId ? indexOfItem(settled, 'tool', item.toolId) : -1;
      if (toolIndex >= 0) settled[toolIndex] = { ...(settled[toolIndex] as Extract<ChatItem, { type: 'tool' }>), approval: event.outcome };
      return { ...state, items: settled };
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
      return { ...state, activity: 'idle', process: 'stopped', items: settleTools(items),
        agents: stopAgents(state.agents, false),
        shells: state.shells.map((shell) => (shell.status === 'running' ? { ...shell, status: 'stopped' } : shell)),
      };
    case 'usage':
      return state;
  }
}

/** What folds into one line and opens on demand: the work behind an answer. */
export type FoldedItem = Extract<ChatItem, { type: 'tool' | 'thinking' }>;

export type RenderGroup =
  | { kind: 'item'; item: Exclude<ChatItem, { type: 'tool' | 'thinking' }> }
  | { kind: 'tools'; id: string; tools: FoldedItem[] }
  | { kind: 'agent'; tool: Extract<ChatItem, { type: 'tool' }> };

/**
 * Looking around folds: adjacent reads, searches and thinking sit in one group, named
 * by foldSummary, and a settled card goes (its tool row keeps the decision). What
 * changes or can fail stays a row of its own: edits, commands, whatever failed. What
 * stays open: messages, answers, cards still waiting for the user, errors, subagents.
 */
export function groupItems(items: ChatItem[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let run: FoldedItem[] = [];
  const flush = () => {
    if (run.length > 0) groups.push({ kind: 'tools', id: run[0].id, tools: run });
    run = [];
  };
  for (const item of items) {
    if (item.type === 'thinking') {
      if (item.text) run.push(item);
    } else if (item.type === 'tool') {
      if (item.toolKind === 'agent') {
        flush();
        groups.push({ kind: 'agent', tool: item });
      } else if (item.status === 'failed' || item.toolKind === 'edit' || item.toolKind === 'execute') {
        flush();
        groups.push({ kind: 'tools', id: item.id, tools: [item] });
      } else {
        run.push(item);
      }
    } else if ((item.type === 'permission' || item.type === 'question') && item.outcome) {
      continue;
    } else {
      flush();
      groups.push({ kind: 'item', item });
    }
  }
  flush();
  return groups;
}

const SUMMARY_VERBS: Partial<Record<ToolKind, string>> = { read: 'Read', search: 'Searched', fetch: 'Fetched' };
// Per verb; the row cuts off what still doesn't fit.
const SUMMARY_TARGETS = 3;

function summaryTarget(tool: Extract<ChatItem, { type: 'tool' }>): string {
  const field = (...keys: string[]) => keys.map((key) => tool.input[key]).find((value): value is string => typeof value === 'string' && !!value);
  const path = field('file_path', 'notebook_path');
  if (path) return path.split(/[\\/]/).pop() ?? path;
  const query = field('pattern', 'query');
  if (query) return `"${query}"`;
  return field('url', 'path', 'description') ?? '';
}

/** One line for a folded run that says what was looked at, so a wrong turn shows without opening it. */
export function foldSummary(items: FoldedItem[]): string {
  const parts: Array<{ verb: string; targets: string[] }> = [];
  for (const item of items) {
    if (item.type !== 'tool') continue;
    const verb = SUMMARY_VERBS[item.toolKind] ?? item.name;
    const last = parts[parts.length - 1];
    const target = summaryTarget(item);
    if (last?.verb === verb) { if (target && !last.targets.includes(target)) last.targets.push(target); } else parts.push({ verb, targets: target ? [target] : [] });
  }
  if (parts.length === 0) return 'Thinking';
  return parts.map(({ verb, targets }) => {
    const shown = targets.slice(0, SUMMARY_TARGETS).join(', ');
    const more = targets.length > SUMMARY_TARGETS ? ` +${targets.length - SUMMARY_TARGETS} more` : '';
    return [verb, shown].filter(Boolean).join(' ') + more;
  }).join(' · ');
}

export interface DiffLine {
  sign: ' ' | '+' | '-';
  text: string;
}

function diffOf(before: string, after: string): DiffLine[] {
  const old = before ? before.split('\n') : [];
  const next = after ? after.split('\n') : [];
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  const same = (line: string): DiffLine => ({ sign: ' ', text: line });
  return [
    ...old.slice(0, start).map(same),
    ...old.slice(start, old.length - end).map((text): DiffLine => ({ sign: '-', text })),
    ...next.slice(start, next.length - end).map((text): DiffLine => ({ sign: '+', text })),
    ...old.slice(old.length - end).map(same),
  ];
}

/** An edit call's change, from its input; null when the input doesn't say. */
export function editDiff(input: Record<string, unknown>): { lines: DiffLine[]; added: number; removed: number } | null {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  let lines: DiffLine[] | null = null;
  if (Array.isArray(input.edits)) lines = (input.edits as Array<Record<string, unknown>>).flatMap((edit) => diffOf(text(edit.old_string), text(edit.new_string)));
  else if (typeof input.old_string === 'string' || typeof input.new_string === 'string') lines = diffOf(text(input.old_string), text(input.new_string));
  else if (typeof input.content === 'string') lines = diffOf('', input.content);
  if (!lines) return null;
  return {
    lines,
    added: lines.filter((line) => line.sign === '+').length,
    removed: lines.filter((line) => line.sign === '-').length,
  };
}

const PREVIEW_LINES = 3;

/** A command's output in a few lines: its start and, where a failure usually says why, its end. */
export function outputPreview(output: string): { head: string[]; hidden: number; tail: string[] } {
  const lines = output.replace(/\n+$/, '').split('\n');
  if (lines.length <= PREVIEW_LINES) return { head: lines, hidden: 0, tail: [] };
  return { head: lines.slice(0, 1), hidden: lines.length - PREVIEW_LINES, tail: lines.slice(-2) };
}

// As near the bottom as still counts as being there.
const AT_BOTTOM_PX = 70;

/** Whether a view that just got shorter had its reader at the bottom before that. */
export function wasAtBottom(view: { scrollHeight: number; scrollTop: number; clientHeight: number }, previousHeight: number): boolean {
  const shrunk = previousHeight - view.clientHeight;
  if (shrunk <= 0) return false;
  return view.scrollHeight - view.scrollTop - previousHeight <= AT_BOTTOM_PX;
}

/** What has to be open to see an item: its row, and the group it is folded into. */
export function keysToReveal(items: ChatItem[], id: string): string[] {
  for (const group of groupItems(items)) {
    if (group.kind === 'agent' && group.tool.id === id) return [id];
    if (group.kind === 'tools' && group.tools.some((item) => item.id === id)) {
      return group.tools.length > 1 ? [`group:${group.id}`, id] : [id];
    }
  }
  return [];
}

/** The tool call Ctrl+O acts on: the newest one that has a row. */
export function latestToolId(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].type === 'tool') return items[i].id;
  }
  return null;
}

/** The items whose text holds the query, oldest first. Folded rows count, whether open or not. */
export function searchItems(items: ChatItem[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return items.filter((item) => {
    const text = item.type === 'tool' ? `${item.title}\n${item.output}`
      : item.type === 'user' || item.type === 'assistant' || item.type === 'thinking' ? item.text
        : '';
    return text.toLowerCase().includes(needle);
  }).map((item) => item.id);
}

/** The user's messages, oldest first, for going back through them with the arrow keys. */
export function sentMessages(items: ChatItem[]): string[] {
  return items.flatMap((item) => (item.type === 'user' && item.text ? [item.text] : []));
}

/** The newest message of the user, also one with images only. */
export function latestUserMessageId(items: ChatItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === 'user') return item.id;
  }
  return null;
}

/**
 * One step through the sent messages. `index` null: not browsing them. Back from there
 * starts at the newest; forward past the newest leaves the list, which gives null.
 */
export function stepHistory(count: number, index: number | null, step: -1 | 1): number | null {
  if (count === 0) return null;
  if (index === null) return step === -1 ? count - 1 : null;
  const next = index + step;
  if (next < 0) return 0;
  return next >= count ? null : next;
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
  if (state.process === 'starting') return 'Starting session…';
  if (state.activity === 'working') return 'Working…';
  if (state.failed) return 'The last turn failed';
  // An empty new session has nothing that stopped.
  if (state.process === 'stopped' && state.items.length > 0) return 'Session stopped. It starts when you send a message.';
  return null;
}
