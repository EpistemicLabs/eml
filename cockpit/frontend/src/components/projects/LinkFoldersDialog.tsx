// "Link them" from the folders banner: every folder-only project of the open space in one list, each with
// what to do — join an existing brain project, a new one, leave the cockpit, or wait. Apply runs the rows
// one by one; a row that fails stays with its error, one that worked says so.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Link2, Loader2, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Project as BrainProject } from '@/lib/types';
import { Button, Dialog, DialogContent, DialogTitle, HUE, Input, Select } from '@/shared/view/ui';
import { useWritable } from '@/stores/useTeamStore';
import type { Project } from '@/types/app';

import {
  createBrainProject, errorText, invalidateBrainProjects, linkFolder, linkTargets, loadLinkTargets, matchingTarget, removeFolder,
} from './brainLink';

/** `link:<brain id>`, or one of the other three. */
type Choice = 'later' | 'new' | 'remove' | `link:${string}`;

type Row = {
  project: Project;
  choice: Choice;
  name: string;
  state: 'idle' | 'running' | 'done' | 'error';
  message?: string;
};

const sessionCount = (project: Project) => Number(project.sessionMeta?.total ?? project.sessions?.length ?? 0) || 0;

export default function LinkFoldersDialog({ projects, onClose, onChanged, onRemoved }: {
  /** The folder-only projects as they were when the dialog opened; the list does not shrink under the user. */
  projects: Project[];
  onClose: () => void;
  /** Something changed on the host: the project lists read again. */
  onChanged: () => void;
  onRemoved: (projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const brain = useWritable();
  const space = projects[0]?.__spaceId;
  const [rows, setRows] = useState<Row[]>(() => projects.map((project) => ({ project, choice: 'later', name: project.displayName, state: 'idle' })));
  const [open, setOpen] = useState<{ brain: BrainProject[]; cockpit: Project[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadLinkTargets(space)
      .then((loaded) => {
        if (cancelled) return;
        setOpen(loaded);
        // A first guess per row: the free project named like the folder, else later (nothing is made unasked).
        setRows((current) => current.map((row) => {
          const match = matchingTarget(linkTargets(loaded.brain, loaded.cockpit, row.project.fullPath), row.project);
          return { ...row, choice: match ? `link:${match.id}` : 'later' };
        }));
      })
      .catch((error) => {
        if (cancelled) return;
        setOpen({ brain: [], cockpit: [] });
        setLoadError(`The brain projects could not be read: ${errorText(error, 'the brain did not answer')}`);
      });
    return () => { cancelled = true; };
  }, [space]);

  const update = (projectId: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.project.projectId === projectId ? { ...row, ...patch } : row)));

  const pending = rows.filter((row) => row.state !== 'done' && row.choice !== 'later');
  const canApply = !busy && open !== null && pending.length > 0
    && pending.every((row) => row.choice !== 'new' || (row.name.trim() && brain.writable));

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    let changed = false;
    let brainList = open?.brain ?? [];
    for (const row of pending) {
      const { project } = row;
      update(project.projectId, { state: 'running', message: undefined });
      let choice = row.choice;
      try {
        if (choice === 'remove') {
          await removeFolder(project);
          changed = true;
          onRemoved(project.projectId);
          update(project.projectId, { state: 'done', message: 'Removed from the cockpit' });
          continue;
        }
        let name = '';
        if (choice === 'new') {
          const made = await createBrainProject({ name: row.name }, { space });
          invalidateBrainProjects(queryClient);
          name = row.name.trim();
          choice = `link:${made.id}`;
          brainList = [...brainList, { id: made.id, name, status: 'active' } as BrainProject];
          // A retry links to the project just made instead of making another.
          update(project.projectId, { choice });
          setOpen((current) => (current ? { ...current, brain: brainList } : current));
        }
        const brainId = choice.slice('link:'.length);
        name ||= brainList.find((b) => b.id === brainId)?.name ?? brainId;
        await linkFolder(project, brainId);
        changed = true;
        update(project.projectId, { state: 'done', message: `Linked to ${name}` });
      } catch (error) {
        update(project.projectId, { state: 'error', message: errorText(error, 'Something went wrong') });
      }
    }
    if (changed) {
      onChanged();
      // Which brain project runs where changed: the choices read again.
      void loadLinkTargets(space).then(setOpen).catch(() => {});
    }
    setBusy(false);
  };

  const done = rows.filter((row) => row.state === 'done').length;
  const failed = rows.filter((row) => row.state === 'error').length;

  return (
    // Escape closes it, a click beside it does not: that would throw away the choices. Not while it applies.
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen && !busy) onClose(); }}>
      <DialogContent aria-labelledby="link-folders-title" dismissOnOutsideClick={false} className="flex max-h-full max-w-dialog-wide flex-col">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
              <Link2 aria-hidden className="size-4 text-foreground" />
            </div>
            <div>
              <DialogTitle id="link-folders-title" className="not-sr-only text-title font-semibold text-foreground">Link folders to brain projects</DialogTitle>
              <p className="text-ui text-muted-foreground">Every project is a brain project now. A linked project takes the folder and its sessions.</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={busy} aria-label="Close">
            <X aria-hidden />
          </Button>
        </div>

        <ul aria-label="Folders" className="m-0 flex min-h-0 list-none flex-col divide-y divide-border overflow-y-auto p-0">
          {rows.map((row) => {
            const { project } = row;
            const targets = open ? linkTargets(open.brain, open.cockpit, project.fullPath) : [];
            const sessions = sessionCount(project);
            const locked = busy || row.state === 'done' || open === null;
            return (
              <li key={project.projectId} className="flex flex-col gap-1.5 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-medium">{project.displayName}</div>
                    <div className="truncate text-caption text-muted-foreground">
                      <span className="font-code">{project.fullPath}</span>
                      {` · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`}
                    </div>
                  </div>
                  {row.state === 'done' ? (
                    <span className="inline-flex items-center gap-1 text-ui text-muted-foreground"><Check aria-hidden className="size-3.5" />{row.message}</span>
                  ) : (
                    <Select
                      aria-label={`What to do with ${project.displayName}`}
                      value={row.choice}
                      disabled={locked}
                      onChange={(e) => update(project.projectId, { choice: e.target.value as Choice })}
                      className="max-w-full"
                    >
                      {targets.length > 0 && (
                        <optgroup label="Link to">
                          {targets.map((t) => (
                            <option key={t.id} value={`link:${t.id}`} disabled={t.elsewhere}>{t.name}{t.elsewhere ? ' (runs in another folder)' : ''}</option>
                          ))}
                        </optgroup>
                      )}
                      <option value="new">New project</option>
                      <option value="remove">Remove from cockpit</option>
                      <option value="later">Later</option>
                    </Select>
                  )}
                  {row.state === 'running' && <Loader2 aria-label="Working" className="size-4 animate-spin text-muted-foreground" />}
                </div>
                {row.choice === 'new' && row.state !== 'done' && (
                  <Input
                    aria-label={`New project name for ${project.displayName}`}
                    value={row.name}
                    disabled={locked}
                    placeholder="Project name"
                    onChange={(e) => update(project.projectId, { name: e.target.value })}
                  />
                )}
                {row.choice === 'remove' && row.state === 'idle' && (
                  <p className="m-0 text-caption text-muted-foreground">The folder on disk stays. Its sessions are stopped and forgotten; transcripts are kept.</p>
                )}
                {row.state === 'error' && (
                  <p role="alert" className={cn('m-0 text-ui', HUE.stopped.ink)}>{row.message}</p>
                )}
              </li>
            );
          })}
        </ul>

        {loadError && (
          <div role="alert" className={cn('mx-4 mb-2 rounded-lg border px-3 py-2 text-body', HUE.stopped.tint, HUE.stopped.edge, HUE.stopped.ink)}>{loadError}</div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <span role="status" className="mr-auto text-ui text-muted-foreground">
            {done + failed > 0 && [done > 0 && `${done} done`, failed > 0 && `${failed} failed`].filter(Boolean).join(' · ')}
          </span>
          <Button variant="outline" onClick={onClose} disabled={busy}>{done > 0 ? 'Close' : 'Cancel'}</Button>
          {done < rows.length && (
            <Button onClick={() => void apply()} loading={busy} disabled={!canApply} title={brain.reason ?? undefined}>Apply</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
