// How a new chat started from a launcher (the empty pane, the sidebar's New session, a pane's "+")
// begins: its agent, first message and model wait here until the chat's socket opens, go to the host
// with the init, and are dropped once the host has the session.
export interface ChatStart {
  /** The agent picker's choice; null: the pane's agent, else the cockpit's default. */
  provider: string | null;
  prompt: string | null;
  model: string | null;
}

/**
 * The frame a chat's socket opens with. `provider`: the agent CLI a new session starts with, the
 * launcher's choice before the pane's; the host ignores it for a session it knows, which keeps its own.
 * `prompt` and `model` likewise.
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
  const provider = start?.provider ?? opts.provider;
  return {
    type: 'init', paneId: opts.paneId, projectId: opts.projectId, sessionId: opts.sessionId, spaceId: opts.spaceId, ...opts.resume, readOnly: true,
    ...(opts.wait ? { whenIdle: true } : {}),
    // Settings › Preferences › Sessions; the host greets only a plain new chat, as in the terminal.
    greet: opts.greet,
    ...(provider ? { provider } : {}),
    // A chat started from a launcher: its first message and model.
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
