// The task's mode next to its name in a session's chat header (decision session-kind-follows-task-delegate):
// "With you" or "<agent> works alone". Clicking it offers the one action that switches it: Take over on a task the
// agent works on alone, only in the task's own session (the one Take over takes over), and Delegate on one that is
// with its owner (only with a name and a goal). Delegate lets the agent carry on in the task's own session when it can,
// else it starts a new one; the confirmation says which. Both can be undone for a few seconds.
import { useState } from 'react';

import { agentName, type BoardTask, canDelegate, type CommandAnswer, handOver, modeLabel, takeOver, takeOverDone, taskMode, undo, useTaskBoard } from '@/lib/task-board';
import { durationMs } from '@/lib/time';
import { Menu, type MenuItem } from '@/shared/view/ui';
import { Toast, type ToastMessage } from '@/shared/view/ui/Toast';

const OPEN = new Set(['planned', 'active']);

/** The one action that switches the task's mode from the chip in `sessionId`'s header, or null when none fits there. */
export function modeAction(task: BoardTask, agents: string[], sessionId: string | null): { label: string; run: () => Promise<CommandAnswer>; done: string } | null {
  const own = task.ownSession && task.ownSession.sessionId === sessionId ? task.ownSession : null;
  if (taskMode(task) === 'alone') {
    // Another session on the task (a helper, a job's run, an older one) is not what Take over takes over.
    return own ? { label: 'Take over', run: () => takeOver(task), done: takeOverDone(task.delegate) } : null;
  }
  const agent = task.handTo && agents.includes(task.handTo) ? task.handTo : agents[0];
  if (!agent || !canDelegate(task)) return null;
  const checkpoint = (task.checkpoint as 'before' | 'after' | 'none' | undefined) ?? 'after';
  return {
    label: `Delegate to ${agentName(agent)} (checkpoint ${checkpoint})`,
    run: () => handOver(task, { mode: 'now', delegate: agent, checkpoint }),
    // The host continues the task's own session when it can (host domain/own-session.ts), which may be another one.
    done: own?.continues ? `Delegated: ${agentName(agent)} carries on in this session alone once Undo is over.`
      : task.ownSession?.continues ? `Delegated: ${agentName(agent)} carries on in the task's own session once Undo is over.`
        : `Delegated: ${agentName(agent)} starts in a new session once Undo is over.`,
  };
}

export function ModeChip({ taskId, sessionId }: { taskId: string | null | undefined; sessionId: string | null }) {
  const { data: board, refetch } = useTaskBoard();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const task = taskId ? board?.tasks.find((t) => t.id === taskId) : undefined;
  if (!board || !task || !OPEN.has(task.status)) return null;
  const say = (text: string, action?: ToastMessage['action'], until?: string) => setToast({ id: crypto.randomUUID(), text, action, until, ms: durationMs('--duration-toast') });
  const action = modeAction(task, board.spaces.find((s) => s.id === task.spaceId)?.agents ?? [], sessionId);
  const items: MenuItem[] = action ? [{
    label: action.label,
    onSelect: () => {
      void action.run().then((answer) => {
        void refetch();
        if (!answer.ok) { say(answer.message); return; }
        say(action.done, { label: 'Undo', run: () => { void undo(answer.opId).then((u) => { void refetch(); say(u.ok ? 'Undone. The task is back as it was.' : u.message); }); } }, answer.undoUntil);
      });
    },
  }] : [];
  const label = modeLabel(task);
  return (
    <>
      {items.length > 0 ? (
        <Menu label={`${label}: change`} items={items} align="start" className="size-auto min-h-(--target-min) w-auto whitespace-nowrap rounded-full bg-muted px-2 text-caption font-medium">
          {label}
        </Menu>
      ) : (
        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-muted px-2 text-caption font-medium text-muted-foreground">{label}</span>
      )}
      <Toast message={toast} onDone={(id) => setToast((t) => (t?.id === id ? null : t))} />
    </>
  );
}
