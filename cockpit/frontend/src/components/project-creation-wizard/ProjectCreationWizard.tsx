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

import { Button, Input } from '@/shared/view/ui';
import { brainGet, brainPost } from '@/lib/api';
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

const textareaClass =
  'flex w-full rounded-md border border-foreground/15 bg-foreground/[0.04] px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground focus-visible:border-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none';

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
      .catch(() => { /* unreachable brain: the server's 409 still guards the id */ });
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

  const canCreate = mode === 'brain' ? Boolean(brainId) : Boolean(folderPath.trim());
  const handleCreate = mode === 'brain' ? handleCreateBrain : handleCreateFolder;
  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleCreate();
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              {mode === 'brain' ? <Brain className="h-4 w-4 text-foreground" /> : <FolderPlus className="h-4 w-4 text-foreground" />}
            </div>
            <h3 className="text-lg font-semibold text-foreground">Add project</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div role="radiogroup" aria-label="Project kind" className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted p-0.5">
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
                  className={cn(
                    'h-7 rounded-full px-3 text-ui font-medium transition-colors',
                    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {mode === 'brain' ? (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Name</label>
                <Input
                  type="text"
                  value={brainName}
                  autoFocus
                  onChange={(event) => setBrainName(event.target.value)}
                  placeholder="e.g. Lighthouse"
                  disabled={isCreating}
                  onKeyDown={submitOnEnter}
                />
                <p className="text-xs text-muted-foreground">
                  Engrams live under <span className="font-mono">project.{brainId || '…'}</span>
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Goal (optional)</label>
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
                <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
                <textarea
                  value={brainDescription}
                  onChange={(event) => setBrainDescription(event.target.value)}
                  placeholder="1–2 sentences of context"
                  rows={2}
                  disabled={isCreating}
                  className={textareaClass}
                  onKeyDown={submitOnEnter}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                The project appears in the sidebar right away; its folder is assigned when you start the first session.
              </p>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Project folder</label>
                <FolderPathField
                  value={folderPath}
                  disabled={isCreating}
                  onChange={setFolderPath}
                  onKeyDown={submitOnEnter}
                />
                <p className="text-xs text-muted-foreground">
                  Sessions run in this folder; its CLAUDE.md and .claude/settings apply. Cockpit only — nothing is written to the brain.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Display name (optional)</label>
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
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} loading={isCreating} disabled={!canCreate}>
            {mode === 'brain' ? 'Create project' : 'Add folder'}
          </Button>
        </div>
      </div>
    </div>
  );
}
