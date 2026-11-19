// The Tasks screen on tokens v2 (mockup v4): three views behind one tab bar (Inbox · Now · Plan).
// A task opens over the view it was clicked in (Inbox: split next to the list). Glass only on the
// control layer; content on solid surfaces; colour only for Needs you and stopped.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { projectIdOfBrain } from '@/lib/project-lead';
import {
  agentName, handOver, readable, reviewDone, snooze, snoozeTimes, triage, undo, useTaskBoard,
  type Board, type BoardTask, type CommandAnswer, type HandOverInput, type HandOverMode, type InboxItem,
} from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/shared/view/ui';
import { Sheet } from '@/shared/view/ui/Sheet';
import { Toast, type ToastMessage } from '@/shared/view/ui/Toast';
import { addWorkerPane, ensureDeskBySlug, getActiveSpaceId, removePane, useDesks } from '@/stores/usePaneStore';
import { paneSpaceKey, switchSpace, useSpaces } from '@/stores/useSpaceStore';

import { InboxView, type InboxAction } from './InboxView';
import { HandOverDialog } from './HandOverDialog';
import { NowBoard } from './NowBoard';
import { BUTTON, FOCUS, LABEL, PRIMARY } from './parts';
import { PlanView } from './PlanView';
import { focusReply, TaskPanel, TASK_TITLE_ID } from './TaskPanel';

type View = 'inbox' | 'now' | 'plan';
const VIEWS: Array<[View, string, string]> = [['inbox', 'Inbox', '1'], ['now', 'Now', '2'], ['plan', 'Plan', '3']];
const VIEW_KEY = 'cockpit-task-board-view';
/** How long an informational toast stays (an Undo toast stays until its deadline). */
const TOAST_MS = 3200;
/** Relative times ("asked 10:27", "in 3 days") are worked out again this often. */
const NOW_TICK_MS = 30_000;

function rememberedView(): View {
  try { const v = localStorage.getItem(VIEW_KEY); return v === 'inbox' || v === 'plan' ? v : 'now'; } catch { return 'now'; }
}

export function TaskBoard() {
  const { data: board, error, refetch } = useTaskBoard();
  const { sessions } = useAllSessions(true);
  const spaces = useSpaces();
  const desks = useDesks();
  const [view, setViewState] = useState<View>(rememberedView);
  const [open, setOpen] = useState<{ taskId: string; sessionId?: string } | null>(null);
  const [dialog, setDialog] = useState<{ taskId: string; mode: HandOverMode } | null>(null);
  const [merging, setMerging] = useState<InboxItem | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS); return () => window.clearInterval(t); }, []);
  useEffect(() => { if (board) setNow(Date.now()); }, [board]);

  const setView = useCallback((v: View) => {
    setViewState(v);
    setOpen(null);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer only */ }
  }, []);

  // 1 · 2 · 3 switch views when nobody types.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (e.metaKey || e.ctrlKey || e.altKey || dialog || el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const hit = VIEWS.find(([, , key]) => key === e.key);
      if (hit) { e.preventDefault(); setView(hit[0]); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog, setView]);

  const byId = useMemo(() => new Map((board?.tasks ?? []).map((t) => [t.id, t])), [board]);
  const task = open ? byId.get(open.taskId) : undefined;
  const say = useCallback((text: string, action?: ToastMessage['action'], until?: string) => setToast({ id: crypto.randomUUID(), text, action, until, ms: TOAST_MS }), []);

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
    } else if (a.kind === 'snooze') {
      const times = snoozeTimes(Date.now());
      answered(await snooze(a.item, a.until === 'tomorrow' ? times.tomorrow : times.monday), `Snoozed to ${a.until === 'tomorrow' ? 'tomorrow 09:00' : 'Monday 09:00'}.`);
    } else if (a.action === 'merge') {
      setMerging(a.item);
    } else {
      answered(await triage(a.item, a.action), a.action === 'accept' ? 'Accepted: the task goes into the brain.' : 'Closed: the proposed task is dropped.');
    }
  }, [answered, byId]);

  if (!board) {
    return (
      <div data-ui="v2" className="flex flex-1 items-center justify-center bg-background p-6 text-body text-muted-foreground">
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
      top={(
        <div className="flex items-center gap-2.5">
          <span className="flex-1 text-caption text-muted-foreground">{split ? 'Pick another item on the left to switch. Esc closes.' : `Slides over ${VIEWS.find(([v]) => v === view)![1]}. Click outside or press Esc to close.`}</span>
          <button type="button" className={cn(BUTTON, 'min-h-(--target-min) px-2.5')} onClick={() => setOpen(null)} aria-label="Close the task">× Close</button>
        </div>
      )}
    />
  );
  const dialogTask = dialog ? byId.get(dialog.taskId) : undefined;
  const spaceAgents = (t: BoardTask) => {
    const agents = board.spaces.find((s) => s.id === t.spaceId)?.agents ?? [];
    return t.delegate && agents.includes(t.delegate) ? [t.delegate, ...agents.filter((a) => a !== t.delegate)] : agents;
  };

  return (
    <div data-ui="v2" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-4 pb-10 pt-3">
        <ControlBar board={board} view={open && !split ? null : view} onView={setView} />
        {split ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-(--grid-inbox-split)">
            <div className="hidden min-w-0 lg:block">
              <InboxView board={board} now={now} compact currentTaskId={task.id} onOpen={(item) => { const t = item.taskId ? byId.get(item.taskId) : undefined; if (t) openTask(t, item.sessionId); }} onAction={onInboxAction} />
            </div>
            <section aria-labelledby={TASK_TITLE_ID} className="flex min-h-(--size-split-panel-min) min-w-0 flex-col gap-2.5 lg:sticky lg:top-2 lg:h-(--size-split-panel)">
              {panel}
            </section>
          </div>
        ) : view === 'inbox' ? (
          <InboxView board={board} now={now} compact={false} currentTaskId={null} onOpen={(item) => { const t = item.taskId ? byId.get(item.taskId) : undefined; if (t) openTask(t, item.sessionId); }} onAction={onInboxAction} />
        ) : view === 'now' ? (
          <NowBoard board={board} now={now} onOpen={(t) => openTask(t)} movedId={board.events[0]?.taskId ?? null} />
        ) : (
          <PlanView board={board} now={now} onOpen={(t) => openTask(t)} />
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
      {merging && <MergeDialog item={merging} board={board} onClose={() => setMerging(null)} onMerge={async (taskId) => { const item = merging; setMerging(null); answered(await triage(item, 'merge', taskId), 'Merged into the task.'); }} />}
      <Toast message={toast} onDone={(id) => setToast((t) => (t?.id === id ? null : t))} />
    </div>
  );
}

function ControlBar({ board, view, onView }: { board: Board; view: View | null; onView: (v: View) => void }) {
  return (
    <header className="glass sticky top-2 z-(--z-sticky) flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-2xl py-2 pl-4 pr-2.5 max-lg:static">
      <span className="text-title font-bold tracking-title">Tasks</span>
      <div role="tablist" aria-label="Views" className="inline-flex gap-0.5 rounded-xl bg-foreground/8 p-1">
        {VIEWS.map(([v, label, key]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} title={`Shortcut: ${key}`} onClick={() => onView(v)}
            className={cn('flex min-h-(--target-comfortable) items-center gap-2 rounded-lg px-3 text-heading font-medium text-muted-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-raised', FOCUS)}>
            {label}
            {v === 'inbox' && board.counts.inbox > 0 && <span title={`${board.counts.inbox} questions, results and proposed tasks`} className="rounded-full bg-muted-foreground/12 px-1.5 font-data text-caption tabular-nums text-foreground">{board.counts.inbox}</span>}
            <kbd className="rounded-sm border border-b-2 border-border px-1 py-0.5 font-data text-caption leading-none text-muted-foreground">{key}</kbd>
          </button>
        ))}
      </div>
      <button type="button" onClick={() => onView('now')} title="Tasks where you have the next move"
        className={cn('inline-flex min-h-(--target-comfortable) items-center gap-2 rounded-lg border border-status-you/40 bg-status-you/10 px-2.5 font-semibold text-you-ink', FOCUS)}>
        Needs you <span className="tabular-nums">{board.counts.needsYou}</span>
      </button>
    </header>
  );
}

function MergeDialog({ item, board, onClose, onMerge }: { item: InboxItem; board: Board; onClose: () => void; onMerge: (taskId: string) => void }) {
  const candidates = board.tasks.filter((t) => t.spaceId === item.space && t.status !== 'resolved').sort((a, b) => b.urgency - a.urgency);
  const [target, setTarget] = useState(candidates[0]?.id ?? '');
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent data-ui="v2" className="glass-thick flex w-full max-w-dialog flex-col gap-3 rounded-3xl p-5 shadow-modal">
        <DialogTitle className="sr-only">Merge into a task</DialogTitle>
        <h3 className="m-0 text-title font-semibold">Merge “{readable(item.title)}”</h3>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Into the open task</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="rounded-lg border border-input bg-background px-2 py-1.5 text-body">
            {candidates.map((t) => <option key={t.id} value={t.id}>{readable(t.title)}</option>)}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={PRIMARY} disabled={!target} onClick={() => onMerge(target)}>Merge</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
