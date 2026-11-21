// A terminal session has one viewer: a view that shows it outside its pane (the task panel) borrows
// it, and says so when it is done with it, so the pane takes it back.
export const RECLAIM_TERMINAL_EVENT = 'cockpit:reclaim-terminal';

export function reclaimTerminal(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(RECLAIM_TERMINAL_EVENT, { detail: { sessionId } }));
}
