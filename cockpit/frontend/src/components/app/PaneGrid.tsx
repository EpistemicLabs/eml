// The pane grid: one flat grid geometry (no re-parenting across the 3→4
// boundary, so terminal state survives reflow), click-to-activate,
// hover-to-focus, per-pane project/session resolution via usePaneContext.
// Inactive panes are not dimmed — every pane stays fully bright; the active one shows the view
// toolbar, the others on hover of their top-right corner (MainContent).
// Compact (phone) layout: the active pane fills the box (the header's pane
// picker switches); the others stay mounted, hidden, so their terminals run on.
// A desk may have a main pane: a full-height column at the left, resized by its
// divider (paneLayout.ts). Dragging a pane title onto another pane swaps the two.
import React, { useCallback, useRef, useState } from 'react';

import MainContent from '../main-content/view/MainContent';
import { usePaneContext } from '@/hooks/usePaneContext';
import { closePane } from '@/lib/pane-close';
import * as paneStore from '@/stores/usePaneStore';
import type { PaneView } from '@/stores/usePaneStore';
import type { Project } from '@/types/app';
import { endPaneDrag, getDraggedPane } from './paneDrag';
import { deskLayout, mainColumnWidth, mainWidthAtPointer } from './paneLayout';

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
  deskId,
  mainPaneId,
  mainWidth,
  deskActive,
  compact,
  projects,
  onSessionStarted,
  onStartNewChat,
}: {
  paneIds: string[];
  activePaneId: string;
  deskId: string;
  mainPaneId?: string;
  mainWidth?: number;
  // Whether this grid's desk is the visible one. Panes in a hidden desk
  // are never "active" — that keeps the active-only chrome (view switcher)
  // and auto-focus from running in backgrounded desks.
  deskActive: boolean;
} & SlotDeps) {
  const slotDeps: SlotDeps = { compact, projects, onSessionStarted, onStartNewChat };
  const gridRef = useRef<HTMLDivElement>(null);
  // The pane a dragged pane title would swap with.
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null);
  if (paneIds.length === 0) return null;

  if (compact && paneIds.length > 1) {
    return <CompactPaneStack paneIds={paneIds} activePaneId={activePaneId} deskActive={deskActive} slotDeps={slotDeps} />;
  }

  if (compact) {
    // The last pane closes back to the empty state (removePane) — offered
    // only when there is something to close. Keyed like the grid's panes: a
    // pane replaced in place (first run) must mount fresh and read its own
    // first message.
    return <PaneSlot key={paneIds[0]} paneId={paneIds[0]} isActive={deskActive} canClose="unlessEmpty" slotDeps={slotDeps} />;
  }

  const n = paneIds.length;
  const layout = deskLayout(n, mainPaneId === paneIds[0], mainWidth);
  // Rendered in a fixed order, placed by the grid: a swap must not move a pane
  // in the DOM, which would reset the scroll position of what is inside it.
  const rendered = [...paneIds].sort();

  return (
    <div
      ref={gridRef}
      className="relative grid h-full w-full"
      style={{
        gridTemplateColumns: layout.gridTemplateColumns,
        gridTemplateRows: layout.gridTemplateRows,
        ...(layout.hasMain ? { '--main-width': mainColumnWidth(mainWidth, n - 1) } : {}),
      } as React.CSSProperties}
    >
      {rendered.map((paneId) => {
        const isActive = deskActive && paneId === activePaneId;
        const placement = layout.placements[paneIds.indexOf(paneId)];
        return (
          <div
            key={paneId}
            style={{ gridColumn: placement.gridColumn, gridRow: placement.gridRow }}
            className={[
              'group relative flex min-h-0 min-w-0 flex-col overflow-hidden',
              placement.borderRight && 'border-r border-foreground/15',
              placement.borderBottom && 'border-b border-foreground/15',
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
            // In the capture phase: a pane title dropped on a terminal or an
            // input must swap the panes, not land there as text.
            onDragOverCapture={(event) => {
              const dragged = getDraggedPane();
              if (!dragged || !paneStore.canSwapPanes(dragged, paneId)) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              if (swapTargetId !== paneId) setSwapTargetId(paneId);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              if (swapTargetId === paneId) setSwapTargetId(null);
            }}
            onDropCapture={(event) => {
              const dragged = getDraggedPane();
              if (!dragged || !paneStore.canSwapPanes(dragged, paneId)) return;
              event.preventDefault();
              event.stopPropagation();
              endPaneDrag();
              setSwapTargetId(null);
              paneStore.swapPanes(dragged, paneId);
            }}
          >
            <PaneSlot
              paneId={paneId}
              isActive={isActive}
              canClose={n > 1 ? true : 'unlessEmpty'}
              isMain={paneId === mainPaneId}
              slotDeps={slotDeps}
            />
            {swapTargetId === paneId && (
              <div aria-hidden className="pointer-events-none absolute inset-0 z-40 bg-primary/15 ring-2 ring-inset ring-primary" />
            )}
          </div>
        );
      })}
      {layout.hasMain && <MainDivider gridRef={gridRef} deskId={deskId} stackCount={n - 1} />}
    </div>
  );
}

// Drags the main column's edge. The width goes straight onto the grid while the
// pointer moves, so the panes aren't rendered again for each step, and into the
// store when it lets go. Terminals refit from their own ResizeObserver, once the
// pointer pauses, so the session isn't sent a resize per step.
function MainDivider({
  gridRef,
  deskId,
  stackCount,
}: {
  gridRef: React.RefObject<HTMLDivElement | null>;
  deskId: string;
  stackCount: number;
}) {
  const shareAt = (event: React.PointerEvent) => {
    const box = gridRef.current!.getBoundingClientRect();
    return mainWidthAtPointer(event.clientX, box.left, box.width, stackCount);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the main pane"
      title="Drag to resize the main pane"
      className="absolute inset-y-0 z-30 w-2 -translate-x-1/2 cursor-col-resize touch-none transition-colors hover:bg-primary/30 active:bg-primary/40"
      style={{ left: 'var(--main-width)' }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        gridRef.current!.style.setProperty('--main-width', mainColumnWidth(shareAt(event), stackCount));
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        paneStore.setMainWidth(deskId, shareAt(event));
      }}
    />
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
              // Inherit, not visible: an explicit visible would show through a hidden desk.
              style={{ visibility: shown ? 'inherit' : 'hidden' }}
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
  isMain = false,
  slotDeps,
}: {
  paneId: string;
  isActive: boolean;
  canClose: boolean | 'unlessEmpty';
  isMain?: boolean;
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
    closePane(paneId);
  }, [paneId]);

  const onToggleMainPane = useCallback(() => {
    paneStore.toggleMainPane(paneId);
  }, [paneId]);

  if (!ctx.pane) return null;

  return (
    <div
      ref={paneRootRef}
      className="flex h-full min-h-0 w-full min-w-0 flex-col"
      onMouseEnter={slotDeps.compact ? undefined : handlePaneHover}
    >
      <div className="min-h-0 flex-1">
      <MainContent
        isActive={isActive}
        paneId={paneId}
        selectedProject={ctx.project}
        selectedSession={ctx.session}
        sessionId={ctx.pane.sessionId}
        paneView={ctx.pane.paneView}
        onSetPaneView={onSetPaneView}
        onClosePane={
          (canClose === 'unlessEmpty' ? ctx.project !== null : canClose) && !ctx.pane.pinned && !isMain
            ? onClosePane
            : undefined
        }
        isMainPane={isMain}
        onToggleMainPane={onToggleMainPane}
        paneLabel={ctx.pane.label ?? null}
      />
      </div>
    </div>
  );
}

export default React.memo(PaneGridLayout);
