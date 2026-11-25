// Kept: the modal shell, path step with FolderPathField (suggestions +
// folder browser), optional custom name, error banner, create. Trimmed: the
// GitHub-clone branch (token selection, clone progress), the two-step
// progress/review chrome (one step is left once cloning is gone), i18n.
// Cockpit (decision cockpit-brain-project-model): every cockpit project is a
// brain project. The form follows the brain's project model (name · goal ·
// description; status stays active) plus an optional folder its sessions run
// in; the id is minted from the name and de-duplicated against the existing
// projects, not typed. A given folder is set after the project is made
// (PATCH /api/projects/bp-<id> { path }); without one the cockpit makes a
// folder on the first session.
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Brain, X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, HUE, Input, Textarea } from '@/shared/view/ui';
import { brainGet } from '@/lib/api';
import { hostErrorMessage } from '@/lib/host-error';
import { projectIdOfBrain } from '@/lib/project-lead';
import { useWritable } from '@/stores/useTeamStore';
import { cn } from '@/lib/utils';
import type { ProjectsResponse } from '@/lib/types';
import { api } from '@/utils/api';
import { createBrainProject, errorText, invalidateBrainProjects, slugify, uniqueId } from '@/components/projects/brainLink';

import FolderPathField from './components/FolderPathField';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

export default function ProjectCreationWizard({ onClose, onProjectCreated }: ProjectCreationWizardProps) {
  const queryClient = useQueryClient();

  const [brainName, setBrainName] = useState('');
  const [brainGoal, setBrainGoal] = useState('');
  const [brainDescription, setBrainDescription] = useState('');
  const [folderPath, setFolderPath] = useState('');
  // Ids the brain already has (all statuses) — the minted id steps around them.
  const [takenIds, setTakenIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    brainGet<ProjectsResponse>('/projects')
      .then((res) => { if (!cancelled) setTakenIds(new Set(res.projects.map((p) => p.id))); })
      .catch(() => { /* unreachable brain: the server's 400 ("already exists") still guards the id */ });
    return () => { cancelled = true; };
  }, []);
  const brainId = uniqueId(slugify(brainName), takenIds);

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Made, but its folder was not taken: the dialog stays to say so, and closing reports the project.
  const [created, setCreated] = useState<Record<string, unknown> | null>(null);

  const close = useCallback(() => {
    if (created) onProjectCreated?.(created);
    else onClose();
  }, [created, onClose, onProjectCreated]);

  const handleCreate = useCallback(async () => {
    if (created) { close(); return; }
    setError(null);
    const name = brainName.trim();
    if (!name || !brainId) {
      setError('Please provide a project name.');
      return;
    }
    setIsCreating(true);
    let made: { id: string; project: Record<string, unknown> } | null = null;
    try {
      // v0.19: projects are created through the object routes (core objects.ts).
      made = await createBrainProject({ name, goal: brainGoal, description: brainDescription }, { taken: takenIds });
      invalidateBrainProjects(queryClient);
      const folder = folderPath.trim();
      if (folder) {
        const response = await api.setProjectPath(projectIdOfBrain(made.id), folder);
        if (!response.ok) throw new Error(await hostErrorMessage(response));
      }
      onProjectCreated?.(made.project);
      onClose();
    } catch (createError) {
      if (made) {
        setCreated(made.project);
        setError(`${name} was created, but its folder was not set: ${errorText(createError, 'the host did not answer')}. Set it later with “Link a folder”.`);
      } else {
        setError(errorText(createError, 'Failed to create the brain project'));
      }
    } finally {
      setIsCreating(false);
    }
  }, [brainDescription, brainGoal, brainId, brainName, close, created, folderPath, onClose, onProjectCreated, queryClient, takenIds]);

  // A brain project is a write; a shared brain that is not live takes none (useTeamStore).
  const brain = useWritable();
  const canCreate = Boolean(created) || (Boolean(brainId) && brain.writable);
  const locked = isCreating || Boolean(created);
  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleCreate();
    }
  };

  return (
    // Escape closes it, a click beside it does not: that would throw away what was typed. Not while it creates.
    <Dialog open onOpenChange={(open) => { if (!open && !isCreating) close(); }}>
      <DialogContent aria-labelledby="add-project-title" dismissOnOutsideClick={false} className="flex flex-col">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
              <Brain aria-hidden className="size-4 text-foreground" />
            </div>
            <DialogTitle id="add-project-title" className="not-sr-only text-title font-semibold text-foreground">Add project</DialogTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={close} disabled={isCreating} aria-label="Close">
            <X aria-hidden />
          </Button>
        </div>

        <div className="space-y-4 p-4">
          <div className="space-y-1.5">
            <label htmlFor="add-project-name" className="text-ui font-medium text-foreground">Name</label>
            <Input
              id="add-project-name"
              type="text"
              value={brainName}
              autoFocus
              onChange={(event) => setBrainName(event.target.value)}
              placeholder="e.g. Lighthouse"
              disabled={locked}
              onKeyDown={submitOnEnter}
            />
            <p className="text-ui text-muted-foreground">
              Engrams live under <span className="font-code">project.{brainId || '…'}</span>
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="add-project-goal" className="text-ui font-medium text-foreground">Goal (optional)</label>
            <Input
              id="add-project-goal"
              type="text"
              value={brainGoal}
              onChange={(event) => setBrainGoal(event.target.value)}
              placeholder="What this project is for"
              disabled={locked}
              onKeyDown={submitOnEnter}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="add-project-description" className="text-ui font-medium text-foreground">Description (optional)</label>
            <Textarea
              id="add-project-description"
              value={brainDescription}
              onChange={(event) => setBrainDescription(event.target.value)}
              placeholder="1–2 sentences of context"
              rows={2}
              disabled={locked}
              className="resize-none"
              onKeyDown={submitOnEnter}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-ui font-medium text-foreground">Folder (optional)</label>
            <FolderPathField
              value={folderPath}
              disabled={locked}
              onChange={setFolderPath}
              onKeyDown={submitOnEnter}
            />
            <p className="text-ui text-muted-foreground">
              Sessions run in this folder; its CLAUDE.md and .claude/settings apply. Leave it empty and the cockpit makes one.
            </p>
          </div>

          {error && (
            <div role="alert" className={cn('rounded-lg border px-3 py-2 text-body', HUE.stopped.tint, HUE.stopped.edge, HUE.stopped.ink)}>
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          {!created && (
            <Button variant="outline" onClick={close} disabled={isCreating}>
              Cancel
            </Button>
          )}
          <Button onClick={() => void handleCreate()} loading={isCreating} disabled={!canCreate} title={created ? undefined : brain.reason ?? undefined}>
            {created ? 'Done' : 'Create project'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
