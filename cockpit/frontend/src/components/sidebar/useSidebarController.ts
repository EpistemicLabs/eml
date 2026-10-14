import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { subscribeSettings } from '@/components/settings/utils/settingsStorage';
import { useDesks } from '@/stores/usePaneStore';
import { api } from '@/utils/api';
import type { Project, ProjectSession } from '@/types/app';
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
    projects,
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
  const refreshList = useCallback(async () => {
    await propsRef.current.onRefresh();
  }, []);

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
    for (const project of projects) map.set(project.projectId, deriveProjectSessions(project));
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
    const starredById = new Map(projects.map((project) => [project.projectId, Boolean(project.isStarred)]));
    setStarOverrides((current) =>
      withoutKeys(current, (id, value) => !starredById.has(id) || starredById.get(id) === value),
    );
    setPinOverrides((current) =>
      withoutKeys(current, (id, value) => !hostPinState.has(id) || hostPinState.get(id) === value),
    );
  }, [projects, hostPinState]);

  const isProjectStarred = useCallback(
    (project: Project) => starOverrides[project.projectId] ?? Boolean(project.isStarred),
    [starOverrides],
  );
  const isSessionPinned = useCallback(
    (session: ProjectSession) => pinOverrides[session.id] ?? hostPinState.get(session.id) ?? Boolean(session.isPinned),
    [pinOverrides, hostPinState],
  );

  const sessionsOf = useCallback(
    (project: Project) => sessionsByProject.get(project.projectId) ?? deriveProjectSessions(project),
    [sessionsByProject],
  );

  // ── Derived lists ──────────────────────────────────────────────────
  const hiddenCount = useMemo(() => projects.filter((project) => !isProjectVisible(project)).length, [projects]);

  const visibleProjects = useMemo(() => {
    const resolved = projects.map((project) =>
      project.projectId in starOverrides ? { ...project, isStarred: starOverrides[project.projectId] } : project,
    );
    const filtered = showHidden ? resolved : resolved.filter(isProjectVisible);
    return sortProjects(filtered, sortOrder, (project) => projectLastActivity(sessionsOf(project)));
  }, [projects, starOverrides, showHidden, sortOrder, sessionsOf]);

  const projectGroups = useMemo(() => groupProjects(visibleProjects), [visibleProjects]);

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
  const selectedProjectId = selectedProject?.projectId ?? null;
  const selectedSessionId = selectedSession?.id ?? null;

  useEffect(() => {
    if (!selectedProjectId) return;
    setExpanded((current) => (current.has(selectedProjectId) ? current : new Set(current).add(selectedProjectId)));
  }, [selectedProjectId]);

  const selectAndToggleProject = useCallback(
    (project: Project) => {
      if (expanded.has(project.projectId)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(project.projectId);
          return next;
        });
        return;
      }
      if (project.projectId !== selectedProjectId) onProjectSelect(project);
      setExpanded((current) => new Set(current).add(project.projectId));
    },
    [expanded, selectedProjectId, onProjectSelect],
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
      await propsRef.current.onRefresh();
    } catch (refreshError) {
      console.error('[Sidebar] Refresh failed:', refreshError);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, []);

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
      const id = project.projectId;
      const previous = isProjectStarred(project);
      const next = !previous;
      const sequence = (starSequence.current.get(id) ?? 0) + 1;
      starSequence.current.set(id, sequence);
      const isLatest = () => starSequence.current.get(id) === sequence;
      setStarOverrides((current) => ({ ...current, [id]: next }));
      try {
        const response = await api.setProjectStar(id, next);
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
    async (projectId: string) => {
      const project = propsRef.current.projects.find((candidate) => candidate.projectId === projectId);
      if (!project) return;
      try {
        const response = await api.setProjectHidden(projectId, !project.hidden);
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
  const [projectRename, setProjectRename] = useState<RenameState | null>(null);
  const startProjectRename = useCallback(
    (project: Project) => setProjectRename({ id: project.projectId, draft: project.displayName }),
    [],
  );
  const setProjectRenameDraft = useCallback(
    (draft: string) => setProjectRename((current) => (current ? { ...current, draft } : current)),
    [],
  );
  const cancelProjectRename = useCallback(() => setProjectRename(null), []);
  const saveProjectRename = useCallback(async () => {
    if (!projectRename) return;
    const { id } = projectRename;
    const name = projectRename.draft.trim();
    setProjectRename(null);
    if (!name) return;
    try {
      const response = await api.renameProject(id, name);
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
  const confirmSessionDelete = useCallback(async () => {
    if (!pendingSessionDelete) return;
    const { sessionId } = pendingSessionDelete;
    setPendingSessionDelete(null);
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
  }, [pendingSessionDelete, reportError, actionSucceeded, refreshList]);

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
      const { projectId } = pendingProjectDelete.project;
      setPendingProjectDelete(null);
      setDeleting((current) => new Set(current).add(projectId));
      try {
        const response = await api.deleteProject(projectId, deleteData);
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
          next.delete(projectId);
          return next;
        });
      }
    },
    [pendingProjectDelete, reportError, actionSucceeded, refreshList],
  );

  // ── Add-project wizard ─────────────────────────────────────────────
  const [wizardOpen, setWizardOpen] = useState(false);
  const openWizard = useCallback(() => setWizardOpen(true), []);
  const closeWizard = useCallback(() => setWizardOpen(false), []);
  const handleProjectCreated = useCallback(() => {
    void runManualRefresh();
  }, [runManualRefresh]);

  return {
    // inputs passed through
    projects,
    isLoading,
    selectedProjectId,
    selectedSessionId,
    onNewSession,
    onShowSettings,
    onSetFolder,
    // view state
    now,
    viewMode,
    setViewMode,
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
    conversationGroups,
    sessionsOf,
    isSessionPinned,
    openSessionIds,
    openNoteIds,
    expanded,
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
    cancelSessionDelete,
    // wizard
    wizardOpen,
    openWizard,
    closeWizard,
    handleProjectCreated,
  };
}

export type SidebarController = ReturnType<typeof useSidebarController>;
