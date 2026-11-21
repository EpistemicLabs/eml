// The `shell` pane view (task cockpit-plugin-terminal): a terminal on this
// computer — the user's login shell in the home folder, as their terminal app
// opens it, of no project. The host runs it in the PTY bridge beside the agent
// sessions (pty-bridge.ts, `init` with kind 'shell'); this pane is the same
// xterm as a session's terminal. The pane mints its shell id the first time it
// shows the view and keeps it, so a reload reattaches; closing the pane ends
// the shell (lib/pane-close.ts).
import { useEffect } from 'react';

import { newCliSessionId, updatePane, usePane } from '@/stores/usePaneStore';

import TerminalPane from '../shell/view/TerminalPane';

export function ShellPluginPane({ paneId, isActive }: { paneId: string; isActive: boolean }) {
  const shellId = usePane(paneId)?.shellId ?? null;
  useEffect(() => {
    if (!shellId) updatePane(paneId, { shellId: newCliSessionId() });
  }, [paneId, shellId]);
  if (!shellId) return null;
  return (
    <TerminalPane
      kind="shell"
      paneId={paneId}
      projectId={null}
      sessionId={shellId}
      sessionTitle="Shell"
      initialCommand={null}
      isActive={isActive}
      autoConnect
    />
  );
}
