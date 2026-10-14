// The brain space menu (decision cockpit-naming-desks-spaces): the sidebar's
// group header over the projects opens it — the spaces, the active one
// marked, and "New space…" (a further local brain, host POST /api/spaces).
// The header shows every space's desks as sections (DeskTabBar), so a desk of
// another space is one click away there. Switching a space switches its desks.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Check, ChevronDown, Loader2, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { setTopView } from '@/stores/useTopViewStore';
import {
  createSpace,
  loadSpaces,
  switchSpace,
  useActiveSpace,
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
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => { if (creating) inputRef.current?.focus(); }, [creating]);

  const close = () => { setOpen(false); setCreating(false); setDraft(''); setError(null); };

  const select = (space: SpaceInfo) => {
    switchSpace(space);
    setTopView('desks');
    close();
  };

  const submit = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    const result = await createSpace(name);
    setBusy(false);
    if ('error' in result) { setError(result.error); return; }
    select(result.space);
  };

  const label = active?.name ?? 'Main';
  const title = `Space: ${label}`;

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
          <Brain className="h-4 w-4" strokeWidth={1.8} />
          <span className="truncate">{label}</span>
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
          <Brain className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
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
          {spaces.map((space) => {
            const isActive = space.id === active?.id;
            return (
              <button
                key={space.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => select(space)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left normal-case tracking-normal',
                  isActive ? 'text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Check className={cn('h-3.5 w-3.5', isActive ? 'opacity-100' : 'opacity-0')} />
                <span className="flex-1 truncate">{space.name}</span>
                {space.main && <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">main</span>}
              </button>
            );
          })}
          <div className="my-1 h-px bg-border" />
          {creating ? (
            <form
              className="px-1 py-1"
              onSubmit={(e) => { e.preventDefault(); void submit(); }}
            >
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Space name"
                maxLength={40}
                disabled={busy}
                autoFocus
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-body normal-case tracking-normal text-foreground outline-none focus:border-primary"
              />
              {error && <p className="mt-1 px-0.5 text-caption normal-case tracking-normal text-destructive">{error}</p>}
              <p className="mt-1 px-0.5 text-caption normal-case tracking-normal text-muted-foreground">
                A new local brain with your agent and profile. Enter to create.
              </p>
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left normal-case tracking-normal text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              New space…
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
