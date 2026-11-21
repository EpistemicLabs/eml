import { useCallback, useEffect, useState } from 'react';
import { Check, Save, Send, X } from 'lucide-react';

import { SESSIONS_CHANGED_EVENT } from '@/lib/session-actions';
import { decideDraft, listDrafts, saveDraft, type Draft } from '@/lib/drafts';
import { cn } from '@/lib/utils';
import { buttonVariants, FIELD, FOCUS } from '@/shared/view/ui';

const BUTTON = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1 px-2.5 font-normal');
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
    <div className="max-h-(--size-drafts) flex-shrink-0 space-y-2 overflow-y-auto border-b border-border bg-muted px-3 py-2" aria-label="Drafts">
      {error && <p role="alert" className="text-caption text-stopped-ink">{error}</p>}
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
    <div className="rounded-lg border border-border bg-card p-2 text-ui shadow-card">
      <p className="truncate text-muted-foreground">
        Draft to <span className="font-medium text-foreground">{draft.to}</span>
        {draft.subject ? ` · ${draft.subject}` : ''}
      </p>
      {draft.replyTo && (
        <details className="mt-1">
          <summary className={cn("cursor-pointer select-none rounded-sm text-muted-foreground", FOCUS)}>
            Answers {draft.replyTo.from} · {new Date(draft.replyTo.receivedAt).toLocaleString()}
          </summary>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-sans text-caption text-muted-foreground">
            {draft.replyTo.text}
          </pre>
        </details>
      )}
      <textarea
        className={cn(FIELD, "mt-1.5 min-h-24 resize-y p-2 text-ui")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={busy}
        aria-label="Draft text"
      />
      {error && <p role="alert" className="mt-1 text-caption text-stopped-ink">{error}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button type="button" className={cn(BUTTON, 'font-medium')} disabled={busy || !text.trim()} onClick={send}>
          {confirming ? <Check aria-hidden className="size-3.5" /> : <Send aria-hidden className="size-3.5" />}
          {confirming ? `Press again to send to ${draft.to}` : 'Send'}
        </button>
        <button type="button" className={BUTTON} disabled={busy || !edited || !text.trim()} onClick={() => void run(() => saveDraft(draft.outboxId, text))}>
          <Save aria-hidden className="size-3.5" /> Save
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(() => decideDraft(draft.outboxId, 'skip'))}>
          <X aria-hidden className="size-3.5" /> Skip
        </button>
      </div>
    </div>
  );
}
