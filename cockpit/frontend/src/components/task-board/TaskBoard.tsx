// The Tasks screen on tokens v2 (mockup v4): three views (Inbox · Now · Plan), picked in the top bar.
// A task opens over the view it was clicked in (Inbox: split next to the list). Glass only on the
// control layer; content on solid surfaces; colour only for Needs you and stopped.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { projectIdOfBrain } from '@/lib/project-lead';
import {
  agentName, closeTask, handOver, readable, reviewDone, snooze, snoozeTimes, undo, useTaskBoard,
  type Board, type BoardTask, type CommandAnswer, type HandOverInput, type HandOverMode,
} from '@/lib/task-board';
import { durationMs } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Sheet } from '@/shared/view/ui/Sheet';
import { Toast, type ToastMessage } from '@/shared/view/ui/Toast';
import { addWorkerPane, ensureDeskBySlug, getActiveSpaceId, removePane, useDesks } from '@/stores/usePaneStore';
import { paneSpaceKey, switchSpace, useSpaces } from '@/stores/useSpaceStore';
import { setTaskView, useTaskView, type TaskView } from '@/stores/useTaskViewStore';
import { useCompactLayout } from '@/hooks/useCompactLayout';
import { BUTTON, FOCUS, LABEL, PRIMARY } from '@/shared/view/ui';

import { InboxView, type InboxAction } from './InboxView';
import { HandOverDialog } from './HandOverDialog';
import { NowBoard } from './NowBoard';
import { PlanView } from './PlanView';
import { focusReply, TaskPanel, TASK_TITLE_ID } from './TaskPanel';

type View = TaskView;
const VIEWS: Array<[View, string]> = [['inbox', 'Inbox'], ['now', 'Now'], ['plan', 'Plan']];
/** Relative times ("asked 10:27", "in 3 days") are worked out again this often. */
const NOW_TICK_MS = 30_000;

export function TaskBoard() {
  const { data: board, error, refetch } = useTaskBoard();
  const { sessions } = useAllSessions(true);
  const spaces = useSpaces();
  const desks = useDesks();
  // The view is picked in the top bar (TaskViewSwitch, G then I / N / P); on a phone in the board's own tabs.
  const { view, picks } = useTaskView();
  const compact = useCompactLayout();
  const [open, setOpen] = useState<{ taskId: string; sessionId?: string } | null>(null);
  const [dialog, setDialog] = useState<{ taskId: string; mode: HandOverMode } | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS); return () => window.clearInterval(t); }, []);
  useEffect(() => { if (board) setNow(Date.now()); }, [board]);

  // Every pick of a view, the same one again too, closes an open task.
  const seenPicks = useRef(picks);
  useEffect(() => { if (picks !== seenPicks.current) { seenPicks.current = picks; setOpen(null); } }, [picks]);

  const byId = useMemo(() => new Map((board?.tasks ?? []).map((t) => [t.id, t])), [board]);
  const task = open ? byId.get(open.taskId) : undefined;
  const say = useCallback((text: string, action?: ToastMessage['action'], until?: string) => setToast({ id: crypto.randomUUID(), text, action, until, ms: durationMs('--duration-toast') }), []);

  const openTask = useCallback((t: BoardTask, sessionId?: string) => {
    // The task's journal and chat load from its own space.
    const space = spaces.find((s) => s.id === t.spaceId);
    if (space && paneSpaceKey(space) !== getActiveSpaceId()) switchSpace(space);
    setOpen({ taskId: t.id, ...(sessionId ? { sessionId } : {}) });
  }, [spaces]);

  /** Show a command's answer: an Undo toast until its deadline, or why it was refused. */
  const answered = useCallback((answer: CommandAnswer, done: string, afterUndo?: () => void) => {
    void refetch();
    if (!answer.ok) { say(answer.message); return; }
    const carried = answer.carriedQuestion ? ' The open question went with it.' : '';
    say(`${done}${carried}`, {
      label: 'Undo',
      run: () => {
        void undo(answer.opId).then((u) => {
          void refetch();
          if (!u.ok) { say(u.message); return; }
          afterUndo?.();
          say('Undone. The task is back as it was.');
        });
      },
    }, answer.undoUntil);
  }, [refetch, say]);

  const submitHandOver = useCallback(async (t: BoardTask, input: HandOverInput, desk: { id: string } | { name: string } | null) => {
    setDialog(null);
    const answer = await handOver(t, input);
    const name = agentName(input.delegate);
    if (!answer.ok || input.mode !== 'together') {
      answered(answer, input.mode === 'now' ? `Delegated to ${name} with checkpoint ${input.checkpoint}. You stay the owner.` : `Scheduled: ${name} starts then. The card is in Agent scheduled.`);
      return;
    }
    // Work on it now: the session opens in the chosen desk, with the brief the host answered with.
    const deskId = desk && 'id' in desk ? desk.id : ensureDeskBySlug(`task-${t.title}`, { name: desk?.name ?? readable(t.title) });
    const space = spaces.find((s) => s.id === t.spaceId);
    const paneId = t.project ? addWorkerPane({
      fromSessionId: null, projectId: projectIdOfBrain(t.project), title: readable(t.title), deskId, taskId: t.id,
      prompt: [answer.brief, `Work on task ${t.id} ("${readable(t.title)}") together with the user, who owns it. Start by saying where it stands and what you would do next.`].filter(Boolean).join('\n\n'),
      ...(space ? { spaceId: paneSpaceKey(space) } : {}),
    }) : null;
    answered(answer, `Opened in desk ${input.desk}.`, () => { if (paneId) removePane(paneId); });
  }, [answered, spaces]);

  const onInboxAction = useCallback(async (a: InboxAction) => {
    if (a.kind === 'review') {
      const t = a.item.taskId ? byId.get(a.item.taskId) : undefined;
      if (t) answered(await reviewDone(t), 'Closed as reviewed.');
    } else {
      const times = snoozeTimes(Date.now());
      answered(await snooze(a.item, a.until === 'tomorrow' ? times.tomorrow : times.monday), `Snoozed to ${a.until === 'tomorrow' ? 'tomorrow 09:00' : 'Monday 09:00'}.`);
    }
  }, [answered, byId]);

  if (!board) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background p-6 text-body text-muted-foreground">
        {error ? <span>{(error as Error).message} <button type="button" className={BUTTON} onClick={() => void refetch()}>Try again</button></span> : 'Loading the tasks…'}
      </div>
    );
  }

  const split = view === 'inbox' && task;
  const panel = task && (
    <TaskPanel
      key={task.id}
      task={task}
      board={board}
      now={now}
      sessions={sessions ?? []}
      spaces={spaces}
      sessionId={open?.sessionId}
      onOpenTask={(t) => openTask(t)}
      onHandOver={(t, mode) => setDialog({ taskId: t.id, mode })}
      onReview={async (t) => answered(await reviewDone(t), 'Closed as reviewed.')}
      onClose={() => setOpen(null)}
    />
  );
  const dialogTask = dialog ? byId.get(dialog.taskId) : undefined;
  const spaceAgents = (t: BoardTask) => {
    const agents = board.spaces.find((s) => s.id === t.spaceId)?.agents ?? [];
    return t.delegate && agents.includes(t.delegate) ? [t.delegate, ...agents.filter((a) => a !== t.delegate)] : agents;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      {/* An open task in the Inbox fills the height, with the same gap below as above; the list beside it scrolls on its own. */}
      <div className={cn('mx-auto flex w-full max-w-content flex-col gap-4 px-4 pt-3', split ? 'min-h-0 flex-1 pb-3' : 'pb-10')}>
        {compact && <ControlBar board={board} view={open && !split ? null : view} onView={setTaskView} />}
        {split ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 gap-4 lg:grid-cols-(--grid-inbox-split)">
            <div className="hidden min-h-0 min-w-0 overflow-y-auto lg:block">
              <InboxView board={board} now={now} compact currentTaskId={task.id} onOpen={(item) => { const t = item.taskId ? byId.get(item.taskId) : undefined; if (t) openTask(t, item.sessionId); }} onAction={onInboxAction} />
            </div>
            <section aria-labelledby={TASK_TITLE_ID} className="flex min-h-(--size-split-panel-min) min-w-0 flex-col gap-2.5">
              {panel}
            </section>
          </div>
        ) : view === 'inbox' ? (
          <InboxView board={board} now={now} compact={false} currentTaskId={null} onOpen={(item) => { const t = item.taskId ? byId.get(item.taskId) : undefined; if (t) openTask(t, item.sessionId); }} onAction={onInboxAction} />
        ) : view === 'now' ? (
          <NowBoard board={board} now={now} onOpen={(t) => openTask(t)} movedId={board.events[0]?.taskId ?? null} />
        ) : (
          <PlanView board={board} now={now} onOpen={(t) => openTask(t)} onCloseTask={async (t) => answered(await closeTask(t), 'Closed: not needed.')} />
        )}
      </div>

      <Sheet open={Boolean(task && !split)} onClose={() => setOpen(null)} labelledBy={TASK_TITLE_ID}>{!split && panel}</Sheet>

      {dialog && dialogTask && (
        <HandOverDialog
          task={dialogTask}
          mode={dialog.mode}
          agents={spaceAgents(dialogTask)}
          desks={desks.filter((d) => d.spaceId === (spaces.find((s) => s.id === dialogTask.spaceId) ? paneSpaceKey(spaces.find((s) => s.id === dialogTask.spaceId)!) : null)).map((d) => ({ id: d.id, name: d.name }))}
          now={now}
          onClose={() => setDialog(null)}
          onAnswerFirst={() => { setDialog(null); window.requestAnimationFrame(focusReply); }}
          onSubmit={(input, desk) => void submitHandOver(dialogTask, input, desk)}
        />
      )}
      <Toast message={toast} onDone={(id) => setToast((t) => (t?.id === id ? null : t))} />
    </div>
  );
}

/** On a phone the top bar is not there: the board switches its views itself. */
function ControlBar({ board, view, onView }: { board: Board; view: View | null; onView: (v: View) => void }) {
  return (
    <header className="glass sticky top-2 z-(--z-sticky) flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-2xl py-2 pl-4 pr-2.5 max-lg:static">
      <span className="text-title font-bold tracking-title">Tasks</span>
      <div role="tablist" aria-label="Views" className="inline-flex gap-0.5 rounded-xl bg-foreground/8 p-1">
        {VIEWS.map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => onView(v)}
            className={cn('flex min-h-(--target-comfortable) items-center gap-2 rounded-lg px-3 text-heading font-medium text-muted-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-raised', FOCUS)}>
            {label}
            {v === 'inbox' && board.counts.inbox > 0 && <span title={`${board.counts.inbox} questions and results to review`} className="rounded-full bg-muted-foreground/12 px-1.5 text-caption tabular-nums text-foreground">{board.counts.inbox}</span>}
          </button>
        ))}
      </div>
    </header>
  );
}
