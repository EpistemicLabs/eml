// A task opened from the board: the task on the left, its session's chat on the right. A question is
// the one thing to do here, so answering comes first; Hand over and Looks good are the direct actions,
// Done and Not needed sit in the ⋯ menu. A closed task keeps its chat: writing there reopens it or starts
// a follow-up (decision task-closing-and-continuation-rules), and Reopen still reopens without a message.
import { useEffect, useState } from 'react';

import MainContentTabSwitcher from '@/components/main-content/view/subcomponents/MainContentTabSwitcher';
import { SessionChat } from '@/components/ui/session-chat';
import { TaskJournal } from '@/components/task-sections';
import type { AllSession } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { useEngramPanel } from '@/lib/engram-panel';
import { useEngram } from '@/lib/queries';
import { agentName, type Board, type BoardRun, type BoardTask, cardLine, repeatsText, CLOSED_STATUSES, closedAsTask, type ContinueHow, continueMode, dueLabel, type HandOverMode, hueOf, originName, readable, taskName, TURN_META, when } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { BUTTON, Chip, FIELD, FOCUS, HUE, LABEL, Menu, type MenuItem, PRIMARY } from '@/shared/view/ui';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';
import { markSeen, useTurnStore } from '@/stores/useTurnStateStore';

import { ContinueComposer } from './ContinueComposer';
import { AgentBadge, FromOrigin } from './parts';
import { TaskRelated } from './TaskRelated';

export const TASK_TITLE_ID = 'task-board-title';
/** The surface id the board's chat goes by (scroll and draft are kept per surface). */
export const TASK_BOARD_PANE_ID = 'tasks';
export const CHAT_ID = 'task-board-chat';

/**
 * Looking at a session here is looking at it, as on its desk: its finished turn counts as seen.
 * Opening it counts at once; a turn that finishes while it is shown only with the window in front.
 */
export function useSeenWhileShown(sessionId: string | null): void {
  const since = useTurnStore().turns[sessionId ?? '']?.since;
  useEffect(() => { if (sessionId) markSeen([sessionId]); }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    const run = () => { if (document.visibilityState === 'visible' && document.hasFocus()) markSeen([sessionId]); };
    run();
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', run);
    return () => { window.removeEventListener('focus', run); document.removeEventListener('visibilitychange', run); };
  }, [sessionId, since]);
}

/** Put the cursor in the chat's composer: answering is typing to the session. */
export function focusReply(): void {
  document.querySelector<HTMLTextAreaElement>(`#${CHAT_ID} textarea`)?.focus();
}

/** How a closed task ended, in a word. */
const ENDED: Record<string, string> = { resolved: 'Done', invalidated: 'Dropped', superseded: 'Replaced' };

/** Runs by what needs attention: one gone silent first, then working, then waiting between turns. */
const RUN_ORDER: Record<BoardRun['state'], number> = { stale: 0, running: 1, idle: 2 };
const RUN_STATE: Record<BoardRun['state'], string> = { stale: 'silent, may have crashed', running: 'working', idle: 'between turns' };

export function TaskPanel({ task, board, now, sessions, spaces, sessionId, onClose, onOpenTask, onHandOver, onReview, onDrop, onReopen, onContinue, onPark }: {
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
  /** Close an open task as done (Looks good, done; the ⋯ menu's Done). */
  onReview: (task: BoardTask) => void;
  /** Close an open task as not needed (dropped). */
  onDrop: (task: BoardTask) => void;
  /** Reopen a closed task (owner only), with an optional reason for its journal. */
  onReopen: (task: BoardTask, reason: string) => void;
  /** Writing in a closed task's chat: reopen it with the message, or start a follow-up. False: the text stays in the input. */
  onContinue: (task: BoardTask, text: string, how: ContinueHow, restore: () => void) => Promise<boolean>;
  /** Park the viewer's wait on the task: until tomorrow or Monday 09:00, or with no date. */
  onPark?: (task: BoardTask, until: 'tomorrow' | 'monday' | 'open') => void;
}) {
  const [reason, setReason] = useState('');
  const { hrefFor, go } = useEngramPanel();
  const spaceKey = (id: string) => { const space = spaces.find((s) => s.id === id); return space ? paneSpaceKey(space) : null; };
  const engram = useEngram(task.id);
  const own = sessions.filter((s) => task.sessionIds.includes(s.id))
    .sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')));
  const [pick, setPick] = useState<string | null>(sessionId ?? null);
  const current = own.find((s) => s.id === pick) ?? own[0];
  useSeenWhileShown(current?.id ?? null);
  const project = board.projects.find((p) => p.spaceId === task.spaceId && p.id === task.project);
  const hue = hueOf(task);
  const closed = CLOSED_STATUSES.has(task.status);
  const asked = task.group === 'asked';
  const review = task.turn === 'review';
  // A task closed in the Done window comes from the board's tasks; when and why it can't reopen are in its closed entry.
  const closedEntry = closed ? board.closed?.find((c) => c.id === task.id && c.spaceId === task.spaceId) : undefined;
  const blocked = task.blocked ?? closedEntry?.blocked;
  const goOn = closed && !task.pending ? continueMode({ owner: task.owner, closedAt: task.closedAt ?? closedEntry?.closedAt ?? null, blocked }, board.viewer, now) : null;
  const composer = goOn && <ContinueComposer mode={goOn} onSend={(text, how, restore) => onContinue(task, text, how, restore)} />;
  const menu: MenuItem[] = closed ? [] : [
    ...(review ? [] : [{ label: 'Done', onSelect: () => onReview(task) }]),
    { label: 'Not needed', onSelect: () => onDrop(task), destructive: true },
  ];

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

  // A closed task: how it ended, and Reopen, or why it can't be reopened here.
  const parent = task.parentId ? board.tasks.find((t) => t.id === task.parentId) ?? board.closed?.find((c) => c.id === task.parentId) : undefined;
  const mine = !task.owner || task.owner === board.viewer;
  const reopen = closed && (
    <div aria-label="Closed" className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5 text-body">
      <div>
        <b className="font-semibold">{ENDED[task.status] ?? 'Closed'}</b>
        {(task.closedAt ?? closedEntry?.closedAt) && <span className="tabular-nums text-muted-foreground"> · {when((task.closedAt ?? closedEntry?.closedAt)!, now)}</span>}
        {(task.outcome ?? closedEntry?.outcome) && <span className="text-muted-foreground"> · {task.outcome ?? closedEntry?.outcome}</span>}
      </div>
      {blocked === 'superseded' ? (
        <span className="text-ui text-muted-foreground">Another task replaced it: go on there.</span>
      ) : blocked === 'parent_closed' ? (
        <span className="text-ui text-muted-foreground">
          Its parent{parent ? <> <button type="button" className={cn('underline underline-offset-2', FOCUS)} onClick={() => onOpenTask('turn' in parent ? parent : closedAsTask(parent))}>{taskName(parent)}</button></> : null} is closed: reopen the parent first.
        </span>
      ) : !mine ? (
        <span className="text-ui text-muted-foreground">Only its owner ({task.owner}) can reopen it.</span>
      ) : (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); onReopen(task, reason); setReason(''); }}>
          <input type="text" aria-label="Why reopen (optional)" placeholder="Why reopen? (optional)" value={reason} maxLength={500}
            onChange={(e) => setReason(e.target.value)} className={cn(FIELD, 'min-w-0 flex-1 basis-48')} />
          <button type="submit" className={PRIMARY}>Reopen</button>
        </form>
      )}
      {!blocked && mine && (
        <span className="text-caption text-muted-foreground">It comes back as active with its owner{task.delegate ? `, delegate ${agentName(task.delegate)}` : ''}{task.checkpoint ? ` and checkpoint ${task.checkpoint}` : ''}. No agent starts; you can undo for 8 s.</span>
      )}
    </div>
  );
  const broughtBack = !closed && task.reopenedWith && task.reopenedWith.length > 0 && (
    <div aria-label="Closed with it" className="rounded-xl border border-border px-3 py-2.5 text-body">
      <div className={cn(LABEL, 'mb-1')}>Closed with it, not back yet</div>
      <ul className="m-0 list-none p-0 text-ui">
        {task.reopenedWith.map((i) => <li key={i.id}>{i.type} · {i.title ? readable(i.title) : i.id}</li>)}
      </ul>
      <div className="mt-1 text-caption text-muted-foreground">Say in the chat which of them still hold, and the agent brings those back.</div>
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
              {menu.length > 0 && <Menu label="More task actions" items={menu} className="ml-auto" />}
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
                {task.group === 'mission'
                  ? <span className="text-ui text-muted-foreground">until the goal is reached{task.nextRunAt ? ` · next check ${when(task.nextRunAt, now)}` : ''}</span>
                  : task.group === 'routine'
                    ? <span className="text-ui text-muted-foreground">{repeatsText(task.schedule).toLowerCase()}{task.nextRunAt ? ` · next ${when(task.nextRunAt, now)}` : ''}</span>
                    : task.nextRunAt && <span className="text-ui text-muted-foreground">next {when(task.nextRunAt, now)}</span>}
              </dd>
              {task.goal && (
                <>
                  <dt className={LABEL}>Goal</dt>
                  <dd className="m-0 text-ui">{task.goal}</dd>
                </>
              )}
              {task.waitingOn && !closed && (
                <>
                  <dt className={LABEL}>Waiting on</dt>
                  <dd className="m-0 text-ui">
                    {task.waitingOn.who === board.viewer ? 'You' : task.waitingOn.who}{task.waitingOn.why ? ` · ${task.waitingOn.why}` : ''}
                    {task.waitingOn.since && <span className="tabular-nums text-muted-foreground"> · since {when(task.waitingOn.since, now)}</span>}
                  </dd>
                </>
              )}
            </dl>
            {!closed && ((onPark && task.waitingOn?.who === board.viewer && task.turn !== 'parked') || task.nextRunAt || task.schedule) && (
              <div className="flex flex-wrap gap-2">
                {onPark && task.waitingOn?.who === board.viewer && task.turn !== 'parked' && (
                  <Menu label="Park this task's wait" align="start" items={[
                    { label: 'Park until tomorrow', onSelect: () => onPark(task, 'tomorrow') },
                    { label: 'Park until Monday', onSelect: () => onPark(task, 'monday') },
                    { label: 'Park, no date', onSelect: () => onPark(task, 'open') },
                  ]}>Park…</Menu>
                )}
                {(task.nextRunAt || task.schedule) && <button type="button" className={BUTTON} onClick={() => onHandOver(task, 'schedule')}>Change schedule…</button>}
              </div>
            )}
            {task.runs && task.runs.length > 0 && (
              <div aria-label="Sessions on it" className="flex flex-col gap-1 rounded-xl border border-border px-3 py-2.5">
                <div className={LABEL}>Sessions on it</div>
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-ui">
                  {[...task.runs].sort((a, b) => RUN_ORDER[a.state] - RUN_ORDER[b.state]).map((r) => (
                    <li key={r.id} className="flex flex-col">
                      <span>
                        <b className={cn('font-medium', r.state === 'stale' && HUE.stopped.ink)}>{agentName(r.agent ?? task.delegate)} · {RUN_STATE[r.state]}</b>
                        <span className="text-muted-foreground">{r.here ? '' : ` · on ${agentName(r.member)}'s cockpit`}{r.lastActivityAt ? ` · last activity ${when(r.lastActivityAt, now)}` : ''}</span>
                      </span>
                      {r.result && <span className="text-muted-foreground">{r.result}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

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
            ) : !closed && task.group !== 'own' && !review ? (
              // A review's result is in the chat's handoff right next to it; the chip names the state (Lasse 2026-11-23).
              <div className={cn('rounded-xl border px-3 py-2.5 text-body', HUE[hue].tint, HUE[hue].edge)}>
                <div className={cn(LABEL, 'mb-1', HUE[hue].ink)}>{task.group === 'nobody' ? 'Nobody on it' : task.turn ? TURN_META[task.turn].name : task.status}</div>
                {cardLine(task, now)}
              </div>
            ) : null}

            {handOver}
            {reopen}
            {broughtBack}
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
            <SessionChat key={current.id} paneId={TASK_BOARD_PANE_ID} projectId={current.__projectId ?? null} sessionId={current.id} session={current} spaceId={spaceKey(current.spaceId)} borrowed toolbar={{ onClosePane: onClose }} {...(closed ? { composer: composer || <ClosedNote task={task} pending={Boolean(task.pending)} /> } : {})} />
          ) : (
            <>
            <div className="flex shrink-0 justify-end px-2 py-1.5">
              <MainContentTabSwitcher groups={[]} paneView="chat" onSetPaneView={() => {}} onClosePane={onClose} />
            </div>
            <div className="m-auto flex max-w-dialog flex-col items-center gap-3 px-5 py-10 text-center text-body text-muted-foreground">
              <b className="text-foreground">{closed ? 'No session on this task.' : 'No session on this task yet.'}</b>
              {closed ? (goOn?.primary === 'reopen' ? 'Write below to reopen it: a session starts with your message.' : null)
                : 'Delegate it so an agent works on it in the background, schedule it, or work on it now with an agent in a desk of your choice.'}
              {handOver}
            </div>
            {composer}
            </>
          )}
        </section>
      </div>
    </>
  );
}

/** Under a closed task's chat when writing can't go on from here: being reopened, or not the viewer's. */
function ClosedNote({ task, pending }: { task: BoardTask; pending: boolean }) {
  return (
    <p className="m-0 shrink-0 border-t border-border p-3 text-ui text-muted-foreground">
      {pending ? 'Reopening… the chat takes your message once it is open.' : `Only its owner (${task.owner}) can go on with this task.`}
    </p>
  );
}
