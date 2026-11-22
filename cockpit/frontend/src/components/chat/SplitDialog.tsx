// Split off a new task: the topic leaves this chat for a task (and a session) of its own. The brief is
// drafted for the person (a quick model call over the last turns, or the agent's own offer) and stays
// editable; the new session gets the brief, not the whole chat.
import { useEffect, useState } from 'react';

import { draftSplit, splitOff, type SplitAnswer, type SplitContext, type SplitDraft, type SplitRelation, type SplitWhen } from '@/lib/split';
import { cn } from '@/lib/utils';
import { BUTTON, Dialog, DialogContent, DialogTitle, Input, LABEL, PRIMARY, RadioCard, Select, Textarea } from '@/shared/view/ui';

const RELATIONS: Array<[SplitRelation, string, string]> = [
  ['spun', 'Spun off', 'Own task, top level. Linked to this one as its origin.'],
  ['sub', 'Sub-task', 'This task can\'t close until it\'s done.'],
  ['unrelated', 'Unrelated', 'Own task, no link. Its journal notes where it came up.'],
];
const WHENS: Array<[SplitWhen, string, string]> = [
  ['now', 'Start now', 'Opens in a new pane on this desk.'],
  ['park', 'Park as a task', 'Shows in Plan; start it later.'],
];

export function SplitDialog({ sessionId, projectId, upTo, offered, onClose, onDone }: {
  sessionId: string;
  /** The chat's project: the default when the draft names none. */
  projectId: string;
  /** The chat item the split starts from; the end of the chat when left out. */
  upTo?: string;
  /** A draft the agent wrote itself (offer_split): no model call then. */
  offered?: SplitDraft;
  onClose: () => void;
  onDone: (result: Extract<SplitAnswer, { ok: true }> & { title: string; when: SplitWhen }) => void;
}) {
  const [drafting, setDrafting] = useState(!offered);
  const [note, setNote] = useState<string | null>(null);
  const [context, setContext] = useState<SplitContext | null>(null);
  const [title, setTitle] = useState(offered?.title ?? '');
  const [relation, setRelation] = useState<SplitRelation>(offered?.relation ?? 'spun');
  const [project, setProject] = useState(offered?.projectId ?? projectId);
  const [brief, setBrief] = useState(offered?.brief ?? '');
  const [when, setWhen] = useState<SplitWhen>('now');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void draftSplit(sessionId, upTo).then((answer) => {
      if (!current) return;
      setContext(answer.context);
      if (!offered) {
        if (answer.ok) {
          setTitle(answer.draft.title);
          setRelation(answer.draft.relation);
          if (answer.draft.projectId) setProject(answer.draft.projectId);
          setBrief(answer.draft.brief);
        } else setNote(`${answer.message.replace(/[.!?]?$/, '.')} Write the brief yourself.`);
      }
      setDrafting(false);
    });
    return () => { current = false; };
  }, [sessionId, upTo, offered]);

  // Where the task system is off there is no task to link: the new session only remembers this one.
  const linksTasks = context?.taskSystem ?? true;
  const relations = RELATIONS.filter(([r]) => r !== 'sub' || (context?.hasTask ?? true));
  const projects = context?.projects.length ? context.projects : [{ id: projectId, name: 'This project' }];
  const ready = title.trim() !== '' && brief.trim() !== '' && !drafting && !sending;

  const submit = async () => {
    if (!ready) return;
    setSending(true);
    setError(null);
    const answer = await splitOff(sessionId, { title: title.trim(), brief: brief.trim(), relation: linksTasks ? relation : 'unrelated', when, projectId: project });
    setSending(false);
    if (!answer.ok) { setError(answer.message); return; }
    onDone({ ...answer, title: title.trim(), when });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-labelledby="split-title" className="glass-thick flex max-h-full w-full max-w-dialog flex-col overflow-y-auto rounded-3xl shadow-modal">
        <DialogTitle className="sr-only">Split off a new task</DialogTitle>
        <header className="flex items-start gap-2.5 px-5 pt-4">
          <h3 id="split-title" className="m-0 flex-1 text-title font-semibold">Split off a new task</h3>
          <button type="button" onClick={onClose} aria-label="Close" className={cn(BUTTON, 'min-h-(--target-min) px-2')}>×</button>
        </header>
        <p className="m-0 px-5 pt-0.5 pb-3 text-ui text-muted-foreground">The new session gets this brief, not the whole chat.</p>
        <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={drafting ? 'Writing a draft…' : 'What the new topic is'} />
          </label>
          {linksTasks ? (
            <div className="flex flex-col gap-1.5">
              <span id="split-relation" className={LABEL}>How it relates</span>
              <div role="radiogroup" aria-labelledby="split-relation" className="flex flex-col gap-1.5">
                {relations.map(([r, name, line]) => (
                  <RadioCard key={r} name="split-relation" value={r} checked={relation === r} onChange={() => setRelation(r)} title={name} description={line} />
                ))}
              </div>
            </div>
          ) : (
            <p className="m-0 text-ui text-muted-foreground">This space has no task system: the new session remembers this one, and parking makes a plain task.</p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Project</span>
            <Select value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>Brief</span>
              <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={7} aria-busy={drafting} aria-describedby="split-brief-status" placeholder={drafting ? 'Writing the brief from the last turns…' : 'Goal, what is decided, what is open'} />
            </label>
            <span id="split-brief-status" role="status" className="text-caption text-muted-foreground">
              {drafting ? 'Writing the brief from the last turns…' : note ?? (offered ? 'Written by the agent.' : 'Drafted from the last turns. Change what is wrong.')}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span id="split-when" className={LABEL}>When</span>
            <div role="radiogroup" aria-labelledby="split-when" className="flex flex-col gap-1.5">
              {WHENS.map(([w, name, line]) => (
                <RadioCard key={w} name="split-when" value={w} checked={when === w} onChange={() => setWhen(w)} title={name} description={line} />
              ))}
            </div>
          </div>
          {error && <p role="alert" className="m-0 text-ui text-stopped-ink">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 pb-4 pt-3">
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={PRIMARY} onClick={() => { void submit(); }} disabled={!ready}>{sending ? 'Splitting off…' : 'Split off'}</button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
