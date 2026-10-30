// Cockpit addition: a status bar under every terminal
// and chat pane — when the last message was, which model answered, how much context
// the last turn carried. All three come from the session transcript the
// host reads (session-summary.ts); the list refreshes with the projects poll.
// A chat pane knows model and context live and passes them in.
import { useEffect, useState, type ReactNode } from 'react';
import { Clock, Cpu, Gauge } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ProjectSession } from '@/types/app';

type TerminalStatusBarProps = {
  session: ProjectSession | null;
  /** Fresher than the transcript; a field that is null falls back to it. */
  live?: { model: string | null; contextTokens: number | null; contextWindow: number | null };
  /** Takes the model's place: a picker instead of a label. */
  modelSlot?: ReactNode;
  className?: string;
};

const MODEL_LABELS: Array<[RegExp, string]> = [
  [/fable-5-5/, 'Fable 5.5'],
  [/fable-5-1/, 'Fable 5.1'],
  [/fable-5/, 'Fable 5'],
  [/mythos-5-1/, 'Mythos 5.1'],
  [/opus-5-5/, 'Opus 5.5'],
  [/opus-5/, 'Opus 5'],
  [/opus-4-8/, 'Opus 4.8'],
  [/opus-4-7/, 'Opus 4.7'],
  [/opus-4-6/, 'Opus 4.6'],
  [/sonnet-5-5/, 'Sonnet 5.5'],
  [/sonnet-5/, 'Sonnet 5'],
  [/sonnet-4-6/, 'Sonnet 4.6'],
  [/haiku-5-5/, 'Haiku 5.5'],
  [/haiku-4-5/, 'Haiku 4.5'],
];

export function modelLabel(model: string): string {
  for (const [pattern, label] of MODEL_LABELS) {
    if (pattern.test(model)) return model.includes('[1m]') ? `${label} (1M)` : label;
  }
  return model;
}

// Context window per model family (verified against `/context` in the
// cockpit 2026-09-21: Sonnet 5 and Fable 5.1 report 1m). The current
// generation — Fable 5/5.1, Mythos 5/5.1, Opus 5/4.8/4.7/4.6, Sonnet 5/4.6 —
// has 1M; Haiku 4.5 and the 4.5 generation have 200k.
function contextWindow(model: string | null | undefined): number {
  if (!model) return 1_000_000;
  if (/haiku-4-5|sonnet-4-5|opus-4-5|sonnet-3|opus-3|haiku-3/.test(model)) return 200_000;
  return 1_000_000;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

// Date + time of the last message: "21 Sep 01:54 PM" (today keeps the date
// too — it should always be visible).
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function formatAge(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const minutes = Math.floor(Math.max(0, now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function TerminalStatusBar({ session, live, modelSlot, className }: TerminalStatusBarProps) {
  // Minute clock so the relative age stays honest without re-fetching.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const lastMessageAt = session?.lastMessageAt ?? null;
  const model = live?.model ?? session?.model ?? null;
  const contextTokens = live?.contextTokens ?? session?.contextTokens ?? null;
  const window_ = live?.contextWindow ?? contextWindow(model);
  const contextPct = contextTokens !== null ? Math.min(100, Math.round((contextTokens / window_) * 100)) : null;

  // One line, always: nothing wraps, the content stays
  // complete — model and context (tokens / window · percent, no bar since
  // 2026-09-22) never shrink. The only concession as the
  // pane narrows: below 32rem the date+time drops and the left column shows
  // just the relative age ("5h ago"). Container query on the bar itself.
  // Column model: the left column is the only one allowed to shrink (and
  // clips); the right column keeps at least its content width.
  return (
    <div className={cn('@container flex-shrink-0 border-t border-foreground/15 px-2 pt-1.5 text-caption text-foreground', className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-2 whitespace-nowrap">
        {/* left: when · middle: model · right: context */}
        <span className="flex min-w-0 items-center gap-1.5 justify-self-start" title="Last message">
          <Clock className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />
          {lastMessageAt ? (
            <span className="truncate">
              <span className="hidden @lg:inline">{formatClock(lastMessageAt)} · </span>
              {formatAge(lastMessageAt, now)}
            </span>
          ) : (
            <span className="truncate">no messages yet</span>
          )}
        </span>

        {modelSlot ?? (
          <span className="flex items-center gap-1.5 justify-self-center" title={model ?? 'Model unknown until the first turn'}>
            <Cpu className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />
            <span>{model ? modelLabel(model) : '—'}</span>
          </span>
        )}

        <span className="flex items-center gap-1.5 justify-self-end" title="Context at the last turn (input + cache tokens) / window">
          <Gauge className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />
          {contextTokens !== null ? (
            <>
              <span>{formatTokens(contextTokens)}</span>
              <span>/ {formatTokens(window_)} · {contextPct}%</span>
            </>
          ) : (
            <span>—</span>
          )}
        </span>
      </div>
    </div>
  );
}
