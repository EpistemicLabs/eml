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
import { FOCUS, LABEL, POPOVER, ROW } from '@/shared/view/ui';
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
            'flex h-full max-w-(--size-menu) items-center gap-1.5 px-2 text-body font-medium transition-colors duration-(--duration-fast)',
            open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            FOCUS,
          )}
        >
          <Brain aria-hidden className="size-4" strokeWidth={1.8} style={{ color: tone }} />
          <span className="truncate">{label}</span>
          {mark && <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', otherBroken ? 'bg-status-stopped' : 'bg-status-you')} />}
          <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={title}
          className={cn(ROW, 'font-medium')}
        >
          <SpaceIcon aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.8} style={{ color: tone }} />
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {mark && <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', otherBroken ? 'bg-status-stopped' : 'bg-status-you')} />}
          <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
        </button>
      )}

      {open && anchor && createPortal(
        <div
          data-ui="v2"
          ref={menuRef}
          role="menu"
          style={{ left: anchor.left, top: anchor.top }}
          // Keep pane focus handlers out of it: a click in the menu is not a click on a pane.
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(POPOVER, 'fixed min-w-(--size-menu) text-body')}
        >
          {variant === 'sidebar' && spaces.length > 1 && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={showingAll}
              onClick={() => { setAllView(true); close(); }}
              className={cn(
                ROW, 'normal-case tracking-normal',
              )}
            >
              <Check aria-hidden className={cn('size-3.5', !showingAll && 'invisible')} />
              <Layers aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
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
                  ROW, 'normal-case tracking-normal',
                )}
              >
                <Check aria-hidden className={cn('size-3.5', !isActive && 'invisible')} />
                <Brain aria-hidden className="size-3.5" strokeWidth={1.8} style={{ color: spaceTone(space) }} />
                <span className="flex-1 truncate">{space.name}</span>
                {failed(space) && (
                  <span className="flex items-center gap-1 text-caption text-stopped-ink" title="The brain update failed — open the space for details">
                    <span aria-hidden className="size-1.5 rounded-full bg-status-stopped" />
                    update failed
                  </span>
                )}
                {state && !failed(space) && (
                  <span aria-hidden className={cn('size-1.5 rounded-full', state.tone === 'destructive' ? 'bg-status-stopped' : 'bg-status-you')} />
                )}
                {space.shared && <span className={LABEL}>shared</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
