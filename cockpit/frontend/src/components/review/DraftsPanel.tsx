import { useCallback, useEffect, useState } from 'react';
import { Check, Save, Send, X } from 'lucide-react';

import { SESSIONS_CHANGED_EVENT } from '@/lib/session-actions';
import { decideDraft, listDrafts, saveDraft, type Draft } from '@/lib/drafts';
import { cn } from '@/lib/utils';

const BUTTON =
  'flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40';
// A second click within this time sends: a draft goes out to someone outside.
const CONFIRM_MS = 4_000;

/** The drafts of the channel job a session works for: what would go out, the mail it answers, and the decision. */
export function DraftsPanel({ jobId }: { jobId: string }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const answer = await listDrafts(jobId);
    setDrafts(answer.drafts);
    setError(answer.error);
  }, [jobId]);

  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener(SESSIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, reload);
  }, [load]);

  if (!error && drafts.length === 0) return null;
  return (
    <div className="max-h-[45%] flex-shrink-0 space-y-2 overflow-y-auto border-b border-border bg-muted/20 px-3 py-2" aria-label="Drafts">
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
      {drafts.map((draft) => (
        <DraftCard key={draft.outboxId} draft={draft} onDone={() => void load()} />
      ))}
    </div>
  );
}

function DraftCard({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = text !== draft.text;

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  const run = async (step: () => Promise<string | null>) => {
    setBusy(true);
    const problem = await step();
    setBusy(false);
    setError(problem);
    if (!problem) onDone();
  };

  const send = () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    void run(async () => (edited ? (await saveDraft(draft.outboxId, text)) ?? decideDraft(draft.outboxId, 'approve') : decideDraft(draft.outboxId, 'approve')));
  };

  return (
    <div className="rounded-md border border-border bg-background p-2 text-xs">
      <p className="truncate text-muted-foreground">
        Draft to <span className="font-medium text-foreground">{draft.to}</span>
        {draft.subject ? ` · ${draft.subject}` : ''}
      </p>
      {draft.replyTo && (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-muted-foreground">
            Answers {draft.replyTo.from} · {new Date(draft.replyTo.receivedAt).toLocaleString()}
          </summary>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-sans text-[11px] text-muted-foreground">
            {draft.replyTo.text}
          </pre>
        </details>
      )}
      <textarea
        className="mt-1.5 min-h-24 w-full resize-y rounded border border-border bg-background p-2 text-xs text-foreground outline-none focus:border-primary"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={busy}
        aria-label="Draft text"
      />
      {error && <p role="alert" className="mt-1 text-[11px] text-destructive">{error}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button type="button" className={cn(BUTTON, 'font-medium')} disabled={busy || !text.trim()} onClick={send}>
          {confirming ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
          {confirming ? `Press again to send to ${draft.to}` : 'Send'}
        </button>
        <button type="button" className={BUTTON} disabled={busy || !edited || !text.trim()} onClick={() => void run(() => saveDraft(draft.outboxId, text))}>
          <Save className="h-3.5 w-3.5" /> Save
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(() => decideDraft(draft.outboxId, 'skip'))}>
          <X className="h-3.5 w-3.5" /> Skip
        </button>
      </div>
    </div>
  );
}
