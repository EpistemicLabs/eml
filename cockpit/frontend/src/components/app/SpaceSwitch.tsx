// The brain space menu (decision cockpit-naming-desks-spaces): the sidebar's
// group header over the projects opens it — the spaces, the active one
// marked; new spaces are made in Settings › Spaces. In the sidebar it also
// offers All spaces, a view of the sidebar only. The header shows every space's desks as sections
// (DeskTabBar), so a desk of another space is one click away there.
// Switching a space switches its desks. A space whose brain failed to migrate
// or whose shared brain is not live is marked here (a dot), so the state is
// seen from every space; its banner says what happened.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Check, ChevronDown, Layers } from 'lucide-react';

import { spaceTone } from '@/lib/space-color';
import { cn } from '@/lib/utils';
import { stateTitle, stateTone } from '@/lib/team';
import { failedUnresolved, useUpdateStatus } from '@/stores/useUpdateStatusStore';
import { useTeams } from '@/stores/useTeamStore';
import { setTopView } from '@/stores/useTopViewStore';
import {
  loadSpaces,
  setAllView,
  switchSpace,
  useActiveSpace,
  useAllView,
  useSpaces,
  type SpaceInfo,
} from '@/stores/useSpaceStore';

interface SpaceSwitchProps {
  /** header: a tab-like button; sidebar: the small uppercase group header. */
  variant: 'header' | 'sidebar';
}

export default function SpaceSwitch({ variant }: SpaceSwitchProps) {
  const spaces = useSpaces();
  const active = useActiveSpace();
  const update = useUpdateStatus();
  const teams = useTeams();
  const failed = (space: SpaceInfo) => failedUnresolved(update?.brains[space.id]);
  /** A shared space's state when it is not live: its title and tone; null while live, local or unknown. */
  const notLive = (space: SpaceInfo): { title: string; tone: 'info' | 'destructive' } | null => {
    const team = teams[space.id];
    if (!space.shared || !team?.shared) return null;
    const title = stateTitle(team);
    return title ? { title, tone: stateTone(team.state) } : null;
  };
  // Another space's brain is offline or not live: the trigger carries the mark too, in the worse tone.
  const otherFailed = spaces.some((s) => s.id !== active?.id && failed(s));
  const others = spaces.filter((s) => s.id !== active?.id).map(notLive);
  const otherNotLive = others.some((state) => state !== null);
  const otherBroken = otherFailed || others.some((state) => state?.tone === 'destructive');
  const allView = useAllView();
  const showingAll = variant === 'sidebar' && allView;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is a portal (the header clips overflow), placed under the trigger.
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return; }
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ left: rect.left, top: rect.bottom + 4 });
  }, [open]);

  useEffect(() => { void loadSpaces(); }, []);
  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  const select = (space: SpaceInfo) => {
    setAllView(false);
    switchSpace(space);
    setTopView('desks');
    close();
  };

  const label = showingAll ? 'All spaces' : active?.name ?? 'Main';
  const title = showingAll
    ? 'All spaces'
    : otherFailed
      ? `Space: ${label} — the brain update failed in another space`
      : otherNotLive ? `Space: ${label} — a shared brain is not live in another space` : `Space: ${label}`;
  const mark = otherFailed || otherNotLive;
  const SpaceIcon = showingAll ? Layers : Brain;
  const tone = showingAll ? undefined : spaceTone(active);

  return (
    <div ref={rootRef} className="relative flex h-full items-stretch">
      {variant === 'header' ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={title}
          className={cn(
            'flex h-full max-w-[12rem] items-center gap-1.5 px-2 text-body font-medium transition-colors',
            open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Brain className="h-4 w-4" strokeWidth={1.8} style={{ color: tone }} />
          <span className="truncate">{label}</span>
          {mark && <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', otherBroken ? 'bg-destructive' : 'bg-warning')} />}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={title}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body font-medium text-foreground hover:bg-muted"
        >
          <SpaceIcon className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} style={{ color: tone }} />
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {mark && <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', otherBroken ? 'bg-destructive' : 'bg-warning')} />}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      )}

      {open && anchor && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ left: anchor.left, top: anchor.top }}
          // Keep pane focus handlers out of it: a click in the menu is not a click on a pane.
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[1000] min-w-[12rem] rounded-lg border border-border bg-popover p-1 text-body shadow-lg"
        >
          {variant === 'sidebar' && spaces.length > 1 && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={showingAll}
              onClick={() => { setAllView(true); close(); }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left normal-case tracking-normal',
                showingAll ? 'text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Check className={cn('h-3.5 w-3.5', showingAll ? 'opacity-100' : 'opacity-0')} />
              <Layers className="h-3.5 w-3.5 opacity-60" strokeWidth={1.8} />
              <span className="flex-1 truncate">All spaces</span>
            </button>
          )}
          {spaces.map((space) => {
            const isActive = !showingAll && space.id === active?.id;
            const state = notLive(space);
            const unknown = space.shared === null;
            return (
              <button
                key={space.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => select(space)}
                title={state?.title ?? (unknown ? 'The cockpit could not ask the brain server.' : undefined)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left normal-case tracking-normal',
                  isActive ? 'text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Check className={cn('h-3.5 w-3.5', isActive ? 'opacity-100' : 'opacity-0')} />
                <Brain className="h-3.5 w-3.5" strokeWidth={1.8} style={{ color: spaceTone(space) }} />
                <span className="flex-1 truncate">{space.name}</span>
                {failed(space) && (
                  <span className="flex items-center gap-1 text-[10px] text-destructive" title="The brain update failed — open the space for details">
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-destructive" />
                    update failed
                  </span>
                )}
                {state && !failed(space) && (
                  <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', state.tone === 'destructive' ? 'bg-destructive' : 'bg-warning')} />
                )}
                {space.shared && <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">shared</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
