// Kept: the Sidebar column + DeskTabBar + per-desk pane grids; every
// visited desk stays MOUNTED and only the active one is shown
// (display:none), so a terminal's xterm + WebSocket survive a desk switch;
// lazy mount on first activation; the sidebar → pane handlers
// (project select is pure navigation, session select focuses an existing
// pane / reuses an empty one / opens a new one, new session pre-mints a
// Claude session id, open-in-new-pane). Trimmed: URL↔pane session sync,
// chat WS provider + session protection, palette, service-worker
// navigation, permission recovery, mobile drawer, todo linking.
import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import Sidebar from '../sidebar/view/Sidebar';
import BrainDashboard from '../brain/BrainDashboard';
import CommandPalette from '../command-palette/CommandPalette';
import Settings from '../settings/view/Settings';
import ProjectFolderDialog from '../project-creation-wizard/ProjectFolderDialog';
import { EngramDrawer } from '../engram-drawer';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/contexts/PaletteOpsContext';
import { useFirstRunSignIn } from '@/components/first-run/FirstRun';
import { findProjectOwningSession, useProjectsState } from '@/hooks/useProjectsState';
import { usePaneContext } from '@/hooks/usePaneContext';
import * as paneStore from '@/stores/usePaneStore';
import { getTopView, setTopView, useTopView } from '@/stores/useTopViewStore';
import { connectTurnEvents, countNeedsYou, markSeen, useTurnStore, type SpawnRequest, type TurnEvent } from '@/stores/useTurnStateStore';
import { api } from '@/utils/api';
import { readSettings } from '@/components/settings/utils/settingsStorage';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useNotesLiveSync } from '@/lib/notes';
import type { Project, ProjectSession } from '@/types/app';

import { PaneGridLayout } from './PaneGrid';
import DeskTabBar from './DeskTabBar';
import { SPACE_CHANGED_EVENT } from '@/stores/useSpaceStore';
import { useQueryClient } from '@tanstack/react-query';
import UpdateBanner from './UpdateBanner';
import AppUpdateBanner from './AppUpdateBanner';
import { useAboutInfo } from '@/hooks/useAboutInfo';
import { Brain } from 'lucide-react';

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const { info: about } = useAboutInfo();
  const {
    projects,
    isLoadingProjects,
    showSettings,
    settingsInitialTab,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    handleSessionDelete,
    handleProjectDelete,
    handleSidebarRefresh,
  } = useProjectsState();

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });
  useFirstRunSignIn(openSettings);

  // Header-level view: the fixed Brain tab vs the desk/pane grid.
  const topView = useTopView();

  // ── Turn state (finished / working / waiting) ─────────────────────────
  // Streams from the host (Claude Code hooks → /api/events). A finished
  // session counts as unseen until the user is looking at its desk with
  // the window in front; that drives the tab badges, the title count and
  // the opt-in browser notification.
  const turnSnapshot = useTurnStore();
  const projectsRef = React.useRef(projects);
  projectsRef.current = projects;
  const refreshProjectsRef = React.useRef(refreshProjectsSilently);
  refreshProjectsRef.current = refreshProjectsSilently;
  // One test for "empty pane" everywhere: a terminal pane whose projectId and
  // pre-minted session both resolve to no project (Choose Your Project), or a
  // note pane with neither a note nor a project (Pick a project…).
  paneStore.setEmptyPaneTest((pane) => {
    const known = projectsRef.current.some((project) => project.projectId === pane.projectId);
    if (pane.paneView === 'note') return !pane.noteId && !known;
    return pane.paneView === 'terminal' && !known &&
      !findProjectOwningSession(projectsRef.current, pane.sessionId ?? '');
  });

  useEffect(() => {
    const onTurn = (event: TurnEvent) => {
      if (event.state !== 'done' || !readSettings().notifyOnDone) return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return;
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const session = projectsRef.current
        .flatMap((project) => project.sessions ?? [])
        .find((candidate) => candidate.id === event.sessionId);
      try {
        new Notification('Session finished', { body: session?.summary || 'Claude finished a turn', tag: event.sessionId });
      } catch { /* notifications unavailable */ }
    };
    // Worker sessions requested by a session (skill spawn-session) or by the
    // host (first run: sign-in, getting started): claim each one — only one tab
    // gets it — and open its pane on the requester's desk. A project the page
    // doesn't know yet (just made by the host) is loaded first: a pane with an
    // unknown project counts as empty and would drop its first message.
    const knownProject = (projectId: string) => projectsRef.current.some((project) => project.projectId === projectId);
    const openWorker = async (request: SpawnRequest) => {
      // Decided before loading the project — that can auto-select it into the empty pane.
      const replacePaneId = request.placement === 'replace-empty-desk' ? paneStore.findEmptyDeskPane() : null;
      if (!knownProject(request.projectId)) {
        await refreshProjectsRef.current();
        for (let i = 0; i < 40 && !knownProject(request.projectId); i++) await new Promise((r) => setTimeout(r, 50));
      }
      // The request names a further space by brain id; absent = main, which the pane store calls null.
      paneStore.addWorkerPane({ ...request, spaceId: request.spaceId ?? null, replacePaneId });
    };
    const onSpawns = (requests: SpawnRequest[]) => {
      for (const request of requests) {
        void api.claimSpawn(request.id).then((response) => {
          if (response.ok) return openWorker(request);
        }).catch(() => { /* host gone — the request is dropped with it */ });
      }
    };
    return connectTurnEvents(onTurn, onSpawns);
  }, []);
  // Note changes on the same stream → note queries + the sidebar's unseen dot.
  useNotesLiveSync();

  // A space change — from the desk bar, the sidebar menu or Settings — means
  // another brain: drop what the brain views cached and refetch the projects.
  const activeSpaceId = paneStore.useActiveSpaceId();
  const queryClient = useQueryClient();
  const firstSpaceRender = useRef(true);
  useEffect(() => {
    if (firstSpaceRender.current) { firstSpaceRender.current = false; return; }
    void queryClient.invalidateQueries();
    window.dispatchEvent(new CustomEvent(SPACE_CHANGED_EVENT, { detail: { spaceId: activeSpaceId } }));
  }, [activeSpaceId, queryClient]);

  // ── Pane state (desks) ─────────────────────────────────────────────
  const desks = paneStore.useDesks();
  const activeDeskIdForSeen = paneStore.useActiveDeskId();

  // "Seen" has two triggers. Explicit: the user switches to a desk (or
  // back from the Brain view) — that is looking, regardless of window
  // focus. Passive: a `done` lands in the desk already on screen, which
  // only counts while the tab is visible and the window is in front;
  // focus/visibility returning re-checks.
  useEffect(() => {
    if (topView !== 'desks') return;
    const desk = desks.find((candidate) => candidate.id === activeDeskIdForSeen);
    if (desk) markSeen(desk.panes.map((pane) => pane.sessionId));
  }, [activeDeskIdForSeen, topView]); // eslint-disable-line react-hooks/exhaustive-deps -- explicit switch only

  useEffect(() => {
    const run = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus() || getTopView() !== 'desks') return;
      const desk = desks.find((candidate) => candidate.id === activeDeskIdForSeen);
      if (desk) markSeen(desk.panes.map((pane) => pane.sessionId));
    };
    run();
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', run);
    };
  }, [desks, activeDeskIdForSeen, turnSnapshot]);

  const unseenTotal = useMemo(
    () => countNeedsYou(turnSnapshot, desks.flatMap((desk) => desk.panes.map((pane) => pane.sessionId))),
    [desks, turnSnapshot],
  );
  const activeDeskId = paneStore.useActiveDeskId();
  const activeDesk = useMemo(
    () => desks.find(s => s.id === activeDeskId) ?? desks[0],
    [desks, activeDeskId],
  );
  const activePaneId = activeDesk.activePaneId;

  // Lazy-mount: a desk is added the first time it becomes active (or gets a
  // waiting worker pane) and never removed (until deleted, when it drops out
  // of `desks`), so a desk you never open doesn't start its terminals.
  const [mountedDeskIds, setMountedDeskIds] = React.useState<Set<string>>(
    () => new Set([activeDeskId]),
  );
  // A desk holding a worker pane that still waits for its first message is
  // mounted right away (hidden), so the worker starts without being looked at.
  useEffect(() => {
    setMountedDeskIds(prev => {
      const wanted = desks
        .filter(s => s.id === activeDeskId || s.panes.some(p => paneStore.hasPendingShellCommand(p.id)))
        .map(s => s.id)
        .filter(id => !prev.has(id));
      return wanted.length ? new Set([...prev, ...wanted]) : prev;
    });
  }, [activeDeskId, desks]);

  // ── Sidebar handlers (drive the active pane) ────────────────────────
  const handleProjectSelect = useCallback((_project: Project) => {
    // Clicking a project is PURE sidebar navigation — it expands the project
    // and reveals its sessions (handled inside the sidebar). It must NOT
    // touch the active pane.
    //
    // Re-homing the active pane's projectId here used to silently swap a
    // running terminal: the project path is part of the host's PTY key, so
    // changing the pane's project tore down the live PTY and reconnected to
    // a different one — the "active terminal got swapped" bug.
    //
    // A pane only adopts a project when the user opens an actual session in
    // it (handleSessionSelect) or starts a new one (handleNewSession).
  }, []);

  // The project a sidebar session belongs to. Callers tag it (__projectId);
  // when that is missing, derive it from the projects list so a pane never
  // stores projectId null for a session that plainly has a project
  // (root of the "+ → Choose Your Project" bug).
  const projectIdForSession = useCallback((session: ProjectSession): string | null => {
    return session.__projectId ?? findProjectOwningSession(projectsRef.current, session.id)?.projectId ?? null;
  }, []);

  // Every open goes through paneStore.openInPane (decision
  // cockpit-pane-model): a session/note already in a pane is focused there —
  // on its desk, in its view, leaving the Brain tab — never duplicated; else
  // an empty active pane takes it; else it opens next to the active pane.
  const handleSessionSelect = useCallback((session: ProjectSession) => {
    paneStore.openInPane({ surface: 'terminal', projectId: projectIdForSession(session), sessionId: session.id });
  }, [projectIdForSession]);

  // "Set folder…" from the sidebar. (A project without a folder no longer
  // needs one before its first session — the host makes a cockpit folder.)
  const [folderTarget, setFolderTarget] = React.useState<{ project: Project } | null>(null);

  // A new session never overwrites what the active pane shows.
  const handleNewSession = useCallback((project: Project) => {
    paneStore.openInPane({ surface: 'terminal', projectId: project.projectId });
  }, []);

  // ── Sidebar derives its selection from the active pane.
  const activePaneCtx = usePaneContext(activePaneId, projects);
  useDocumentTitle(activePaneCtx.project?.displayName, unseenTotal);

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* One top row across the full width (cockpit layout): the brand label at the left, the desk tabs beside it.
          The sidebar rail and the pane grid start below it, top-aligned. */}
      <div className="flex h-[54px] flex-shrink-0 items-stretch border-b border-foreground/15 bg-background/60 backdrop-blur-sm">
        {/* Brand: the same coral brain mark as Settings › About, then the wordmark. */}
        <div className="flex flex-shrink-0 items-center gap-2.5 pr-4 pl-3 text-[16px] font-semibold tracking-wide text-primary">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm">
            <Brain className="h-4 w-4 text-primary-foreground" />
          </span>
          EML COCKPIT
          {about && (
            <button
              type="button"
              onClick={() => openSettings('about')}
              title="About EML Cockpit"
              className="font-mono text-[11px] font-normal tracking-normal text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              v{about.version}
            </button>
          )}
          {about?.runMode === 'dev' && (
            <span
              className="rounded border border-warning/50 bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-warning"
              title={`Development cockpit (v${about.version}) — not your production cockpit`}
            >
              DEV
            </span>
          )}
        </div>
        {/* Per brain space: its Brain tab (the dashboard) and its desks (DeskTabBar). */}
        <div className="min-w-0 flex-1">
          <DeskTabBar />
        </div>
      </div>

      {/* Outcome of the last brain-schema update, full width under the header. */}
      <UpdateBanner />
      <AppUpdateBanner />

      <div className="flex min-h-0 flex-1">
      {/* Card styling (frosted/rounded/overflow) lives inside Sidebar: it
          renders the icon rail plus a hover overlay that must extend past
          this wrapper — overflow-hidden here would clip it. z-40 lifts the
          overlay above the pane grid. */}
      <div className="relative z-40 my-2 ml-2 h-[calc(100%-1rem)] flex-shrink-0">
        <Sidebar
          projects={projects}
          selectedProject={activePaneCtx.project}
          selectedSession={activePaneCtx.session}
          onProjectSelect={handleProjectSelect}
          onSessionSelect={handleSessionSelect}
          onNewSession={handleNewSession}
          onSessionDelete={handleSessionDelete}
          onProjectDelete={handleProjectDelete}
          isLoading={isLoadingProjects}
          onRefresh={handleSidebarRefresh}
          onShowSettings={() => openSettings()}
          onSetFolder={(project) => setFolderTarget({ project })}
        />
      </div>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 min-w-0 flex-1">
          {/* The brain dashboard overlays the grid box when the Brain tab is
              active; the desks below stay mounted (hidden) so terminals
              keep running. */}
          {topView === 'brain' && (
            <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col">
              <BrainDashboard />
            </div>
          )}
          {/* All visited desks stay mounted, stacked in the same box; only
              the active one is shown. Hiding (not unmounting) keeps each
              desk's terminals/WebSockets alive across switches. */}
          {desks
            .filter(desk => desk.id === activeDeskId || mountedDeskIds.has(desk.id))
            .map(desk => {
              const isDeskActive = topView === 'desks' && desk.id === activeDeskId;
              return (
                <div
                  key={desk.id}
                  aria-hidden={!isDeskActive}
                  inert={!isDeskActive}
                  className="absolute inset-0 flex min-h-0 min-w-0 flex-col"
                  // Hidden, not display:none: a hidden desk keeps its real
                  // size, so a terminal starting there (a worker) gets its
                  // true geometry instead of waiting to be shown.
                  style={{ visibility: isDeskActive ? 'visible' : 'hidden' }}
                >
                  <PaneGridLayout
                    paneIds={desk.panes.map(p => p.id)}
                    activePaneId={desk.activePaneId}
                    deskActive={isDeskActive}
                    projects={projects}
                    onSessionStarted={refreshProjectsSilently}
                    onStartNewChat={handleNewSession}
                  />
                </div>
              );
            })}
        </div>
      </div>
      </div>
      <EngramDrawer projects={projects} />

      {folderTarget && (
        <ProjectFolderDialog
          project={folderTarget.project}
          onClose={() => setFolderTarget(null)}
          onSaved={() => { void refreshProjectsSilently(); }}
        />
      )}

      <Settings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        initialTab={settingsInitialTab}
      />

      <CommandPalette
        projects={projects}
        selectedProject={activePaneCtx.project}
        onStartNewChat={handleNewSession}
        onOpenSettings={(tab) => openSettings(tab)}
        onShowView={(view) => {
          setTopView('desks');
          const active = paneStore.getActivePane();
          if (active) paneStore.setPaneView(active.id, view);
        }}
        onOpenSession={(sessionId, projectId) => {
          handleSessionSelect({ id: sessionId, __projectId: projectId ?? undefined });
        }}
      />
    </div>
  );
}
