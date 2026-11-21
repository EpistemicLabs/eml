// The Jobs view (header › Jobs): every space's scheduled jobs with their next
// and last runs, and pause, resume, run now and delete. Sessions make jobs with
// their schedule tool; this is where the user sees and stops them.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pause, Play, RotateCw, Trash2 } from 'lucide-react';

import { api } from '@/utils/api';
import { cn } from '@/lib/utils';
import { FOCUS, LABEL, PRIMARY } from '@/shared/view/ui';
import { splitEnded } from '@/lib/job-run-label';
import { formatAgo, formatWhen, openSession, runLabel, type Job, type JobRun } from './jobs';

// Colour only for meaning: amber when the run waits for you, red when it failed; fine is plain text.
const TONE: Record<ReturnType<typeof runLabel>['tone'], string> = {
  ok: 'text-foreground',
  attention: 'text-you-ink',
  bad: 'text-stopped-ink',
  muted: 'text-muted-foreground',
};
/** An inline text action: underlined text, the focus ring around it. */
const LINK = cn('rounded-sm text-ui font-medium text-foreground underline underline-offset-2 hover:no-underline disabled:opacity-60', FOCUS);
/** The second click of something that cannot be taken back quietly: red. */
const CONFIRM = cn('min-h-(--target-min) rounded-full bg-status-stopped/12 px-2.5 text-ui font-medium text-stopped-ink hover:bg-status-stopped/20 disabled:opacity-60', FOCUS);

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

  // Runs change on the host's clock: follow it.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const spaces = jobs ? [...new Set(jobs.map((job) => job.spaceName))] : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background px-6 py-5">
      <div className="mx-auto w-full max-w-4xl">
        <h1 className="text-display font-semibold tracking-title text-foreground">Jobs</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Work the cockpit wakes a session for, on a schedule. Sessions set them up with their schedule tool; times
          read in {timeZone ?? 'your time zone'}.
        </p>
        {error && <p role="alert" className="mt-4 text-body text-stopped-ink">Jobs could not be loaded: {error}</p>}
        {jobs && jobs.length === 0 && (
          <p className="mt-8 text-body text-muted-foreground">
            No jobs yet. Ask an agent for something on a schedule, for example "every weekday at 8:00 write the daily brief".
          </p>
        )}
        {spaces.map((spaceName) => (
          <section key={spaceName} className="mt-6">
            {spaces.length > 1 && <h2 className={cn(LABEL, "mb-2")}>{spaceName}</h2>}
            <SpaceJobs jobs={jobs!.filter((job) => job.spaceName === spaceName)} onChanged={load} />
          </section>
        ))}
      </div>
    </div>
  );
}

// Ended jobs fold into a list of their own, closed until the user opens it.
function SpaceJobs({ jobs, onChanged }: { jobs: Job[]; onChanged: () => Promise<void> }) {
  const [showEnded, setShowEnded] = useState(false);
  const { open, ended } = splitEnded(jobs);
  return (
    <div className="flex flex-col gap-2">
      {open.map((job) => <JobCard key={job.id} job={job} onChanged={onChanged} />)}
      {ended.length > 0 && (
        <button type="button" onClick={() => setShowEnded(!showEnded)} className={cn("flex min-h-(--target-min) items-center gap-1 self-start rounded-md text-ui text-muted-foreground hover:text-foreground", FOCUS)}>
          {showEnded ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
          Ended ({ended.length})
        </button>
      )}
      {showEnded && ended.map((job) => <JobCard key={job.id} job={job} onChanged={onChanged} />)}
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
  const [confirmFree, setConfirmFree] = useState(false);
  const grants = (job.grants ?? []).filter((grant) => Date.parse(grant.until) > Date.now());

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
      setConfirmFree(false);
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
    // An ended or paused job reads as such by its dashed edge and its state chip, never by fading its controls.
    <div className={cn('rounded-xl border px-4 py-3', state ? 'border-dashed border-border-strong bg-transparent' : 'border-border bg-card shadow-card')}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(!open)} className={cn("grid size-(--target-min) shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground", FOCUS)} aria-label={open ? 'Hide details' : 'Show details'}>
          {open ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-body font-medium text-foreground">{job.name}</span>
            {state && <span className="rounded-full bg-muted px-2 text-caption font-medium text-muted-foreground">{state}</span>}
            {job.pendingApproval && <span className="rounded-full bg-status-you/12 px-2 text-caption font-medium text-you-ink">Waiting for your OK</span>}
            <span className="text-ui text-muted-foreground">{job.schedule} · wakes {job.wakes}</span>
          </div>
          {job.goal && <div className="mt-1 text-body text-foreground">Goal: {job.goal}</div>}
          <div className="mt-1 text-body text-muted-foreground">
            {job.nextRuns.length > 0 && <>Next: {job.nextRuns.map(formatWhen).join(' · ')}</>}
            {job.pausedReason && <span className="text-you-ink">{job.pausedReason}</span>}
          </div>
          {last && <LastRun run={last} spaceId={job.spaceId} />}
          {job.pendingApproval && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-status-you/40 bg-status-you/10 px-2.5 py-1.5 text-body">
              <span className="text-foreground">This job wants to react to {job.schedule.split(' + ').filter((part) => part.startsWith('on ')).map((part) => part.slice(3)).join(' and ')}. Mail for it waits until you approve.</span>
              <button type="button" onClick={() => void decide(() => api.approveJob(job.id))} disabled={busy} className={cn(PRIMARY, "min-h-(--target-min) px-3 text-ui")}>
                Approve
              </button>
            </div>
          )}
          {channels.map((channel) => {
            const mode = job.reply[channel] ?? 'draft';
            return (
              <div key={channel} className="mt-1 flex flex-wrap items-center gap-2 text-body text-muted-foreground">
                <span>Replies on {channel}: <span className={mode === 'send' ? 'font-medium text-foreground' : 'text-foreground'}>{mode === 'send' ? 'sent without asking' : 'drafts you approve'}</span></span>
                {mode === 'send' ? (
                  <button type="button" onClick={() => void decide(() => api.setJobReply(job.id, channel, 'draft'))} disabled={busy} className={LINK}>Back to drafts</button>
                ) : confirmSend === channel ? (
                  <button type="button" onClick={() => void decide(() => api.setJobReply(job.id, channel, 'send'))} disabled={busy} className={CONFIRM}>
                    Yes, send without asking
                  </button>
                ) : (
                  <button type="button" onClick={() => setConfirmSend(channel)} disabled={busy} className={LINK}>Let it send…</button>
                )}
              </div>
            );
          })}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-body text-muted-foreground">
            {job.limited ? (
              <>
                <span><span className="text-foreground">Limited</span>: no shell, no messages to sessions, only the brain</span>
                {confirmFree ? (
                  <button type="button" onClick={() => void decide(() => api.setJobLimited(job.id, false))} disabled={busy} className={CONFIRM}>
                    Yes, give it all its tools
                  </button>
                ) : (
                  <button type="button" onClick={() => setConfirmFree(true)} disabled={busy} className={LINK}>Remove limits…</button>
                )}
              </>
            ) : (
              <>
                <span>Runs with all its maker’s tools</span>
                <button type="button" onClick={() => void decide(() => api.setJobLimited(job.id, true))} disabled={busy} className={LINK}>Limit it</button>
              </>
            )}
          </div>
          {job.limited && !job.endedAt && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-body text-muted-foreground">
              {grants.map((grant) => (
                <span key={grant.tool} className="inline-flex items-center gap-1 rounded-full bg-muted px-2">
                  <span className="text-foreground">{grant.tool === 'chrome' ? 'Chrome' : 'Messages'}</span> lent until {formatWhen(grant.until)}
                  <button type="button" onClick={() => void decide(() => api.revokeJobTool(job.id, grant.tool))} disabled={busy} className={LINK}>take back</button>
                </span>
              ))}
              {(['chrome', 'SendMessage'] as const).filter((tool) => !grants.some((grant) => grant.tool === tool)).map((tool) => (
                <button key={tool} type="button" onClick={() => void decide(() => api.grantJobTool(job.id, tool))} disabled={busy} className={LINK}>
                  Lend {tool === 'chrome' ? 'Chrome' : 'messages'} for 1 h
                </button>
              ))}
            </div>
          )}
          {message && <p className="mt-1 text-ui text-muted-foreground">{message}</p>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {!job.endedAt && (
            <IconButton label="Run now" onClick={() => void act('run_now')} disabled={busy}><RotateCw aria-hidden className="size-4" /></IconButton>
          )}
          {!job.endedAt && (job.paused
            ? <IconButton label="Resume" onClick={() => void act('resume')} disabled={busy}><Play aria-hidden className="size-4" /></IconButton>
            : <IconButton label="Pause" onClick={() => void act('pause')} disabled={busy}><Pause aria-hidden className="size-4" /></IconButton>)}
          {confirmDelete ? (
            <button type="button" onClick={() => void act('delete')} disabled={busy} className={CONFIRM}>
              Delete job
            </button>
          ) : (
            <IconButton label="Delete" onClick={() => setConfirmDelete(true)} disabled={busy}><Trash2 aria-hidden className="size-4" /></IconButton>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-3 border-t border-border pt-3 pl-7 text-body">
          <p className="mt-2 whitespace-pre-wrap text-foreground">{job.prompt}</p>
          <h3 className={cn(LABEL, "mt-3")}>Runs</h3>
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
    <div className="mt-1 text-body text-muted-foreground">
      Last: <RunLine run={run} spaceId={spaceId} current />
    </div>
  );
}

function RunLine({ run, spaceId, current = false }: { run: JobRun; spaceId: string | null; current?: boolean }) {
  const label = runLabel(run, current);
  const when = run.startedAt ?? run.finishedAt ?? run.dueAt;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span title={formatWhen(when)}>{formatAgo(when)}</span>
      <span className={TONE[label.tone]}>{label.text}</span>
      {run.note && <span className="text-ui text-muted-foreground">({run.note})</span>}
      {run.sessionId && (
        <button type="button" className={LINK} onClick={() => openSession(spaceId, run.sessionId!, run.session)}>
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
      className={cn("flex size-(--target-comfortable) items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-muted hover:text-foreground disabled:opacity-60", FOCUS)}
    >
      {children}
    </button>
  );
}
