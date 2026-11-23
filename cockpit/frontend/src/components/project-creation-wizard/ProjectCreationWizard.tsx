// Kept: the modal shell, path step with FolderPathField (suggestions +
// folder browser), optional custom name, error banner, create. Trimmed: the
// GitHub-clone branch (token selection, clone progress), the two-step
// progress/review chrome (one step is left once cloning is gone), i18n.
// Cockpit (decision cockpit-brain-project-model): two ways to add a
// project — "Brain project" creates it in the brain (POST /project; it
// then shows up in the list, folder assigned on first use) and "Local
// cockpit folder" registers a directory in the cockpit alone.
// The brain form follows the brain's project model
// (name · goal · description; status stays active); the id is minted from
// the name and de-duplicated against the existing projects, not typed.
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Brain, FolderPlus, X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, HUE, Input, TAB, Textarea, TRACK } from '@/shared/view/ui';
import { brainGet, brainPost } from '@/lib/api';
import { useWritable } from '@/stores/useTeamStore';
import { cn } from '@/lib/utils';
import type { ProjectsResponse } from '@/lib/types';

import FolderPathField from './components/FolderPathField';
import { createProject } from './data/folderApi';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

type Mode = 'brain' | 'folder';

const slugify = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** First free id: `slug`, then `slug-2`, `slug-3`, … against the ids the brain already has. */
const uniqueId = (slug: string, taken: ReadonlySet<string>) => {
  if (!slug || !taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

export default function ProjectCreationWizard({ onClose, onProjectCreated }: ProjectCreationWizardProps) {
  const [mode, setMode] = useState<Mode>('brain');
  const queryClient = useQueryClient();

  // Local cockpit folder
  const [folderPath, setFolderPath] = useState('');
  const [customName, setCustomName] = useState('');

  // Brain project
  const [brainName, setBrainName] = useState('');
  const [brainGoal, setBrainGoal] = useState('');
  const [brainDescription, setBrainDescription] = useState('');
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

  const handleCreateFolder = useCallback(async () => {
    setError(null);
    if (!folderPath.trim()) {
      setError('Please provide a project folder.');
      return;
    }
    setIsCreating(true);
    try {
      const project = await createProject({
        path: folderPath.trim(),
        customName: customName.trim() || undefined,
      });
      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to add the folder');
    } finally {
      setIsCreating(false);
    }
  }, [customName, onClose, onProjectCreated, folderPath]);

  const handleCreateBrain = useCallback(async () => {
    setError(null);
    const name = brainName.trim();
    if (!name || !brainId) {
      setError('Please provide a project name.');
      return;
    }
    setIsCreating(true);
    try {
      // v0.19: projects are created through the object routes (core objects.ts).
      const { object: project } = await brainPost<{ object: Record<string, unknown>; created: boolean }>('/object/project', {
        id: brainId,
        name,
        goal: brainGoal.trim() || undefined,
        description: brainDescription.trim() || undefined,
        status: 'active',
      });
      // The brain views (Brain tab dashboard, project pages) read the project
      // list through react-query with a 30s freshness window — drop it so the
      // new project shows up there right away, not after a reload.
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create the brain project');
    } finally {
      setIsCreating(false);
    }
  }, [brainDescription, brainGoal, brainId, brainName, onClose, onProjectCreated, queryClient]);

  // A brain project is a write; a shared brain that is not live takes none (useTeamStore). A folder-only project is local.
  const brain = useWritable();
  const canCreate = mode === 'brain' ? Boolean(brainId) && brain.writable : Boolean(folderPath.trim());
  const handleCreate = mode === 'brain' ? handleCreateBrain : handleCreateFolder;
  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleCreate();
    }
  };

  return (
    // Escape closes it, a click beside it does not: that would throw away what was typed. Not while it creates.
    <Dialog open onOpenChange={(open) => { if (!open && !isCreating) onClose(); }}>
      <DialogContent aria-labelledby="add-project-title" dismissOnOutsideClick={false} className="flex flex-col">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
              {mode === 'brain' ? <Brain aria-hidden className="size-4 text-foreground" /> : <FolderPlus aria-hidden className="size-4 text-foreground" />}
            </div>
            <DialogTitle id="add-project-title" className="not-sr-only text-title font-semibold text-foreground">Add project</DialogTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={isCreating} aria-label="Close">
            <X aria-hidden />
          </Button>
        </div>

        <div className="space-y-4 p-4">
          <div role="radiogroup" aria-label="Project kind" className={cn(TRACK, 'inline-flex bg-muted')}>
            {([
              { value: 'brain', label: 'Brain project' },
              { value: 'folder', label: 'Local cockpit folder' },
            ] as const).map((option) => {
              const active = mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => { setMode(option.value); setError(null); }}
                  className={cn(TAB, 'text-ui aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-(--shadow-pill)')}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {mode === 'brain' ? (
            <>
              <div className="space-y-1.5">
                <label className="text-ui font-medium text-foreground">Name</label>
                <Input
                  type="text"
                  value={brainName}
                  autoFocus
                  onChange={(event) => setBrainName(event.target.value)}
                  placeholder="e.g. Lighthouse"
                  disabled={isCreating}
                  onKeyDown={submitOnEnter}
                />
                <p className="text-ui text-muted-foreground">
                  Engrams live under <span className="font-code">project.{brainId || '…'}</span>
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-ui font-medium text-foreground">Goal (optional)</label>
                <Input
                  type="text"
                  value={brainGoal}
                  onChange={(event) => setBrainGoal(event.target.value)}
                  placeholder="What this project is for"
                  disabled={isCreating}
                  onKeyDown={submitOnEnter}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-ui font-medium text-foreground">Description (optional)</label>
                <Textarea
                  value={brainDescription}
                  onChange={(event) => setBrainDescription(event.target.value)}
                  placeholder="1–2 sentences of context"
                  rows={2}
                  disabled={isCreating}
                  className="resize-none"
                  onKeyDown={submitOnEnter}
                />
              </div>
              <p className="text-ui text-muted-foreground">
                The project appears in the sidebar right away; its folder is assigned when you start the first session.
              </p>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-ui font-medium text-foreground">Project folder</label>
                <FolderPathField
                  value={folderPath}
                  disabled={isCreating}
                  onChange={setFolderPath}
                  onKeyDown={submitOnEnter}
                />
                <p className="text-ui text-muted-foreground">
                  Sessions run in this folder; its CLAUDE.md and .claude/settings apply. Cockpit only — nothing is written to the brain.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-ui font-medium text-foreground">Display name (optional)</label>
                <Input
                  type="text"
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  placeholder="Defaults to the folder name"
                  disabled={isCreating}
                  onKeyDown={submitOnEnter}
                />
              </div>
            </>
          )}

          {error && (
            <div className={cn('rounded-lg border px-3 py-2 text-body', HUE.stopped.tint, HUE.stopped.edge, HUE.stopped.ink)}>
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} loading={isCreating} disabled={!canCreate} title={mode === 'brain' ? brain.reason ?? undefined : undefined}>
            {mode === 'brain' ? 'Create project' : 'Add folder'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
