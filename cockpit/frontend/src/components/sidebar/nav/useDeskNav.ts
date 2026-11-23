// The spaces and their desks as the sidebar shows them, and everything you can do to them: open,
// rename, create, close, reorder by drag, move a pane onto a desk, ⌘/Ctrl 1–9. Each desk owns its
// own panes (usePaneStore), so opening a desk swaps the whole pane grid.
import React, { useEffect, useRef, useState } from 'react';

import { endPaneDrag, getDraggedPane } from '@/components/app/paneDrag';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { IS_MAC } from '@/components/top-bar/shortcuts';
import * as paneStore from '@/stores/usePaneStore';
import type { DeskState } from '@/stores/usePaneStore';
import { loadSpaces, paneSpaceKey, renameSpace, reorderSpaces, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { setTopView, useTopView } from '@/stores/useTopViewStore';
import { isUnseenDone, useTurnStore } from '@/stores/useTurnStateStore';

export type Section = { space: SpaceInfo | null; key: string | null; desks: DeskState[] };
/** What a desk's count says: nothing, how many sessions to look at, or that one stopped. */
export type DeskMark = { kind: 'none' } | { kind: 'look'; count: number } | { kind: 'stopped'; count: number };
type Place = 'before' | 'after';

const OPEN_KEY = 'cockpit-sidebar-open-spaces';
function readOpen(): Set<string> | null {
  try { const raw = localStorage.getItem(OPEN_KEY); return raw ? new Set(JSON.parse(raw) as string[]) : null; } catch { return null; }
}
function writeOpen(ids: Set<string>): void {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...ids])); } catch { /* the fold state is a convenience */ }
}

/** Before or after the row under the pointer, by its vertical middle. */
const placeOf = (event: React.DragEvent<HTMLElement>): Place => {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
};

/** `shortcuts`: register ⌘/Ctrl 1–9 and the held-modifier hint (only the one spaces list does). */
export function useDeskNav({ shortcuts = false }: { shortcuts?: boolean } = {}) {
  const desks = paneStore.useDesks();
  const activeDeskId = paneStore.useActiveDeskId();
  const activeSpaceId = paneStore.useActiveSpaceId();
  const spaces = useSpaces();
  const topView = useTopView();
  const turns = useTurnStore();
  const { sessions } = useAllSessions(true);
  const failed = new Set((sessions ?? []).filter((s) => s.attention?.kind === 'failed').map((s) => s.id));

  useEffect(() => { void loadSpaces(); }, []);

  const sections: Section[] = spaces.length === 0
    ? [{ space: null, key: null, desks }]
    : spaces.map((space) => { const key = paneSpaceKey(space); return { space, key, desks: desks.filter((d) => d.spaceId === key) }; });
  const ordered = sections.flatMap((s) => s.desks);

  // Folded spaces: the open space starts unfolded; what you fold or unfold is remembered.
  const [unfolded, setUnfolded] = useState<Set<string>>(() => readOpen() ?? new Set());
  const sectionId = (section: Section) => section.space?.id ?? 'all';
  const isUnfolded = (section: Section) => unfolded.has(sectionId(section)) || section.key === activeSpaceId || section.space === null;
  const toggleFold = (section: Section) => setUnfolded((current) => {
    const next = new Set(current);
    const id = sectionId(section);
    if (isUnfolded(section)) next.delete(id); else next.add(id);
    // The open space is always shown unfolded; folding it means remembering "closed" for when you leave it.
    if (section.key === activeSpaceId && next.has(id)) next.delete(id);
    writeOpen(next);
    return next;
  });

  // Holding the modifier shows each desk's ⌘N.
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!shortcuts) return;
    const modKey = IS_MAC ? 'Meta' : 'Control';
    const down = (e: KeyboardEvent) => { if (e.key === modKey) setHint(true); };
    const up = (e: KeyboardEvent) => { if (e.key === modKey) setHint(false); };
    const off = () => setHint(false);
    document.addEventListener('keydown', down, true);
    document.addEventListener('keyup', up, true);
    window.addEventListener('blur', off);
    return () => { document.removeEventListener('keydown', down, true); document.removeEventListener('keyup', up, true); window.removeEventListener('blur', off); };
  }, [shortcuts]);

  // Renaming: a desk id, or `space:<id>` for a space.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  useEffect(() => { if (editingId) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editingId]);
  const spaceEditId = (space: SpaceInfo) => `space:${space.id}`;
  const startEditing = (id: string, current: string) => { setDraft(current); setEditingId(id); };
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
      if (event.key === 'Enter') { event.preventDefault(); cancelRef.current = false; event.currentTarget.blur(); }
      else if (event.key === 'Escape') { event.preventDefault(); cancelRef.current = true; event.currentTarget.blur(); }
    },
    onBlur: () => {
      if (cancelRef.current) { cancelRef.current = false; setEditingId(null); return; }
      commitRename(id);
    },
  });

  // ⌘/Ctrl + 1–9: the Nth desk, top to bottom. Capture phase, so a focused terminal can't swallow it;
  // keyed off e.code so it doesn't depend on the keyboard layout; not while renaming.
  useEffect(() => {
    if (!shortcuts) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || editingId) return;
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      const target = match ? ordered[Number(match[1]) - 1] : undefined;
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      setTopView('desks');
      paneStore.activateDesk(target.id);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [ordered, editingId, shortcuts]);

  const openDesk = (desk: DeskState) => { setTopView('desks'); paneStore.activateDesk(desk.id); };
  const isOpenDesk = (desk: DeskState) => topView === 'desks' && desk.id === activeDeskId;
  const createDesk = (section: Section) => {
    setTopView('desks');
    if (section.space) setUnfolded((current) => { const next = new Set(current).add(section.space!.id); writeOpen(next); return next; });
    const id = paneStore.createDesk({ name: `Desk ${section.desks.length + 1}`, spaceId: section.key });
    startEditing(id, '');
  };
  const closeDesk = (desk: DeskState, siblings: number) => {
    if (siblings <= 1) return;
    if (desk.panes.some((p) => p.sessionId) && !window.confirm(`Close the "${desk.name}" desk and its terminals?`)) return;
    setEditingId(null);
    paneStore.removeDesk(desk.id);
  };

  /** The desk's count: its sessions you haven't looked at that finished or ask you something; red "!" when one stopped. */
  const markOf = (desk: DeskState): DeskMark => {
    const ids = desk.panes.map((p) => p.sessionId).filter((id): id is string => Boolean(id) && (turns.turns[id!]?.state === 'waiting' || isUnseenDone(turns, id!)));
    if (ids.length === 0) return { kind: 'none' };
    const stopped = ids.filter((id) => failed.has(id)).length;
    return stopped > 0 ? { kind: 'stopped', count: stopped } : { kind: 'look', count: ids.length };
  };
  /** A folded space's count: the sum of its desks', red when any of them stopped. */
  const markOfSection = (section: Section): DeskMark => {
    const marks = section.desks.map(markOf);
    const stopped = marks.reduce((n, m) => n + (m.kind === 'stopped' ? m.count : 0), 0);
    if (stopped > 0) return { kind: 'stopped', count: stopped };
    const look = marks.reduce((n, m) => n + (m.kind === 'look' ? m.count : 0), 0);
    return look > 0 ? { kind: 'look', count: look } : { kind: 'none' };
  };

  // Drag: desks within their space, spaces among themselves, a pane (by its title) onto a desk of its space.
  const [dragging, setDragging] = useState<{ id: string; spaceKey: string | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: Place } | null>(null);
  const [paneDropId, setPaneDropId] = useState<string | null>(null);
  const [draggingSpace, setDraggingSpace] = useState<string | null>(null);
  const [spaceDrop, setSpaceDrop] = useState<{ id: string; place: Place } | null>(null);
  const endDrag = () => { setDragging(null); setDropTarget(null); setPaneDropId(null); setDraggingSpace(null); setSpaceDrop(null); };

  const spaceDragProps = (space: SpaceInfo) => ({
    draggable: editingId !== spaceEditId(space),
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', space.name); // Firefox only starts a drag that carries data.
      endPaneDrag();
      setDraggingSpace(space.id);
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!draggingSpace || draggingSpace === space.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const place = placeOf(event);
      if (spaceDrop?.id !== space.id || spaceDrop.place !== place) setSpaceDrop({ id: space.id, place });
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (spaceDrop?.id === space.id) setSpaceDrop(null);
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!draggingSpace) return;
      event.preventDefault();
      if (spaceDrop?.id === space.id) {
        const ids = spaces.map((s) => s.id).filter((id) => id !== draggingSpace);
        ids.splice(ids.indexOf(space.id) + (spaceDrop.place === 'after' ? 1 : 0), 0, draggingSpace);
        void reorderSpaces(ids);
      }
      endDrag();
    },
    onDragEnd: endDrag,
  });

  const deskDragProps = (desk: DeskState, spaceKey: string | null) => ({
    draggable: editingId !== desk.id,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', desk.name);
      endPaneDrag();
      setDragging({ id: desk.id, spaceKey });
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
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
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      const place = placeOf(event);
      if (dropTarget?.id !== desk.id || dropTarget.place !== place) setDropTarget({ id: desk.id, place });
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (dropTarget?.id === desk.id) setDropTarget(null);
      if (paneDropId === desk.id) setPaneDropId(null);
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const paneId = getDraggedPane();
      if (paneId) { endPaneDrag(); setTopView('desks'); paneStore.movePaneToDesk(paneId, desk.id); }
      if (dragging && dropTarget?.id === desk.id) paneStore.moveDesk(dragging.id, desk.id, dropTarget.place);
      endDrag();
    },
    onDragEnd: endDrag,
  });

  return {
    sections, ordered, activeSpaceId, topView, hint,
    isUnfolded, toggleFold,
    editingId, spaceEditId, startEditing, renameInputProps,
    openDesk, isOpenDesk, createDesk, closeDesk, markOf, markOfSection,
    dragging, dropTarget, paneDropId, draggingSpace, spaceDrop, spaceDragProps, deskDragProps,
  };
}
