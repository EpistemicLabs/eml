// Kept: the pane layout (title row, floating view-mode toolbar — shown on the
// active pane, on hover of the corner elsewhere — error-bounded body), the
// empty "Choose Your Project" state, the pending-shell-command consume once
// the terminal can start, the body dispatch on paneView. Adapted: dispatch is terminal → the ported StandaloneShell,
// brain → BrainPane (decision cockpit-pane-types), note → NotePane (decision
// cockpit-notes-pane), worktrees → WorktreesPane, repository → RepositoryPane (loaded
// on first use: it brings the code editor), shell → ShellPluginPane; a plugin switched off in
// Settings › EML Plugins shows the brain instead. Trimmed: ChatInterface,
// sub-panes (files / source control / editor), todos, TaskMaster, palette
// ops, UI preferences, mobile menu, loading state.
import { heldCommandAfter, shouldOpenInChat } from '@/components/chat/chat-default';
import { readSettings, subscribeSettings } from '@/components/settings/utils/settingsStorage';
import { useCompactLayout } from '@/hooks/useCompactLayout';
import type { LLMProvider } from '@/types/app';
import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import { BrainPane } from '../../brain/BrainPane';
import { NotePane } from '../../notes/NotePane';
import { WorktreesPane } from '../../worktrees/WorktreesPane';
import { SessionChat } from '../../ui/session-chat';
import { ShellPluginPane } from '../../shell-plugin/ShellPluginPane';
import { TimePane } from '../../time-plugin/TimePane';
import { FilePane } from '../../media/FilePane';
import { useSwitchBlocked } from '../../chat/chat-store';
import { LimitsBadge } from '../../chat/LimitsBadge';
import type { MainContentProps } from '../types/types';
import { addPaneNextTo, consumePendingShellCommand, newSessionView, getSessionView, peekPendingShellCommand, usePane, type PaneView } from '@/stores/usePaneStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import { cn } from '@/lib/utils';
import { PLUGIN_DEFS, useViewEnabled } from '@/lib/pane-views';
import { providerCanChat, useProviders } from '@/lib/providers';

import MainContentTitle from './subcomponents/MainContentTitle';
import MainContentTabSwitcher from './subcomponents/MainContentTabSwitcher';
import { ModeChip } from '@/components/task-board/ModeChip';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

// The repository view brings CodeMirror: its own chunk, fetched when a pane first shows it.
const RepositoryPane = lazy(() => import('../../repository/RepositoryPane').then((m) => ({ default: m.RepositoryPane })));

function MainContent({
  isActive = true,
  paneId,
  selectedProject,
  selectedSession,
  sessionId,
  paneView: chosenView,
  onSetPaneView,
  onClosePane,
  isMainPane,
  onToggleMainPane,
  paneLabel,
}: MainContentProps) {
  // The shell command queued by an external spawn for this pane, taken once the
  // terminal can start — a worker of a space that isn't open has no project
  // here yet. Read during render, removed from the (persisted) queue only
  // after mount, so a reload before the space is opened keeps it. Held in a
  // ref until the first turn is done: re-renders and reconnects until then reuse it.
  // A pane left on a plugin that was switched off moves to the first plugin
  // still on, or with none on to the terminal.
  const viewEnabled = useViewEnabled();
  const paneView = viewEnabled(chosenView)
    ? chosenView
    : PLUGIN_DEFS.find((def) => viewEnabled(def.view))?.view ?? 'terminal';
  useEffect(() => {
    if (paneView !== chosenView) onSetPaneView(paneView);
  }, [paneView, chosenView, onSetPaneView]);
  const heldShellCommand = useRef<string | null | undefined>(undefined);
  if (heldShellCommand.current === undefined && (paneView !== 'terminal' || selectedProject)) {
    heldShellCommand.current = peekPendingShellCommand(paneId);
  }
  const turnState = useTurnStore().turns[sessionId ?? '']?.state;
  heldShellCommand.current = heldCommandAfter(heldShellCommand.current, turnState);
  const initialShellCommand = heldShellCommand.current ?? null;
  useEffect(() => {
    if (initialShellCommand !== null) consumePendingShellCommand(paneId);
  }, [paneId, initialShellCommand]);
  const pane = usePane(paneId);
  const noteId = pane?.noteId;
  const chatDefault = useSyncExternalStore(subscribeSettings, () => readSettings().chatDefault);
  const canChat = providerCanChat(useProviders().data, selectedSession?.__provider ?? pane?.provider ?? 'claude');
  // A session's way of running follows it (session-handoff.ts): when it appears here
  // or moves to chat elsewhere. Not on every look: a session the user just moved
  // back to the terminal still reads as chat until the host has moved it.
  const knownRuntime = useRef<{ sessionId: string; runtime: string | null } | null>(null);
  useLayoutEffect(() => {
    if (!selectedSession || !sessionId) return;
    const runtime = (selectedSession.runtime as string | undefined) ?? null;
    const known = knownRuntime.current;
    const changed = known?.sessionId !== sessionId || known.runtime !== runtime;
    knownRuntime.current = { sessionId, runtime };
    if (shouldOpenInChat({
      view: paneView,
      runtime: changed ? runtime : null,
      chatDefault,
      pickedView: getSessionView(sessionId),
      canChat,
      queuedCommand: initialShellCommand !== null,
    })) onSetPaneView('chat');
  }, [selectedSession, sessionId, paneView, chatDefault, canChat, initialShellCommand, onSetPaneView]);
  const switchBlocked = useSwitchBlocked(sessionId);

  // "+" in the toolbar: a new pane to the right of this one. Project: what
  // this pane resolves to (a pane opened from a sidebar session may carry no
  // projectId itself — its project comes from the session's owner), else the
  // store's fallbacks (this pane's id → desk default → a sibling's project).
  const handleAddPane = (view: PaneView, provider?: LLMProvider) => {
    addPaneNextTo(paneId, {
      paneView: view === 'terminal' ? newSessionView(provider) : view,
      ...(provider ? { provider } : {}),
      ...(selectedProject ? { projectId: selectedProject.projectId } : {}),
    });
  };

  // The toolbar is always there on the active pane. On any other pane it
  // appears while the mouse is in the pane's top-right corner (or a control
  // has keyboard focus), so closing or adding a pane does not need a click to
  // activate it first. The wrapper's padding reaches into the corner, so the
  // hover zone is the whole corner, not only the icons. Touch has no hover: a
  // tap there would hit an invisible control, so it stays active-only.
  const compact = useCompactLayout();
  const toolbarReveal = !isActive &&
    'opacity-0 transition-opacity duration-(--duration-fast) hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:hidden';

  // A file pinned from the media viewer: the file alone, the toolbar without view switch.
  if (paneView === 'file') {
    return (
      <FilePane
        filePath={pane?.filePath ?? ''}
        toolbar={!compact && (
          <div className={toolbarReveal || undefined}>
            <MainContentTabSwitcher groups={[]} paneView={paneView} onSetPaneView={onSetPaneView} onClosePane={onClosePane} onAddPane={handleAddPane} isMainPane={isMainPane} onToggleMainPane={onToggleMainPane} />
          </div>
        )}
      />
    );
  }

  // Plugin panes don't need a project here; terminal and chat panes do.
  if ((paneView === 'terminal' || paneView === 'chat') && !selectedProject) {
    return (
      <div className="relative flex h-full flex-col">
        {/* A main pane can't be closed, but must stay able to stop being main. */}
        {(onClosePane || isMainPane) && !compact && (
          <div className={cn('pointer-events-auto absolute top-0 right-0 z-(--z-pane-toolbar) pt-2 pr-2 pb-2 sm:pt-3 sm:pr-3', toolbarReveal)}>
            <MainContentTabSwitcher paneView={paneView} onSetPaneView={onSetPaneView} onClosePane={onClosePane} onAddPane={handleAddPane} isMainPane={isMainPane} onToggleMainPane={onToggleMainPane} />
          </div>
        )}
        <MainContentStateView mode="empty" paneId={paneId} />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Body area: title (top-left), floating toolbar (top-right of THIS
          area), and the pane body. */}
      <div className="relative flex min-h-0 min-w-(--size-pane-min) flex-1 flex-col overflow-hidden">
        {/* pr-64 keeps the title clear of the absolutely positioned tab
            switcher. It must not be overridden by a responsive px-* (a
            former sm:px-4 reset it to 1rem, and long titles ran under the
            icons). */}
        {/* Compact layout: the header's pickers name, switch, add and close
            panes, so the pane gives that height to its content. */}
        {!compact && (
          <>
            <div className="flex flex-shrink-0 items-center gap-2 pt-2 pr-64 pb-1 pl-3 sm:pl-4">
              <MainContentTitle
                paneId={paneId}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                paneLabel={paneLabel}
                badge={paneView === 'chat' && sessionId ? (
                  // The task's mode beside its name (with you / the agent works alone), with the one action that switches it.
                  <span className="flex items-center gap-1"><ModeChip taskId={selectedSession?.taskId as string | null | undefined} sessionId={sessionId} /><LimitsBadge sessionId={sessionId} /></span>
                ) : null}
              />
            </div>

            <div className={cn('pointer-events-auto absolute top-0 right-0 z-(--z-pane-toolbar) pt-2 pr-2 pb-1 sm:pr-3', toolbarReveal)}>
              <MainContentTabSwitcher
                paneView={paneView}
                onSetPaneView={onSetPaneView}
                onClosePane={onClosePane}
                onAddPane={handleAddPane}
                isMainPane={isMainPane}
                onToggleMainPane={onToggleMainPane}
                switchBlocked={switchBlocked}
              />
            </div>
          </>
        )}

        <div
          className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', compact ? (paneView === 'chat' ? 'px-0' : 'px-1') : 'px-2', paneView === 'chat' ? 'pb-0' : compact ? '' : 'pb-2')}
          // Only a chat runs under the floating header and to the bottom edge.
          style={compact && paneView !== 'chat' ? { paddingTop: 'calc(env(safe-area-inset-top) + var(--pad-pane-compact-top))', paddingBottom: 'calc(var(--bottom-inset, 0px) + var(--pad-pane-compact-bottom))' } : undefined}
        >
          <ErrorBoundary showDetails>
            {paneView === 'terminal' || (paneView === 'chat' && selectedProject && sessionId) ? (
              <SessionChat
                paneId={paneId}
                projectId={selectedProject?.projectId ?? null}
                sessionId={sessionId}
                session={selectedSession}
                view={paneView}
                onView={onSetPaneView}
                isActive={isActive}
                whenIdle={chatDefault}
                command={initialShellCommand}
                title={(selectedSession?.summary as string | undefined) || paneLabel || null}
              />
            ) : paneView === 'note' ? (
              <NotePane paneId={paneId} project={selectedProject} noteId={noteId} />
            ) : paneView === 'worktrees' ? (
              <WorktreesPane project={selectedProject} />
            ) : paneView === 'time' ? (
              <TimePane />
            ) : paneView === 'shell' ? (
              <ShellPluginPane paneId={paneId} isActive={isActive} />
            ) : paneView === 'repository' ? (
              <Suspense fallback={null}>
                <RepositoryPane paneId={paneId} project={selectedProject} />
              </Suspense>
            ) : (
              <BrainPane paneId={paneId} project={selectedProject} />
            )}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

export default React.memo(MainContent);
