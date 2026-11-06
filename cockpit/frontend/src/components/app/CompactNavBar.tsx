import { Menu, X } from 'lucide-react';

import * as paneStore from '@/stores/usePaneStore';
import { closePane } from '@/lib/pane-close';
import { cn } from '@/lib/utils';

/**
 * The compact (phone) layout's navigation: the menu and closing the shown pane,
 * floating above it. Everything else is in the side panel. Glass over a chat,
 * solid over a terminal, since nothing may blur above terminal text.
 */

const CAPSULE_BUTTON_CLASS =
  "relative flex h-10 w-10 items-center justify-center rounded-full text-foreground after:absolute after:-inset-0.5 after:content-[''] active:bg-foreground/15 disabled:opacity-30";

export default function CompactNavBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const activeDesk = paneStore.useActiveDesk();
  const activePaneId = paneStore.useActivePaneId();
  const panes = activeDesk.panes;
  const shownPane = panes.find((pane) => pane.id === activePaneId) ?? panes[0];
  const overChat = shownPane?.paneView === 'chat';
  const capsule = cn('rounded-full', overChat ? 'glass-bar' : 'glass-solid');

  // As in the desktop pane toolbar: the last pane closes only when it holds
  // something, and a pinned or main pane never.
  const canClose = !!shownPane && !paneStore.isPaneProtected(shownPane.id) && (panes.length > 1 || shownPane.projectId !== null);

  return (
    <>
      {overChat && <div aria-hidden="true" className="glass-edge-top pointer-events-none absolute inset-x-0 top-0 z-20 h-[calc(env(safe-area-inset-top)+56px)]" />}
      <div className="pointer-events-none absolute inset-x-2 top-[calc(env(safe-area-inset-top)+6px)] z-30 flex items-center justify-between">
        <div className={cn('pointer-events-auto', capsule)}>
          <button type="button" className={CAPSULE_BUTTON_CLASS} aria-label="Projects and sessions" onClick={onOpenMenu}>
            <Menu className="h-5 w-5" />
          </button>
        </div>
        <div className={cn('pointer-events-auto', capsule)}>
          <button
            type="button"
            className={CAPSULE_BUTTON_CLASS}
            aria-label="Close pane"
            disabled={!canClose}
            onClick={() => shownPane && closePane(shownPane.id)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
    </>
  );
}
