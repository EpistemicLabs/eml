// How a new chat started from the empty pane's launcher begins: its first message and
// model wait here until the chat's socket opens, go to the host with the init, and are
// dropped once the host has the session. Also the last model list a chat reported, so the
// launcher can offer the models before any session of its own is running.
import type { ModelOption } from './chat-state';

export interface ChatStart {
  prompt: string | null;
  model: string | null;
}

/**
 * The frame a chat's socket opens with. `provider`: the agent CLI a new session starts with; the host
 * ignores it for a session it knows, which keeps its own. `prompt` and `model` likewise.
 */
export function chatInitFrame(opts: {
  paneId: string;
  projectId: string;
  sessionId: string;
  spaceId: string | null;
  /** Where the view stands in the session's events (chat-store resumePoint). */
  resume: Record<string, unknown>;
  wait: boolean;
  greet: boolean;
  provider: string | null;
  start: ChatStart | null;
}): Record<string, unknown> {
  const { start } = opts;
  return {
    type: 'init', paneId: opts.paneId, projectId: opts.projectId, sessionId: opts.sessionId, spaceId: opts.spaceId, ...opts.resume, readOnly: true,
    ...(opts.wait ? { whenIdle: true } : {}),
    // Settings › Preferences › Sessions; the host greets only a plain new chat, as in the terminal.
    greet: opts.greet,
    ...(opts.provider ? { provider: opts.provider } : {}),
    // A chat started from the launcher: its first message and model.
    ...(start?.prompt ? { prompt: start.prompt } : {}),
    ...(start?.model ? { model: start.model } : {}),
  };
}

const starts = new Map<string, ChatStart>();

export function queueChatStart(sessionId: string, start: ChatStart): void {
  starts.set(sessionId, start);
}

export function peekChatStart(sessionId: string): ChatStart | null {
  return starts.get(sessionId) ?? null;
}

export function clearChatStart(sessionId: string): void {
  starts.delete(sessionId);
}

const MODELS_KEY = 'cockpit-chat-models';

export function rememberModels(models: ModelOption[]): void {
  if (models.length === 0) return;
  try { localStorage.setItem(MODELS_KEY, JSON.stringify(models)); } catch { /* per-viewer only */ }
}

export function knownModels(): ModelOption[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MODELS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((m): m is ModelOption => typeof m?.id === 'string' && typeof m?.label === 'string') : [];
  } catch {
    return [];
  }
}
