// Cockpit addition: Settings › Spaces. Spaces, where this cockpit keeps its
// files, and WAL-safe backups — all from the host (GET /api/brain-info,
// /api/brain-backups). Who is in the brain shows in Account and Agent. Read-only except "Back up now"; switching the source
// to a remote brain and restoring a backup are later steps.
import { useCallback, useEffect, useState } from 'react';
import { Brain, FolderSearch, HardDriveDownload, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { spaceTone } from '@/lib/space-color';
import { SPACE_HEADER } from '@/lib/space-header';
import { cn } from '@/lib/utils';
import { createSharedSpace, createSpace, joinSharedSpace, loadSpaces, removeSpace, renameSpace, switchSpace, useActiveSpace, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { Button } from '@/shared/view/ui';
import SettingsCard from '../SettingsCard';
import { SpaceColorPicker } from '../SpaceColorPicker';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsSegmented from '../SettingsSegmented';
import { useAccount } from '../../hooks/useAccount';
import { useBrainInfo } from '../../hooks/useBrainInfo';
import { agentName, useAgents } from '../../hooks/useAgents';
import { relayHost, type Team } from '@/lib/team';
import { refreshTeams, useTeams } from '@/stores/useTeamStore';
import TeamSections from './TeamSections';

type BrainBackup = { name: string; kind: 'manual' | 'pre-migration'; sizeBytes: number; createdAt: string };

const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// control.db stores "YYYY-MM-DD HH:MM:SS" in UTC without a zone.
const formatDate = (value: string | null): string => {
  if (!value) return '—';
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

/** What a space row says: where it comes from and which agent works in it; an unbound one points at the banner. */
function spaceDescription(space: SpaceInfo, team: Team | undefined): string {
  const host = team?.shared ? relayHost(team.relay) : null;
  const origin = space.main ? 'The space this cockpit was set up with' : space.shared ? (host ? `A shared brain on ${host}` : 'A shared brain') : 'A further local brain';
  return space.agent ? origin : `${origin} · no agent bound — see the banner above`;
}

export default function SpacesTab() {
  const spaces = useSpaces();
  const activeSpace = useActiveSpace();
  // The space shown below: picked here, without opening it in the cockpit.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [kind, setKind] = useState<'local' | 'shared' | null>(null);
  const tab = kind ?? (activeSpace?.shared ? 'shared' : 'local');
  const listed = spaces.filter((space) => (tab === 'shared' ? space.shared : !space.shared));
  const shown = listed.find((space) => space.id === pickedId) ?? listed.find((space) => space.id === activeSpace?.id) ?? listed[0];
  const shownId = shown?.id;
  const { info, failed: infoFailed } = useBrainInfo(shownId);
  const [backups, setBackups] = useState<BrainBackup[]>([]);
  const [backingUp, setBackingUp] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const { agents } = useAgents();
  const mainAgentName = agentName(agents, spaces.find((s) => s.main)?.agent ?? null);
  // v0.21: a shared space's team (useTeamStore) — the row says where it lives, the sections below show it.
  const teams = useTeams();
  const shownTeam = shown?.shared ? teams[shown.id] : undefined;
  const [spaceName, setSpaceName] = useState('');
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SpaceInfo | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  useEffect(() => { void loadSpaces(); }, []);
  const commitRename = async () => {
    if (!renaming) return;
    const name = renameDraft.trim();
    if (!name || name === renaming.name) { setRenaming(null); return; }
    const result = await renameSpace(renaming, name);
    if ('error' in result) { setRenameError(result.error); return; }
    setRenaming(null);
    setRenameError(null);
  };
  const addSpace = async () => {
    const name = spaceName.trim();
    if (!name) return;
    setSpaceBusy(true);
    setSpaceError(null);
    const result = await createSpace(name);
    setSpaceBusy(false);
    if ('error' in result) { setSpaceError(result.error); return; }
    setSpaceName('');
    switchSpace(result.space);
  };

  const inShown = useCallback(
    (init?: RequestInit): RequestInit => ({ ...init, headers: shownId ? { [SPACE_HEADER]: shownId } : {} }),
    [shownId],
  );

  const loadBackups = useCallback(async () => {
    try {
      return (await getJson<{ backups: BrainBackup[] }>('/api/brain-backups', inShown())).backups;
    } catch {
      return null;
    }
  }, [inShown]);

  useEffect(() => {
    let current = true;
    setBackups([]);
    setBackupError(null);
    void loadBackups().then((list) => { if (current && list) setBackups(list); });
    return () => { current = false; };
  }, [loadBackups]);

  const backUpNow = async () => {
    setBackingUp(true);
    setBackupError(null);
    try {
      await getJson('/api/brain-backups', inShown({ method: 'POST' }));
      const list = await loadBackups();
      if (list) setBackups(list);
    } catch {
      setBackupError('Backup failed — see the host log.');
    } finally {
      setBackingUp(false);
    }
  };

  const reveal = () => {
    void fetch('/api/brain-info/reveal', inShown({ method: 'POST' }));
  };

  const fallback = infoFailed ? 'unavailable' : '…';

  const spaceRow = (space: SpaceInfo) => (
    <SettingsRow
      key={space.id}
      label={
        <button
          type="button"
          aria-pressed={space.id === shownId}
          onClick={() => setPickedId(space.id)}
          className="flex max-w-full items-center gap-2 text-left hover:underline"
        >
          <Brain className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.8} style={{ color: spaceTone(space) }} />
          <span className="truncate">{space.name}</span>
        </button>
      }
      className={cn(space.id === shownId && 'bg-foreground/[0.05]')}
      description={(renaming?.id === space.id && renameError) || spaceDescription(space, teams[space.id])}
    >
      <div className="flex items-center gap-2">
        <SpaceColorPicker space={space} onError={setSpaceError} />
        {renaming?.id === space.id ? (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void commitRename(); }}>
            <input
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setRenaming(null); setRenameError(null); } }}
              maxLength={40}
              autoFocus
              aria-label="Space name"
              className="h-8 w-40 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
            />
            <Button size="sm" className="h-8 text-xs" type="submit">Save</Button>
          </form>
        ) : (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => { setRenaming(space); setRenameDraft(space.name); setRenameError(null); }}>
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </Button>
        )}
      </div>
    </SettingsRow>
  );

  return (
    <div className="space-y-8">
      <SettingsSegmented
        value={tab}
        options={[{ value: 'local', label: 'Local' }, { value: 'shared', label: 'Shared' }]}
        onChange={(value) => { setKind(value); setPickedId(null); }}
        ariaLabel="Local or shared spaces"
      />

      <SettingsSection description="Each space has its own brain and never sees another space's brain.">
        <SettingsCard divided>
          {listed.map(spaceRow)}
          {tab === 'local' ? (
            <SettingsRow label="New space" description={spaceError ?? (mainAgentName ? `A new local brain for your work; ${mainAgentName} works in it from the start.` : 'A new local brain for your work.')}>
              <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void addSpace(); }}>
                <input
                  value={spaceName}
                  onChange={(e) => setSpaceName(e.target.value)}
                  placeholder="Name"
                  maxLength={40}
                  disabled={spaceBusy}
                  className="h-8 w-40 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                />
                <Button size="sm" className="h-8 gap-1.5 text-xs" type="submit" disabled={spaceBusy || !spaceName.trim()}>
                  {spaceBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Create
                </Button>
              </form>
            </SettingsRow>
          ) : (
            <>
              <NewSharedSpace />
              <JoinSharedSpace />
            </>
          )}
        </SettingsCard>
      </SettingsSection>

      {shown && shownTeam?.shared && <TeamSections spaceId={shown.id} team={shownTeam} />}

      {shown && (
        <>
        <SettingsSection title={shown.name}>
          <SettingsCard divided>
            {shown.ownRuntime && (
              <SettingsRow
                label="Login and tools"
                description={`Sessions here use ${shown.agentName}'s own Claude login and tools, not the ones in Settings › Models.`}
              >
                <span className="text-sm text-foreground">Own</span>
              </SettingsRow>
            )}
            <SettingsRow label="Brain file" description={info?.brainFile ?? undefined}>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={reveal} disabled={!info?.brainFile}>
                <FolderSearch className="h-3.5 w-3.5" />
                Show in Finder
              </Button>
            </SettingsRow>
            <SettingsRow label="Schema version">
              <Mono>{info?.schemaVersion ?? fallback}</Mono>
            </SettingsRow>
            <SettingsRow label="Size">
              <Mono>{info ? formatBytes(info.sizeBytes) : fallback}</Mono>
            </SettingsRow>
            <SettingsRow label="Last write">
              <Mono>{info ? formatDate(info.modifiedAt) : fallback}</Mono>
            </SettingsRow>
            <SettingsRow label="Created">
              <Mono>{info ? formatDate(info.createdAt) : fallback}</Mono>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title={`Backups of ${shown.name}`}
          description="Consistent copies of the brain file, even while sessions write — kept in the backups folder (see Settings › Data). A copy is also taken automatically before every brain update; the newest 3 are kept."
        >
          <SettingsCard divided>
            <SettingsRow label="Back up now" description={backupError ?? 'A full copy of the brain as it is right now'}>
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void backUpNow()} disabled={backingUp || !info?.brainFile}>
                {backingUp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HardDriveDownload className="h-3.5 w-3.5" />}
                {backingUp ? 'Backing up…' : 'Back up now'}
              </Button>
            </SettingsRow>
            {backups.length === 0 ? (
              <div className="px-4 py-4 text-sm text-muted-foreground">No backups yet.</div>
            ) : (
              backups.map((b) => (
                <div key={b.name} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Mono className="min-w-0 truncate">{b.name}</Mono>
                    {b.kind === 'pre-migration' && (
                      <span className="flex-shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] text-muted-foreground">before update</span>
                    )}
                  </span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground">
                    {formatDate(b.createdAt)} · {formatBytes(b.sizeBytes)}
                  </span>
                </div>
              ))
            )}
          </SettingsCard>
        </SettingsSection>
        </>
      )}

      {shown && !shown.main && shown.shared === false && (
        <DeleteSpace key={shown.id} space={shown} onDeleted={() => setPickedId(null)} />
      )}
    </div>
  );
}

const spaceInput = 'h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary';

/** A new shared brain on the relay; it needs the EML account in the team-brain beta. */
function NewSharedSpace() {
  const account = useAccount();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!(account.status?.signedIn === true && account.status.beta)) {
    return <SettingsRow label="New shared space" description="Needs an EML account in the beta (Settings › Account)."><span /></SettingsRow>;
  }

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await createSharedSpace(name.trim());
    setBusy(false);
    if ('error' in result) { setError(result.error); return; }
    setName('');
    void refreshTeams();
    switchSpace(result.space);
  };

  return (
    <SettingsRow label="New shared space" description={error ?? (busy ? 'Talking to the relay…' : 'A brain you share with others.')}>
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Shared space name" maxLength={40} disabled={busy} className={`w-40 ${spaceInput}`} />
        <Button size="sm" className="h-8 gap-1.5 text-xs" type="submit" disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Create
        </Button>
      </form>
    </SettingsRow>
  );
}

/** Joining a shared space by the invite link its owner sent. */
function JoinSharedSpace() {
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    setBusy(true);
    setError(null);
    const result = await joinSharedSpace(name.trim(), link.trim());
    setBusy(false);
    if ('error' in result) { setError(result.error); return; }
    setName('');
    setLink('');
    void refreshTeams();
    switchSpace(result.space);
  };

  return (
    <SettingsRow label="Join a shared space" description={error ?? (busy ? 'Talking to the relay…' : 'With the invite link you were sent.')}>
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void join(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Space name to join under" maxLength={40} disabled={busy} className={`w-28 ${spaceInput}`} />
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Invite link" aria-label="Invite link" spellCheck={false} disabled={busy} className={`w-44 font-mono ${spaceInput}`} />
        <Button size="sm" className="h-8 text-xs" type="submit" disabled={busy || !name.trim() || !link.trim()}>Join</Button>
      </form>
    </SettingsRow>
  );
}

/** Deleting a local space: the host backs it up first, and its name has to be typed. */
function DeleteSpace({ space, onDeleted }: { space: SpaceInfo; onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await removeSpace(space, typed);
    setBusy(false);
    if ('error' in result) setError(result.error);
    else onDeleted();
  };

  return (
    <SettingsSection title={`Delete ${space.name}`}>
      <SettingsCard>
        <SettingsRow
          label="Delete this space"
          description={error ?? 'Its brain leaves this cockpit. A backup is made first. Type the name to confirm.'}
        >
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void remove(); }}>
            <input
              aria-label="Name of the space to delete"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={space.name}
              disabled={busy}
              className="h-8 w-40 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
            />
            <Button variant="destructive" size="sm" className="h-8 gap-1.5 text-xs" type="submit" disabled={busy || typed !== space.name}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete
            </Button>
          </form>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`block font-mono text-xs text-foreground ${className ?? ''}`}>
      {children}
    </span>
  );
}
