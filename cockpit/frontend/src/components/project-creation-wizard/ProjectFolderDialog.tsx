// Assign (or change) the folder a brain project's sessions run in, from
// "Set folder…" in the sidebar. (Sessions no longer wait for a folder: the
// host makes a cockpit folder on the first start, 2026-09-22.) Same path
// field + folder browser as the add-project wizard; saves via PATCH
// /api/projects/:id { path }.
import { useCallback, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, HUE } from '@/shared/view/ui';
import { api } from '@/utils/api';
import type { Project } from '@/types/app';

import FolderPathField from './components/FolderPathField';

type ProjectFolderDialogProps = {
  project: Project;
  onClose: () => void;
  /** Called with the saved project (the host's view) after the folder is set. */
  onSaved: (project: Project) => void;
};

export default function ProjectFolderDialog({ project, onClose, onSaved }: ProjectFolderDialogProps) {
  // A cockpit folder is not a folder the user chose — start empty
  // and show it as a hint, so they link their own instead of editing it.
  const isCockpitFolder = project.folderKind === 'cockpit';
  const [folderPath, setFolderPath] = useState(isCockpitFolder ? '' : project.fullPath ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setError(null);
    if (!folderPath.trim()) {
      setError('Please provide a folder.');
      return;
    }
    setIsSaving(true);
    try {
      const response = await api.setProjectPath(project.projectId, folderPath.trim(), project.__spaceId);
      const data = (await response.json()) as { project?: Project; error?: { message?: string } | string };
      if (!response.ok || !data.project) {
        const message = typeof data.error === 'string' ? data.error : data.error?.message;
        throw new Error(message || 'Failed to set the folder');
      }
      onSaved(data.project);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to set the folder');
    } finally {
      setIsSaving(false);
    }
  }, [onClose, onSaved, project.projectId, folderPath]);

  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSave();
    }
  };

  return (
    // Escape closes it, a click beside it does not: that would throw away the typed path. Not while it saves.
    <Dialog open onOpenChange={(open) => { if (!open && !isSaving) onClose(); }}>
      <DialogContent aria-labelledby="link-folder-title" dismissOnOutsideClick={false} className="flex flex-col">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
              <FolderOpen aria-hidden className="size-4 text-foreground" />
            </div>
            <div>
              <DialogTitle id="link-folder-title" className="not-sr-only text-title font-semibold text-foreground">{project.fullPath && !isCockpitFolder ? 'Change folder' : 'Link folder'}</DialogTitle>
              <p className="text-ui text-muted-foreground">{project.displayName}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={isSaving} aria-label="Close">
            <X aria-hidden />
          </Button>
        </div>

        <div className="space-y-4 p-4">
          <div className="space-y-1.5">
            <label className="text-ui font-medium text-foreground">Project folder</label>
            <FolderPathField
              value={folderPath}
              disabled={isSaving}
              onChange={setFolderPath}
              onKeyDown={submitOnEnter}
            />
            <p className="text-ui text-muted-foreground">
              Where Claude works: code, documents, notes — anything in this folder Claude can read and edit. Its CLAUDE.md and .claude/settings apply.
            </p>
            {isCockpitFolder && project.fullPath && (
              <p className="text-ui text-muted-foreground">
                Currently running in the cockpit folder <span className="font-code">{project.fullPath}</span>. Files there stay where they are.
              </p>
            )}
          </div>

          {error && (
            <div className={cn('rounded-lg border px-3 py-2 text-body', HUE.stopped.tint, HUE.stopped.edge, HUE.stopped.ink)}>{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} loading={isSaving} disabled={!folderPath.trim()}>
            Link folder
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
