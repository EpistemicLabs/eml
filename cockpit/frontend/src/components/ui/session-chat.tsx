import { useEffect } from 'react';

import { ChatPane } from '@/components/chat/ChatPane';
import type { AllSession } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import StandaloneShell from '@/components/standalone-shell/view/StandaloneShell';
import { reclaimTerminal } from '@/stores/useReviewStore';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';

/**
 * A session's conversation outside its desk pane: the chat view for a session that runs in the
 * chat, its terminal for one that runs in a terminal. A terminal has one viewer, so it is borrowed
 * from its pane and given back when this unmounts. `paneId` names the surface that shows it (the
 * task board, the review screen), so the chat keeps its scroll and draft per surface.
 */
export function SessionChat({ session, space, paneId }: { session: AllSession; space: SpaceInfo | undefined; paneId: string }) {
  const terminal = session.runtime !== 'sdk';
  useEffect(() => {
    if (!terminal) return;
    return () => reclaimTerminal(session.id);
  }, [session.id, terminal]);
  if (!session.__projectId) return <p className="p-4 text-body text-muted-foreground">This session has no project to open it in.</p>;
  const spaceId = space ? paneSpaceKey(space) : null;
  return (
    <div className="relative min-h-0 flex-1">
      {terminal ? (
        <StandaloneShell paneId={paneId} projectId={session.__projectId} sessionId={session.id} sessionTitle={sessionDisplayName(session)} isActive={false} spaceId={spaceId} />
      ) : (
        <ChatPane paneId={paneId} projectId={session.__projectId} sessionId={session.id} session={session} isActive spaceId={spaceId} />
      )}
    </div>
  );
}
