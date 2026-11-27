// Kept: the pane layout (title row, floating view-mode toolbar — shown on the
// active pane, on hover of the corner elsewhere — error-bounded body), the
// empty "Choose Your Project" state, the body dispatch on paneView. Adapted: dispatch is chat → SessionChat
// (the session's chat, or its terminal while the pane is in the terminal fallback), brain → BrainPane (decision cockpit-pane-types), note → NotePane (decision
// cockpit-notes-pane), worktrees → WorktreesPane, repository → RepositoryPane (loaded
// on first use: it brings the code editor), shell → ShellPluginPane; a plugin switched off in
// Settings › EML Plugins shows the brain instead. Trimmed: ChatInterface,
// sub-panes (files / source control / editor), todos, TaskMaster, palette
// ops, UI preferences, mobile menu, loading state.
import { useCompactLayout } from '@/hooks/useCompactLayout';
import type { LLMProvider } from '@/types/app';
import React, { Suspense, lazy, useEffect } from 'react';

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
import { addPaneNextTo, closeTerminalFallback, newCliSessionId, openTerminalFallback, usePane, type PaneView } from '@/stores/usePaneStore';
import { queueChatStart } from '@/components/chat/chat-start';
import { cn } from '@/lib/utils';
import { PLUGIN_DEFS, useViewEnabled } from '@/lib/pane-views';
import { useTerminalFallback } from '@/lib/terminal-fallback';

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
  // A pane left on a plugin that was switched off moves to the first plugin
  // still on, or with none on to the chat.
  const viewEnabled = useViewEnabled();
  const paneView = viewEnabled(chosenView)
    ? chosenView
    : PLUGIN_DEFS.find((def) => viewEnabled(def.view))?.view ?? 'chat';
  useEffect(() => {
    if (paneView !== chosenView) onSetPaneView(paneView);
  }, [paneView, chosenView, onSetPaneView]);
  const pane = usePane(paneId);
  const noteId = pane?.noteId;
  // The hidden terminal fallback (Settings › Advanced): offered in the pane's ··· menu while the switch is on.
  const fallbackOn = useTerminalFallback();
  const inFallback = paneView === 'chat' && pane?.terminalFallback === true;
  const fallbackActions = paneView === 'chat' && sessionId && selectedProject && (fallbackOn || inFallback)
    ? inFallback
      ? { label: 'Back to chat', run: () => closeTerminalFallback(paneId) }
      : { label: 'Open in terminal (fallback)', run: () => openTerminalFallback(paneId) }
    : null;
  const switchBlocked = useSwitchBlocked(sessionId);

  // "+" in the toolbar: a new pane to the right of this one. Project: what
  // this pane resolves to (a pane opened from a sidebar session may carry no
  // projectId itself — its project comes from the session's owner), else the
  // store's fallbacks (this pane's id → desk default → a sibling's project).
  // A new chat the agent picker chose (MainContentTabSwitcher): its id minted here, so its model waits for the chat's socket.
  // `terminalFallback`: an agent without a chat, offered only while the fallback is on.
  const handleAddPane = (view: PaneView, provider?: LLMProvider, model?: string | null, terminalFallback?: boolean) => {
    const project = selectedProject ? { projectId: selectedProject.projectId } : {};
    if (view === 'chat' && provider && !terminalFallback) {
      const sessionId = newCliSessionId();
      queueChatStart(sessionId, { provider, prompt: null, model: model ?? null });
      addPaneNextTo(paneId, { paneView: 'chat', sessionId, provider, ...project });
      return;
    }
    addPaneNextTo(paneId, {
      paneView: view,
      ...(provider ? { provider } : {}),
      ...(terminalFallback ? { terminalFallback: true } : {}),
      ...project,
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

  // Plugin panes don't need a project here; session panes do.
  if (paneView === 'chat' && !selectedProject) {
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
                fallback={fallbackActions}
              />
            </div>
          </>
        )}

        <div
          className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', compact ? (paneView === 'chat' && !inFallback ? 'px-0' : 'px-1') : 'px-2', paneView === 'chat' && !inFallback ? 'pb-0' : compact ? '' : 'pb-2')}
          // Only a chat runs under the floating header and to the bottom edge.
          style={compact && (paneView !== 'chat' || inFallback) ? { paddingTop: 'calc(env(safe-area-inset-top) + var(--pad-pane-compact-top))', paddingBottom: 'calc(var(--bottom-inset, 0px) + var(--pad-pane-compact-bottom))' } : undefined}
        >
          <ErrorBoundary showDetails>
            {paneView === 'chat' && selectedProject && sessionId ? (
              <SessionChat
                paneId={paneId}
                projectId={selectedProject.projectId}
                sessionId={sessionId}
                session={selectedSession}
                terminalFallback={inFallback ? { onBack: () => closeTerminalFallback(paneId) } : null}
                isActive={isActive}
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
