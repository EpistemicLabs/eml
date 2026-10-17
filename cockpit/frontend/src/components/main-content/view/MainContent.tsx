// Kept: the pane layout (title row, floating view-mode toolbar — shown on the
// active pane, on hover of the corner elsewhere — error-bounded body), the
// empty "Choose Your Project" state, the pending-shell-command consume once
// the terminal can start, the body dispatch on paneView. Adapted: dispatch is terminal → the ported StandaloneShell,
// brain → BrainPane (decision cockpit-pane-types), note → NotePane (decision
// cockpit-notes-pane). Trimmed: ChatInterface,
// sub-panes (files / source control / editor), todos, TaskMaster, palette
// ops, UI preferences, mobile menu, loading state.
import type { LLMProvider } from '@/types/app';
import React, { useEffect, useRef } from 'react';

import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import { BrainPane } from '../../brain/BrainPane';
import { NotePane } from '../../notes/NotePane';
import type { MainContentProps } from '../types/types';
import { addPaneNextTo, consumePendingShellCommand, peekPendingShellCommand, usePane, type PaneView } from '@/stores/usePaneStore';
import { cn } from '@/lib/utils';

import MainContentTitle from './subcomponents/MainContentTitle';
import TerminalStatusBar from './subcomponents/TerminalStatusBar';
import MainContentTabSwitcher from './subcomponents/MainContentTabSwitcher';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

function MainContent({
  isActive = true,
  paneId,
  selectedProject,
  selectedSession,
  sessionId,
  paneView,
  onSetPaneView,
  onClosePane,
  paneLabel,
}: MainContentProps) {
  // The shell command queued by an external spawn for this pane, taken once the
  // terminal can start — a worker of a space that isn't open has no project
  // here yet. Read during render, removed from the (persisted) queue only
  // after mount, so a reload before the space is opened keeps it. Held in a
  // ref: later re-renders (e.g. paneView toggles) reuse it.
  const heldShellCommand = useRef<string | null | undefined>(undefined);
  if (heldShellCommand.current === undefined && (paneView !== 'terminal' || selectedProject)) {
    heldShellCommand.current = peekPendingShellCommand(paneId);
  }
  const initialShellCommand = heldShellCommand.current ?? null;
  useEffect(() => {
    if (initialShellCommand !== null) consumePendingShellCommand(paneId);
  }, [paneId, initialShellCommand]);
  const noteId = usePane(paneId)?.noteId;

  // "+" in the toolbar: a new pane to the right of this one. Project: what
  // this pane resolves to (a pane opened from a sidebar session may carry no
  // projectId itself — its project comes from the session's owner), else the
  // store's fallbacks (this pane's id → desk default → a sibling's project).
  const handleAddPane = (view: PaneView, provider?: LLMProvider) => {
    addPaneNextTo(paneId, {
      paneView: view,
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
  const toolbarReveal = !isActive &&
    'opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:hidden';

  // Brain and note panes don't need a project here; terminal panes do.
  if (paneView === 'terminal' && !selectedProject) {
    return (
      <div className="relative flex h-full flex-col">
        {onClosePane && (
          <div className={cn('pointer-events-auto absolute top-0 right-0 z-30 pt-2 pr-2 pb-2 sm:pt-3 sm:pr-3', toolbarReveal)}>
            <MainContentTabSwitcher paneView={paneView} onSetPaneView={onSetPaneView} onClosePane={onClosePane} onAddPane={handleAddPane} />
          </div>
        )}
        <MainContentStateView mode="empty" />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Body area: title (top-left), floating toolbar (top-right of THIS
          area), and the pane body. */}
      <div className="relative flex min-h-0 min-w-[280px] flex-1 flex-col overflow-hidden">
        {/* pr-40 keeps the title clear of the absolutely positioned tab
            switcher. It must not be overridden by a responsive px-* (a
            former sm:px-4 reset it to 1rem, and long titles ran under the
            icons). */}
        <div className="flex flex-shrink-0 items-center gap-2 pt-2 pr-40 pb-1 pl-3 sm:pl-4">
          <MainContentTitle
            paneId={paneId}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            paneLabel={paneLabel}
          />
        </div>

        <div className={cn('pointer-events-auto absolute top-0 right-0 z-30 pt-2 pr-2 pb-1 sm:pr-3', toolbarReveal)}>
          <MainContentTabSwitcher
            paneView={paneView}
            onSetPaneView={onSetPaneView}
            onClosePane={onClosePane}
            onAddPane={handleAddPane}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2">
          <ErrorBoundary showDetails>
            {paneView === 'terminal' ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1">
                  <StandaloneShell
                    paneId={paneId}
                    projectId={selectedProject?.projectId ?? null}
                    sessionId={sessionId}
                    sessionTitle={(selectedSession?.summary as string | undefined) || paneLabel || null}
                    command={initialShellCommand}
                    isActive={isActive}
                  />
                </div>
                <TerminalStatusBar session={selectedSession} />
              </div>
            ) : paneView === 'note' ? (
              <NotePane paneId={paneId} project={selectedProject} noteId={noteId} />
            ) : (
              <BrainPane project={selectedProject} />
            )}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

export default React.memo(MainContent);
