import { useCallback, useEffect, useState } from 'react';

import * as paneStore from '@/stores/usePaneStore';
import { SPACE_CHANGED_EVENT } from '@/stores/useSpaceStore';
import { api, type ProjectsResponse } from '@/utils/api';
import type { Project } from '@/types/app';

const POLL_INTERVAL_MS = 5000;

type FetchOptions = { showLoadingState?: boolean };

export function findProjectOwningSession(projects: Project[], sessionId: string): Project | null {
  return projects.find((project) => project.sessions?.some((session) => session.id === sessionId)) ?? null;
}

/** Structural equality over JSON-shaped values; arrays compare positionally. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

const isDocumentVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

const NO_PROJECTS: Project[] = [];
const spaceKey = (spaceId: string | null): string => spaceId ?? '';

/** Projects of each space seen in this tab, by space id ('' = main). */
export type ProjectsBySpace = Readonly<Record<string, Project[]>>;

/** One space's projects; a stable empty list for a space not loaded yet. */
export function projectsOfSpace(bySpace: ProjectsBySpace, spaceId: string | null): Project[] {
  return bySpace[spaceKey(spaceId)] ?? NO_PROJECTS;
}

export function useProjectsState() {
  // Kept per space: the desks of a space left open stay mounted, and their
  // panes resolve against their own space's projects, not the open one's — a
  // pane that lost its project would drop its terminal and its connection.
  const [projectsBySpace, setProjectsBySpace] = useState<ProjectsBySpace>({});
  const activeSpaceId = paneStore.useActiveSpaceId();
  const projects = projectsOfSpace(projectsBySpace, activeSpaceId);
  // Changes the open space's list only.
  const setProjects = useCallback((update: (previous: Project[]) => Project[]) => {
    const key = spaceKey(paneStore.getActiveSpaceId());
    setProjectsBySpace((bySpace) => {
      const previous = bySpace[key] ?? NO_PROJECTS;
      const next = update(previous);
      return next === previous ? bySpace : { ...bySpace, [key]: next };
    });
  }, []);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('account');

  const openSettings = useCallback((tab: string = 'account') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  const fetchProjects = useCallback(async (options: FetchOptions = {}) => {
    const showLoadingState = options.showLoadingState ?? true;
    if (showLoadingState) setIsLoadingProjects(true);
    try {
      // The request goes to the space open now; its answer belongs to that
      // space even if the user switched while it was underway.
      const key = spaceKey(paneStore.getActiveSpaceId());
      const response = await api.projects();
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
      const body = (await response.json()) as ProjectsResponse;
      const fetched = Array.isArray(body?.projects) ? body.projects : [];
      setProjectsBySpace((bySpace) => {
        const previous = bySpace[key];
        if (previous && previous.length > 0 && sameValue(previous, fetched)) return bySpace;
        return { ...bySpace, [key]: fetched };
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) setIsLoadingProjects(false);
    }
  }, []);

  const refreshProjectsSilently = useCallback(() => fetchProjects({ showLoadingState: false }), [fetchProjects]);

  const handleSidebarRefresh = useCallback(() => refreshProjectsSilently(), [refreshProjectsSilently]);

  useEffect(() => {
    void fetchProjects({ showLoadingState: true });
  }, [fetchProjects]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (isDocumentVisible()) void refreshProjectsSilently();
    };
    const interval = window.setInterval(refreshIfVisible, POLL_INTERVAL_MS);
    const onSpaceChanged = () => {
      void refreshProjectsSilently();
    };
    window.addEventListener('focus', refreshIfVisible);
    window.addEventListener(SPACE_CHANGED_EVENT, onSpaceChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshIfVisible);
      window.removeEventListener(SPACE_CHANGED_EVENT, onSpaceChanged);
    };
  }, [refreshProjectsSilently]);

  useEffect(() => {
    if (isLoadingProjects || projects.length !== 1) return;
    const pane = paneStore.getActivePane();
    if (pane && !pane.projectId && pane.paneView === 'terminal') {
      paneStore.updatePane(pane.id, { projectId: projects[0].projectId });
    }
  }, [projects, isLoadingProjects]);

  const handleSessionDelete = useCallback((sessionId: string) => {
    for (const pane of paneStore.getPanes()) {
      if (pane.sessionId !== sessionId) continue;
      if (pane.pinned) paneStore.clearPane(pane.id);
      else paneStore.removePane(pane.id);
    }
    setProjects((previous) =>
      previous.map((project) => {
        if (!project.sessions?.some((session) => session.id === sessionId)) return project;
        const previousTotal = Number(project.sessionMeta?.total ?? 0) || 0;
        return {
          ...project,
          sessions: project.sessions.filter((session) => session.id !== sessionId),
          sessionMeta: { ...project.sessionMeta, total: Math.max(0, previousTotal - 1), hasMore: false },
        };
      }),
    );
  }, [setProjects]);

  const handleProjectDelete = useCallback((projectId: string) => {
    for (const pane of paneStore.getPanes()) {
      if (pane.projectId === projectId) {
        paneStore.updatePane(pane.id, { projectId: null, sessionId: paneStore.newCliSessionId() });
      }
    }
    setProjects((previous) => previous.filter((project) => project.projectId !== projectId));
  }, [setProjects]);

  return {
    projects,
    projectsBySpace,
    isLoadingProjects,
    showSettings,
    settingsInitialTab,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    handleSessionDelete,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
