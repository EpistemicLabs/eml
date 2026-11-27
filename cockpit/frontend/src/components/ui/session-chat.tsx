import { type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';

import { ChatPane } from '@/components/chat/ChatPane';
import MainContentTabSwitcher from '@/components/main-content/view/subcomponents/MainContentTabSwitcher';
import SessionStatusBar from '@/components/main-content/view/subcomponents/SessionStatusBar';
import TerminalPane from '@/components/shell/view/TerminalPane';
import { tellOnDesk } from '@/components/command-palette/openTask';
import { cn } from '@/lib/utils';
import { buttonVariants, LABEL } from '@/shared/view/ui';
import type { ProjectSession } from '@/types/app';

/**
 * The toolbar's pane actions; each one shows only where it is passed. The task board passes the
 * close action; a desk pane draws its own toolbar.
 */
export interface SessionChatToolbar {
  onClosePane?: () => void;
}

/**
 * A session's conversation, wherever it is shown: its chat. One component for the desk panes, the
 * task board and the media viewer.
 *
 * - `terminalFallback` (desk panes only, while the pane is in the hidden terminal fallback, Settings ›
 *   Advanced): the same session in the agent's own terminal, under a "Terminal fallback" label with
 *   "Back to chat". The host refuses the terminal while the switch is off; the pane then goes back to
 *   the chat with a notice.
 * - `toolbar` shows the pane actions given; leave it out where the caller draws its own toolbar.
 * - `paneId` names the surface, so scroll and draft are kept per surface.
 * - `composer` replaces the session's input (a closed task's chat in the task panel).
 */
export function SessionChat({
  paneId, projectId, sessionId, session, spaceId, toolbar, terminalFallback = null,
  isActive = true, title = null, composer,
}: {
  paneId: string;
  projectId: string | null;
  sessionId: string | null;
  session: ProjectSession | null;
  /** Outside the desks: the session's space, which a pane takes from its desk. */
  spaceId?: string | null;
  toolbar?: SessionChatToolbar;
  terminalFallback?: { onBack: () => void } | null;
  isActive?: boolean;
  title?: string | null;
  composer?: ReactNode;
}) {
  if (!projectId) return <p className="p-4 text-body text-muted-foreground">This session has no project to open it in.</p>;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {toolbar && (
        <div className="flex shrink-0 justify-end px-2 py-1.5">
          <MainContentTabSwitcher groups={[]} paneView="chat" onSetPaneView={() => {}} {...toolbar} />
        </div>
      )}
      {terminalFallback && sessionId && !composer ? (
        <TerminalFallback
          paneId={paneId}
          projectId={projectId}
          sessionId={sessionId}
          session={session}
          spaceId={spaceId}
          isActive={isActive}
          title={title ?? (session?.summary as string | undefined) ?? null}
          onBack={terminalFallback.onBack}
        />
      ) : sessionId ? (
        // Waits for a turn running in the terminal fallback to end rather than interrupting it.
        <ChatPane paneId={paneId} projectId={projectId} sessionId={sessionId} session={session} whenIdle isActive={isActive} spaceId={spaceId} composer={composer} />
      ) : null}
    </div>
  );
}

/** The session in its agent's own terminal (host PTY), for debugging: labelled, with the way back to the chat. */
function TerminalFallback({ paneId, projectId, sessionId, session, spaceId, isActive, title, onBack }: {
  paneId: string;
  projectId: string;
  sessionId: string;
  session: ProjectSession | null;
  spaceId?: string | null;
  isActive: boolean;
  title: string | null;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="status" className="flex shrink-0 items-center gap-2 px-2 pb-1">
        <span className={LABEL}>Terminal fallback</span>
        <button type="button" onClick={onBack} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'ml-auto gap-1.5')}>
          <MessageSquare aria-hidden className="size-3.5" strokeWidth={1.8} />
          Back to chat
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalPane
          paneId={paneId}
          projectId={projectId}
          sessionId={sessionId}
          sessionTitle={title}
          initialCommand={null}
          isActive={isActive}
          autoConnect
          spaceId={spaceId}
          onFallbackOff={() => {
            onBack();
            tellOnDesk('The terminal fallback is off (Settings › Advanced), so this session is back in its chat.');
          }}
        />
      </div>
      <SessionStatusBar session={session} />
    </div>
  );
}
