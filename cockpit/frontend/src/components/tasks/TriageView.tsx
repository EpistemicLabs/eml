// Triage (host application/triage.ts): tasks sessions created on their own wait
// here until the user accepts, merges or closes them; only then do they reach
// the brain. The one place in the task views with buttons: each is the user's
// own decision about a proposal, like a confirmation tap.
import { useCallback, useEffect, useState } from 'react';

import { formatAgo } from '@/components/jobs/jobs';
import { cn } from '@/lib/utils';

export type PendingTask = {
  id: string;
  spaceId: string;
  spaceName: string | null;
  title: string;
  content: string;
  scope: string;
  source: { kind: 'session' | 'worker'; sessionId: string | null; sessionName: string | null };
  createdAt: string;
  entries: Array<{ at: string; text: string }>;
  suggestion?: { kind: 'merge'; taskId: string; title: string } | null;
};

export async function loadTriage(): Promise<PendingTask[]> {
  const res = await fetch('/api/triage').catch(() => null);
  if (!res?.ok) return [];
  return ((await res.json()) as { items: PendingTask[] }).items;
}

/** The pending tasks, newest last; refreshed while the view is open. */
export function useTriage(): { items: PendingTask[]; reload: () => Promise<void> } {
  const [items, setItems] = useState<PendingTask[]>([]);
  const reload = useCallback(async () => setItems(await loadTriage()), []);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 20_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { items, reload };
}

const where = (item: PendingTask) => (item.scope.startsWith('project.') ? item.scope.slice('project.'.length) : 'no project');
const BUTTON = 'rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50';

export function TriageView({ items, reload }: { items: PendingTask[]; reload: () => Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = items.find((i) => i.id === selectedId) ?? items[0];

  const act = async (body: Record<string, unknown>) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/triage/${encodeURIComponent(selected.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const answer = await res?.json().catch(() => null) as { error?: { message?: string } } | null;
      setError(answer?.error?.message ?? 'The cockpit did not answer.');
      return;
    }
    setSelectedId(null);
    await reload();
  };

  if (items.length === 0) {
    return <p className="mt-6 text-sm text-muted-foreground">Nothing waits for triage. Tasks sessions create on their own land here before they reach the brain.</p>;
  }
  return (
    <div className="mt-6 grid overflow-hidden rounded-lg border border-border md:grid-cols-[minmax(0,1fr)_22rem]">
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => setSelectedId(item.id)} aria-current={item.id === selected?.id ? 'true' : undefined}
              className={cn('flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-accent', item.id === selected?.id && 'bg-accent')}>
              <span className="mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full border border-dashed border-foreground/50" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{item.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {item.source.kind === 'worker' ? 'for a worker' : 'from a session'}{item.source.sessionName ? ` · ${item.source.sessionName}` : ''} · {where(item)}{item.spaceName ? ` · ${item.spaceName}` : ''}
                </span>
              </span>
              <span className="flex-shrink-0 text-[11px] text-muted-foreground">{formatAgo(item.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <section aria-label="Triage decision" className="flex flex-col gap-3 border-t border-border p-4 md:border-l md:border-t-0">
          <div>
            <p className="text-[11px] text-muted-foreground">{selected.source.sessionName ?? (selected.source.kind === 'worker' ? 'a worker' : 'a session')} · {formatAgo(selected.createdAt)}</p>
            <h3 className="mt-1 text-sm font-semibold text-foreground">{selected.title}</h3>
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{selected.content}</p>
            {selected.entries.length > 0 && <p className="mt-2 text-[11px] text-muted-foreground">{selected.entries.length} update{selected.entries.length === 1 ? '' : 's'} kept for the task it becomes.</p>}
          </div>
          {selected.suggestion && (
            <div className="rounded-md border border-border p-3 text-xs">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Looks like</p>
              <p className="mt-1 text-foreground">an open task with the same words: <b>{selected.suggestion.title}</b></p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {selected.suggestion && (
              <button type="button" disabled={busy} onClick={() => void act({ action: 'merge', taskId: selected.suggestion!.taskId })}
                className={cn(BUTTON, 'border-foreground bg-foreground text-background hover:opacity-90')}>Merge into it</button>
            )}
            <button type="button" disabled={busy} onClick={() => void act({ action: 'accept' })}
              className={cn(BUTTON, selected.suggestion ? 'text-foreground hover:bg-accent' : 'border-foreground bg-foreground text-background hover:opacity-90')}>Accept into {where(selected)}</button>
            <button type="button" disabled={busy} onClick={() => void act({ action: 'close' })} className={cn(BUTTON, 'text-muted-foreground hover:bg-accent')}>Close</button>
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <p className="text-[11px] text-muted-foreground">Anything else, such as another project, ask the session that created it.</p>
        </section>
      )}
    </div>
  );
}
