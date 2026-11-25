// "Link to brain project…" for a folder-only project (decision cockpit-brain-project-model): the folder
// joins a brain project of its space, an existing one or a new one made here. The brain project takes the
// folder and its sessions (POST /api/projects/:id/link); the folder-only entry goes.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, HUE, Input, LABEL, RadioCard, Select } from '@/shared/view/ui';
import { useWritable } from '@/stores/useTeamStore';
import type { Project } from '@/types/app';

import {
  createBrainProject, errorText, invalidateBrainProjects, linkFolder, linkTargets, loadLinkTargets, matchingTarget, type LinkTarget,
} from './brainLink';

type Mode = 'existing' | 'new';

export default function LinkProjectDialog({ project, onClose, onLinked }: {
  project: Project;
  onClose: () => void;
  /** Called after the host linked it; the project lists read again. */
  onLinked: () => void;
}) {
  const queryClient = useQueryClient();
  const brain = useWritable();
  const [targets, setTargets] = useState<LinkTarget[] | null>(null);
  const [mode, setMode] = useState<Mode>('existing');
  const [brainId, setBrainId] = useState('');
  const [name, setName] = useState(project.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLinkTargets(project.__spaceId)
      .then(({ brain: open, cockpit }) => {
        if (cancelled) return;
        const list = linkTargets(open, cockpit, project.fullPath);
        setTargets(list);
        const match = matchingTarget(list, project);
        if (match) setBrainId(match.id);
        else if (!list.some((t) => !t.elsewhere)) setMode('new');
      })
      .catch((loadError) => {
        if (cancelled) return;
        setTargets([]);
        setMode('new');
        setError(`The brain projects could not be read: ${errorText(loadError, 'the brain did not answer')}`);
      });
    return () => { cancelled = true; };
    // Read once per folder: a list read again keeps the choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.projectId, project.__spaceId]);

  const ready = mode === 'existing' ? Boolean(brainId) : Boolean(name.trim()) && brain.writable;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    let target = brainId;
    try {
      if (mode === 'new') {
        const made = await createBrainProject({ name }, { space: project.__spaceId });
        invalidateBrainProjects(queryClient);
        target = made.id;
        // A retry links to the project just made instead of making another.
        setTargets((list) => [...(list ?? []), { id: made.id, name: name.trim(), elsewhere: false }]);
        setBrainId(made.id);
        setMode('existing');
      }
      await linkFolder(project, target);
      onLinked();
      onClose();
    } catch (linkError) {
      setError(errorText(linkError, 'The folder was not linked.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Escape closes it, a click beside it does not: that would throw away the choice. Not while it links.
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent aria-labelledby="link-brain-title" dismissOnOutsideClick={false} className="flex flex-col">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted">
              <Link2 aria-hidden className="size-4 text-foreground" />
            </div>
            <div className="min-w-0">
              <DialogTitle id="link-brain-title" className="not-sr-only text-title font-semibold text-foreground">Link to brain project</DialogTitle>
              <p className="truncate text-ui text-muted-foreground">
                {project.displayName}
                {project.fullPath && <span className="ml-2 font-code">{project.fullPath}</span>}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={busy} aria-label="Close">
            <X aria-hidden />
          </Button>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <p className="m-0 text-ui text-muted-foreground">The project takes this folder and its sessions.</p>
          <div role="radiogroup" aria-label="Brain project" className="flex flex-col gap-1.5">
            <RadioCard name="link-brain-mode" value="existing" checked={mode === 'existing'} onChange={() => setMode('existing')} title="Existing project" />
            {mode === 'existing' && (
              <Select aria-label="Existing project" value={brainId} onChange={(e) => setBrainId(e.target.value)} disabled={busy || targets === null} className="w-full">
                <option value="">{targets === null ? 'Loading…' : targets.length === 0 ? 'No projects in this brain yet' : 'Pick a project…'}</option>
                {(targets ?? []).map((t) => (
                  <option key={t.id} value={t.id} disabled={t.elsewhere}>{t.name}{t.elsewhere ? ' (runs in another folder)' : ''}</option>
                ))}
              </Select>
            )}
            <RadioCard name="link-brain-mode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} title="New project" />
            {mode === 'new' && (
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Name</span>
                <Input
                  value={name}
                  autoFocus
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                />
              </label>
            )}
          </div>
          {error && (
            <div role="alert" className={cn('rounded-lg border px-3 py-2 text-body', HUE.stopped.tint, HUE.stopped.edge, HUE.stopped.ink)}>{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!ready} title={mode === 'new' ? brain.reason ?? undefined : undefined}>
            Link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
