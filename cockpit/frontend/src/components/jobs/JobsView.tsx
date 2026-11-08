// The Jobs view (header › Jobs): every space's scheduled jobs with their next
// and last runs, and pause, resume, run now and delete. Sessions make jobs with
// their schedule tool; this is where the user sees and stops them.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pause, Play, RotateCw, Trash2 } from 'lucide-react';

import { api } from '@/utils/api';
import { cn } from '@/lib/utils';
import { formatAgo, formatWhen, openSession, runLabel, type Job, type JobRun } from './jobs';

const TONE: Record<ReturnType<typeof runLabel>['tone'], string> = {
  ok: 'text-success',
  attention: 'text-warning',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

export default function JobsView() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.jobs();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { jobs: Job[]; timeZone: string | null };
      setJobs(body.jobs);
      setTimeZone(body.timeZone);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load the jobs');
    }
  }, []);

  // Runs change on the host's clock: follow it, and at once when the cockpit tells something.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    const onNotification = () => void load();
    window.addEventListener('cockpit:notification', onNotification);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('cockpit:notification', onNotification);
    };
  }, [load]);

  const spaces = jobs ? [...new Set(jobs.map((job) => job.spaceName))] : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">
      <div className="mx-auto w-full max-w-4xl">
        <h1 className="text-lg font-semibold text-foreground">Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Work the cockpit wakes a session for, on a schedule. Sessions set them up with their schedule tool; times
          read in {timeZone ?? 'your time zone'}.
        </p>
        {error && <p className="mt-4 text-sm text-destructive">Jobs could not be loaded: {error}</p>}
        {jobs && jobs.length === 0 && (
          <p className="mt-8 text-sm text-muted-foreground">
            No jobs yet. Ask an agent for something on a schedule, for example "every weekday at 8:00 write the daily brief".
          </p>
        )}
        {spaces.map((spaceName) => (
          <section key={spaceName} className="mt-6">
            {spaces.length > 1 && <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{spaceName}</h2>}
            <div className="flex flex-col gap-2">
              {jobs!.filter((job) => job.spaceName === spaceName).map((job) => <JobCard key={job.id} job={job} onChanged={load} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function JobCard({ job, onChanged }: { job: Job; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const last = job.runs.find((run) => run.status !== 'waiting' || run.number > 0);
  const state = job.endedAt ? 'Ended' : job.paused ? 'Paused' : null;
  const channels = (['mail', 'slack', 'whatsapp'] as const).filter((channel) => job.triggers.some((t) => t.type === channel));
  const [confirmSend, setConfirmSend] = useState<typeof channels[number] | null>(null);

  const decide = async (request: () => Promise<Response>) => {
    setBusy(true);
    try {
      const response = await request();
      const body = await response.json().catch(() => ({})) as { text?: string };
      setMessage(response.ok ? null : body.text ?? `HTTP ${response.status}`);
      await onChanged();
    } finally {
      setBusy(false);
      setConfirmSend(null);
    }
  };

  const act = async (action: 'pause' | 'resume' | 'delete' | 'run_now') => {
    setBusy(true);
    try {
      const response = await api.jobAction(job.id, action);
      const body = await response.json().catch(() => ({})) as { text?: string };
      setMessage(response.ok ? null : body.text ?? `HTTP ${response.status}`);
      if (action === 'run_now' && response.ok) setMessage(body.text ?? null);
      await onChanged();
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className={cn('rounded-lg border border-foreground/10 bg-foreground/[0.02] px-4 py-3', state && 'opacity-75')}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-muted-foreground hover:text-foreground" aria-label={open ? 'Hide details' : 'Show details'}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-foreground">{job.name}</span>
            {state && <span className="rounded bg-foreground/10 px-1.5 py-px text-[11px] text-muted-foreground">{state}</span>}
            {job.pendingApproval && <span className="rounded bg-warning/15 px-1.5 py-px text-[11px] text-warning">Waiting for your OK</span>}
            <span className="text-xs text-muted-foreground">{job.schedule} · wakes {job.wakes}</span>
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {job.nextRuns.length > 0 && <>Next: {job.nextRuns.map(formatWhen).join(' · ')}</>}
            {job.pausedReason && <span className="text-warning">{job.pausedReason}</span>}
          </div>
          {last && <LastRun run={last} spaceId={job.spaceId} />}
          {job.pendingApproval && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-2 py-1.5 text-sm">
              <span className="text-foreground/90">This job wants to react to {job.schedule.split(' + ').filter((part) => part.startsWith('on ')).map((part) => part.slice(3)).join(' and ')}. Mail for it waits until you approve.</span>
              <button type="button" onClick={() => void decide(() => api.approveJob(job.id))} disabled={busy} className="rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">
                Approve
              </button>
            </div>
          )}
          {channels.map((channel) => {
            const mode = job.reply[channel] ?? 'draft';
            return (
              <div key={channel} className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Replies on {channel}: <span className={mode === 'send' ? 'text-warning' : 'text-foreground/90'}>{mode === 'send' ? 'sent without asking' : 'drafts you approve'}</span></span>
                {mode === 'send' ? (
                  <button type="button" onClick={() => void decide(() => api.setJobReply(job.id, channel, 'draft'))} disabled={busy} className="text-xs text-primary hover:underline">Back to drafts</button>
                ) : confirmSend === channel ? (
                  <button type="button" onClick={() => void decide(() => api.setJobReply(job.id, channel, 'send'))} disabled={busy} className="rounded-md bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/25">
                    Yes, send without asking
                  </button>
                ) : (
                  <button type="button" onClick={() => setConfirmSend(channel)} disabled={busy} className="text-xs text-primary hover:underline">Let it send…</button>
                )}
              </div>
            );
          })}
          {message && <p className="mt-1 text-xs text-muted-foreground">{message}</p>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {!job.endedAt && (
            <IconButton label="Run now" onClick={() => void act('run_now')} disabled={busy}><RotateCw className="h-4 w-4" /></IconButton>
          )}
          {!job.endedAt && (job.paused
            ? <IconButton label="Resume" onClick={() => void act('resume')} disabled={busy}><Play className="h-4 w-4" /></IconButton>
            : <IconButton label="Pause" onClick={() => void act('pause')} disabled={busy}><Pause className="h-4 w-4" /></IconButton>)}
          {confirmDelete ? (
            <button type="button" onClick={() => void act('delete')} disabled={busy} className="rounded-md bg-destructive/15 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/25">
              Delete job
            </button>
          ) : (
            <IconButton label="Delete" onClick={() => setConfirmDelete(true)} disabled={busy}><Trash2 className="h-4 w-4" /></IconButton>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-3 border-t border-foreground/10 pt-3 pl-7 text-sm">
          <p className="mt-2 whitespace-pre-wrap text-foreground/90">{job.prompt}</p>
          <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Runs</h3>
          {job.runs.length === 0 && <p className="mt-1 text-muted-foreground">None yet.</p>}
          <ul className="mt-1 flex flex-col gap-1">
            {job.runs.map((run) => <li key={run.id}><RunLine run={run} spaceId={job.spaceId} /></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function LastRun({ run, spaceId }: { run: JobRun; spaceId: string | null }) {
  return (
    <div className="mt-1 text-sm text-muted-foreground">
      Last: <RunLine run={run} spaceId={spaceId} />
    </div>
  );
}

function RunLine({ run, spaceId }: { run: JobRun; spaceId: string | null }) {
  const label = runLabel(run);
  const when = run.startedAt ?? run.finishedAt ?? run.dueAt;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span title={formatWhen(when)}>{formatAgo(when)}</span>
      <span className={TONE[label.tone]}>{label.text}</span>
      {run.note && <span className="text-xs text-muted-foreground">({run.note})</span>}
      {run.sessionId && (
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => openSession(spaceId, run.sessionId!, run.session)}>
          open session
        </button>
      )}
    </span>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}
