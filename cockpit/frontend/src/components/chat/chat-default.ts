// When a terminal pane should show its session in the chat view instead.
export function shouldOpenInChat(pane: {
  view: string;
  /** How the session runs, when that just became known or changed here; null otherwise. */
  runtime: string | null;
  /** The setting that opens sessions in the chat view. */
  chatDefault: boolean;
  /** The view the user picked for this session in this browser. */
  pickedView: string | undefined;
  provider: string;
  /** A worker's start command waits for the terminal. */
  queuedCommand: boolean;
}): boolean {
  if (pane.view !== 'terminal' || pane.provider !== 'claude' || pane.queuedCommand) return false;
  if (pane.runtime === 'sdk') return true;
  return pane.chatDefault && pane.pickedView !== 'terminal';
}

// A worker's start command is needed until its first turn has run; after that the
// pane has no more use for it, and holding it would keep the pane in the terminal.
export function heldCommandAfter(command: string | null | undefined, turnState: string | undefined): string | null | undefined {
  return turnState === 'done' ? null : command;
}
