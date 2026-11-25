// The Tasks screen on tokens v2 (mockup v4): three views (Inbox · Now · Plan), picked in the top bar.
// A task opens over the view it was clicked in (Inbox: split next to the list). Glass only on the
// control layer; content on solid surfaces; colour only for Needs you and stopped.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectActions } from '@/components/projects/useProjectActions';
import type { AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import type { ProjectsBySpace } from '@/hooks/useProjectsState';
import { projectIdOfBrain } from '@/lib/project-lead';
import { markSessionRead, restoreSessionRead } from '@/lib/session-actions';
import { agentName, type Board, type BoardTask, type InboxItem, closeTask, closedAsTask, type ContinueHow, continueTask, endSchedule, followUpTask, isScheduled, reopenTask, type CommandAnswer, handOver, type HandOverInput, type HandOverMode, reviewDone, snooze, snoozeTimes, taskName, undo, useTaskBoard } from '@/lib/task-board';
import { durationMs } from '@/lib/time';
import { answerTime, readBefore, unreadAnswers, unreadFoldOpen } from '@/lib/unread-answers';
import { cn } from '@/lib/utils';
import { nextRuns, type WorkingRow, workingNow } from '@/lib/working-now';
import { Sheet } from '@/shared/view/ui/Sheet';
import { Toast, type ToastMessage } from '@/shared/view/ui/Toast';
import { addWorkerPane, ensureDeskBySlug, getActiveSpaceId, removePane, useDesks } from '@/stores/usePaneStore';
import { paneSpaceKey, switchSpace, useSpaces } from '@/stores/useSpaceStore';
import { openItemIn, type OpenItem, setFold, setOpenItem, useTaskBoardPage } from '@/stores/useTaskBoardPageStore';
import { clearTaskPanelRequest, getTaskView, setTaskView, taskPanelRequestTask, useTaskPanelRequest, useTaskView, type TaskView } from '@/stores/useTaskViewStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import { useCompactLayout } from '@/hooks/useCompactLayout';
import { BUTTON, FOCUS, LABEL, PRIMARY } from '@/shared/view/ui';

import { InboxView, type InboxAction, type UnreadProps } from './InboxView';
import { HandOverDialog } from './HandOverDialog';
import { NowBoard } from './NowBoard';
import { PlanView } from './PlanView';
import { SessionPanel } from './SessionPanel';
import { UnreadDot } from './parts';
import { WorkingColumn, WorkingStrip } from './WorkingNow';
import { focusReply, TaskPanel, TASK_TITLE_ID } from './TaskPanel';

type View = TaskView;
const VIEWS: Array<[View, string]> = [['inbox', 'Inbox'], ['now', 'Now'], ['plan', 'Plan']];
/** Relative times ("asked 10:27", "in 3 days") are worked out again this often. */
const NOW_TICK_MS = 30_000;
/** How long after its undo window a follow-up's panel still opens on its own once the board has it. */
const FOLLOW_UP_WAIT_MS = 60_000;
/** How long Mark all read can be undone: as long as the host's commands (8 s). */
const UNREAD_UNDO_MS = 8_000;
/** Open something in the view that is shown now; it stays open when the board is left and shown again. */
const setOpen = (item: OpenItem | null) => setOpenItem(item, getTaskView());
/** A row read here is hidden by its answer: a newer answer of the same session shows again. */
const readKey = (session: AllSession) => `${session.id}@${answerTime(session)}`;

/** `projects` and `projectActions`: Plan's project list and its actions (both live in AppContent, so the launcher's add-project works anywhere). */
export function TaskBoard({ projects, projectActions }: { projects?: ProjectsBySpace; projectActions?: ProjectActions } = {}) {
  const { data: board, error, refetch } = useTaskBoard();
  const { sessions } = useAllSessions(true);
  const spaces = useSpaces();
  const desks = useDesks();
  // The view is picked in the top bar (TaskViewSwitch, G then I / N / P); on a phone in the board's own tabs.
  const { view, picks } = useTaskView();
  const compact = useCompactLayout();
  const page = useTaskBoardPage();
  const open = openItemIn(page, view);
  const [dialog, setDialog] = useState<{ taskId: string; mode: HandOverMode } | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { turns } = useTurnStore();
  // The Unread fold: a toggle by hand holds until a reload (the store); rows read here leave at once, before the list refetches.
  const unreadPicked = page.folds.unread;
  const [readHere, setReadHere] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS); return () => window.clearInterval(t); }, []);
  useEffect(() => { if (board) setNow(Date.now()); }, [board]);

  // Every pick of a view, the same one again too, closes an open task.
  const seenPicks = useRef(picks);
  useEffect(() => { if (picks !== seenPicks.current) { seenPicks.current = picks; setOpen(null); } }, [picks]);

  // A closed task older than the board's lists that someone asked for (the tasks card's Show done): the panel shows it.
  const [requested, setRequested] = useState<BoardTask | null>(null);
  // A closed task opens in the panel too (Reopen lives there); an open one wins while a reopen is in its undo window.
  const byId = useMemo(() => new Map([
    ...(requested ? [[requested.id, requested] as const] : []),
    ...(board?.closed ?? []).map((c) => [c.id, closedAsTask(c)] as const),
    ...(board?.tasks ?? []).map((t) => [t.id, t] as const),
  ]), [board, requested]);
  const task = open?.taskId ? byId.get(open.taskId) : undefined;
  // A session with no task on the board: it opens on its own where a task would.
  const sessionOnly = open && !task ? open.sessionId : undefined;
  const say = useCallback((text: string, action?: ToastMessage['action'], until?: string) => setToast({ id: crypto.randomUUID(), text, action, until, ms: durationMs('--duration-toast') }), []);

  const closePanel = useCallback(() => setOpen(null), []);
  const openTask = useCallback((t: BoardTask, sessionId?: string) => {
    // The task's journal and chat load from its own space.
    const space = spaces.find((s) => s.id === t.spaceId);
    if (space && paneSpaceKey(space) !== getActiveSpaceId()) switchSpace(space);
    setOpen({ taskId: t.id, ...(sessionId ? { sessionId } : {}) });
  }, [spaces]);

  // ⌘K asked for a task's panel (a closed one): open it once the board has it.
  const panelRequest = useTaskPanelRequest();
  useEffect(() => {
    if (!panelRequest || !board) return;
    const extra = taskPanelRequestTask();
    const t = byId.get(panelRequest) ?? extra ?? undefined;
    clearTaskPanelRequest();
    if (t && t === extra) setRequested(extra);
    if (t) openTask(t);
  }, [panelRequest, board, byId, openTask]);

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

  /** Looks good: closes the task, or on a task whose schedule is on approves that run only. */
  const review = useCallback(async (t: BoardTask, closed: string) => answered(await reviewDone(t), isScheduled(t) ? 'Run approved. The task stays open.' : closed), [answered]);
  const endTaskSchedule = useCallback(async (t: BoardTask) => answered(await endSchedule(t), 'Schedule ended, task closed.'), [answered]);

  // A follow-up started from a closed task's chat: its panel opens once the board has the new task.
  const [followUpOf, setFollowUpOf] = useState<{ taskId: string; spaceId: string; since: number; until: number } | null>(null);
  useEffect(() => {
    if (!followUpOf || !board) return;
    if (Date.now() > followUpOf.until) { setFollowUpOf(null); return; }
    const made = board.tasks.filter((t) => t.originId === followUpOf.taskId && t.spaceId === followUpOf.spaceId && Date.parse(t.updatedAt ?? '') >= followUpOf.since)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
    if (made) { setFollowUpOf(null); openTask(made); }
  }, [board, followUpOf, openTask]);

  const continueFrom = useCallback(async (t: BoardTask, text: string, how: ContinueHow, restore: () => void) => {
    const answer = how === 'reopen' ? await continueTask(t, text) : await followUpTask(t, text);
    answered(answer, how === 'reopen'
      ? 'Reopened: its session gets your message once Undo is over.'
      : 'Follow-up started: a new task linked to this one opens once Undo is over.', restore);
    if (answer.ok && how === 'follow_up') {
      // Only tasks made after this send count: an older follow-up of the same task must not open instead.
      setFollowUpOf({ taskId: t.id, spaceId: t.spaceId, since: Date.parse(answer.undoUntil), until: Date.parse(answer.undoUntil) + FOLLOW_UP_WAIT_MS });
      window.setTimeout(() => { void refetch(); }, Math.max(0, Date.parse(answer.undoUntil) - Date.now()) + 1000);
    }
    return answer.ok;
  }, [answered, refetch]);

  const submitHandOver = useCallback(async (t: BoardTask, input: HandOverInput, desk: { id: string } | { name: string } | null) => {
    setDialog(null);
    const answer = await handOver(t, input);
    const name = agentName(input.delegate);
    if (!answer.ok || input.mode !== 'together') {
      answered(answer, input.mode === 'now' ? `Delegated to ${name} with checkpoint ${input.checkpoint}. You stay the owner.` : `Scheduled: ${name} starts then. The card is in Agent scheduled.`);
      return;
    }
    // Work on it now: the session opens in the chosen desk, with the brief the host answered with.
    const deskId = desk && 'id' in desk ? desk.id : ensureDeskBySlug(`task-${t.title}`, { name: desk?.name ?? taskName(t) });
    const space = spaces.find((s) => s.id === t.spaceId);
    const paneId = t.project ? addWorkerPane({
      fromSessionId: null, projectId: projectIdOfBrain(t.project), title: taskName(t), deskId, taskId: t.id,
      prompt: [answer.brief, `Work on task ${t.id} ("${taskName(t)}") together with the user, who owns it. Start by saying where it stands and what you would do next. When the work is done, hand it over for review; close the task only when the user tells you to.`,
        // Reopened on the board: what closed with it comes back only on the owner's yes.
        t.reopenedWith?.length ? `The task was reopened. These closed with it and are not back yet: ${t.reopenedWith.map((i) => `${i.type} ${i.title ?? i.id} (${i.id})`).join('; ')}. Ask the user which still hold, and bring those back with eml_update status active.` : null,
      ].filter(Boolean).join('\n\n'),
      ...(space ? { spaceId: paneSpaceKey(space) } : {}),
    }) : null;
    answered(answer, `Opened in desk ${input.desk}.`, () => { if (paneId) removePane(paneId); });
  }, [answered, spaces]);

  // Parking puts the snooze on the task's wait in the brain, so it holds on every device and for every member.
  const park = useCallback(async (item: InboxItem, when: 'tomorrow' | 'monday' | 'open' | 'now') => {
    const times = snoozeTimes(Date.now());
    const until = when === 'tomorrow' ? times.tomorrow : when === 'monday' ? times.monday : when;
    const said = when === 'tomorrow' ? 'Parked until tomorrow 09:00.' : when === 'monday' ? 'Parked until Monday 09:00.' : when === 'open' ? 'Parked with no date: bring it back from the Inbox\'s Parked fold.' : 'Brought back.';
    answered(await snooze(item, until), said);
  }, [answered]);

  const onInboxAction = useCallback(async (a: InboxAction) => {
    if (a.kind === 'review') {
      const t = a.item.taskId ? byId.get(a.item.taskId) : undefined;
      if (t) await review(t, 'Closed as reviewed.');
    } else {
      await park(a.item, a.until);
    }
  }, [review, park, byId]);

  const unreadSessions = useMemo(
    () => (board && sessions ? unreadAnswers(sessions, board, turns, now).filter((s) => !readHere.has(readKey(s))) : []),
    [board, sessions, turns, now, readHere],
  );

  /** Opening an unread answer reads it, and it opens as the Inbox opens its items: with its task, or on its own. */
  const openUnread = useCallback((session: AllSession) => {
    setReadHere((prev) => new Set(prev).add(readKey(session)));
    void markSessionRead(session.id);
    const t = session.taskId ? byId.get(session.taskId) : undefined;
    if (t?.sessionIds.includes(session.id)) { openTask(t, session.id); return; }
    const space = spaces.find((s) => s.id === session.spaceId);
    if (space && paneSpaceKey(space) !== getActiveSpaceId()) switchSpace(space);
    setOpen({ sessionId: session.id });
  }, [byId, openTask, spaces]);

  // Working now: this cockpit's working sessions (live turn state) and other members' runs from the board.
  const working = useMemo(() => (board ? workingNow(sessions ?? [], turns, board, spaces) : []), [board, sessions, turns, spaces]);
  const upcoming = useMemo(() => (board ? nextRuns(board) : []), [board]);

  /** A working row opens as an Inbox item does: with its task when the task lists the session, else the session on its own. */
  const openWorking = useCallback((row: WorkingRow) => {
    if (row.task && (!row.sessionId || row.task.sessionIds.includes(row.sessionId))) { openTask(row.task, row.sessionId ?? undefined); return; }
    const session = sessions?.find((s) => s.id === row.sessionId);
    if (!session) return;
    const space = spaces.find((s) => s.id === session.spaceId);
    if (space && paneSpaceKey(space) !== getActiveSpaceId()) switchSpace(space);
    setOpen({ sessionId: session.id });
  }, [openTask, sessions, spaces]);

  const markAllRead = useCallback(() => {
    const before = readBefore(unreadSessions);
    const keys = unreadSessions.map(readKey);
    setReadHere((prev) => new Set([...prev, ...keys]));
    void Promise.all(before.map((b) => markSessionRead(b.id)));
    say(`${before.length} marked read.`, {
      label: 'Undo',
      run: () => {
        setReadHere((prev) => { const next = new Set(prev); for (const k of keys) next.delete(k); return next; });
        void Promise.all(before.map((b) => restoreSessionRead(b.id, b))).then((errors) => {
          const error = errors.find(Boolean);
          say(error ?? 'Undone. They are unread again.');
        });
      },
    }, new Date(Date.now() + UNREAD_UNDO_MS).toISOString());
  }, [unreadSessions, say]);

  if (!board) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background p-6 text-body text-muted-foreground">
        {error ? <span>{(error as Error).message} <button type="button" className={BUTTON} onClick={() => void refetch()}>Try again</button></span> : 'Loading the tasks…'}
      </div>
    );
  }

  const split = view === 'inbox' && Boolean(task || sessionOnly);
  const unread: UnreadProps = {
    sessions: unreadSessions,
    spaces,
    open: unreadFoldOpen(unreadPicked, board.inbox.length),
    onToggle: () => setFold('unread', !unreadFoldOpen(unreadPicked, board.inbox.length)),
    onOpen: openUnread,
    onMarkAllRead: markAllRead,
  };
  const currentWorking = working.find((r) => (r.sessionId ? r.sessionId === (open?.sessionId ?? sessionOnly) : r.task?.id === task?.id))?.key ?? null;
  const workingColumn = (
    <WorkingColumn rows={working} next={upcoming} now={now} current={split ? currentWorking : null} onOpen={openWorking} onOpenTask={(t) => openTask(t)} onShowNow={() => setTaskView('now')} />
  );
  const panel = task ? (
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
      onReview={(t) => void review(t, 'Closed as done.')}
      onEndSchedule={(t) => void endTaskSchedule(t)}
      onDrop={async (t) => answered(await closeTask(t), 'Closed: not needed.')}
      onReopen={async (t, reason) => answered(await reopenTask(t, reason), 'Reopened: active again, nothing started. Hand it over when an agent should go on.')}
      onContinue={continueFrom}
      onPark={async (t, until) => {
        // The task's Inbox item as the host keyed it; a wait the Inbox does not list (a stop, someone outside) by the task alone.
        const item = board.inbox.find((i) => i.taskId === t.id && i.space === t.spaceId) ?? board.snoozed.find((i) => i.taskId === t.id)
          ?? { key: `task:${t.id}@`, kind: 'question' as const, space: t.spaceId, title: t.title, text: '', since: '', taskId: t.id };
        await park(item, until);
      }}
      onClose={closePanel}
    />
  ) : sessionOnly ? (
    <SessionPanel key={sessionOnly} session={sessions?.find((s) => s.id === sessionOnly)} board={board} spaces={spaces} onClose={closePanel} />
  ) : null;
  const dialogTask = dialog ? byId.get(dialog.taskId) : undefined;
  const spaceAgents = (t: BoardTask) => {
    const agents = board.spaces.find((s) => s.id === t.spaceId)?.agents ?? [];
    return t.delegate && agents.includes(t.delegate) ? [t.delegate, ...agents.filter((a) => a !== t.delegate)] : agents;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      {/* An open task in the Inbox fills the height, with the same gap below as above; the list beside it scrolls on its own.
          Wide: the shell's gap on every side and between the columns, as around the sidebar and between desk panes. */}
      <div className={cn('flex w-full flex-col gap-4', compact ? 'px-4 pt-3' : 'px-(--gap-shell) pt-(--gap-shell)', split ? (compact ? 'min-h-0 flex-1 pb-3' : 'min-h-0 flex-1 pb-(--gap-shell)') : 'pb-10')}>
        {compact && <ControlBar board={board} unread={unreadSessions.length} view={open && !split ? null : view} onView={setTaskView} />}
        {split ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 gap-4 lg:grid-cols-(--grid-inbox-working-split) lg:gap-(--gap-shell)">
            <div className="hidden min-h-0 min-w-0 overflow-y-auto lg:block">{workingColumn}</div>
            <div className="hidden min-h-0 min-w-0 overflow-y-auto lg:block">
              <InboxView board={board} now={now} compact currentTaskId={task?.id ?? null} unread={unread} onOpen={(item) => { const t = item.taskId ? byId.get(item.taskId) : undefined; if (t) openTask(t, item.sessionId); }} onAction={onInboxAction} />
            </div>
            <section aria-labelledby={TASK_TITLE_ID} className="flex min-h-(--size-split-panel-min) min-w-0 flex-col gap-2.5">
              {panel}
            </section>
          </div>
        ) : view === 'inbox' ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-(--grid-inbox-working) lg:gap-(--gap-shell)">
            {/* Wide: a column left of the list. Narrow: a strip of cards above it, gone while nothing works. */}
            <div className="hidden min-w-0 lg:sticky lg:top-(--gap-shell) lg:block">{workingColumn}</div>
            <div className="min-w-0 lg:hidden"><WorkingStrip rows={working} now={now} onOpen={openWorking} /></div>
            <InboxView board={board} now={now} compact={false} currentTaskId={null} unread={unread} onOpen={(item) => { const t = item.taskId ? byId.get(item.taskId) : undefined; if (t) openTask(t, item.sessionId); }} onAction={onInboxAction} />
          </div>
        ) : view === 'now' ? (
          <NowBoard board={board} now={now} onOpen={(t) => openTask(t)} movedId={board.events[0]?.taskId ?? null} />
        ) : (
          <PlanView board={board} now={now} onOpen={(t) => openTask(t)} onCloseTask={async (t) => answered(await closeTask(t), 'Closed: not needed.')} onEndSchedule={(t) => void endTaskSchedule(t)} projects={projects} projectActions={projectActions} />
        )}
      </div>

      <Sheet open={Boolean(panel && !split)} onClose={closePanel} labelledBy={TASK_TITLE_ID}>{!split && panel}</Sheet>

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
function ControlBar({ board, unread, view, onView }: { board: Board; unread: number; view: View | null; onView: (v: View) => void }) {
  return (
    <header className="glass sticky top-2 z-(--z-sticky) flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-2xl py-2 pl-4 pr-2.5 max-lg:static">
      <span className="text-title font-bold tracking-title">Tasks</span>
      <div role="tablist" aria-label="Views" className="inline-flex gap-0.5 rounded-xl bg-foreground/8 p-1">
        {VIEWS.map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => onView(v)}
            className={cn('flex min-h-(--target-comfortable) items-center gap-2 rounded-lg px-3 text-heading font-medium text-muted-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-raised', FOCUS)}>
            {label}
            {v === 'inbox' && board.counts.inbox > 0 && <span title={`${board.counts.inbox} questions and results to review`} className="rounded-full bg-muted-foreground/12 px-1.5 text-caption tabular-nums text-foreground">{board.counts.inbox}</span>}
            {v === 'inbox' && unread > 0 && <UnreadDot count={unread} />}
          </button>
        ))}
      </div>
    </header>
  );
}
