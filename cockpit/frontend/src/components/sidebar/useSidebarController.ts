import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { subscribeSettings } from '@/components/settings/utils/settingsStorage';
import { useDesks } from '@/stores/usePaneStore';
import { api } from '@/utils/api';
import { switchSpace, useActiveSpace, useAllView, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import type { Project, ProjectSession } from '@/types/app';
import { bySpace, listProjects, projectKey } from './spaceProjects';
import { useAllSessions } from './useAllSessions';
import type {
  ConversationEntry,
  PendingProjectDelete,
  PendingSessionDelete,
  ProjectSortOrder,
  RenameState,
  SidebarError,
  SidebarProps,
  SidebarViewMode,
} from './types';
import {
  FALLBACK_ERROR_MESSAGE,
  bucketConversations,
  deriveProjectSessions,
  groupProjects,
  hostErrorMessage,
  isProjectVisible,
  projectLastActivity,
  readPinnedOpen,
  readSortOrder,
  readViewMode,
  sessionDisplayName,
  sortProjects,
  writePinnedOpen,
  writeViewMode,
} from './utils';

const CLOCK_INTERVAL_MS = 60_000;
const ERROR_DISMISS_MS = 6_000;

type Overrides = Record<string, boolean>;

function withoutKeys(source: Overrides, drop: (id: string, value: boolean) => boolean): Overrides {
  let changed = false;
  const next: Overrides = {};
  for (const [id, value] of Object.entries(source)) {
    if (drop(id, value)) changed = true;
    else next[id] = value;
  }
  return changed ? next : source;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

export function useSidebarController(props: SidebarProps) {
  const {
    projects: openProjects,
    projectsBySpace,
    selectedProject,
    selectedSession,
    onProjectSelect,
    onSessionSelect,
    onNewSession,
    isLoading,
    onShowSettings,
    onSetFolder,
  } = props;

  // Latest callbacks for async handlers without re-creating them per render.
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });
  const allView = useAllView();
  const spaces = useSpaces();
  const activeSpace = useActiveSpace();
  const projects = useMemo(
    () => listProjects(projectsBySpace, openProjects, spaces, activeSpace, allView),
    [projectsBySpace, openProjects, spaces, activeSpace, allView],
  );
  const { sessions: allSessions, queued: queuedWorkers, refresh: refreshAllSessions } = useAllSessions(true);
  const refreshList = useCallback(async () => {
    await Promise.all([propsRef.current.onRefresh(), refreshAllSessions()]);
  }, [refreshAllSessions]);

  // ── Errors (user actions only) ─────────────────────────────────────
  const [error, setError] = useState<SidebarError | null>(null);
  const reportError = useCallback((message: string) => {
    setError((previous) => ({ id: (previous?.id ?? 0) + 1, message: message || FALLBACK_ERROR_MESSAGE }));
  }, []);
  const dismissError = useCallback(() => setError(null), []);
  const actionSucceeded = dismissError;
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), ERROR_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  // ── Clock, settings, persisted toggles ─────────────────────────────
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const [sortOrder, setSortOrder] = useState<ProjectSortOrder>(readSortOrder);
  useEffect(() => subscribeSettings(() => setSortOrder(readSortOrder())), []);

  const [viewMode, setViewModeState] = useState<SidebarViewMode>(readViewMode);
  const setViewMode = useCallback((mode: SidebarViewMode) => {
    setViewModeState(mode);
    writeViewMode(mode);
  }, []);

  const [isPinnedOpen, setPinnedOpen] = useState(readPinnedOpen);
  const togglePinnedOpen = useCallback(() => {
    setPinnedOpen((pinned) => {
      writePinnedOpen(!pinned);
      return !pinned;
    });
  }, []);

  const [showHidden, setShowHidden] = useState(false);
  const toggleShowHidden = useCallback(() => setShowHidden((value) => !value), []);

  // ── First list arrival (gates the sessions skeleton) ───────────────
  const [listArrived, setListArrived] = useState(false);
  useEffect(() => {
    if (!listArrived && !isLoading && projects.length > 0) setListArrived(true);
  }, [listArrived, isLoading, projects.length]);

  // ── Optimistic star / pin state ────────────────────────────────────
  const [starOverrides, setStarOverrides] = useState<Overrides>({});
  const [pinOverrides, setPinOverrides] = useState<Overrides>({});
  const starSequence = useRef(new Map<string, number>());
  const pinSequence = useRef(new Map<string, number>());

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, ProjectSession[]>();
    for (const project of projects) map.set(projectKey(project), deriveProjectSessions(project));
    return map;
  }, [projects]);

  const hostPinState = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const sessions of sessionsByProject.values()) {
      for (const session of sessions) map.set(session.id, Boolean(session.isPinned));
    }
    return map;
  }, [sessionsByProject]);

  useEffect(() => {
    const starredById = new Map(projects.map((project) => [projectKey(project), Boolean(project.isStarred)]));
    setStarOverrides((current) =>
      withoutKeys(current, (id, value) => !starredById.has(id) || starredById.get(id) === value),
    );
    setPinOverrides((current) =>
      withoutKeys(current, (id, value) => !hostPinState.has(id) || hostPinState.get(id) === value),
    );
  }, [projects, hostPinState]);

  const isProjectStarred = useCallback(
    (project: Project) => starOverrides[projectKey(project)] ?? Boolean(project.isStarred),
    [starOverrides],
  );
  const isSessionPinned = useCallback(
    (session: ProjectSession) => pinOverrides[session.id] ?? hostPinState.get(session.id) ?? Boolean(session.isPinned),
    [pinOverrides, hostPinState],
  );

  const sessionsOf = useCallback(
    (project: Project) => sessionsByProject.get(projectKey(project)) ?? deriveProjectSessions(project),
    [sessionsByProject],
  );

  // ── Derived lists ──────────────────────────────────────────────────
  const hiddenCount = useMemo(() => projects.filter((project) => !isProjectVisible(project)).length, [projects]);

  const visibleProjects = useMemo(() => {
    const resolved = projects.map((project) => {
      const key = projectKey(project);
      return key in starOverrides ? { ...project, isStarred: starOverrides[key] } : project;
    });
    const filtered = showHidden ? resolved : resolved.filter(isProjectVisible);
    return sortProjects(filtered, sortOrder, (project) => projectLastActivity(sessionsOf(project)));
  }, [projects, starOverrides, showHidden, sortOrder, sessionsOf]);

  const projectGroups = useMemo(() => groupProjects(visibleProjects), [visibleProjects]);
  // Under All spaces the same groups, once per space.
  const projectSections = useMemo(
    () => (allView ? bySpace(spaces, visibleProjects, groupProjects) : null),
    [allView, spaces, visibleProjects],
  );

  const conversationGroups = useMemo(() => {
    const entries: ConversationEntry[] = [];
    for (const project of visibleProjects) {
      for (const session of sessionsOf(project)) entries.push({ project, session });
    }
    return bucketConversations(entries, now, isSessionPinned);
  }, [visibleProjects, sessionsOf, now, isSessionPinned]);

  // ── Panes (recency) ────────────────────────────────────────────────
  const desks = useDesks();
  const { openSessionIds, openNoteIds } = useMemo(() => {
    const sessionIds = new Set<string>();
    const noteIds = new Set<string>();
    for (const desk of desks) {
      for (const pane of desk.panes) {
        if (pane.sessionId) sessionIds.add(pane.sessionId);
        if (pane.noteId) noteIds.add(pane.noteId);
      }
    }
    return { openSessionIds: sessionIds, openNoteIds: noteIds };
  }, [desks]);

  // ── Expansion and selection ────────────────────────────────────────
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The selection comes from the active pane, so it is always of the open space.
  const selectedProjectKey = selectedProject
    ? projectKey({ projectId: selectedProject.projectId, __spaceId: activeSpace?.id })
    : null;
  const selectedSessionId = selectedSession?.id ?? null;

  useEffect(() => {
    if (!selectedProjectKey) return;
    setExpanded((current) => (current.has(selectedProjectKey) ? current : new Set(current).add(selectedProjectKey)));
  }, [selectedProjectKey]);

  const spaceOf = useCallback(
    (project: Project) => spaces.find((space) => space.id === project.__spaceId) ?? null,
    [spaces],
  );
  const inOpenSpace = useCallback(
    (project: Project) => project.__spaceId === activeSpace?.id,
    [activeSpace],
  );
  // What opens up in a project (its notes, new sessions, later its write rights)
  // works in the open space, so working with a project opens its space, as
  // opening a session of the overview does. All spaces stays on.
  const enterSpace = useCallback(
    (project: Project) => {
      const space = spaceOf(project);
      if (space && !inOpenSpace(project)) switchSpace(space);
    },
    [spaceOf, inOpenSpace],
  );
  // Only the open space's projects show open: see enterSpace.
  const isExpanded = useCallback(
    (project: Project) => inOpenSpace(project) && expanded.has(projectKey(project)),
    [inOpenSpace, expanded],
  );

  const selectAndToggleProject = useCallback(
    (project: Project) => {
      const key = projectKey(project);
      if (isExpanded(project)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        return;
      }
      enterSpace(project);
      if (key !== selectedProjectKey) onProjectSelect(project);
      setExpanded((current) => new Set(current).add(key));
    },
    [isExpanded, enterSpace, selectedProjectKey, onProjectSelect],
  );

  const selectSession = useCallback(
    (session: ProjectSession, projectId: string) => onSessionSelect({ ...session, __projectId: projectId }),
    [onSessionSelect],
  );

  // ── Manual refresh ─────────────────────────────────────────────────
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const runManualRefresh = useCallback(async () => {
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await refreshList();
    } catch (refreshError) {
      console.error('[Sidebar] Refresh failed:', refreshError);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [refreshList]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'r' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void runManualRefresh();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [runManualRefresh]);

  // ── Star / pin / hide ──────────────────────────────────────────────
  const toggleProjectStar = useCallback(
    async (project: Project) => {
      const id = projectKey(project);
      const previous = isProjectStarred(project);
      const next = !previous;
      const sequence = (starSequence.current.get(id) ?? 0) + 1;
      starSequence.current.set(id, sequence);
      const isLatest = () => starSequence.current.get(id) === sequence;
      setStarOverrides((current) => ({ ...current, [id]: next }));
      try {
        const response = await api.setProjectStar(project.projectId, next, project.__spaceId);
        if (!response.ok) {
          const message = await hostErrorMessage(response);
          if (isLatest()) setStarOverrides((current) => ({ ...current, [id]: previous }));
          console.error('[Sidebar] Failed to toggle project star:', response.status);
          reportError(message);
          return;
        }
        const body = (await response.json()) as { project?: { isStarred?: unknown } };
        if (!isLatest()) return;
        setStarOverrides((current) => ({ ...current, [id]: Boolean(body?.project?.isStarred ?? false) }));
        actionSucceeded();
        await refreshList();
      } catch (starError) {
        if (isLatest()) setStarOverrides((current) => ({ ...current, [id]: previous }));
        console.error('[Sidebar] Failed to toggle project star:', starError);
        reportError(FALLBACK_ERROR_MESSAGE);
      }
    },
    [isProjectStarred, reportError, actionSucceeded, refreshList],
  );

  const toggleSessionPin = useCallback(
    async (session: ProjectSession) => {
      const id = session.id;
      const previous = isSessionPinned(session);
      const next = !previous;
      const sequence = (pinSequence.current.get(id) ?? 0) + 1;
      pinSequence.current.set(id, sequence);
      const isLatest = () => pinSequence.current.get(id) === sequence;
      setPinOverrides((current) => ({ ...current, [id]: next }));
      try {
        const response = await api.setSessionPin(id, next);
        if (!response.ok) {
          const message = await hostErrorMessage(response);
          if (isLatest()) setPinOverrides((current) => ({ ...current, [id]: previous }));
          console.error('[Sidebar] Failed to toggle session pin:', response.status);
          reportError(message);
          return;
        }
        const body = (await response.json()) as { session?: { isPinned?: unknown } };
        if (!isLatest()) return;
        setPinOverrides((current) => ({ ...current, [id]: Boolean(body?.session?.isPinned ?? false) }));
        actionSucceeded();
        await refreshList();
      } catch (pinError) {
        if (isLatest()) setPinOverrides((current) => ({ ...current, [id]: previous }));
        console.error('[Sidebar] Failed to toggle session pin:', pinError);
        reportError(FALLBACK_ERROR_MESSAGE);
      }
    },
    [isSessionPinned, reportError, actionSucceeded, refreshList],
  );

  const toggleProjectHidden = useCallback(
    async (project: Project) => {
      try {
        const response = await api.setProjectHidden(project.projectId, !project.hidden, project.__spaceId);
        if (!response.ok) {
          const message = await hostErrorMessage(response);
          console.error('[Sidebar] Failed to toggle project visibility:', response.status);
          reportError(message);
          return;
        }
        actionSucceeded();
        await refreshList();
      } catch (hideError) {
        console.error('[Sidebar] Failed to toggle project visibility:', hideError);
        reportError(FALLBACK_ERROR_MESSAGE);
      }
    },
    [reportError, actionSucceeded, refreshList],
  );

  // ── Rename project ─────────────────────────────────────────────────
  const [projectRename, setProjectRename] = useState<(RenameState & { project: Project }) | null>(null);
  const startProjectRename = useCallback(
    (project: Project) => setProjectRename({ id: projectKey(project), draft: project.displayName, project }),
    [],
  );
  const setProjectRenameDraft = useCallback(
    (draft: string) => setProjectRename((current) => (current ? { ...current, draft } : current)),
    [],
  );
  const cancelProjectRename = useCallback(() => setProjectRename(null), []);
  const saveProjectRename = useCallback(async () => {
    if (!projectRename) return;
    const { project } = projectRename;
    const name = projectRename.draft.trim();
    setProjectRename(null);
    if (!name) return;
    try {
      const response = await api.renameProject(project.projectId, name, project.__spaceId);
      if (!response.ok) {
        console.error('Failed to rename project');
        reportError(await hostErrorMessage(response));
        return;
      }
      actionSucceeded();
      await refreshList();
    } catch (renameError) {
      console.error('Error renaming project:', renameError);
      reportError(FALLBACK_ERROR_MESSAGE);
    }
  }, [projectRename, reportError, actionSucceeded, refreshList]);

  // ── Rename session ─────────────────────────────────────────────────
  const [sessionRename, setSessionRename] = useState<RenameState | null>(null);
  const startSessionRename = useCallback(
    (session: ProjectSession) => setSessionRename({ id: session.id, draft: sessionDisplayName(session) }),
    [],
  );
  const setSessionRenameDraft = useCallback(
    (draft: string) => setSessionRename((current) => (current ? { ...current, draft } : current)),
    [],
  );
  const cancelSessionRename = useCallback(() => setSessionRename(null), []);
  const saveSessionRename = useCallback(async () => {
    if (!sessionRename) return;
    const { id } = sessionRename;
    const title = sessionRename.draft.trim();
    setSessionRename(null);
    if (!title) return;
    try {
      const response = await api.renameSession(id, title);
      if (!response.ok) {
        console.error('[Sidebar] Failed to rename session:', response.status);
        reportError(await hostErrorMessage(response));
        return;
      }
      actionSucceeded();
      await refreshList();
    } catch (renameError) {
      console.error('[Sidebar] Error renaming session:', renameError);
      reportError(FALLBACK_ERROR_MESSAGE);
    }
  }, [sessionRename, reportError, actionSucceeded, refreshList]);

  // ── Delete session ─────────────────────────────────────────────────
  const [pendingSessionDelete, setPendingSessionDelete] = useState<PendingSessionDelete | null>(null);
  const requestSessionDelete = useCallback(
    (projectId: string, session: ProjectSession) =>
      setPendingSessionDelete({ projectId, sessionId: session.id, title: sessionDisplayName(session) }),
    [],
  );
  const cancelSessionDelete = useCallback(() => setPendingSessionDelete(null), []);
  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      const response = await api.deleteSession(sessionId);
      if (!response.ok) {
        const message = await hostErrorMessage(response);
        const text = await response.text().catch(() => '');
        console.error('[Sidebar] Failed to delete session:', response.status, text);
        reportError(message);
        return;
      }
      actionSucceeded();
      propsRef.current.onSessionDelete?.(sessionId);
      await refreshList();
    } catch (deleteError) {
      console.error('[Sidebar] Error deleting session:', deleteError);
      reportError(FALLBACK_ERROR_MESSAGE);
    }
  }, [reportError, actionSucceeded, refreshList]);
  const confirmSessionDelete = useCallback(async () => {
    if (!pendingSessionDelete) return;
    const { sessionId } = pendingSessionDelete;
    setPendingSessionDelete(null);
    await deleteSession(sessionId);
  }, [pendingSessionDelete, deleteSession]);

  // ── Remove a folder project ────────────────────────────────────────
  const [pendingProjectDelete, setPendingProjectDelete] = useState<PendingProjectDelete | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());
  const requestProjectDelete = useCallback(
    (project: Project) => setPendingProjectDelete({ project, sessionCount: sessionsOf(project).length }),
    [sessionsOf],
  );
  const cancelProjectDelete = useCallback(() => setPendingProjectDelete(null), []);
  const confirmProjectDelete = useCallback(
    async (deleteData = false) => {
      if (!pendingProjectDelete) return;
      const { projectId, __spaceId: space } = pendingProjectDelete.project;
      const key = projectKey(pendingProjectDelete.project);
      setPendingProjectDelete(null);
      setDeleting((current) => new Set(current).add(key));
      try {
        const response = await api.deleteProject(projectId, deleteData, space);
        if (!response.ok) {
          console.error('[Sidebar] Failed to delete project:', response.status);
          reportError(await hostErrorMessage(response));
        } else {
          actionSucceeded();
          propsRef.current.onProjectDelete?.(projectId);
          await refreshList();
        }
      } catch (deleteError) {
        console.error('Error deleting project:', deleteError);
        reportError(FALLBACK_ERROR_MESSAGE);
      } finally {
        setDeleting((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [pendingProjectDelete, reportError, actionSucceeded, refreshList],
  );

  // ── Add-project wizard ─────────────────────────────────────────────
  const [wizardOpen, setWizardOpen] = useState(false);
  const closeWizard = useCallback(() => setWizardOpen(false), []);
  // The wizard creates in the open space, so adding to a space opens it first.
  const addProjectTo = useCallback(
    (space: SpaceInfo | null) => {
      if (space && space.id !== activeSpace?.id) switchSpace(space);
      setWizardOpen(true);
    },
    [activeSpace],
  );
  const handleProjectCreated = useCallback(() => {
    void runManualRefresh();
  }, [runManualRefresh]);

  return {
    // inputs passed through
    projects,
    isLoading,
    selectedProjectKey,
    selectedSessionId,
    onNewSession,
    onShowSettings,
    onSetFolder,
    // view state
    now,
    viewMode,
    setViewMode,
    allView,
    activeSpace,
    spaceOf,
    enterSpace,
    allSessions,
    queuedWorkers,
    reportError,
    isPinnedOpen,
    togglePinnedOpen,
    showHidden,
    toggleShowHidden,
    listArrived,
    error,
    dismissError,
    // derived data
    hiddenCount,
    visibleProjects,
    projectGroups,
    projectSections,
    conversationGroups,
    sessionsOf,
    isSessionPinned,
    openSessionIds,
    openNoteIds,
    isExpanded,
    deleting,
    // selection
    selectAndToggleProject,
    selectSession,
    // refresh
    refreshing,
    refreshingRef,
    runManualRefresh,
    // project actions
    toggleProjectStar,
    toggleProjectHidden,
    projectRename,
    startProjectRename,
    setProjectRenameDraft,
    saveProjectRename,
    cancelProjectRename,
    pendingProjectDelete,
    requestProjectDelete,
    confirmProjectDelete,
    cancelProjectDelete,
    // session actions
    toggleSessionPin,
    sessionRename,
    startSessionRename,
    setSessionRenameDraft,
    saveSessionRename,
    cancelSessionRename,
    pendingSessionDelete,
    requestSessionDelete,
    confirmSessionDelete,
    deleteSession,
    cancelSessionDelete,
    // wizard
    wizardOpen,
    addProjectTo,
    closeWizard,
    handleProjectCreated,
  };
}

export type SidebarController = ReturnType<typeof useSidebarController>;
