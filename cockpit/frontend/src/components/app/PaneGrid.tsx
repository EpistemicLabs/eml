// The pane grid: one flat grid geometry (no re-parenting across the 3→4
// boundary, so terminal state survives reflow), click-to-activate,
// hover-to-focus, per-pane project/session resolution via usePaneContext.
// Inactive panes are not dimmed — every pane stays fully bright; the active one shows the view
// toolbar, the others on hover of their top-right corner (MainContent).
// Compact (phone) layout: the active pane fills the box (the header's pane
// picker switches); the others stay mounted, hidden, so their terminals run on.
import React, { useCallback, useRef } from 'react';

import MainContent from '../main-content/view/MainContent';
import { usePaneContext } from '@/hooks/usePaneContext';
import * as paneStore from '@/stores/usePaneStore';
import type { PaneView } from '@/stores/usePaneStore';
import type { Project } from '@/types/app';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

// Grid geometry for a pane at index `i` of `n` total. ≤3 panes share one row;
// 4+ split into a top row of ceil(n/2) and a bottom row of floor(n/2).
// Returned as explicit grid placement so every pane stays a flat sibling of
// ONE grid container — crossing the 3→4 boundary only moves a pane's grid
// cell, it never reparents (and thus never unmounts/remounts) the pane, so
// terminal state survives the reflow.
function paneGridGeometry(i: number, n: number) {
  const twoRows = n > 3;
  const top = twoRows ? Math.ceil(n / 2) : n;
  const bottom = n - top;
  const cols = twoRows ? lcm(top, bottom) : n;
  const inTopRow = !twoRows || i < top;
  const rowCount = inTopRow ? top : bottom;
  const posInRow = inTopRow ? i : i - top;
  const span = cols / rowCount;
  return {
    cols,
    twoRows,
    gridRow: inTopRow ? 1 : 2,
    gridColumn: `${posInRow * span + 1} / span ${span}`,
    isLastInRow: posInRow === rowCount - 1,
    inTopRow,
  };
}

// Hover-to-focus: pull keyboard focus into a pane's primary input the
// moment the pointer enters it, so the user can type immediately — or
// just hit Enter when the CLI is waiting on a prompt. xterm's focusable
// element is its hidden helper textarea. Skip when focus is already inside
// this pane so we don't yank it (and scroll-jump) while the user is
// mid-interaction.
function focusPaneInput(paneEl: HTMLElement | null): void {
  if (!paneEl || paneEl.contains(document.activeElement)) return;
  const target =
    paneEl.querySelector<HTMLElement>('.xterm-helper-textarea') ??
    paneEl.querySelector<HTMLElement>('textarea, [contenteditable="true"]');
  target?.focus({ preventScroll: true });
}

type SlotDeps = {
  /** Phone layout: no hover-to-focus (a tap would raise the keyboard). */
  compact: boolean;
  projects: Project[];
  onSessionStarted: () => void;
  onStartNewChat: (project: Project) => void;
};

export function PaneGridLayout({
  paneIds,
  activePaneId,
  deskActive,
  compact,
  projects,
  onSessionStarted,
  onStartNewChat,
}: {
  paneIds: string[];
  activePaneId: string;
  // Whether this grid's desk is the visible one. Panes in a hidden desk
  // are never "active" — that keeps the active-only chrome (view switcher)
  // and auto-focus from running in backgrounded desks.
  deskActive: boolean;
} & SlotDeps) {
  const slotDeps: SlotDeps = { compact, projects, onSessionStarted, onStartNewChat };
  if (paneIds.length === 0) return null;

  if (compact && paneIds.length > 1) {
    return <CompactPaneStack paneIds={paneIds} activePaneId={activePaneId} deskActive={deskActive} slotDeps={slotDeps} />;
  }

  if (paneIds.length === 1) {
    // The last pane closes back to the empty state (removePane) — offered
    // only when there is something to close. Keyed like the grid's panes: a
    // pane replaced in place (first run) must mount fresh and read its own
    // first message.
    return <PaneSlot key={paneIds[0]} paneId={paneIds[0]} isActive={deskActive} canClose="unlessEmpty" slotDeps={slotDeps} />;
  }

  const n = paneIds.length;
  const canRemove = n > 1;
  const { cols, twoRows } = paneGridGeometry(0, n);

  return (
    <div
      className="grid h-full w-full"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: twoRows ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
      }}
    >
      {paneIds.map((paneId, i) => {
        const isActive = deskActive && paneId === activePaneId;
        const geo = paneGridGeometry(i, n);
        return (
          <div
            key={paneId}
            style={{ gridColumn: geo.gridColumn, gridRow: String(geo.gridRow) }}
            className={[
              'group relative flex min-h-0 min-w-0 flex-col overflow-hidden',
              !geo.isLastInRow && 'border-r border-foreground/15',
              geo.twoRows && geo.inTopRow && 'border-b border-foreground/15',
              !isActive && 'cursor-pointer',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={(event) => {
              if (isActive) return;
              const target = event.target as Element | null;
              if (target?.closest('[data-pane-close]')) return;
              paneStore.activatePane(paneId);
            }}
          >
            <PaneSlot paneId={paneId} isActive={isActive} canClose={canRemove} slotDeps={slotDeps} />
          </div>
        );
      })}
    </div>
  );
}

// Hidden, not display:none, as for desks: a hidden pane keeps its real size,
// so its terminal keeps the right geometry while another pane is shown.
function CompactPaneStack({
  paneIds,
  activePaneId,
  deskActive,
  slotDeps,
}: {
  paneIds: string[];
  activePaneId: string;
  deskActive: boolean;
  slotDeps: SlotDeps;
}) {
  const shownId = paneIds.includes(activePaneId) ? activePaneId : paneIds[0];
  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative min-h-0 flex-1">
        {paneIds.map((paneId) => {
          const shown = paneId === shownId;
          return (
            <div
              key={paneId}
              aria-hidden={!shown}
              inert={!shown}
              className="absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden"
              style={{ visibility: shown ? 'visible' : 'hidden' }}
            >
              <PaneSlot paneId={paneId} isActive={deskActive && shown} canClose slotDeps={slotDeps} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PaneSlot({
  paneId,
  isActive,
  canClose,
  slotDeps,
}: {
  paneId: string;
  isActive: boolean;
  canClose: boolean | 'unlessEmpty';
  slotDeps: SlotDeps;
}) {
  const ctx = usePaneContext(paneId, slotDeps.projects);

  const onSetPaneView = useCallback((view: PaneView) => {
    paneStore.setPaneView(paneId, view);
  }, [paneId]);

  // Hovering a pane focuses its input for immediate typing — but does NOT
  // change the active pane. Activation stays on click (the grid wrapper's
  // onClick). Focus alone is enough to type / press Enter, since keystrokes
  // go to whichever input is focused.
  const paneRootRef = useRef<HTMLDivElement>(null);
  const handlePaneHover = useCallback(() => {
    focusPaneInput(paneRootRef.current);
  }, []);

  const onClosePane = useCallback(() => {
    paneStore.removePane(paneId);
  }, [paneId]);

  if (!ctx.pane) return null;

  return (
    <div
      ref={paneRootRef}
      className="flex h-full min-h-0 w-full min-w-0 flex-col"
      onMouseEnter={slotDeps.compact ? undefined : handlePaneHover}
    >
      <MainContent
        isActive={isActive}
        paneId={paneId}
        selectedProject={ctx.project}
        selectedSession={ctx.session}
        sessionId={ctx.pane.sessionId}
        paneView={ctx.pane.paneView}
        onSetPaneView={onSetPaneView}
        onClosePane={
          (canClose === 'unlessEmpty' ? ctx.project !== null : canClose) && !ctx.pane.pinned
            ? onClosePane
            : undefined
        }
        paneLabel={ctx.pane.label ?? null}
      />
    </div>
  );
}

export default React.memo(PaneGridLayout);
