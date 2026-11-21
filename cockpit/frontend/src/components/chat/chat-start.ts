// How a new chat started from the empty pane's launcher begins: its first message and
// model wait here until the chat's socket opens, go to the host with the init, and are
// dropped once the host has the session. Also the last model list a chat reported, so the
// launcher can offer the models before any session of its own is running.
import type { ModelOption } from './chat-state';

export interface ChatStart {
  prompt: string | null;
  model: string | null;
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
