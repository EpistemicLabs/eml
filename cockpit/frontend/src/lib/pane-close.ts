import * as paneStore from '@/stores/usePaneStore';
import { api } from '@/utils/api';

/**
 * Close a pane (×). A pane in the terminal fallback releases its session's
 * terminal, which ends after the host's timeout; the session stays resumable.
 * The pane's shell (Shell plugin) ends with it, like a closed terminal window.
 * Pinned and main panes stay, as removePane keeps them.
 */
export function closePane(paneId: string): void {
  const pane = paneStore.getPane(paneId);
  if (!pane || paneStore.isPaneProtected(paneId)) return;
  if (pane.terminalFallback && pane.sessionId) {
    void api.releaseSession(pane.sessionId, paneId).catch(() => {
      // Unreachable host: a kept session then stays kept until it is closed again.
    });
  }
  if (pane.shellId) {
    void api.endShell(pane.shellId).catch(() => {
      // Unreachable host: the shell ends after the host's detach timeout.
    });
  }
  paneStore.removePane(paneId);
}
