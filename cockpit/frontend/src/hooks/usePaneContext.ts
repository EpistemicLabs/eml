// One `sessions` list per project, each session carrying its provider.
import { useMemo } from 'react';

import { usePane } from '@/stores/usePaneStore';
import type { PaneState } from '@/stores/usePaneStore';
import type { Project, ProjectSession } from '@/types/app';

export interface PaneContext {
  pane: PaneState | undefined;
  project: Project | null;
  session: ProjectSession | null;
}

/**
 * Resolve {pane, project, session} for a given pane id by scanning the
 * loaded projects array.
 *
 * Same resolution path is used for the active pane AND inactive panes —
 * that symmetry is the whole point of this hook.
 *
 * `projects` is passed in (rather than read from a hook) because the
 * canonical projects state lives in `useProjectsState`, called once at
 * the top level. Resolving here avoids re-running that whole stateful
 * hook for every pane.
 */
export function usePaneContext(paneId: string, projects: Project[]): PaneContext {
  const pane = usePane(paneId);

  return useMemo(() => {
    if (!pane) return { pane: undefined, project: null, session: null };

    // Resolve project up-front so we can return it even when sessionId is null
    // (e.g. a fresh pane the user just opened with "+ New Session for project X").
    const projectFromPane = pane.projectId
      ? projects.find(p => p.projectId === pane.projectId) ?? null
      : null;

    if (!pane.sessionId) {
      return { pane, project: projectFromPane, session: null };
    }

    for (const project of projects) {
      const session = project.sessions?.find(s => s.id === pane.sessionId);
      if (session) {
        const tagged: ProjectSession = session.__provider
          ? session
          : { ...session, __provider: 'claude' };
        return {
          pane,
          project: projectFromPane ?? project,
          session: tagged,
        };
      }
    }

    // sessionId set but not found in any project list yet (e.g. a freshly
    // created session that hasn't propagated to /api/projects). Keep the
    // project context so the pane header still has something to render.
    return { pane, project: projectFromPane, session: null };
  }, [pane, projects]);
}
