// What you can do to a project from Plan (decision cockpit-review-screen-removed-drafts-in-chat:
// project management lives in the Plan view): rename, pin, hide or show, link a folder, remove from
// the cockpit, and add one. Every change goes to the host, then the project lists read again.
import { useCallback, useEffect, useState } from 'react';

import { FALLBACK_ERROR_MESSAGE, hostErrorMessage } from '@/lib/host-error';
import type { Project } from '@/types/app';
import { api } from '@/utils/api';

/** The session launcher's "New project…" asks for the add-project wizard with this window event. */
export const ADD_PROJECT_EVENT = 'cockpit-add-project';

export function useProjectActions({ onChanged, onRemoved }: { onChanged: () => void; onRemoved?: (projectId: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [linking, setLinking] = useState<Project | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const open = () => setAdding(true);
    window.addEventListener(ADD_PROJECT_EVENT, open);
    return () => window.removeEventListener(ADD_PROJECT_EVENT, open);
  }, []);

  /** One host call; on success the lists read again, on failure the host's message shows. */
  const run = useCallback(async (request: () => Promise<Response>): Promise<boolean> => {
    setBusy(true);
    try {
      const response = await request();
      if (!response.ok) { setError(await hostErrorMessage(response)); return false; }
      setError(null);
      onChanged();
      return true;
    } catch {
      setError(FALLBACK_ERROR_MESSAGE);
      return false;
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const rename = useCallback(async (project: Project, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === project.displayName) return;
    await run(() => api.renameProject(project.projectId, trimmed, project.__spaceId));
  }, [run]);

  const togglePin = useCallback((project: Project) => run(() => api.setProjectStar(project.projectId, !project.isStarred, project.__spaceId)), [run]);
  const toggleHidden = useCallback((project: Project) => run(() => api.setProjectHidden(project.projectId, !project.hidden, project.__spaceId)), [run]);

  /** Removes the project asked about in `removing`; `deleteData` also deletes its session transcripts. */
  const confirmRemove = useCallback(async (deleteData: boolean) => {
    const project = removing;
    setRemoving(null);
    if (!project) return;
    if (await run(() => api.deleteProject(project.projectId, deleteData, project.__spaceId))) onRemoved?.(project.projectId);
  }, [removing, run, onRemoved]);

  return {
    error, dismissError: () => setError(null), busy, refresh: onChanged,
    renaming, startRename: setRenaming, cancelRename: () => setRenaming(null), rename,
    togglePin, toggleHidden,
    removing, askRemove: setRemoving, cancelRemove: () => setRemoving(null), confirmRemove,
    linking, startLink: setLinking, endLink: () => setLinking(null),
    adding, startAdd: () => setAdding(true), endAdd: () => setAdding(false),
  };
}

export type ProjectActions = ReturnType<typeof useProjectActions>;
