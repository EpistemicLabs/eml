import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';

import { ChatPane } from '@/components/chat/ChatPane';
import { EngramDetail } from '@/components/engram-detail';
import type { AllSession } from '@/components/sidebar/allSessions';
import { compactAge, sessionDisplayName } from '@/components/sidebar/utils';
import StandaloneShell from '@/components/standalone-shell/view/StandaloneShell';
import { useEngramPanel } from '@/lib/engram-panel';
import type { OverviewTask } from '@/lib/tasks-overview';
import { cn } from '@/lib/utils';
import { reclaimTerminal } from '@/stores/useReviewStore';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';

/** The id the Tasks view's session view uses where a pane would give its own. */
export const TASKS_PANE_ID = 'tasks';

/**
 * A task opened in the Tasks view: its panel (the one the Brain tab uses) and,
 * next to it, the chat of a session that works on it, so the user reads the
 * task and answers its session in one place. The sessions are the task's own
 * and its steps', the most recent first; tabs switch between them.
 */
export function TaskWorkspace({ task, stepIds, sessions, spaces, onClose }: {
  task: OverviewTask;
  /** The task's steps: their sessions belong to it too. */
  stepIds: string[];
  sessions: AllSession[];
  spaces: SpaceInfo[];
  onClose: () => void;
}) {
  const { hrefFor } = useEngramPanel();
  const own = useMemo(() => {
    const ids = new Set([task.id, ...stepIds]);
    return sessions
      .filter((s) => s.taskId && ids.has(s.taskId) && !s.archivedAt)
      .sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')));
  }, [task.id, stepIds, sessions]);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => setPick(null), [task.id]);
  const current = own.find((s) => s.id === pick) ?? own[0];

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section aria-label="Task" className="flex w-[30rem] min-w-0 flex-shrink-0 flex-col border-l border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task · {task.spaceName}</span>
          <button type="button" onClick={onClose} aria-label="Close the task" title="Close the task" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <EngramDetail id={task.id} relationHref={hrefFor} />
        </div>
      </section>
      <section aria-label="Session" className="flex min-w-0 flex-1 flex-col border-l border-border">
        {own.length > 1 && (
          <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
            {own.map((s) => (
              <button key={s.id} type="button" onClick={() => setPick(s.id)}
                className={cn('max-w-56 flex-shrink-0 truncate rounded px-2 py-1 text-xs', s.id === current?.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {sessionDisplayName(s)}
                {s.lastActivity && <span className="pl-1.5 text-muted-foreground">{compactAge(String(s.lastActivity), new Date())}</span>}
              </button>
            ))}
          </div>
        )}
        {current ? (
          <SessionView key={current.id} session={current} space={spaces.find((s) => s.id === current.spaceId)} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            No session works on this task yet. Sessions started from now on get their task when they start; ask an agent to work on it.
          </p>
        )}
      </section>
    </div>
  );
}

function SessionView({ session, space }: { session: AllSession; space: SpaceInfo | undefined }) {
  // A terminal session has one viewer: the view borrows it from its pane and gives it back when it moves on.
  const terminal = session.runtime !== 'sdk';
  useEffect(() => {
    if (!terminal) return;
    return () => reclaimTerminal(session.id);
  }, [session.id, terminal]);
  if (!session.__projectId) return <p className="p-4 text-sm text-muted-foreground">This session has no project to open it in.</p>;
  const spaceId = space ? paneSpaceKey(space) : null;
  return (
    <div className="relative min-h-0 flex-1">
      {terminal ? (
        <StandaloneShell paneId={TASKS_PANE_ID} projectId={session.__projectId} sessionId={session.id} sessionTitle={sessionDisplayName(session)} isActive={false} spaceId={spaceId} />
      ) : (
        <ChatPane paneId={TASKS_PANE_ID} projectId={session.__projectId} sessionId={session.id} session={session} isActive spaceId={spaceId} />
      )}
    </div>
  );
}
