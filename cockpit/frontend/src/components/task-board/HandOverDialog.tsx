// Hand over: give a task to an agent now, at a time, or work on it together in a desk. The owner stays.
// Schedule writes the task's schedule: one time is its wake-up (a task has one, so it replaces the one set), Repeat
// adds a repeating time to those it has. A repeating time starts a new session, a wake-up continues the task's.
// An open question is never dropped: the dialog says so, and the host carries it into the brief.
// Delegate now continues the task's own session when it has one the agent can carry on in, or starts a new one when
// the owner chooses Start fresh; the dialog says which happens. On a task the agent works on alone, with its own
// session, working on it yourself is Take over: that session opens, no new one starts.
import { useState } from 'react';

import { BUTTON, Dialog, DialogContent, DialogTitle, FOCUS, LABEL, LINK, PRIMARY, RadioCard } from '@/shared/view/ui';
import { agentName, type BoardTask, type HandOverInput, type HandOverMode, scheduleZone, snoozeTimes, taskName, when as whenText } from '@/lib/task-board';
import { inputStamp, useTimeZone } from '@/lib/time-zone';
import { cn } from '@/lib/utils';

type When = 'tomorrow' | 'monday' | 'pick';
type Repeat = 'weekdays' | 'mondays';
/** What happens after the first run: nothing more, the agent keeps checking until the goal is reached, or it repeats. */
type Then = 'once' | 'goal' | 'repeat';

const CHECKPOINTS = {
  after: 'the agent does it, then hands you the result to review',
  before: 'the agent prepares, then asks for your go',
  none: 'the agent runs to the end on its own',
} as const;
type Checkpoint = keyof typeof CHECKPOINTS;

const modes = (takeOver: boolean): Array<[HandOverMode, string, string]> => [
  ['now', 'Delegate now', 'agent starts'], ['schedule', 'Schedule', 'agent starts later'],
  takeOver ? ['together', 'Take over', 'its session opens'] : ['together', 'Work on it now', 'with an agent'],
];
const PILL = cn('min-h-(--target-comfortable) rounded-full border border-border bg-card px-3 text-body aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background', FOCUS);
const FIELD = 'rounded-lg border border-input bg-background px-2 py-1.5 text-body text-foreground';
const NEW_DESK = '__new';


export function HandOverDialog({ task, mode: initialMode, agents, desks, now, onClose, onAnswerFirst, onSubmit }: {
  task: BoardTask;
  mode: HandOverMode;
  /** The agents of the task's space; its current delegate first. */
  agents: string[];
  desks: Array<{ id: string; name: string }>;
  now: number;
  onClose: () => void;
  onAnswerFirst: () => void;
  onSubmit: (input: HandOverInput, desk: { id: string } | { name: string } | null) => void;
}) {
  // Every time here is read in the user's time zone (Settings), not the browser's: the host reads it so too.
  const { zone: timeZone } = useTimeZone();
  const times = snoozeTimes(now, timeZone);
  const localStamp = (iso: string) => inputStamp(Date.parse(iso), timeZone);
  const [mode, setMode] = useState<HandOverMode>(initialMode);
  const preferred = task.delegate ?? task.handTo;
  const [agent, setAgent] = useState(preferred && agents.includes(preferred) ? preferred : agents[0] ?? '');
  const [checkpoint, setCheckpoint] = useState<Checkpoint>((task.checkpoint as Checkpoint | undefined) ?? 'after');
  const [choosing, setChoosing] = useState(false);
  const [when, setWhen] = useState<When>('tomorrow');
  const [picked, setPicked] = useState(localStamp(times.tomorrow));
  const [then, setThen] = useState<Then>('once');
  const [repeat, setRepeat] = useState<Repeat>('weekdays');
  const [desk, setDesk] = useState(desks[0]?.id ?? NEW_DESK);
  const [deskName, setDeskName] = useState(taskName(task));
  // The task's own session goes on unless the owner starts fresh (only when there is one the agent can carry on in).
  const continuable = task.ownSession?.continues === true;
  const [fresh, setFresh] = useState(false);
  // The host takes over the task's own session whenever it has one (host domain/hand-over.ts), delegated or not.
  const takeOver = Boolean(task.ownSession);
  const question = task.group === 'asked' ? task.waitingOn?.why : undefined;
  // A task's repeating times share one zone (the host's rule): one more joins it, whatever zone the user reads in.
  const otherZone = task.schedule?.crons?.length ? scheduleZone(task.schedule, timeZone) : null;

  const schedule = (): HandOverInput['schedule'] => {
    const at = when === 'pick' ? `${picked.date}T${picked.time}` : (() => { const s = localStamp(when === 'tomorrow' ? times.tomorrow : times.monday); return `${s.date}T${s.time}`; })();
    if (then !== 'repeat') return { at, timeZone, ...(then === 'goal' ? { untilGoal: true } : {}) };
    const [hour, minute] = at.slice(11, 16).split(':').map(Number);
    return { cron: `${minute} ${hour} * * ${repeat === 'weekdays' ? '1-5' : '1'}`, timeZone };
  };

  const submit = () => {
    if (!agent) return;
    const input: HandOverInput = { mode, delegate: agent, checkpoint, ...(mode === 'schedule' ? { schedule: schedule() } : {}), ...(mode === 'now' && continuable && fresh ? { fresh: true } : {}) };
    const chosen = mode !== 'together' ? null : desk === NEW_DESK ? { name: deskName.trim() || taskName(task) } : { id: desk };
    if (mode === 'together') input.desk = chosen && 'name' in chosen ? chosen.name : desks.find((d) => d.id === desk)?.name ?? 'Main';
    onSubmit(input, chosen);
  };

  const go = (mode === 'now' ? `Delegate to ${agentName(agent)}` : mode === 'schedule' ? 'Schedule' : takeOver ? 'Take over' : 'Open the panel') + (question ? ' anyway' : '');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-labelledby="hand-over-title" className="glass-thick flex max-h-full w-full max-w-dialog flex-col overflow-y-auto rounded-3xl shadow-modal">
        <DialogTitle className="sr-only">Hand over</DialogTitle>
        <header className="flex items-start gap-2.5 px-5 pt-4">
          <h3 id="hand-over-title" className="m-0 flex-1 text-title font-semibold">Hand over</h3>
          <button type="button" onClick={onClose} aria-label="Close" className={cn(BUTTON, 'min-h-(--target-min) px-2')}>×</button>
        </header>
        <div className="px-5 pb-3 pt-0.5 text-ui text-muted-foreground">{taskName(task)} · owner stays <b className="text-foreground">{task.owner ? 'you' : 'nobody'}</b></div>
        <div className="grid grid-cols-3 border-y border-border">
          {modes(takeOver).map(([m, label, small]) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
              className={cn('flex flex-col items-center gap-0.5 border-b-2 border-transparent px-2 py-2.5 text-body text-muted-foreground aria-pressed:border-foreground aria-pressed:font-semibold aria-pressed:text-foreground', FOCUS)}>
              {label}<small className="text-caption">{small}</small>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {question && (
            <div className="flex flex-col gap-2 rounded-xl border border-status-you/40 bg-status-you/10 px-3 py-2.5 text-body">
              <span><b className="text-you-ink">{agentName(task.delegate)} asked you something that is still open:</b> {question}</span>
              <span>Answer it first, or hand over anyway: the question goes into the brief and stays in the journal.</span>
              <span><button type="button" className={BUTTON} onClick={onAnswerFirst}>Answer first</button></span>
            </div>
          )}
          {mode !== 'together' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <span className={LABEL}>Agent</span>
                <div className="flex flex-wrap gap-1.5">
                  {agents.length === 0 && <span className="text-ui text-muted-foreground">This space has no agent.</span>}
                  {agents.map((a) => <button key={a} type="button" aria-pressed={agent === a} onClick={() => setAgent(a)} className={PILL}>{agentName(a)}</button>)}
                </div>
              </div>
              {mode === 'schedule' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL}>When</span>
                    <div className="flex flex-wrap gap-1.5">
                      {([['tomorrow', 'Tomorrow 09:00'], ['monday', 'Monday 09:00'], ['pick', 'Pick a date…']] as Array<[When, string]>).map(([k, label]) => (
                        <button key={k} type="button" aria-pressed={when === k} onClick={() => setWhen(k)} className={PILL}>{label}</button>
                      ))}
                    </div>
                    {when === 'pick' && (
                      <div className="flex flex-wrap gap-2">
                        <input type="date" aria-label="Date" value={picked.date} min={inputStamp(now, timeZone).date} onChange={(e) => setPicked({ ...picked, date: e.target.value })} className={FIELD} />
                        <input type="time" aria-label="Time" value={picked.time} onChange={(e) => setPicked({ ...picked, time: e.target.value })} className={FIELD} />
                        <span className="self-center text-caption text-muted-foreground">{timeZone}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL}>Then</span>
                    <div className="flex flex-wrap gap-1.5">
                      {([['once', 'Once'], ['goal', 'Until the goal is reached'], ['repeat', 'Repeat…']] as Array<[Then, string]>).map(([k, label]) => (
                        <button key={k} type="button" aria-pressed={then === k} onClick={() => setThen(k)} className={PILL}>{label}</button>
                      ))}
                    </div>
                    {then === 'repeat' && (
                      <select aria-label="Repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} className={FIELD}>
                        <option value="weekdays">Every weekday</option><option value="mondays">Every Monday</option>
                      </select>
                    )}
                    {then === 'goal' && (
                      <p className="m-0 text-caption text-muted-foreground">
                        {task.goal
                          ? <>Goal: {task.goal} {agentName(agent)} checks the goal each time it wakes up. If it isn't reached, it sets its own next check and says why.</>
                          : <>The task has no goal yet: set one first (say in the chat what has to be true), then schedule it until the goal is reached.</>}
                      </p>
                    )}
                  </div>
                </>
              )}
              <div className="flex flex-col gap-1.5">
                <span className={LABEL}>Checkpoint</span>
                {choosing ? (
                  <div role="radiogroup" className="flex flex-col gap-1.5">
                    {(Object.keys(CHECKPOINTS) as Checkpoint[]).map((k) => (
                      <RadioCard key={k} name="checkpoint" value={k} checked={checkpoint === k} onChange={() => setCheckpoint(k)} title={k} description={CHECKPOINTS[k]} />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 text-body">
                    <span>{checkpoint}: {CHECKPOINTS[checkpoint]}</span>
                    <button type="button" onClick={() => setChoosing(true)} className={LINK}>change</button>
                  </div>
                )}
              </div>
              {mode === 'now' && continuable && (
                <div className="flex flex-col gap-1.5">
                  <span className={LABEL}>Session</span>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" aria-pressed={!fresh} onClick={() => setFresh(false)} className={PILL}>Continue its session</button>
                    <button type="button" aria-pressed={fresh} onClick={() => setFresh(true)} className={PILL}>Start fresh</button>
                  </div>
                </div>
              )}
              <p className="m-0 text-caption text-muted-foreground">
                {mode === 'now'
                  ? `${continuable && !fresh
                    ? `${agentName(agent)} carries on in the task's session, with what was said there, once the few seconds to undo are over.`
                    : `${agentName(agent)} starts in a new session${task.ownSession && !continuable ? ` (${task.ownSession.why === 'terminal' ? 'its session runs in a terminal' : task.ownSession.why === 'long_context' ? 'its session is very long' : 'its session cannot carry on'})` : ''}, from the task's journal, once the few seconds to undo are over.`} You stay the owner; the card moves to Agent working, then to Review.`
                  : then === 'goal'
                    ? `${agentName(agent)} starts then and keeps going until the goal is reached. Until then the task sits in Agent scheduled under Missions, on every device and for every member. You're asked only for a question, a review or a failed run.`
                    : then === 'repeat'
                      ? `${agentName(agent)} works on it on that rhythm until you end it, each time in a new session.${task.schedule?.crons?.length ? ` The time is added to those the task repeats at${otherZone ? `, and read in their time zone (${otherZone}), not yours` : ''}.` : ''} The task sits in Agent scheduled under Routines, on every device and for every member.`
                      : `${agentName(agent)} is woken on this task at that time.${task.schedule?.at ? ` It replaces the wake-up set for ${whenText(task.schedule.at, now)}.` : ''} Until then the card sits in Agent scheduled, with the date.`}
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <span className={LABEL}>{takeOver ? 'Open its session in which desk?' : 'Open the panel in which desk?'}</span>
                <div role="radiogroup" className="flex flex-col gap-1.5">
                  {desks.map((d) => (
                    <RadioCard key={d.id} name="desk" value={d.id} checked={desk === d.id} onChange={() => setDesk(d.id)} title={d.name} />
                  ))}
                  <RadioCard name="desk" value={NEW_DESK} checked={desk === NEW_DESK} onChange={() => setDesk(NEW_DESK)} title="New desk"
                    description={desk === NEW_DESK ? undefined : 'a fresh desk just for this task'}>
                    {desk === NEW_DESK && <input type="text" aria-label="Desk name" value={deskName} onChange={(e) => setDeskName(e.target.value)} className={cn(FIELD, 'mt-1.5 w-full')} />}
                  </RadioCard>
                </div>
              </div>
              <p className="m-0 text-caption text-muted-foreground">{takeOver
                ? `The task's session opens in a new pane on that desk, and ${agentName(task.delegate)} no longer works on it alone. A turn it is in finishes first; then the session is yours.`
                : 'A session starts on the task with its journal and last handoff, in a new pane on that desk. You work on it together; you stay the owner.'}</p>
            </>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 pb-4 pt-3">
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={PRIMARY} onClick={submit} disabled={(!agent && mode !== 'together') || (mode === 'schedule' && then === 'goal' && !task.goal)}>{go}</button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
