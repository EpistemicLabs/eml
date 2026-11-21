// Hand over: give a task to an agent now, at a time, or work on it together in a desk. The owner stays.
// An open question is never dropped: the dialog says so, and the host carries it into the brief.
import { useState } from 'react';

import { BUTTON, Dialog, DialogContent, DialogTitle, FOCUS, LABEL, PRIMARY } from '@/shared/view/ui';
import { agentName, readable, snoozeTimes, type BoardTask, type HandOverInput, type HandOverMode } from '@/lib/task-board';
import { cn } from '@/lib/utils';

type When = 'tomorrow' | 'monday' | 'pick';
type Repeat = 'once' | 'weekdays' | 'mondays';

const CHECKPOINTS = {
  after: 'the agent does it, then hands you the result to review',
  before: 'the agent prepares, then asks for your go',
  none: 'the agent runs to the end on its own',
} as const;
type Checkpoint = keyof typeof CHECKPOINTS;

const MODES: Array<[HandOverMode, string, string]> = [['now', 'Delegate now', 'agent starts'], ['schedule', 'Schedule', 'agent starts later'], ['together', 'Work on it now', 'with an agent']];
const PILL = cn('min-h-(--target-comfortable) rounded-full border border-border bg-card px-3 text-body aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background', FOCUS);
const FIELD = 'rounded-lg border border-input bg-background px-2 py-1.5 text-body text-foreground';
const RADIO = 'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-xl border border-border px-2.5 py-2 text-body has-checked:border-foreground has-checked:bg-muted';
const NEW_DESK = '__new';

const pad = (n: number) => String(n).padStart(2, '0');
const localStamp = (iso: string) => { const d = new Date(iso); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };

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
  const times = snoozeTimes(now);
  const [mode, setMode] = useState<HandOverMode>(initialMode);
  const [agent, setAgent] = useState(task.delegate && agents.includes(task.delegate) ? task.delegate : agents[0] ?? '');
  const [checkpoint, setCheckpoint] = useState<Checkpoint>((task.checkpoint as Checkpoint | undefined) ?? 'after');
  const [choosing, setChoosing] = useState(false);
  const [when, setWhen] = useState<When>('tomorrow');
  const [picked, setPicked] = useState(localStamp(times.tomorrow));
  const [repeat, setRepeat] = useState<Repeat>('once');
  const [desk, setDesk] = useState(desks[0]?.id ?? NEW_DESK);
  const [deskName, setDeskName] = useState(readable(task.title));
  const question = task.group === 'asked' ? task.waitingOn?.why : undefined;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const schedule = (): HandOverInput['schedule'] => {
    const at = when === 'pick' ? `${picked.date}T${picked.time}` : (() => { const s = localStamp(when === 'tomorrow' ? times.tomorrow : times.monday); return `${s.date}T${s.time}`; })();
    if (repeat === 'once') return { at, timeZone };
    const [hour, minute] = at.slice(11, 16).split(':').map(Number);
    return { cron: `${minute} ${hour} * * ${repeat === 'weekdays' ? '1-5' : '1'}`, timeZone };
  };

  const submit = () => {
    if (!agent) return;
    const input: HandOverInput = { mode, delegate: agent, checkpoint, ...(mode === 'schedule' ? { schedule: schedule() } : {}) };
    const chosen = mode !== 'together' ? null : desk === NEW_DESK ? { name: deskName.trim() || readable(task.title) } : { id: desk };
    if (mode === 'together') input.desk = chosen && 'name' in chosen ? chosen.name : desks.find((d) => d.id === desk)?.name ?? 'Main';
    onSubmit(input, chosen);
  };

  const go = (mode === 'now' ? `Delegate to ${agentName(agent)}` : mode === 'schedule' ? 'Schedule' : 'Open the panel') + (question ? ' anyway' : '');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-labelledby="hand-over-title" className="glass-thick flex max-h-full w-full max-w-dialog flex-col overflow-y-auto rounded-3xl shadow-modal">
        <DialogTitle className="sr-only">Hand over</DialogTitle>
        <header className="flex items-start gap-2.5 px-5 pt-4">
          <h3 id="hand-over-title" className="m-0 flex-1 text-title font-semibold">Hand over</h3>
          <button type="button" onClick={onClose} aria-label="Close" className={cn(BUTTON, 'min-h-(--target-min) px-2')}>×</button>
        </header>
        <div className="px-5 pb-3 pt-0.5 text-ui text-muted-foreground">{readable(task.title)} · owner stays <b className="text-foreground">{task.owner ? 'you' : 'nobody'}</b></div>
        <div className="grid grid-cols-3 border-y border-border">
          {MODES.map(([m, label, small]) => (
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
                        <input type="date" aria-label="Date" value={picked.date} min={localStamp(new Date(now).toISOString()).date} onChange={(e) => setPicked({ ...picked, date: e.target.value })} className={FIELD} />
                        <input type="time" aria-label="Time" value={picked.time} onChange={(e) => setPicked({ ...picked, time: e.target.value })} className={FIELD} />
                      </div>
                    )}
                  </div>
                  <label className="flex flex-col gap-1.5">
                    <span className={LABEL}>Repeat</span>
                    <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} className={FIELD}>
                      <option value="once">Once</option><option value="weekdays">Every weekday</option><option value="mondays">Every Monday</option>
                    </select>
                  </label>
                </>
              )}
              <div className="flex flex-col gap-1.5">
                <span className={LABEL}>Checkpoint</span>
                {choosing ? (
                  <div role="radiogroup" className="flex flex-col gap-1.5">
                    {(Object.keys(CHECKPOINTS) as Checkpoint[]).map((k) => (
                      <label key={k} className={RADIO}>
                        <input type="radio" name="checkpoint" value={k} checked={checkpoint === k} onChange={() => setCheckpoint(k)} className="mt-1" />
                        <span><b>{k}</b><small className="block text-ui text-muted-foreground">{CHECKPOINTS[k]}</small></span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 text-body">
                    <span>{checkpoint}: {CHECKPOINTS[checkpoint]}</span>
                    <button type="button" onClick={() => setChoosing(true)} className={cn('min-h-(--target-min) text-ui text-mark-ink underline underline-offset-2', FOCUS)}>change</button>
                  </div>
                )}
              </div>
              <p className="m-0 text-caption text-muted-foreground">
                {mode === 'now'
                  ? `${agentName(agent)} starts in the background once the few seconds to undo are over. You stay the owner; the card moves to Agent working, then to Review.`
                  : `A job starts ${agentName(agent)} on this task at that time. Until then the card sits in Agent scheduled with the date.`}
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <span className={LABEL}>Open the panel in which desk?</span>
                <div role="radiogroup" className="flex flex-col gap-1.5">
                  {desks.map((d) => (
                    <label key={d.id} className={RADIO}>
                      <input type="radio" name="desk" value={d.id} checked={desk === d.id} onChange={() => setDesk(d.id)} className="mt-1" />
                      <span><b>{d.name}</b></span>
                    </label>
                  ))}
                  <label className={RADIO}>
                    <input type="radio" name="desk" value={NEW_DESK} checked={desk === NEW_DESK} onChange={() => setDesk(NEW_DESK)} className="mt-1" />
                    <span>
                      <b>New desk</b>
                      {desk === NEW_DESK
                        ? <input type="text" aria-label="Desk name" value={deskName} onChange={(e) => setDeskName(e.target.value)} className={cn(FIELD, 'mt-1.5 w-full')} />
                        : <small className="block text-ui text-muted-foreground">a fresh desk just for this task</small>}
                    </span>
                  </label>
                </div>
              </div>
              <p className="m-0 text-caption text-muted-foreground">A session starts on the task with its journal and last handoff, in a new pane on that desk. You work on it together; you stay the owner.</p>
            </>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 pb-4 pt-3">
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={PRIMARY} onClick={submit} disabled={!agent && mode !== 'together'}>{go}</button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
