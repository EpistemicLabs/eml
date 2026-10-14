// Trimmed to what the cockpit's pane body needs: no project/session objects,
// no chat WS plumbing, no sub-panes, no TaskMaster/PRD types.
import type { PaneView } from '@/stores/usePaneStore';
import type { Project, ProjectSession } from '@/types/app';

export type MainContentProps = {
  // Multi-pane: when false, this MainContent is in a non-active pane — we
  // hide the view switcher to reduce visual noise (Apple Stage-Manager
  // style). The pane stays mounted so its terminal keeps streaming in the
  // background; clicking it (handled at the grid wrapper level) flips it
  // back to active.
  isActive?: boolean;
  /** Owning pane id — keys the PTY registry entry together with the session. */
  paneId: string;
  /** The host-registered project resolved for this pane (null → empty state). */
  selectedProject: Project | null;
  /** The pane's session record from the host (null until listed). */
  selectedSession: ProjectSession | null;
  /** The pane's pre-minted session id (null for brain panes). */
  sessionId: string | null;
  // Body slot — Terminal or Brain (mutually exclusive).
  paneView: PaneView;
  // Switch the pane's body. Wired to the segmented control in the in-pane
  // toolbar.
  onSetPaneView: (view: PaneView) => void;
  // Close the whole pane. Undefined when this is the last/only pane (we
  // never allow leaving the user with zero panes) or the pane is pinned.
  onClosePane?: () => void;
  /**
   * Auto-assigned pane label ("Terminal 2") shown in the title when the pane
   * has no user-chosen title — keeps parallel panes distinguishable.
   */
  paneLabel?: string | null;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
};
