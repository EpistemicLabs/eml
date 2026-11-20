// The add-pane actions that used to sit at the right end moved into the
// pane header's "+" (2026-09-22). Top bar v2 (mockup top bar v2, tokens v2): monochrome,
// the space name opens its brain, one badge per desk with one meaning.
import React, { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';

import { endPaneDrag, getDraggedPane } from '@/components/app/paneDrag';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { FOCUS } from '@/components/task-board/parts';
import { cn } from '@/lib/utils';
import { reset as resetBrainSurface } from '@/lib/brain-nav';
import { usePendingReviews } from '@/lib/queries';
import * as paneStore from '@/stores/usePaneStore';
import type { DeskState } from '@/stores/usePaneStore';
import { loadSpaces, paneSpaceKey, renameSpace, reorderSpaces, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { setTopView, useTopView } from '@/stores/useTopViewStore';
import { isUnseenDone, useTurnStore } from '@/stores/useTurnStateStore';

import { IS_MAC, MOD } from './shortcuts';
import { Count, TAB, TRACK } from './TaskViewSwitch';

/**
 * Top-level desk tabs (called spaces until 0.17.4; "space" now means a brain
 * space, decision cockpit-naming-desks-spaces). The bar shows every space as
 * a section — its name (opens that brain's dashboard), then its desks, then
 * "+" — so any desk of any space is one click away; activating a desk or the
 * name of another space switches the space with it. A desk's badge counts
 * its sessions you have not seen yet that finished or ask you something
 * (grey, gone once seen); a red "!" when one of them stopped with an error
 * (decision desk-dot-until-seen). Each desk owns its own panes (see usePaneStore), so switching
 * tabs swaps the entire pane grid — letting e.g. an isolated "Research" desk
 * live next to "Dev" without their terminals mixing.
 *
 * Interactions:
 *  • click a tab        → activate that desk (and its space)
 *  • double-click a tab → inline-rename it (the space name renames the space)
 *  • × (hover/active)   → delete it (guarded: never a space's last desk; warns
 *                         if the desk still holds a live session)
 *  • + (per section)    → create a new desk in that space, straight into rename
 *  • drag a tab         → reorder it among the desks of its space
 *  • drag a space name  → reorder the spaces (kept by the host, cockpit config)
 *  • drop a pane title  → move that pane to the desk (same space only; pinned and main panes stay)
 *  • ⌘/Ctrl 1–9         → the Nth desk in bar order; holding ⌘/Ctrl shows the numbers
 */
export default function DeskTabBar() {
  const desks = paneStore.useDesks();
  const activeDeskId = paneStore.useActiveDeskId();
  const spaces = useSpaces();
  // Cockpit: the fixed Brain tab in the header takes the active highlight
  // away from the desks while it is shown.
  const topView = useTopView();
  // Per desk: the sessions that need a look, and whether one of them failed.
  const turnSnapshot = useTurnStore();
  const { sessions } = useAllSessions(true);
  const failed = new Set((sessions ?? []).filter((s) => s.attention?.kind === 'failed').map((s) => s.id));
  // Holding the modifier shows each desk's ⌘N.
  const [hint, setHint] = useState(false);
  useEffect(() => {
    const modKey = IS_MAC ? 'Meta' : 'Control';
    const down = (e: KeyboardEvent) => { if (e.key === modKey) setHint(true); };
    const up = (e: KeyboardEvent) => { if (e.key === modKey) setHint(false); };
    const off = () => setHint(false);
    document.addEventListener('keydown', down, true);
    document.addEventListener('keyup', up, true);
    window.addEventListener('blur', off);
    return () => { document.removeEventListener('keydown', down, true); document.removeEventListener('keyup', up, true); window.removeEventListener('blur', off); };
  }, []);
  const activeSpaceId = paneStore.useActiveSpaceId();
  // The active space comes into view when the bar scrolls (many spaces).
  const activeSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => { activeSectionRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [activeSpaceId]);
  // Engrams flagged for review in the ACTIVE space's brain (the request names
  // the active space) — shown next to that section's name only.
  const pendingReviews = usePendingReviews().data?.length ?? 0;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Distinguishes Escape (cancel) from Enter/blur (commit) on the rename input.
  const cancelRef = useRef(false);
  // Drag to reorder: the desk being dragged (with its space, the only place it
  // may land) and where it would land — before or after the desk under the pointer.
  const [dragging, setDragging] = useState<{ id: string; spaceKey: string | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: 'before' | 'after' } | null>(null);
  // A pane dragged by its title (paneDrag) over a desk that would take it.
  const [paneDropId, setPaneDropId] = useState<string | null>(null);
  // Drag a space by its Brain tab: the space being dragged and where it would
  // land — before or after the section under the pointer.
  const [draggingSpace, setDraggingSpace] = useState<string | null>(null);
  const [spaceDrop, setSpaceDrop] = useState<{ id: string; place: 'before' | 'after' } | null>(null);

  // The header needs the space list on its own: the sidebar's space switch,
  // the other loader, is only mounted in the projects view.
  useEffect(() => { void loadSpaces(); }, []);

  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  // The sections: main first (the list's order), each with its desks. Before
  // the space list has loaded, every desk sits under one unnamed section.
  const sections: Array<{ space: SpaceInfo | null; key: string | null; desks: DeskState[] }> =
    spaces.length === 0
      ? [{ space: null, key: null, desks }]
      : spaces.map((space) => {
          const key = paneSpaceKey(space);
          return { space, key, desks: desks.filter((desk) => desk.spaceId === key) };
        });
  // Bar order, for the ⌘N shortcuts.
  const ordered = sections.flatMap((section) => section.desks);

  // ⌘/Ctrl + 1–9 jump to the Nth desk. Registered in the CAPTURE phase so
  // it fires before a focused terminal (xterm) or input swallows the keystroke —
  // otherwise the shortcut only worked when no pane had focus. We key off
  // `e.code` (Digit1–Digit9 / Numpad1–Numpad9) rather than `e.key`, so it's
  // independent of keyboard layout. Skipped while renaming a tab so digits land
  // in the input.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (editingId) return;
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      if (!match) return;
      const target = ordered[Number(match[1]) - 1];
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      setTopView('desks');
      paneStore.activateDesk(target.id);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [ordered, editingId]);

  const startEditing = (id: string, currentName: string) => {
    setDraft(currentName);
    setEditingId(id);
  };

  // Editing ids: a desk id, or `space:<id>` for a section's Brain tab.
  const spaceEditId = (space: SpaceInfo) => `space:${space.id}`;

  const commitRename = (id: string) => {
    setEditingId(null);
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (id.startsWith('space:')) {
      const space = spaces.find((s) => spaceEditId(s) === id);
      if (space && space.name !== trimmed) void renameSpace(space, trimmed);
      return;
    }
    paneStore.renameDesk(id, trimmed);
  };

  const renameInputProps = (id: string) => ({
    ref: inputRef,
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        cancelRef.current = false;
        event.currentTarget.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRef.current = true;
        event.currentTarget.blur();
      }
    },
    onBlur: () => {
      if (cancelRef.current) {
        cancelRef.current = false;
        setEditingId(null);
        return;
      }
      commitRename(id);
    },
    className: 'w-24 min-w-0 rounded border border-border bg-transparent px-1 py-0 text-body font-medium text-foreground outline-none focus:border-foreground/40',
  });

  const handleCreate = (spaceKey: string | null, count: number) => {
    setTopView('desks');
    const id = paneStore.createDesk({ name: `Desk ${count + 1}`, spaceId: spaceKey });
    startEditing(id, '');
  };

  const handleDelete = (desk: DeskState, siblings: number) => {
    if (siblings <= 1) return;
    const hasSession = desk.panes.some(p => p.sessionId);
    if (hasSession && !window.confirm(`Close the "${desk.name}" desk and its terminals?`)) {
      return;
    }
    setEditingId(null);
    paneStore.removeDesk(desk.id);
  };

  const endDrag = () => {
    setDragging(null);
    setDropTarget(null);
    setPaneDropId(null);
    setDraggingSpace(null);
    setSpaceDrop(null);
  };

  /** Drag handlers for a section: its Brain tab starts the drag, the whole section takes the drop. */
  const spaceDragProps = (space: SpaceInfo) => ({
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (!draggingSpace || draggingSpace === space.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = event.currentTarget.getBoundingClientRect();
      const place = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      if (spaceDrop?.id !== space.id || spaceDrop.place !== place) setSpaceDrop({ id: space.id, place });
    },
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (spaceDrop?.id === space.id) setSpaceDrop(null);
    },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      if (!draggingSpace) return;
      event.preventDefault();
      if (spaceDrop?.id === space.id) {
        const ids = spaces.map((s) => s.id).filter((id) => id !== draggingSpace);
        ids.splice(ids.indexOf(space.id) + (spaceDrop.place === 'after' ? 1 : 0), 0, draggingSpace);
        void reorderSpaces(ids);
      }
      endDrag();
    },
  });

  /** Drag handlers for one desk tab; a drop is only accepted within the dragged desk's space. */
  const dragProps = (desk: DeskState, spaceKey: string | null) => ({
    draggable: editingId !== desk.id,
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox only starts a drag that carries data.
      event.dataTransfer.setData('text/plain', desk.name);
      endPaneDrag();
      setDragging({ id: desk.id, spaceKey });
    },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      const paneId = getDraggedPane();
      if (paneId) {
        if (!paneStore.canMovePaneToDesk(paneId, desk.id)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (paneDropId !== desk.id) setPaneDropId(desk.id);
        return;
      }
      if (!dragging || dragging.spaceKey !== spaceKey || dragging.id === desk.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = event.currentTarget.getBoundingClientRect();
      const place = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      if (dropTarget?.id !== desk.id || dropTarget.place !== place) setDropTarget({ id: desk.id, place });
    },
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (dropTarget?.id === desk.id) setDropTarget(null);
      if (paneDropId === desk.id) setPaneDropId(null);
    },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const paneId = getDraggedPane();
      if (paneId) {
        // The move unmounts the dragged title, so its dragend may never fire.
        endPaneDrag();
        setTopView('desks');
        paneStore.movePaneToDesk(paneId, desk.id);
      }
      if (dragging && dropTarget?.id === desk.id) paneStore.moveDesk(dragging.id, desk.id, dropTarget.place);
      endDrag();
    },
    onDragEnd: endDrag,
  });

  let position = 0;

  return (
    <div className="flex h-full flex-shrink-0 items-center">
      {sections.map((section, sectionIndex) => {
        const isActiveSpace = section.key === activeSpaceId;
        const brainActive = topView === 'brain' && isActiveSpace;
        const count = isActiveSpace ? pendingReviews : 0;
        const spaceLabel = section.space?.name ?? 'Brain';
        const spaceDropPlace = section.space && spaceDrop?.id === section.space.id ? spaceDrop.place : null;
        return (
          // One group per brain: its name, its desks, "+". A hairline sets the groups apart;
          // the space you are in has a light background.
          <div key={section.space?.id ?? 'all'} className="flex h-full items-center">
          {/* The gap between spaces, its hairline in the middle. */}
          {sectionIndex > 0 && <span aria-hidden className="flex w-(--gap-spaces) flex-shrink-0 justify-center self-stretch py-2"><span className="w-px bg-(--glass-line)" /></span>}
          <div
            ref={isActiveSpace ? activeSectionRef : undefined}
            data-active={isActiveSpace || undefined}
            role="tablist"
            aria-label={spaceLabel}
            {...(section.space ? spaceDragProps(section.space) : {})}
            className={cn(
              cn(TRACK, 'relative'),
              isActiveSpace && topView !== 'tasks' && topView !== 'jobs' && 'bg-foreground/8',
              section.space && draggingSpace === section.space.id && 'opacity-60',
            )}
          >
            {/* Where the dragged space would land: a line in the gap before or after this group. */}
            {spaceDropPlace && (
              <span aria-hidden className={cn('pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary', spaceDropPlace === 'before' ? '-left-1' : '-right-1')} />
            )}
            {section.space && editingId === spaceEditId(section.space) ? (
              <input {...renameInputProps(spaceEditId(section.space))} placeholder="Space name" aria-label="Space name" maxLength={40} />
            ) : (
            <button
              type="button"
              onClick={() => {
                if (brainActive) { resetBrainSurface('tab'); return; }
                paneStore.activateSpace(section.key);
                setTopView('brain');
              }}
              onDoubleClick={() => { if (section.space) startEditing(spaceEditId(section.space), section.space.name); }}
              draggable={Boolean(section.space)}
              onDragStart={(event) => {
                if (!section.space) return;
                event.dataTransfer.effectAllowed = 'move';
                // Firefox only starts a drag that carries data.
                event.dataTransfer.setData('text/plain', section.space.name);
                endPaneDrag();
                setDraggingSpace(section.space.id);
              }}
              onDragEnd={endDrag}
              aria-pressed={brainActive}
              title={`${spaceLabel}: open its brain${count > 0 ? ` · ${count} pending review${count === 1 ? '' : 's'}` : ''}${section.space ? ' · double-click to rename, drag to reorder the spaces' : ''}`}
              className={cn(
                'mr-1.5 flex h-(--size-tab) items-center gap-1.5 whitespace-nowrap rounded-(--radius-tab) px-1.5 text-body font-semibold text-foreground hover:bg-foreground/8 aria-pressed:bg-card aria-pressed:shadow-(--shadow-pill)',
                FOCUS,
              )}
            >
              <span className="max-w-40 truncate">{spaceLabel}</span>
              {count > 0 && <Count label={`${count} pending review${count === 1 ? '' : 's'}`}>{count}</Count>}
            </button>
            )}
            {section.desks.map((desk) => {
              const idx = position++;
              const isActive = topView === 'desks' && desk.id === activeDeskId;
              const isEditing = editingId === desk.id;
              const key = idx < 9 ? `${MOD}${idx + 1}` : null;
              const dropPlace = dropTarget?.id === desk.id ? dropTarget.place : null;
              return (
                <div
                  key={desk.id}
                  {...dragProps(desk, section.key)}
                  className={cn('relative flex items-center', dragging?.id === desk.id && 'opacity-60')}
                >
                  {/* Where the dragged desk would land: a line on this tab's left or right edge. */}
                  {dropPlace && (
                    <span aria-hidden className={cn('pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary', dropPlace === 'before' ? '-left-px' : '-right-px')} />
                  )}
                  {isEditing ? (
                    <span className="flex h-(--size-tab) items-center gap-1 px-1">
                      <input {...renameInputProps(desk.id)} placeholder="Desk name" aria-label="Desk name" />
                      {section.desks.length > 1 && (
                        <button
                          type="button"
                          // Keeps the focus in the name field: its blur would end editing and take this button away.
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleDelete(desk, section.desks.length)}
                          aria-label={`Close ${desk.name} desk`}
                          title={`Close ${desk.name} desk`}
                          className="flex size-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/12 hover:text-destructive"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </span>
                  ) : (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => {
                        setTopView('desks');
                        paneStore.activateDesk(desk.id);
                      }}
                      onDoubleClick={() => startEditing(desk.id, desk.name)}
                      title={`${desk.name}${key ? ` (${key})` : ''} · double-click to rename or close, drag to reorder, drop a pane title here to move the pane`}
                      className={cn(TAB, paneDropId === desk.id && 'bg-foreground/12 text-foreground')}
                    >
                      <span className="max-w-32 truncate">{desk.name}</span>
                      <DeskBadge sessionIds={desk.panes.map((pane) => pane.sessionId)} turns={turnSnapshot} failed={failed} />
                      {key && hint && <span aria-hidden className="text-caption text-muted-foreground">{key}</span>}
                    </button>
                  )}
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => handleCreate(section.key, section.desks.length)}
              aria-label={section.space ? `New desk in ${section.space.name}` : 'New desk'}
              title={section.space ? `New desk in ${section.space.name}` : 'New desk'}
              className={cn('ml-0.5 flex h-(--size-tab) w-(--size-add) flex-shrink-0 items-center justify-center rounded-(--radius-tab) text-muted-foreground hover:bg-foreground/8 hover:text-foreground', FOCUS)}
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A desk's badge: how many of its sessions finished or ask you something and are not seen yet
 * (grey; gone once you look), or a red "!" when one of them stopped with an error.
 */
function DeskBadge({ sessionIds, turns, failed }: { sessionIds: Array<string | null | undefined>; turns: ReturnType<typeof useTurnStore>; failed: Set<string> }) {
  const ids = sessionIds.filter((id): id is string => Boolean(id) && (turns.turns[id!]?.state === 'waiting' || isUnseenDone(turns, id!)));
  if (ids.length === 0) return null;
  const stopped = ids.filter((id) => failed.has(id)).length;
  if (stopped > 0) return <Count stopped label={`${stopped} session${stopped === 1 ? '' : 's'} stopped with an error`}>!</Count>;
  return <Count label={`${ids.length} session${ids.length === 1 ? '' : 's'} to look at: finished or asking you`}>{ids.length}</Count>;
}
