// The task's mode next to its name in a session's chat header (decision session-kind-follows-task-delegate):
// "With you" or "<agent> works alone". Clicking it offers the one action that switches it: Take over on a task the
// agent works on alone, Delegate on one that is with its owner (only with a name and a goal). Either acts on this
// session, which is the task's own: Delegate lets the agent carry on in it, Take over makes it the owner's from the end
// of the turn it is in. Both can be undone for a few seconds.
import { useState } from 'react';

import { agentName, type BoardTask, canDelegate, type CommandAnswer, handOver, modeLabel, takeOver, taskMode, undo, useTaskBoard } from '@/lib/task-board';
import { durationMs } from '@/lib/time';
import { Menu, type MenuItem } from '@/shared/view/ui';
import { Toast, type ToastMessage } from '@/shared/view/ui/Toast';

const OPEN = new Set(['planned', 'active']);

/** The one action that switches the task's mode from the chip, or null when none fits. */
export function modeAction(task: BoardTask, agents: string[]): { label: string; run: () => Promise<CommandAnswer>; done: string } | null {
  if (taskMode(task) === 'alone') {
    return { label: 'Take over', run: () => takeOver(task), done: `Taken over: ${agentName(task.delegate)} finishes the turn it is in, then the session is yours.` };
  }
  const agent = task.handTo && agents.includes(task.handTo) ? task.handTo : agents[0];
  if (!agent || !canDelegate(task)) return null;
  const checkpoint = (task.checkpoint as 'before' | 'after' | 'none' | undefined) ?? 'after';
  return {
    label: `Delegate to ${agentName(agent)} (checkpoint ${checkpoint})`,
    run: () => handOver(task, { mode: 'now', delegate: agent, checkpoint }),
    done: `Delegated: ${agentName(agent)} carries on in this session alone once Undo is over.`,
  };
}

export function ModeChip({ taskId }: { taskId: string | null | undefined }) {
  const { data: board, refetch } = useTaskBoard();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const task = taskId ? board?.tasks.find((t) => t.id === taskId) : undefined;
  if (!board || !task || !OPEN.has(task.status)) return null;
  const say = (text: string, action?: ToastMessage['action'], until?: string) => setToast({ id: crypto.randomUUID(), text, action, until, ms: durationMs('--duration-toast') });
  const action = modeAction(task, board.spaces.find((s) => s.id === task.spaceId)?.agents ?? []);
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
