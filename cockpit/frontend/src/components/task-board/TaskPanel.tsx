// A task opened from the board: the task on the left, its session's chat on the right. A question is
// the one thing to do here, so answering comes first; Hand over and Looks good are the direct actions.
import { useEffect, useState } from 'react';

import MainContentTabSwitcher from '@/components/main-content/view/subcomponents/MainContentTabSwitcher';
import { SessionChat } from '@/components/ui/session-chat';
import { TaskJournal } from '@/components/task-sections';
import type { AllSession } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { useEngramPanel } from '@/lib/engram-panel';
import { useEngram } from '@/lib/queries';
import { agentName, type Board, type BoardTask, cardLine, dueLabel, type HandOverMode, hueOf, originName, readable, taskName, TURN_META, when } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { BUTTON, Chip, FOCUS, HUE, LABEL, PRIMARY } from '@/shared/view/ui';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';
import { markSeen, useTurnStore } from '@/stores/useTurnStateStore';

import { AgentBadge, FromOrigin } from './parts';
import { TaskRelated } from './TaskRelated';

export const TASK_TITLE_ID = 'task-board-title';
/** The surface id the board's chat goes by (scroll and draft are kept per surface). */
const TASK_BOARD_PANE_ID = 'tasks';
const CHAT_ID = 'task-board-chat';

/** Put the cursor in the chat's composer: answering is typing to the session. */
export function focusReply(): void {
  document.querySelector<HTMLTextAreaElement>(`#${CHAT_ID} textarea`)?.focus();
}

export function TaskPanel({ task, board, now, sessions, spaces, sessionId, onClose, onOpenTask, onHandOver, onReview }: {
  task: BoardTask;
  board: Board;
  now: number;
  sessions: AllSession[];
  spaces: SpaceInfo[];
  /** Open on this session (the Inbox item that asked), not the newest. */
  sessionId?: string;
  /** Closes the task: the × in the chat's toolbar, as on a desk pane. */
  onClose: () => void;
  onOpenTask: (task: BoardTask) => void;
  onHandOver: (task: BoardTask, mode: HandOverMode) => void;
  onReview: (task: BoardTask) => void;
}) {
  const { hrefFor, go } = useEngramPanel();
  const spaceKey = (id: string) => { const space = spaces.find((s) => s.id === id); return space ? paneSpaceKey(space) : null; };
  const engram = useEngram(task.id);
  const own = sessions.filter((s) => task.sessionIds.includes(s.id))
    .sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')));
  const [pick, setPick] = useState<string | null>(sessionId ?? null);
  const current = own.find((s) => s.id === pick) ?? own[0];
  // Looking at a session here is looking at it, as on its desk: its finished turn counts as seen.
  // Opening it counts at once; a turn that finishes while it is shown only with the window in front.
  const currentId = current?.id ?? null;
  const since = useTurnStore().turns[currentId ?? '']?.since;
  useEffect(() => { if (currentId) markSeen([currentId]); }, [currentId]);
  useEffect(() => {
    if (!currentId) return;
    const run = () => { if (document.visibilityState === 'visible' && document.hasFocus()) markSeen([currentId]); };
    run();
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', run);
    return () => { window.removeEventListener('focus', run); document.removeEventListener('visibilitychange', run); };
  }, [currentId, since]);
  const project = board.projects.find((p) => p.spaceId === task.spaceId && p.id === task.project);
  const hue = hueOf(task);
  const closed = task.status === 'resolved' || task.status === 'invalidated';
  const asked = task.group === 'asked';
  const review = task.turn === 'review';

  const handOver = !closed && (
    <div className="flex flex-wrap gap-2">
      {review && <button type="button" className={PRIMARY} onClick={() => onReview(task)}>Looks good, done</button>}
      <button type="button" className={review || asked ? BUTTON : PRIMARY} onClick={() => onHandOver(task, 'now')}>
        {task.delegate ? `Run ${agentName(task.delegate)} now` : task.handTo ? `Hand to ${agentName(task.handTo)}` : 'Delegate now'}
      </button>
      <button type="button" className={BUTTON} onClick={() => onHandOver(task, 'schedule')}>Schedule…</button>
      <button type="button" className={BUTTON} onClick={() => onHandOver(task, 'together')}>Work on it now</button>
    </div>
  );

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto rounded-xl border border-border bg-card lg:grid-cols-(--grid-task) lg:overflow-hidden">
        <section aria-label="Task" className="flex min-w-0 flex-col border-b border-border lg:min-h-0 lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-3 p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <div className="flex flex-wrap items-center gap-2">
              <Chip hue={hue}>{task.group === 'nobody' ? 'nobody on it' : task.turn ? TURN_META[task.turn].name : task.status}</Chip>
              {task.priority === 'high' && <Chip hue="stopped">high</Chip>}
              {task.due && <Chip hue="mark">due {dueLabel(task.due, now)}</Chip>}
              {task.checkpoint && <Chip>checkpoint {task.checkpoint}</Chip>}
            </div>
            <h2 id={TASK_TITLE_ID} tabIndex={-1} data-autofocus className={cn('m-0 text-display font-semibold tracking-title text-balance', FOCUS)}>{taskName(task)}</h2>
            <details className="group text-ui text-muted-foreground">
              <summary className={cn('inline-flex cursor-pointer list-none gap-1.5', FOCUS)}>
                <span aria-hidden className="inline-block transition-transform duration-(--duration-fast) group-open:rotate-90">›</span>
                {task.spaceName} · {project?.name ?? (task.project ? readable(task.project) : 'No project')}
              </summary>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 tabular-nums text-caption">
                <span>project.{task.project ?? '–'}</span><span>{task.status}</span><span>{task.id}</span>
              </div>
            </details>
            {(() => {
              const from = originName(task, board);
              if (!from || !task.originId) return null;
              const open = board.tasks.find((t) => t.id === task.originId && t.spaceId === task.spaceId);
              return <FromOrigin name={from} className="text-ui" onOpen={() => (open ? onOpenTask(open) : go(task.originId!))} />;
            })()}
            {task.statusLine && (
              // Where it stands: the newest handoff's Result and Next (host domain/status-line.ts).
              <div aria-label="Where it stands" className="flex flex-col gap-0.5 rounded-xl bg-background px-3 py-2 text-body">
                <div className="flex items-baseline justify-between gap-2">
                  <span><b className="font-semibold">Now:</b> {task.statusLine.now}</span>
                  <time className="shrink-0 whitespace-nowrap tabular-nums text-caption text-muted-foreground">{when(task.statusLine.at, now)}</time>
                </div>
                {task.statusLine.next && <span className="text-ui text-muted-foreground">Next: {task.statusLine.next}</span>}
              </div>
            )}
            {/* Where it came from and what came out of it; a closed ancestor isn't on the board, so its engram opens.
                Its key differs from the journal's: siblings sharing a key make React leave copies of the block behind. */}
            <TaskRelated key={`related-${task.id}`} task={task} board={board} onOpen={(r) => (r.task ? onOpenTask(r.task) : go(r.id))} />
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 rounded-xl border border-border px-3 py-2.5 text-body">
              <dt className={LABEL}>Owner</dt>
              <dd className="m-0">{task.owner ? (task.owner === board.viewer ? 'You' : task.owner) : <span className="text-muted-foreground">nobody</span>}</dd>
              <dt className={LABEL}>Delegate</dt>
              <dd className="m-0 flex flex-wrap items-center gap-2">
                {task.delegate ? <AgentBadge handle={task.delegate} /> : <span className="text-muted-foreground">not delegated</span>}
                {task.nextRunAt && <span className="text-ui text-muted-foreground">next {when(task.nextRunAt, now)}</span>}
              </dd>
            </dl>

            {asked ? (
              <div className={cn('rounded-xl border px-3 py-2.5', HUE.you.tint, HUE.you.edge)}>
                <div className={cn(LABEL, 'mb-1', HUE.you.ink)}>Needs you · {agentName(task.delegate)} asks</div>
                <div className="text-heading">{task.waitingOn?.why}</div>
                {task.waitingOn?.since && <div className="mt-1 tabular-nums text-caption text-muted-foreground">asked {when(task.waitingOn.since, now)}</div>}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {current
                    ? <button type="button" className={PRIMARY} onClick={focusReply}>Reply…</button>
                    : <span className="text-ui text-muted-foreground">Its session is gone: hand the task over or work on it now to answer.</span>}
                </div>
              </div>
            ) : task.group !== 'own' && !review ? (
              // A review's result is in the chat's handoff right next to it; the chip names the state (Lasse 2026-11-23).
              <div className={cn('rounded-xl border px-3 py-2.5 text-body', HUE[hue].tint, HUE[hue].edge)}>
                <div className={cn(LABEL, 'mb-1', HUE[hue].ink)}>{task.group === 'nobody' ? 'Nobody on it' : task.turn ? TURN_META[task.turn].name : task.status}</div>
                {cardLine(task, now)}
              </div>
            ) : null}

            {handOver}
            {engram.data && <TaskJournal key={`journal-${task.id}`} engram={engram.data} relationHref={hrefFor} foldable />}
          </div>
        </section>

        <section aria-label="Session" id={CHAT_ID} className="flex min-h-0 min-w-0 flex-col">
          {own.length > 1 && (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
              {own.map((s) => (
                <button key={s.id} type="button" onClick={() => setPick(s.id)} aria-pressed={s.id === current?.id}
                  className={cn('max-w-56 shrink-0 truncate rounded-md px-2 py-1 tabular-nums text-ui text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground', FOCUS)}>
                  {sessionDisplayName(s)}
                </button>
              ))}
            </div>
          )}
          {current ? (
            <SessionChat key={current.id} paneId={TASK_BOARD_PANE_ID} projectId={current.__projectId ?? null} sessionId={current.id} session={current} spaceId={spaceKey(current.spaceId)} borrowed toolbar={{ onClosePane: onClose }} />
          ) : (
            <>
            <div className="flex shrink-0 justify-end px-2 py-1.5">
              <MainContentTabSwitcher groups={[]} paneView="chat" onSetPaneView={() => {}} onClosePane={onClose} />
            </div>
            <div className="m-auto flex max-w-dialog flex-col items-center gap-3 px-5 py-10 text-center text-body text-muted-foreground">
              <b className="text-foreground">No session on this task yet.</b>
              Delegate it so an agent works on it in the background, schedule it, or work on it now with an agent in a desk of your choice.
              {handOver}
            </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
