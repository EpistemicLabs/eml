import * as paneStore from '@/stores/usePaneStore';
import { api } from '@/utils/api';

/**
 * Close a pane (×). A terminal pane's session detaches and ends after the
 * host's timeout, as before — also one kept running for Remote Control, which
 * the host no longer keeps once its pane is closed. It stays resumable from
 * the sidebar. Pinned panes stay, as removePane keeps them.
 */
export function closePane(paneId: string): void {
  const pane = paneStore.getPane(paneId);
  if (!pane || pane.pinned) return;
  if (pane.paneView === 'terminal' && pane.sessionId) {
    void api.releaseSession(pane.sessionId, paneId).catch(() => {
      // Unreachable host: a kept session then stays kept until it is closed again.
    });
  }
  paneStore.removePane(paneId);
}
