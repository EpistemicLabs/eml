// The strip for a shared space whose brain is not live (spec
// team-brain-membership-flows-spec §5): the title names the state, the body is
// the brain server's own read-only text — the one text a write would get —
// and a join shows the step it is at. A join that stopped before the brain
// had anything offers a new link (the host routes it to this space; the
// server replaces the stopped join) or the space's removal. The state comes
// from useTeamStore (GET /api/spaces/:id/team); nothing here is invented.
import { useState } from 'react';
import { Link2, Loader2, Users, XCircle } from 'lucide-react';

import { deadJoin, joinStep, stateTitle, stateTone } from '@/lib/team';
import { joinSharedSpace, removeSpace, useActiveSpace } from '@/stores/useSpaceStore';
import { refreshTeams, useTeam } from '@/stores/useTeamStore';
import { Banner, BannerButton, BannerLink } from './Banner';

export default function TeamBanner() {
  const space = useActiveSpace();
  const team = useTeam(space?.id);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!space || !space.shared || !team?.shared) return null;
  const title = stateTitle(team);
  if (!title) return null;
  const dead = deadJoin(team);
  const step = joinStep(team.state);

  const join = async () => {
    const value = link?.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const result = await joinSharedSpace(space.name, value);
    setBusy(false);
    if ('error' in result) { setError(result.error); return; }
    setLink(null);
    void refreshTeams();
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await removeSpace(space);
    setBusy(false);
    if ('error' in result) setError(result.error);
  };

  return (
    <Banner
      tone={stateTone(team.state)}
      icon={team.state.kind === 'joining' ? Users : XCircle}
      busy={busy || team.state.kind === 'joining' || team.state.kind === 'catching_up'}
      detail={error ?? step ?? team.read_only}
      actions={dead && link === null && (
        <>
          <BannerLink icon={Link2} onClick={() => setLink('')}>Paste a new link</BannerLink>
          <BannerLink icon={XCircle} onClick={() => void remove()}>Remove space</BannerLink>
        </>
      )}
      below={dead && link !== null && (
        <form className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void join(); }}>
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…/i/1/…"
            aria-label="Invite link"
            spellCheck={false}
            autoFocus
            disabled={busy}
            className="min-w-0 flex-1 rounded-md border border-current/30 bg-background/70 px-2 py-1 font-mono text-xs text-foreground outline-none"
          />
          <BannerButton disabled={busy || !link.trim()} onClick={() => void join()}>{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Join'}</BannerButton>
          <BannerLink onClick={() => { setLink(null); setError(null); }}>Cancel</BannerLink>
        </form>
      )}
    >
      {title}
    </Banner>
  );
}
