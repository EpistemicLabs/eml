// Cockpit addition: Settings › Brain. Spaces, where this cockpit keeps its
// files, and WAL-safe backups — all from the host (GET /api/brain-info,
// /api/brain-backups). Who is in the brain shows in Account and Agent. Read-only except "Back up now"; switching the source
// to a remote brain and restoring a backup are later steps.
import { useCallback, useEffect, useState } from 'react';
import { FolderSearch, HardDriveDownload, Loader2, Pencil, Plus } from 'lucide-react';

import { useAboutInfo } from '@/hooks/useAboutInfo';
import { createSpace, loadSpaces, renameSpace, switchSpace, useActiveSpace, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { Button } from '@/shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import { useBrainInfo } from '../../hooks/useBrainInfo';

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

export default function BrainTab() {
  const { info, failed: infoFailed } = useBrainInfo();
  const [backups, setBackups] = useState<BrainBackup[]>([]);
  const [backingUp, setBackingUp] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const { info: about } = useAboutInfo();
  const spaces = useSpaces();
  const activeSpace = useActiveSpace();
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

  const loadBackups = useCallback(async () => {
    try {
      setBackups((await getJson<{ backups: BrainBackup[] }>('/api/brain-backups')).backups);
    } catch { /* list stays as is */ }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const backUpNow = async () => {
    setBackingUp(true);
    setBackupError(null);
    try {
      await getJson('/api/brain-backups', { method: 'POST' });
      await loadBackups();
    } catch {
      setBackupError('Backup failed — see the host log.');
    } finally {
      setBackingUp(false);
    }
  };

  const reveal = () => {
    void fetch('/api/brain-info/reveal', { method: 'POST' });
  };

  const fallback = infoFailed ? 'unavailable' : '…';

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Spaces"
        description="Each space is its own brain. Sessions, desks and projects of a space never see another space's brain. The details below are the active space's."
      >
        <SettingsCard divided>
          {spaces.map((space) => (
            <SettingsRow
              key={space.id}
              label={space.name}
              description={(renaming?.id === space.id && renameError) || (space.main ? 'The brain this cockpit was set up with' : 'A further local brain with the same agent and profile')}
            >
              <div className="flex items-center gap-2">
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
                {space.id === activeSpace?.id ? (
                  <Mono>active</Mono>
                ) : (
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => switchSpace(space)}>
                    Switch
                  </Button>
                )}
              </div>
            </SettingsRow>
          ))}
          <SettingsRow label="New space" description={spaceError ?? 'A new local brain, seeded with your agent and profile'}>
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
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Source">
        <SettingsCard divided>
          <SettingsRow
            label="Brain source"
            description="The brain that ships with this cockpit, on this machine. A remote brain (URL + token) comes later."
          >
            <Mono>{info ? 'Local (bundled)' : fallback}</Mono>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Paths">
        <SettingsCard divided>
          <SettingsRow label="Cockpit home" description="All state of this cockpit instance lives here">
            <Mono className="max-w-sm break-all text-right">{info?.home ?? fallback}</Mono>
          </SettingsRow>
          <SettingsRow label="Brain file" description={info?.brainFile ?? undefined}>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={reveal} disabled={!info?.brainFile}>
              <FolderSearch className="h-3.5 w-3.5" />
              Show in Finder
            </Button>
          </SettingsRow>
          <SettingsRow
            label="Claude config directory"
            description="The app's own Claude environment — your local ~/.claude stays untouched"
          >
            <Mono className="max-w-sm break-all text-right">{about?.configDir ?? '—'}</Mono>
          </SettingsRow>
          <SettingsRow label="Backups folder">
            <Mono className="max-w-sm break-all text-right">{info ? `${info.home}/backups` : fallback}</Mono>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Details">
        <SettingsCard divided>
          <SettingsRow label="Brain ID">
            <Mono>{info?.brainId ?? fallback}</Mono>
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
        title="Backups"
        description="Consistent copies of the brain file, even while sessions write — kept in the backups folder (see Paths). A copy is also taken automatically before every brain update; the newest 3 are kept."
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
    </div>
  );
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`block font-mono text-xs text-foreground ${className ?? ''}`}>
      {children}
    </span>
  );
}
