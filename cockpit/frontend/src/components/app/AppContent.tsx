// Kept: the Sidebar column (spaces, desks, task views) + per-desk pane grids; every
// visited desk stays MOUNTED and only the active one is shown
// (display:none), so a terminal's xterm + WebSocket survive a desk switch;
// lazy mount on first activation; the sidebar → pane handlers
// (project select is pure navigation, session select focuses an existing
// pane / reuses an empty one / opens a new one, new session pre-mints a
// Claude session id, open-in-new-pane). Trimmed: URL↔pane session sync,
// chat WS provider + session protection, palette, service-worker
// navigation, permission recovery, todo linking. Added: the compact
// (phone) layout — sidebar as a drawer, one pane at a time, the page sized to
// the part above the on-screen keyboard.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useProviders } from '@/lib/providers';
import Sidebar from '../sidebar/view/Sidebar';
import BrainDashboard from '../brain/BrainDashboard';
import { TaskBoard } from '../task-board/TaskBoard';
import { taskSessionsKey, useTaskBoard } from '@/lib/task-board';
import { loadTimeZone } from '@/lib/time-zone';
import CommandPalette from '../command-palette/CommandPalette';
import Settings from '../settings/view/Settings';
import { ProjectModals } from '../projects/ProjectModals';
import { useProjectActions } from '../projects/useProjectActions';
import { EngramDrawer } from '../engram-drawer';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/contexts/PaletteOpsContext';
import { FirstRunSignIn } from '@/components/first-run/FirstRun';
import { findProjectOwningSession, projectsOfSpace, spaceLoaded, useProjectsState } from '@/hooks/useProjectsState';
import { usePaneContext } from '@/hooks/usePaneContext';
import * as paneStore from '@/stores/usePaneStore';
import { getTopView, setTopView, useTopView } from '@/stores/useTopViewStore';
import { connectTurnEvents, countNeedsYou, markSeen, useTurnStore, waitingSessions, type SpawnRequest } from '@/stores/useTurnStateStore';
import { setSessionDeskMain } from '@/lib/session-actions';
import { useSeenResults } from './useSeenResults';
import { usePushLinks } from './usePushLinks';
import { api } from '@/utils/api';
import { useCloseFallbacksWhenOff } from '@/lib/terminal-fallback';
import { tellOnDesk } from '@/components/command-palette/openTask';
import { spawnProblem } from '@/lib/spawn-problem';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useNotesLiveSync } from '@/lib/notes';
import { useTimeBeat } from '@/components/time-plugin/useTimeBeat';
import type { Project, ProjectSession } from '@/types/app';

import { PaneGridLayout } from './PaneGrid';
import { ShortcutSheet } from '../top-bar/ShortcutSheet';
import { useCockpitShortcuts } from '../top-bar/useCockpitShortcuts';
import { setLauncherProjects } from '../session-launcher/launcher-projects';
import CompactNavBar from './CompactNavBar';
import { SPACE_CHANGED_EVENT } from '@/stores/useSpaceStore';
import { useQueryClient } from '@tanstack/react-query';
import UpdateBanner from './UpdateBanner';
import AgentUpgradeBanner from './AgentUpgradeBanner';
import BrainHygieneBanner from './BrainHygieneBanner';
import LinkFoldersBanner from './LinkFoldersBanner';
import TeamBanner from './TeamBanner';
import { useCompactLayout } from '@/hooks/useCompactLayout';
import { cn } from '@/lib/utils';
import { useDrawerSwipe } from '@/hooks/useDrawerSwipe';
import { useSoftKeyboardOpen } from '@/hooks/useSoftKeyboardOpen';
import { APP_HEIGHT_VAR, useVisibleViewportHeight } from '@/hooks/useVisibleViewportHeight';
import { TasksCard } from '@/components/tasks-card/TasksCard';
import { useTasksCard } from '@/stores/useTasksCardStore';
import { OpenTaskToast } from '@/components/command-palette/OpenTaskToast';
import { FileSlideOver } from '@/components/media/FileSlideOver';

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const compact = useCompactLayout();
  useVisibleViewportHeight();
  // The compact layout's sidebar drawer; closed again whenever the layout widens.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { if (!compact) setDrawerOpen(false); }, [compact]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  useDrawerSwipe(compact, drawerOpen, openDrawer, closeDrawer);
  const keyboardOpen = useSoftKeyboardOpen();
  const {
    projects,
    projectsBySpace,
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
  // The empty panes' launcher offers the open space's projects.
  useEffect(() => { setLauncherProjects(projects); }, [projects]);
  // ⌘. Inbox, ⌘, Settings, G then I / N / P, ? (top-bar/shortcuts.ts lists them all).
  const openSettingsDefault = useCallback(() => openSettings(), [openSettings]);
  useCockpitShortcuts(openSettingsDefault);

  // Every time reads and shows in the user's time zone (Settings): read it from the host. A browser fills it in
  // only while none is saved; it never replaces a saved one (lib/time-zone.ts).
  useEffect(() => { void loadTimeZone(); }, []);

  // Header-level view: the fixed Brain tab vs the desk/pane grid.
  const topView = useTopView();

  // ── Turn state (finished / working / waiting) ─────────────────────────
  // Streams from the host (Claude Code hooks → /api/events). A finished
  // session counts as unseen until the user is looking at its desk with
  // the window in front; that drives the tab badges and the title count.
  // Notifications are web push from the host (lib/push.ts).
  const turnSnapshot = useTurnStore();
  const projectsRef = React.useRef(projects);
  projectsRef.current = projects;
  const projectsBySpaceRef = React.useRef(projectsBySpace);
  projectsBySpaceRef.current = projectsBySpace;
  const refreshProjectsRef = React.useRef(refreshProjectsSilently);
  refreshProjectsRef.current = refreshProjectsSilently;
  // A session with a task is called by its task and waits for you only while its task does: a task renamed, closed or
  // answered anywhere changes its sessions in the list too.
  const { data: taskBoard } = useTaskBoard();
  const taskSessions = taskBoard ? taskSessionsKey(taskBoard) : null;
  const seenTaskSessionsRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (taskSessions === null) return;
    // The first board too: the list may have been read before the host had a board.
    if (seenTaskSessionsRef.current !== taskSessions) void refreshProjectsRef.current();
    seenTaskSessionsRef.current = taskSessions;
  }, [taskSessions]);
  const { data: providers } = useProviders();
  paneStore.setProviders(providers);
  paneStore.setDefaultProvider((providers?.find((provider) => provider.isDefault) ?? providers?.[0])?.id ?? null);
  // A pane in the terminal fallback goes back to the chat when the switch (Settings › Advanced) is off.
  useCloseFallbacksWhenOff();
  // One test for "empty pane" everywhere: a session pane whose projectId and
  // pre-minted session both resolve to no project (Choose Your Project), or a
  // note pane with neither a note nor a project (Pick a project…). Against the
  // projects of the pane's own space.
  paneStore.setEmptyPaneTest((pane) => {
    // A file pane is never empty while it names its file; it needs no project.
    if (pane.paneView === 'file') return !pane.filePath;
    const desk = paneStore.getDeskOfPane(pane.id);
    // Projects not loaded yet (a space first opened from the All view): nothing
    // can be told about the pane, so only one without a project counts as empty,
    // or a click would replace a running session.
    if (desk && !spaceLoaded(projectsBySpaceRef.current, desk.spaceId)) return !pane.projectId;
    const spaceProjects = desk
      ? projectsOfSpace(projectsBySpaceRef.current, desk.spaceId)
      : projectsRef.current;
    const known = spaceProjects.some((project) => project.projectId === pane.projectId);
    if (pane.paneView === 'note') return !pane.noteId && !known;
    return pane.paneView === 'chat' && !known &&
      !findProjectOwningSession(spaceProjects, pane.sessionId ?? '');
  });

  useEffect(() => {
    // Worker sessions requested by a session (skill spawn-session) or by the
    // host (first run: sign-in, getting started): claim each one — only one tab
    // gets it — and open its pane on the requester's desk. A project the page
    // doesn't know yet (just made by the host) is loaded first: a pane with an
    // unknown project counts as empty and would drop its first message. Only
    // for the open space — the projects list holds just its projects, so a
    // worker of another space would wait out the whole loop (minutes in a
    // background tab, where the browser throttles the timers).
    const knownProject = (projectId: string) => projectsRef.current.some((project) => project.projectId === projectId);
    const openWorker = async (request: SpawnRequest) => {
      // Decided before loading the project — that can auto-select it into the empty pane.
      const replacePaneId = request.placement === 'replace-empty-desk' ? paneStore.findEmptyDeskPane() : null;
      const inOpenSpace = (request.spaceId ?? null) === paneStore.getActiveSpaceId();
      if (inOpenSpace && !knownProject(request.projectId)) {
        await refreshProjectsRef.current();
        for (let i = 0; i < 40 && !knownProject(request.projectId); i++) await new Promise((r) => setTimeout(r, 50));
      }
      // The request names a further space by brain id; absent = main, which the pane store calls null.
      // Its id is the worker's session id — the requester already got the worker's address from it.
      // The host started it in the chat with its prompt: the pane only joins.
      const { prompt: _prompt, ...worker } = request;
      paneStore.addWorkerPane({ ...worker, sessionId: request.id, spaceId: request.spaceId ?? null, replacePaneId });
    };
    const onSpawns = (requests: SpawnRequest[]) => {
      for (const request of requests) {
        // A session's worker, a job's run and a background task run stay on the host and show in the sidebar, unless they asked for a pane.
        if ((request.fromSessionId || request.origin === 'job' || request.origin === 'runner') && !request.open) continue;
        // The host starts the worker in the chat, or says why it could not: no terminal to fall back to.
        void api.claimSpawn(request.id).then(async (response) => {
          if (response.ok) return openWorker(request);
          const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
          const why = spawnProblem(body?.error);
          if (why) tellOnDesk(why);
        }).catch(() => { /* host gone — the request is dropped with it */ });
      }
    };
    return connectTurnEvents(onSpawns);
  }, []);
  // Note changes on the same stream → note queries + the sidebar's unseen dot.
  useNotesLiveSync();
  // The Time plugin's clock: beats while someone works here (time-plugin/useTimeBeat.ts).
  useTimeBeat();

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

  // Which sessions are main goes to the host, like a pin, so every device lists them.
  // Only what changes here: a device whose desks have no main pane clears nobody's.
  const sentMainSessions = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = paneStore.deskMainSessions(desks);
    for (const id of current) if (!sentMainSessions.current.has(id)) void setSessionDeskMain(id, true);
    for (const id of sentMainSessions.current) if (!current.has(id)) void setSessionDeskMain(id, false);
    sentMainSessions.current = current;
  }, [desks]);

  useSeenResults();
  usePushLinks();

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
    () => countNeedsYou(turnSnapshot, [...new Set([...desks.flatMap((desk) => desk.panes.map((pane) => pane.sessionId)), ...waitingSessions(turnSnapshot)])]),
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
  // Workers start in the chat on the host, so a desk with a new worker pane waits to be opened like any other.
  useEffect(() => {
    setMountedDeskIds(prev => (prev.has(activeDeskId) ? prev : new Set([...prev, activeDeskId])));
  }, [activeDeskId]);

  // ── Sidebar handlers (drive the active pane) ────────────────────────

  // The project a sidebar session belongs to. Callers tag it (__projectId);
  // when that is missing, derive it from the projects list so a pane never
  // stores projectId null for a session that plainly has a project
  // (root of the "+ → Choose Your Project" bug).
  const projectIdForSession = useCallback((session: ProjectSession): string | null => {
    return session.__projectId || (findProjectOwningSession(projectsRef.current, session.id)?.projectId ?? null);
  }, []);

  // Every open goes through paneStore.openInPane (decision
  // cockpit-pane-model): a session/note already in a pane is focused there —
  // on its desk, in its view, leaving the Brain tab — never duplicated; else
  // an empty active pane takes it; else it opens next to the active pane.
  const handleSessionSelect = useCallback((session: ProjectSession) => {
    const target = { surface: 'session' as const, projectId: projectIdForSession(session), sessionId: session.id };
    if (session.__spaceKey !== undefined) paneStore.openSessionInSpace(session.__spaceKey, target);
    else paneStore.openInPane(target);
  }, [projectIdForSession]);

  // Project management (Plan) and its dialogs: here, so the launcher's "New project…" opens the
  // wizard from any view.
  const projectActions = useProjectActions({ onChanged: handleSidebarRefresh, onRemoved: handleProjectDelete });

  // A new session never overwrites what the active pane shows.
  const handleNewSession = useCallback((project: Project) => {
    paneStore.openInPane({ surface: 'session', projectId: project.projectId });
  }, []);

  // The tasks card: next to the sidebar or right of the desk, never on a phone. It belongs to a desk: the
  // pages across spaces (Inbox, Now, Plan, Brain) go without it.
  const tasksCard = useTasksCard();
  const tasksCardPlace = !compact && tasksCard.shown && topView === 'desks' ? tasksCard.place : null;

  // ── Sidebar derives its selection from the active pane.
  const activePaneCtx = usePaneContext(activePaneId, projects);
  useDocumentTitle(activePaneCtx.project?.displayName, unseenTotal);


  return (
    <div
      data-app-root
      className="fixed inset-x-0 top-0 flex flex-col bg-background"
      style={{ height: `var(${APP_HEIGHT_VAR}, 100dvh)` }}
    >

      <div className="relative flex min-h-0 flex-1">
      {/* Card styling (frosted/rounded/overflow) lives inside Sidebar: it
          renders the icon rail plus a hover overlay that must extend past
          this wrapper — overflow-hidden here would clip it. The chrome layer
          lifts the overlay above the pane grid; the row stretches it to its
          height less the margins. */}
      <div className={compact ? 'contents' : 'relative z-(--z-chrome) my-(--gap-shell) ml-(--gap-shell) flex-shrink-0 self-stretch'}>
        <Sidebar
          drawer={compact ? { open: drawerOpen, onClose: closeDrawer } : undefined}
          onShowSettings={(tab) => { setDrawerOpen(false); openSettings(tab); }}
        />
      </div>
      {tasksCardPlace === 'left' && (
        <div className="relative my-(--gap-shell) ml-(--gap-shell) flex-shrink-0 self-stretch">
          <TasksCard projects={projectsBySpace} />
        </div>
      )}

      {/* The home indicator's inset is only needed at the screen's bottom edge. With the keyboard
          up the app already ends above it, but iOS keeps reporting the inset. */}
      <div
        className={cn('relative flex min-w-0 flex-1 flex-col', !compact && !keyboardOpen && 'pb-[env(safe-area-inset-bottom)]')}
        style={compact ? ({ '--bottom-inset': keyboardOpen ? '0px' : 'env(safe-area-inset-bottom)' } as React.CSSProperties) : undefined}
      >
        {/* Over the panes, in this order: update (available → installing → outcome), a space without
            an agent (the agent upgrade), a shared brain that is not live, brain hygiene, folders not in a brain project. */}
        {/* On a phone the top banner sits between the floating menu and close buttons. */}
        <div className={cn('peer', compact && 'pt-[env(safe-area-inset-top)] empty:hidden [&>:first-child]:mx-[calc(var(--inset-phone-nav)+--spacing(1))]')}>
          <UpdateBanner />
          <AgentUpgradeBanner />
          <TeamBanner />
          <BrainHygieneBanner />
          <LinkFoldersBanner projects={projects} onChanged={handleSidebarRefresh} onRemoved={handleProjectDelete} />
        </div>
        {compact && <CompactNavBar onOpenMenu={openDrawer} />}
        <div className="relative min-h-0 min-w-0 flex-1">
          {/* The brain dashboard overlays the grid box when the Brain tab is
              active; the desks below stay mounted (hidden) so terminals
              keep running. */}
          {topView === 'brain' && (
            <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col">
              <BrainDashboard />
            </div>
          )}
          {/* With no banner above, the task views start below the phone's floating buttons, as a pane does. */}
          {topView === 'tasks' && (
            <div className={cn('absolute inset-0 flex min-h-0 min-w-0 flex-col bg-background', compact && '[.peer:empty~*_&]:pt-[calc(env(safe-area-inset-top)+var(--pad-pane-compact-top))]')}>
              <TaskBoard projects={projectsBySpace} projectActions={projectActions} />
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
                    deskId={desk.id}
                    mainPaneId={desk.mainPaneId}
                    mainWidth={desk.mainWidth}
                    deskActive={isDeskActive}
                    compact={compact}
                    projects={projectsOfSpace(projectsBySpace, desk.spaceId)}
                    onSessionStarted={refreshProjectsSilently}
                    onStartNewChat={handleNewSession}
                  />
                </div>
              );
            })}
        </div>
      </div>
      {tasksCardPlace === 'right' && (
        <div className="relative my-(--gap-shell) mr-(--gap-shell) flex-shrink-0 self-stretch">
          <TasksCard projects={projectsBySpace} />
        </div>
      )}
      {/* Inside the row, not on the viewport: the drawer starts and ends
          where the sidebar does, under the header and any banner. */}
      <EngramDrawer projects={projects} />
      </div>

      <ProjectModals actions={projectActions} />

      <Settings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        initialTab={settingsInitialTab}
      />

      <FirstRunSignIn />
      <ShortcutSheet />

      <OpenTaskToast />
      <FileSlideOver />
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

