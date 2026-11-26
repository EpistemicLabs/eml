// A task's schedule in its panel: the repeating times, each with Remove, the wake-up with its reason, the next run,
// and one Pause or Resume, Run now and End for the whole schedule. Below it, what only this cockpit keeps for the
// task (its record): the last runs, and the settings of a task that messages wake or that runs limited. Those show
// only when the record has something to show; addresses waiting for the user's OK show first.
// Everything here but End schedule applies at once and cannot be undone, so nothing offers Undo.
import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { activeGrants, type BoardTask, type GrantTool, GRANT_TOOLS, isDue, isLastTime, NEEDS_OK, nextRunText, RECORD_KEY, type RecordChange, recordShows, REPLY_CHANNELS, runLine, runsLeft, runsLeftText, type ScheduleAction, scheduleZone, timeText, useTaskRecord, when } from '@/lib/task-board';
import type { RunTone } from '@/lib/job-run-label';
import { cn } from '@/lib/utils';
import { Chip, FOCUS, HUE, LABEL, LINK, MINI, PRIMARY } from '@/shared/view/ui';

/** The second step of something that cannot be taken back: red. */
const CONFIRM = cn(MINI, HUE.stopped.edge, HUE.stopped.ink, 'hover:text-stopped-ink');
// Colour only for meaning: a run that waits for you, a run that failed.
const TONE: Record<RunTone, string> = { ok: 'text-foreground', attention: 'text-you-ink', bad: 'text-stopped-ink', muted: 'text-muted-foreground' };
const TOOL_NAME: Record<GrantTool, string> = { chrome: 'Chrome', SendMessage: 'Messages' };
/** How many of the last runs the fold lists. */
const RUNS_SHOWN = 5;

/** Asks before something that cannot be taken back: what happens, the step itself, and Cancel. */
function ConfirmRow({ text, action, busy, onConfirm, onCancel }: { text: string; action: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="group" aria-label={action} className="flex flex-wrap items-center gap-2 text-ui">
      <span className="basis-full text-foreground">{text}</span>
      <button type="button" className={CONFIRM} disabled={busy} onClick={onConfirm}>{action}</button>
      <button type="button" className={MINI} disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  );
}

export function ScheduleSection({ task, now, onAct, onEndSchedule, onAddTime }: {
  task: BoardTask;
  now: number;
  /** Carries the action out and says how it went (or why it was refused). True once done. */
  onAct: (task: BoardTask, action: ScheduleAction) => Promise<boolean>;
  /** End the schedule and close the task (the one End; it has the board's undo window). */
  onEndSchedule: (task: BoardTask) => void;
  /** Add a repeating time or set the wake-up: the hand-over dialog's Schedule. */
  onAddTime: (task: BoardTask) => void;
}) {
  const client = useQueryClient();
  const { data } = useTaskRecord(task, true);
  const [busy, setBusy] = useState(false);
  /** The one step that waits for its second click: a time's rule, a channel, or the limits. */
  const [asking, setAsking] = useState<string | null>(null);

  const schedule = task.schedule;
  const record = data?.record ?? null;
  const settings = recordShows(record, now);
  if (!schedule && !task.hasSchedule && !settings) return null;

  const act = async (action: ScheduleAction) => {
    setBusy(true);
    try {
      await onAct(task, action);
      await client.invalidateQueries({ queryKey: [...RECORD_KEY, task.spaceId, task.id] });
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };
  const change = (c: RecordChange) => act({ kind: 'record', change: c });

  const crons = schedule?.crons ?? [];
  const zone = scheduleZone(schedule);
  const paused = Boolean(schedule?.paused);
  // The end is the repeating times' end: a wake-up fires at its own time, also after it.
  const ended = crons.length > 0 && isDue(schedule?.ends_at, now);
  const channels = REPLY_CHANNELS.filter((c) => record?.triggers.some((t) => t.type === c));
  const grants = activeGrants(record, now);
  const runs = (data?.runs ?? []).slice(0, RUNS_SHOWN);

  const left = runsLeft(record);

  const newest = runs[0] ? runLine(runs[0], now, true) : { text: '', tone: 'muted' as const };

  const next = task.nextRunAt ? (isDue(task.nextRunAt, now) ? `Run ${nextRunText(task.nextRunAt, now)}` : `Next run ${when(task.nextRunAt, now)}`) : '';
  let stands: ReactNode = null;
  if (paused) stands = record?.pausedReason ? <span className="text-you-ink">Paused by the cockpit: {record.pausedReason}</span> : 'Paused: nothing runs until you resume it.';
  else if (ended && schedule?.at) stands = `Its end has passed (${when(schedule.ends_at, now)}): the repeating times no longer run, the wake-up still does.${next ? ` ${next}` : ''}`;
  else if (ended) stands = `Its end has passed (${when(schedule?.ends_at, now)}): nothing runs any more.`;
  else if (next) stands = `${next}${crons.length > 0 && schedule?.ends_at ? ` · ends ${when(schedule.ends_at, now)}` : ''}`;

  return (
    <section aria-label="Schedule" className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5 text-body">
      <div className="flex flex-wrap items-center gap-2">
        <span className={LABEL}>Schedule</span>
        {paused && <Chip>paused</Chip>}
        {record?.pendingApproval && <Chip hue="you">{NEEDS_OK}</Chip>}
      </div>

      {record?.pendingApproval && (
        // A safety step: new addresses do not wake the task until the user says so.
        <div role="group" aria-label="Waiting for your OK" className="flex flex-col gap-2 rounded-xl border border-status-you/40 bg-status-you/10 px-3 py-2.5">
          <span><b className="text-you-ink">This task wants to be woken by {channels.length > 0 ? channels.join(' and ') : 'messages'}.</b> Messages for it wait, and its repeating times and Run now are held, until you approve.</span>
          <span><button type="button" className={PRIMARY} disabled={busy} onClick={() => void change({ kind: 'approve' })}>Approve</button></span>
        </div>
      )}

      {crons.length > 0 && (
        <ul aria-label="Repeating times" className="m-0 flex list-none flex-col p-0">
          {crons.map((cron) => {
            const text = timeText(cron);
            const last = isLastTime(schedule, cron);
            return (
              <li key={cron} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span title={cron}>{text}</span>
                  {asking !== cron && (
                    <button type="button" className={LINK} disabled={busy} aria-label={`Remove the time: ${text}`}
                      onClick={() => (last ? setAsking(cron) : void act({ kind: 'remove_time', cron }))}>Remove</button>
                  )}
                </div>
                {asking === cron && (
                  <ConfirmRow text="This is its only time: removing it ends the schedule. The task stays open." action="Remove and end schedule" busy={busy}
                    onConfirm={() => void act({ kind: 'remove_time', cron })} onCancel={() => setAsking(null)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {crons.length > 0 && zone && <span className="text-caption text-muted-foreground">Times in {zone}.</span>}

      {schedule?.at && (
        <div aria-label="Wake-up" className="flex flex-col gap-0.5">
          <span><b className="font-semibold">Wake-up</b> <time className="tabular-nums">{when(schedule.at, now)}</time></span>
          {schedule.why && <span title={schedule.why} className="line-clamp-3 whitespace-pre-wrap text-ui text-muted-foreground">{schedule.why}</span>}
        </div>
      )}

      {stands && <div className="text-ui text-muted-foreground">{stands}</div>}
      {left !== null && task.hasSchedule && <div className="text-ui text-muted-foreground">{runsLeftText(left)}, then the schedule ends.</div>}

      <div className="flex flex-wrap items-center gap-2">
        {task.hasSchedule && (paused
          ? <button type="button" className={MINI} disabled={busy} onClick={() => void act({ kind: 'resume' })}>Resume</button>
          : <button type="button" className={MINI} disabled={busy} onClick={() => void act({ kind: 'pause' })}>Pause</button>)}
        <button type="button" className={MINI} disabled={busy} title="Starts a run now, whatever its times say." onClick={() => void act({ kind: 'run_now' })}>Run now</button>
        {task.hasSchedule && <button type="button" className={MINI} disabled={busy} title="No more runs. The task closes as done." onClick={() => onEndSchedule(task)}>End schedule and close</button>}
        {task.hasSchedule && <button type="button" className={LINK} onClick={() => onAddTime(task)}>Add a time…</button>}
      </div>

      {runs.length > 0 && (
        <details className="group text-ui text-muted-foreground">
          <summary className={cn('inline-flex cursor-pointer list-none gap-1.5', FOCUS)}>
            <span aria-hidden className="inline-block transition-transform duration-(--duration-fast) group-open:rotate-90">›</span>
            {/* The newest run is read without opening the fold: a failed or missed one must not hide. */}
            <span>Last run <span className={cn('tabular-nums', TONE[newest.tone])}>{newest.text}</span></span>
          </summary>
          {runs.length > 1
            ? (
              <ul aria-label="Earlier runs" className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 pl-3.5 tabular-nums">
                {runs.slice(1).map((run) => { const line = runLine(run, now); return <li key={run.id} className={TONE[line.tone]}>{line.text}</li>; })}
              </ul>
            )
            : <p className="m-0 mt-1 pl-3.5">No earlier run.</p>}
        </details>
      )}

      {record && settings && (
        <div aria-label="On this cockpit" className="flex flex-col gap-1.5 border-t border-border pt-2 text-ui text-muted-foreground">
          <span className={LABEL}>On this cockpit</span>
          {channels.map((channel) => {
            const sends = record.reply[channel] === 'send';
            const key = `send:${channel}`;
            return (
              <div key={channel} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span>Replies on {channel}: <span className="text-foreground">{sends ? 'sent without asking' : 'drafts you approve'}</span></span>
                  {sends
                    ? <button type="button" className={LINK} disabled={busy} onClick={() => void change({ kind: 'reply', channel, mode: 'draft' })}>Back to drafts</button>
                    : asking !== key && <button type="button" className={LINK} disabled={busy} onClick={() => setAsking(key)}>Let it send…</button>}
                </div>
                {asking === key && (
                  <ConfirmRow text={`Its ${channel} replies go out without you reading them first.`} action="Send without asking" busy={busy}
                    onConfirm={() => void change({ kind: 'reply', channel, mode: 'send' })} onCancel={() => setAsking(null)} />
                )}
              </div>
            );
          })}
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              {record.limited ? (
                <>
                  <span><span className="text-foreground">Limited</span>: no shell, no messages to sessions, only the brain</span>
                  {asking !== 'free' && <button type="button" className={LINK} disabled={busy} onClick={() => setAsking('free')}>Remove limits…</button>}
                </>
              ) : (
                <>
                  <span>Its sessions run with all their tools</span>
                  <button type="button" className={LINK} disabled={busy} onClick={() => void change({ kind: 'limited', limited: true })}>Limit it</button>
                </>
              )}
            </div>
            {asking === 'free' && (
              <ConfirmRow text="Its sessions get the shell and every tool back." action="Remove limits" busy={busy}
                onConfirm={() => void change({ kind: 'limited', limited: false })} onCancel={() => setAsking(null)} />
            )}
          </div>
          {record.limited && (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {grants.map((grant) => (
                <span key={grant.tool} className="inline-flex flex-wrap items-baseline gap-x-1.5">
                  <span><span className="text-foreground">{TOOL_NAME[grant.tool]}</span> lent until {when(grant.until, now)}</span>
                  <button type="button" className={LINK} disabled={busy} aria-label={`Take ${TOOL_NAME[grant.tool]} back`} onClick={() => void change({ kind: 'revoke', tool: grant.tool })}>Take back</button>
                </span>
              ))}
              {GRANT_TOOLS.filter((tool) => !grants.some((g) => g.tool === tool)).map((tool) => (
                <button key={tool} type="button" className={LINK} disabled={busy} onClick={() => void change({ kind: 'grant', tool })}>Lend {TOOL_NAME[tool]} for 1 h</button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
