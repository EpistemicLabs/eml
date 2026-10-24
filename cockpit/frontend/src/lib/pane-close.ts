import * as paneStore from '@/stores/usePaneStore';
import { api } from '@/utils/api';

/**
 * Close a pane (×). A terminal pane's session process ends on the host now —
 * also one kept running for Remote Control, which a closed tab no longer ends —
 * and stays resumable from the sidebar. Pinned panes stay, as removePane keeps them.
 */
export function closePane(paneId: string): void {
  const pane = paneStore.getPane(paneId);
  if (!pane || pane.pinned) return;
  if (pane.paneView === 'terminal' && pane.sessionId) {
    void api.stopSession(pane.sessionId, paneId).catch(() => {
      // Unreachable host: the detached session then ends by itself, as before.
    });
  }
  paneStore.removePane(paneId);
}
