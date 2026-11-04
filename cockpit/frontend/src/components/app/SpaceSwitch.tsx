// The brain space menu (decision cockpit-naming-desks-spaces): the sidebar's
// group header over the projects opens it — the spaces, the active one
// marked, and the ways to a new one: "New space…" (a further local brain),
// "New shared space…" (a shared brain on the relay, needs the EML account in
// the team-brain beta) and "Join shared space…" (by an invite link); all
// host POST /api/spaces. The header shows every space's desks as sections
// (DeskTabBar), so a desk of another space is one click away there.
// Switching a space switches its desks. A space whose brain failed to migrate
// or whose shared brain is not live is marked here (a dot), so the state is
// seen from every space; its banner says what happened.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Check, ChevronDown, Link2, Loader2, Plus, Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import { stateTitle, stateTone } from '@/lib/team';
import { failedUnresolved, useUpdateStatus } from '@/stores/useUpdateStatusStore';
import { refreshTeams, useTeams } from '@/stores/useTeamStore';
import { setTopView } from '@/stores/useTopViewStore';
import {
  createSharedSpace,
  createSpace,
  joinSharedSpace,
  loadSpaces,
  switchSpace,
  useActiveSpace,
  useSpaces,
  type SpaceInfo,
} from '@/stores/useSpaceStore';
import { useAccount } from '@/components/settings/hooks/useAccount';

/** Which form the menu shows: a local space, a shared brain, or a join by link. */
type NewSpace = 'local' | 'shared' | 'join';

const FORM_HINT: Record<NewSpace, string> = {
  local: 'A new local brain with your agent and profile. Enter to create.',
  shared: 'Enter to create a shared brain on the relay.',
  join: 'Enter to join.',
};

const NOT_ENTITLED = 'Shared spaces need an EML account in the team-brain beta (Settings › Account).';

interface SpaceSwitchProps {
  /** header: a tab-like button; sidebar: the small uppercase group header. */
  variant: 'header' | 'sidebar';
}

export default function SpaceSwitch({ variant }: SpaceSwitchProps) {
  const spaces = useSpaces();
  const active = useActiveSpace();
  const update = useUpdateStatus();
  const teams = useTeams();
  const account = useAccount();
  const entitled = account.status?.signedIn === true && account.status.beta;
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
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<NewSpace | null>(null);
  const [draft, setDraft] = useState('');
  const [link, setLink] = useState('');
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
  // The account may have signed in or out in Settings since: read it again when the menu opens.
  const refreshAccount = account.refresh;
  useEffect(() => { if (open) void refreshAccount(); }, [open, refreshAccount]);

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

  const close = () => { setOpen(false); setCreating(null); setDraft(''); setLink(''); setError(null); };

  const select = (space: SpaceInfo) => {
    switchSpace(space);
    setTopView('desks');
    close();
  };

  const submit = async () => {
    const name = draft.trim();
    if (!name || busy || !creating) return;
    if (creating === 'join' && !link.trim()) return;
    setBusy(true);
    setError(null);
    const result = creating === 'local' ? await createSpace(name)
      : creating === 'shared' ? await createSharedSpace(name)
        : await joinSharedSpace(name, link.trim());
    setBusy(false);
    if ('error' in result) { setError(result.error); return; }
    if (creating !== 'local') void refreshTeams();
    select(result.space);
  };

  const label = active?.name ?? 'Main';
  const title = otherFailed
    ? `Space: ${label} — the brain update failed in another space`
    : otherNotLive ? `Space: ${label} — a shared brain is not live in another space` : `Space: ${label}`;
  const mark = otherFailed || otherNotLive;

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
          <Brain className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
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
          {spaces.map((space) => {
            const isActive = space.id === active?.id;
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
                aria-label="Space name"
                maxLength={40}
                disabled={busy}
                autoFocus
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-body normal-case tracking-normal text-foreground outline-none focus:border-primary"
              />
              {creating === 'join' && (
                <input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://…/i/1/…"
                  aria-label="Invite link"
                  spellCheck={false}
                  disabled={busy}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-caption normal-case tracking-normal text-foreground outline-none focus:border-primary"
                />
              )}
              {error && <p className="mt-1 px-0.5 text-caption normal-case tracking-normal text-destructive">{error}</p>}
              <p className="mt-1 px-0.5 text-caption normal-case tracking-normal text-muted-foreground">
                {busy && creating !== 'local' ? 'Talking to the relay…' : FORM_HINT[creating]}
              </p>
            </form>
          ) : (
            <>
              <MenuAction icon={Plus} busy={busy} onClick={() => setCreating('local')}>New space…</MenuAction>
              {entitled ? (
                <MenuAction icon={Users} busy={busy} onClick={() => setCreating('shared')}>New shared space…</MenuAction>
              ) : (
                <p className="px-2 py-1.5 text-caption normal-case tracking-normal text-muted-foreground/70">{NOT_ENTITLED}</p>
              )}
              <MenuAction icon={Link2} busy={busy} onClick={() => setCreating('join')}>Join shared space…</MenuAction>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function MenuAction({ icon: Icon, busy, onClick, children }: { icon: typeof Plus; busy: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left normal-case tracking-normal text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}
