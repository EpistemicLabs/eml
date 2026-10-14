// The add-pane actions that used to sit at the right end moved into the
// pane header's "+" (2026-09-22).
import React, { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { reset as resetBrainSurface } from '@/lib/brain-nav';
import { usePendingReviews } from '@/lib/queries';
import * as paneStore from '@/stores/usePaneStore';
import type { DeskState } from '@/stores/usePaneStore';
import { loadSpaces, paneSpaceKey, renameSpace, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { setTopView, useTopView } from '@/stores/useTopViewStore';
import { countNeedsYou, useTurnStore } from '@/stores/useTurnStateStore';

/**
 * Top-level desk tabs (called spaces until 0.17.4; "space" now means a brain
 * space, decision cockpit-naming-desks-spaces). The bar shows every space as
 * a section — its Brain tab (the brain's name, opens that brain's dashboard),
 * then its desks, then "+" — so any desk of any space is one click away;
 * activating a desk or the Brain tab of another space switches the space
 * with it. Each desk owns its own panes (see usePaneStore), so switching
 * tabs swaps the entire pane grid — letting e.g. an isolated "Research" desk
 * live next to "Dev" without their terminals mixing.
 *
 * Interactions:
 *  • click a tab        → activate that desk (and its space)
 *  • double-click a tab → inline-rename it (the Brain tab renames the space)
 *  • × (hover/active)   → delete it (guarded: never a space's last desk; warns
 *                         if the desk still holds a live session)
 *  • + (per section)    → create a new desk in that space, straight into rename
 *  • ⌘/Ctrl 1–9         → the Nth desk in bar order
 */
export default function DeskTabBar() {
  const desks = paneStore.useDesks();
  const activeDeskId = paneStore.useActiveDeskId();
  const spaces = useSpaces();
  // Cockpit: the fixed Brain tab in the header takes the active highlight
  // away from the desks while it is shown.
  const topView = useTopView();
  // Finished-while-away sessions per desk: one badge
  // per tab — a dot for one, a count for more; gone once the desk is viewed.
  const turnSnapshot = useTurnStore();
  const activeSpaceId = paneStore.useActiveSpaceId();
  // Engrams flagged for review in the ACTIVE space's brain (the request names
  // the active space) — shown on that section's Brain tab only.
  const pendingReviews = usePendingReviews().data?.length ?? 0;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Distinguishes Escape (cancel) from Enter/blur (commit) on the rename input.
  const cancelRef = useRef(false);

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
    className: 'w-[12ch] min-w-0 rounded border border-border bg-transparent px-1 py-0 text-body font-medium text-foreground outline-none focus:border-foreground/40',
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
    paneStore.removeDesk(desk.id);
  };

  let position = 0;

  return (
    <div className="flex h-full flex-shrink-0 items-stretch gap-2 px-1">
      {sections.map((section) => {
        const isActiveSpace = section.key === activeSpaceId;
        const brainActive = topView === 'brain' && isActiveSpace;
        const count = isActiveSpace ? pendingReviews : 0;
        const brainLabel = section.space?.name ?? 'Brain';
        return (
          // One section per brain: a faint band holds its Brain tab and desks,
          // so the bands — not separator lines — tell the brains apart.
          <div
            key={section.space?.id ?? 'all'}
            className={cn(
              'my-1.5 flex items-stretch overflow-hidden rounded-md border',
              isActiveSpace ? 'border-foreground/15 bg-foreground/[0.05]' : 'border-foreground/[0.08] bg-foreground/[0.02]',
            )}
          >
            {/* The section's Brain tab: this brain's dashboard. Same underline
                idiom as the desks; the coral brain mark stays the brand's. */}
            {section.space && editingId === spaceEditId(section.space) ? (
              <div className="flex items-center gap-1.5 px-2">
                <Brain className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
                <input {...renameInputProps(spaceEditId(section.space))} placeholder="Space name" aria-label="Space name" maxLength={40} />
              </div>
            ) : (
            <button
              type="button"
              onClick={() => {
                if (brainActive) { resetBrainSurface('tab'); return; }
                paneStore.activateSpace(section.key);
                setTopView('brain');
              }}
              onDoubleClick={() => { if (section.space) startEditing(spaceEditId(section.space), section.space.name); }}
              aria-pressed={brainActive}
              title={`${count > 0 ? `${brainLabel} · ${count} pending review${count === 1 ? '' : 's'}` : `Brain: ${brainLabel}`}${section.space ? ' · double-click to rename' : ''}`}
              className={cn(
                'relative flex h-full items-center gap-1.5 rounded-l-md px-2 text-body font-medium transition-colors',
                brainActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                brainActive && 'after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:bg-primary',
              )}
            >
              <Brain className="h-4 w-4" strokeWidth={brainActive ? 2.2 : 1.8} />
              <span className="max-w-[10ch] truncate">{brainLabel}</span>
              {count > 0 && (
                <span className="rounded-full bg-warning/15 px-1.5 py-px font-mono text-[10px] leading-4 tabular-nums text-warning">
                  {count}
                </span>
              )}
            </button>
            )}
            <div className="w-px bg-foreground/15" aria-hidden />
            {section.desks.map((desk, deskIdx) => {
              const idx = position++;
              const isActive = topView === 'desks' && desk.id === activeDeskId;
              const isEditing = editingId === desk.id;
              const shortcut = idx < 9 ? ` — ⌘${idx + 1}` : '';
              return (
                <div
                  key={desk.id}
                  className={cn(
                    // The row holds the name and its unseen badge; the × sits in the
                    // tab's top-right corner above them, on hover only.
                    'group relative flex items-center gap-1.5 px-2.5 text-body transition-colors',
                    // A hairline between neighbouring desks.
                    deskIdx > 0 && 'border-l border-foreground/10',
                    isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                    // Active marker (Variante B): a 2px coral line on the header's
                    // bottom edge, flush with the pane headers underneath.
                    isActive && 'after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full after:bg-primary',
                  )}
                >
                  {isEditing ? (
                    <input {...renameInputProps(desk.id)} placeholder="Desk name" aria-label="Desk name" />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setTopView('desks');
                        paneStore.activateDesk(desk.id);
                      }}
                      onDoubleClick={() => startEditing(desk.id, desk.name)}
                      title={`${desk.name}${shortcut} · double-click to rename`}
                      className="max-w-[10ch] cursor-pointer truncate font-medium whitespace-nowrap"
                    >
                      {desk.name}
                    </button>
                  )}

                  {!isEditing && (
                    <UnseenBadge count={countNeedsYou(turnSnapshot, desk.panes.map((pane) => pane.sessionId))} />
                  )}

                  {!isEditing && section.desks.length > 1 && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDelete(desk, section.desks.length);
                      }}
                      aria-label={`Close ${desk.name} desk`}
                      title={`Close ${desk.name} desk`}
                      className={[
                        'absolute right-0.5 top-0.5 flex h-3 w-3 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-foreground/10 hover:text-foreground',
                        // Hover only, active desk included — the band stays quiet.
                        'opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100 focus-visible:opacity-100',
                      ].join(' ')}
                    >
                      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
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
              className="my-auto mx-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border-l-0 text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Sessions that need you on this desk: a dot (one) or a count, next to the name. */
function UnseenBadge({ count }: { count: number }) {
  if (count === 0) return null;
  const label = `${count} session${count === 1 ? ' needs' : 's need'} you — waiting for input or finished while you were away`;
  if (count === 1) {
    return <span className="h-2 w-2 flex-shrink-0 rounded-full bg-primary" title={label} aria-label={label} />;
  }
  return (
    <span
      title={label}
      aria-label={label}
      className="flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] font-semibold leading-none text-primary-foreground tabular-nums"
    >
      {count}
    </span>
  );
}
