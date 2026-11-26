// A sign-in the host runs with an agent CLI, without a terminal (host:
// /api/providers/:id/sign-in, domain AgentSignIn). The user opens the sign-in
// page in a tab of their own; Claude Code's page ends with a code the user
// pastes here, Codex's page asks for the code shown here and finishes by
// itself. Settings › Models and the first-run card both use it.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';

import { Button, Input, LINK } from '@/shared/view/ui';

export type SignInAttempt = {
  id: string;
  state: 'waiting' | 'checking' | 'done' | 'failed' | 'cancelled';
  url: string;
  userCode: string | null;
  takesCode: boolean;
  error: string | null;
};

// How often an open attempt is read again: it can end without this page (Codex
// finishing, Claude Code taking a sign-in in a browser on the host's computer).
const POLL_MS = 2500;

async function call(path: string, init?: RequestInit): Promise<SignInAttempt> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body as SignInAttempt;
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export default function AgentSignIn({
  provider,
  label = 'Sign in',
  disabled = false,
  onDone,
  wide = false,
}: {
  provider: 'claude' | 'codex';
  label?: string;
  disabled?: boolean;
  /** The sign-in is stored: read the status again. */
  onDone: () => void;
  /** The start button takes the full width (the first-run card). */
  wide?: boolean;
}) {
  const base = `/api/providers/${provider}/sign-in`;
  const [attempt, setAttempt] = useState<SignInAttempt | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const qc = useQueryClient();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const open = attempt !== null && (attempt.state === 'waiting' || attempt.state === 'checking');

  useEffect(() => {
    if (!attempt || attempt.state !== 'waiting') return;
    const timer = window.setInterval(() => {
      call(`${base}/${attempt.id}`)
        .then((next) => { if (next.state !== 'waiting') setAttempt((now) => (now?.id === next.id && now.state === 'waiting' ? next : now)); })
        .catch(() => { /* the host is away for a moment; the next read tells */ });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [attempt, base]);

  useEffect(() => {
    if (attempt?.state !== 'done') return;
    // Every place that shows whether a provider is signed in (the host forgot its cached answer).
    void qc.invalidateQueries({ queryKey: ['agent-providers'] });
    doneRef.current();
  }, [attempt?.state, qc]);

  const run = async (request: () => Promise<SignInAttempt>) => {
    setBusy(true);
    setError(null);
    try {
      setAttempt(await request());
    } catch (e) {
      setError((e as Error).message || 'The cockpit host is not reachable.');
    } finally {
      setBusy(false);
    }
  };

  const start = () => { setCode(''); setCopied(false); void run(() => call(base, post())); };
  const submit = () => { if (attempt) void run(() => call(`${base}/${attempt.id}/code`, post({ code }))).then(() => setCode('')); };
  const cancel = () => {
    if (!attempt) return;
    void fetch(`${base}/${attempt.id}`, { method: 'DELETE' }).catch(() => {});
    setAttempt(null);
    setCode('');
    setError(null);
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  };

  if (attempt?.state === 'done') return <p className="text-body text-muted-foreground">Signed in.</p>;

  if (!open) {
    const failed = attempt?.state === 'failed' ? attempt.error ?? 'The sign-in did not finish.' : null;
    return (
      <div className="space-y-2">
        <Button size={wide ? 'default' : 'sm'} className={wide ? 'w-full' : undefined} disabled={busy || disabled} onClick={start}>
          {busy ? 'Starting…' : failed ? 'Try again' : label}
        </Button>
        {(failed || error) && <p className="text-body text-stopped-ink">{failed ?? error}</p>}
      </div>
    );
  }

  const page = (
    <a href={attempt.url} target="_blank" rel="noreferrer" className={`${LINK} inline-flex items-center gap-1`}>
      Open the sign-in page <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );

  return (
    <div className="space-y-3 text-body">
      {attempt.takesCode ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>{page}</li>
            <li>Sign in there. The page then shows a code: copy it.</li>
            <li>Paste the code here.</li>
          </ol>
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (code.trim()) submit(); }}>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Code from the sign-in page"
              placeholder="Code from the sign-in page"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={attempt.state === 'checking'}
              className="flex-1 font-code text-ui"
            />
            <Button type="submit" size="sm" disabled={busy || !code.trim() || attempt.state === 'checking'}>
              {attempt.state === 'checking' ? 'Checking…' : 'Finish'}
            </Button>
          </form>
        </>
      ) : (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>{page}</li>
            <li>Sign in there and enter this code when the page asks for it:</li>
          </ol>
          <div className="flex items-center gap-2 pl-5">
            <span className="rounded-md border border-border bg-card px-3 py-1 font-code text-heading tracking-wider text-foreground">{attempt.userCode}</span>
            <Button size="sm" variant="ghost" onClick={() => void copy(attempt.userCode ?? '')}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
          <p className="text-muted-foreground">This finishes by itself once you have signed in on that page.</p>
        </>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={cancel} disabled={attempt.state === 'checking'}>Cancel</Button>
      </div>
      {error && <p className="text-stopped-ink">{error}</p>}
    </div>
  );
}
