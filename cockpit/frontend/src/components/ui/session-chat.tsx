import { type ReactNode, useEffect, useState } from 'react';

import { ChatPane } from '@/components/chat/ChatPane';
import { useSwitchBlocked } from '@/components/chat/chat-store';
import MainContentTabSwitcher from '@/components/main-content/view/subcomponents/MainContentTabSwitcher';
import TerminalStatusBar from '@/components/main-content/view/subcomponents/TerminalStatusBar';
import StandaloneShell from '@/components/standalone-shell/view/StandaloneShell';
import { reclaimTerminal } from '@/lib/terminal-reclaim';
import type { PaneView } from '@/stores/usePaneStore';
import type { LLMProvider, ProjectSession } from '@/types/app';

export type SessionView = 'terminal' | 'chat';

/**
 * The toolbar's pane actions; each one shows only where it is passed. A desk pane passes them all,
 * the task board none, so there only the terminal/chat switch shows.
 */
export interface SessionChatToolbar {
  onAddPane?: (view: PaneView, provider?: LLMProvider, model?: string | null) => void;
  onClosePane?: () => void;
  isMainPane?: boolean;
  onToggleMainPane?: () => void;
}

/**
 * A session's conversation, wherever it is shown: the chat view for a session that runs in the chat,
 * its terminal (with the status bar) for one that runs in a terminal. One component for the desk
 * panes and the task board.
 *
 * - `view`/`onView` control which one shows (a desk pane keeps it in the pane); without them the
 *   component starts from how the session runs and keeps the choice itself.
 * - `toolbar` shows the view switch with the pane actions given; leave it out where the caller draws
 *   its own toolbar (a desk pane's, which also switches to the plugins).
 * - `borrowed`: shown outside its pane, so the terminal goes back to the pane on unmount.
 * - `paneId` names the surface, so scroll and draft are kept per surface.
 * - `composer` replaces the session's input (a closed task's chat in the task panel); the chat view
 *   then stays, since the terminal would write to the session straight away.
 */
export function SessionChat({
  paneId, projectId, sessionId, session, spaceId, view: controlled, onView, toolbar, borrowed = false,
  isActive = true, whenIdle = false, command = null, title = null, composer,
}: {
  paneId: string;
  projectId: string | null;
  sessionId: string | null;
  session: ProjectSession | null;
  /** Outside the desks: the session's space, which a pane takes from its desk. */
  spaceId?: string | null;
  view?: SessionView;
  onView?: (view: SessionView) => void;
  toolbar?: SessionChatToolbar;
  borrowed?: boolean;
  isActive?: boolean;
  whenIdle?: boolean;
  /** First prompt for a freshly spawned terminal session. */
  command?: string | null;
  title?: string | null;
  composer?: ReactNode;
}) {
  const [own, setOwn] = useState<SessionView>(session?.runtime === 'sdk' ? 'chat' : 'terminal');
  const view = composer ? 'chat' : controlled ?? own;
  const setView = (next: SessionView) => { if (onView) onView(next); else setOwn(next); };
  const switchBlocked = useSwitchBlocked(sessionId);
  useEffect(() => {
    if (!borrowed || view !== 'terminal' || !sessionId) return;
    return () => reclaimTerminal(sessionId);
  }, [borrowed, view, sessionId]);

  if (!projectId) return <p className="p-4 text-body text-muted-foreground">This session has no project to open it in.</p>;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {toolbar && (
        <div className="flex shrink-0 justify-end px-2 py-1.5">
          <MainContentTabSwitcher
            groups={composer ? [] : ['session']}
            paneView={view}
            onSetPaneView={(next) => { if (next === 'terminal' || next === 'chat') setView(next); }}
            switchBlocked={switchBlocked}
            {...toolbar}
          />
        </div>
      )}
      {view === 'chat' && sessionId ? (
        <ChatPane paneId={paneId} projectId={projectId} sessionId={sessionId} session={session} whenIdle={whenIdle} isActive={isActive} spaceId={spaceId} composer={composer} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <StandaloneShell paneId={paneId} projectId={projectId} sessionId={sessionId} sessionTitle={title ?? (session?.summary as string | undefined) ?? null} command={command} isActive={borrowed ? false : isActive} spaceId={spaceId} />
          </div>
          <TerminalStatusBar session={session} />
        </div>
      )}
    </div>
  );
}
