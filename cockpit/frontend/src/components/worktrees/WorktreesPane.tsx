// The `worktrees` pane view (decision cockpit-builtin-plugins-first): the
// project folder's git worktrees, each with its branch, changes, distance to
// the default branch, last commit, the cockpit sessions working in it and the
// local ports its processes listen on; a worktree opens to its changed files
// and its commits ahead. Read-only; a session opens on click, a worktree's
// changes and files in the Repository view (while that plugin is on). Data:
// /api/plugins/worktrees/git and /ports (host plugins-api.ts), the sessions
// from the project list (their workdir, from the agent's hooks). Drawn with
// the brain surface's cards (../brain/ui.tsx). Tokens v2: state is grey with a
// label; only a session waiting for you is amber.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, FileDiff, GitBranch, Loader2, RefreshCw, Terminal } from 'lucide-react';

import { BrainCard, SectionHeader } from '@/components/brain/ui';
import { compactAge, sessionDisplayName } from '@/components/sidebar/utils';
import { useViewEnabled } from '@/lib/pane-views';
import { cn } from '@/lib/utils';
import { FOCUS, LABEL } from '@/shared/view/ui';
import { openInPane } from '@/stores/usePaneStore';
import { isUnseenDone, useTurnStore } from '@/stores/useTurnStateStore';
import type { Project, ProjectSession } from '@/types/app';

interface Commit {
  hash: string;
  subject: string;
  at: string;
}

interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  dirty: number;
  changes: Array<{ code: string; path: string }>;
  ahead: number | null;
  behind: number | null;
  commits: Commit[];
  lastCommit: Commit | null;
  createdAt: string | null;
  isProjectFolder: boolean;
}

interface WorktreesGit {
  folder: string;
  base: string | null;
  worktrees: Worktree[] | null;
}

interface ListeningPort {
  port: number;
  address: string;
  pid: number;
  command: string;
  cwd: string | null;
  startedAt: string | null;
  /** Secrets blacked out by the host, the home folder as ~. */
  commandLine: string | null;
  memory: number | null;
  /** The cockpit session whose agent started it. */
  session: { id: string; name: string | null; projectId: string | null } | null;
  /** The cockpit's own: "EML Cockpit", "EML brain server". */
  label: string | null;
  /** Outside the user's home folder: the system's. */
  system: boolean;
}

// While the pane is open and the window has focus; the button refreshes at once.
const REFRESH_MS = 30_000;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/plugins/worktrees/${path}`, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

/** The worktree a folder lies in: the deepest one that contains it. */
function worktreeOf(folder: string | null | undefined, worktrees: Worktree[]): Worktree | undefined {
  if (!folder) return undefined;
  return worktrees
    .filter((wt) => folder === wt.path || folder.startsWith(`${wt.path}/`) || folder.startsWith(`${wt.path}\\`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

const age = (iso: string | null | undefined, now: Date) => (iso ? compactAge(iso, now) : '');

export function WorktreesPane({ project }: { project: Project | null }) {
  const projectId = project?.projectId ?? null;
  const git = useQuery({
    queryKey: ['worktrees-git', projectId],
    queryFn: () => get<WorktreesGit>(`git?projectId=${encodeURIComponent(projectId ?? '')}`),
    enabled: Boolean(project?.path),
    refetchInterval: REFRESH_MS,
  });
  const ports = useQuery({
    queryKey: ['worktrees-ports'],
    queryFn: () => get<{ ports: ListeningPort[] | null }>('ports'),
    refetchInterval: REFRESH_MS,
    // A remote viewer is refused (403): asking again gives the same answer.
    retry: false,
  });

  if (!project) return <PaneMessage>Pick a project for this pane to see its worktrees.</PaneMessage>;
  if (!project.path) return <PaneMessage>This project has no folder yet — worktrees are a git folder's checkouts.</PaneMessage>;
  if (git.isPending) return <PaneMessage><Loader2 aria-hidden className="size-4 animate-spin" /></PaneMessage>;
  if (git.isError) return <PaneMessage>{git.error.message}</PaneMessage>;

  const now = new Date();
  const { worktrees, base, folder } = git.data;
  const sessions = (project.sessions ?? []).filter((session) => !session.archivedAt);
  const allPorts = ports.data?.ports ?? [];
  const portsOf = (wt: Worktree) => allPorts.filter((port) => worktreeOf(port.cwd, worktrees ?? []) === wt);
  const otherPorts = allPorts.filter((port) => !worktreeOf(port.cwd, worktrees ?? []));
  const refreshing = git.isFetching || ports.isFetching;
  // The project folder first, then the worktree worked in last: its newest commit or session.
  const rows = (list: Worktree[]) =>
    list
      .map((wt) => {
        const here = sessions.filter((session) => worktreeOf(session.workdir ?? project.path, list) === wt);
        const at = [wt.lastCommit?.at, ...here.map((session) => session.lastActivity as string | undefined)]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null;
        return { wt, here, at };
      })
      .sort((a, b) => Number(b.wt.isProjectFolder) - Number(a.wt.isProjectFolder) || (b.at ?? '').localeCompare(a.at ?? ''));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-2">
        <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground" title={folder}>
          {worktrees
            ? `${worktrees.length} ${worktrees.length === 1 ? 'worktree' : 'worktrees'}${base ? ` · compared with ${base}` : ''}`
            : folder}
        </span>
        <button
          type="button"
          onClick={() => { void git.refetch(); void ports.refetch(); }}
          aria-label="Refresh"
          title="Refresh"
          className={cn("flex size-(--target-min) items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-muted hover:text-foreground", FOCUS)}
        >
          <RefreshCw aria-hidden className={cn('size-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {!worktrees ? (
          <BrainCard className="p-4 text-body text-muted-foreground">The project folder is no git repository.</BrainCard>
        ) : (
          rows(worktrees).map(({ wt, here, at }) => (
            <WorktreeCard key={wt.path} worktree={wt} base={base} projectId={project.projectId} sessions={here} ports={portsOf(wt)} lastActive={at} now={now} />
          ))
        )}
        {ports.isError ? (
          <p className="px-1 text-caption text-muted-foreground">{ports.error.message}</p>
        ) : ports.data?.ports === null ? (
          <p className="px-1 text-caption text-muted-foreground">This system does not tell the cockpit which ports are in use.</p>
        ) : otherPorts.length > 0 && <OtherPorts ports={otherPorts} now={now} />}
      </div>
    </div>
  );
}

function WorktreeCard({ worktree, base, projectId, sessions, ports, lastActive, now }: {
  worktree: Worktree;
  base: string | null;
  projectId: string;
  sessions: ProjectSession[];
  ports: ListeningPort[];
  lastActive: string | null;
  now: Date;
}) {
  const [open, setOpen] = useState(false);
  const repositoryOn = useViewEnabled()('repository');
  const { branch, dirty, ahead, behind, lastCommit, changes, commits } = worktree;

  return (
    <BrainCard className="px-2.5 py-2">
      {/* Folded: one line to scan — branch, its state, who works there, what runs there. */}
      <div className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn("flex min-h-(--target-min) min-w-0 flex-1 items-center gap-2 rounded-md text-left", FOCUS)}
      >
        <ChevronRight aria-hidden className={cn('size-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)', open && 'rotate-90')} />
        <GitBranch aria-hidden className="size-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-body font-semibold text-foreground" title={worktree.path}>
          {branch ?? `detached at ${worktree.head.slice(0, 7)}`}
        </span>
        {worktree.isProjectFolder && <Chip>project folder</Chip>}
        <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
          {dirty > 0 && <Chip strong>{dirty} changed</Chip>}
          {ahead !== null && behind !== null && (ahead > 0 || behind > 0) && (
            <Chip strong={ahead > 0} title={`${ahead} commits ahead of ${base}, ${behind} behind`}>
              ↑{ahead} ↓{behind}
            </Chip>
          )}
          {sessions.length > 0 && <SessionsChip sessions={sessions} />}
          {ports.map((port) => (
            <Chip key={`${port.pid}:${port.address}:${port.port}`} title={`${port.command} listens on ${port.address}:${port.port}`}>
              :{port.port}
            </Chip>
          ))}
          <span className="w-8 text-right text-caption tabular-nums text-muted-foreground" title="Last commit or session activity">
            {age(lastActive, now)}
          </span>
        </span>
      </button>
      {repositoryOn && (
        <button
          type="button"
          onClick={() => openInPane({ surface: 'repository', projectId, worktree: worktree.path })}
          title="Show its changes and files"
          aria-label="Show its changes and files"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <FileDiff className="h-3 w-3" />
        </button>
      )}
      </div>

      {open && (
        <div className="mt-2 space-y-2.5 pl-(--indent-worktree)">
          <div className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
            <span className="min-w-0 truncate font-code" title={worktree.path}>{worktree.path}</span>
            {worktree.createdAt && <span className="flex-shrink-0">· added {age(worktree.createdAt, now)} ago</span>}
          </div>
          {(sessions.length > 0 || ports.length > 0) && (
            <DetailList title="Running here">
              {sessions.map((session) => <SessionRow key={session.id} session={session} projectId={projectId} now={now} />)}
              {ports.map((port) => <PortRow key={`${port.pid}:${port.address}:${port.port}`} port={port} now={now} />)}
            </DetailList>
          )}
          {changes.length > 0 && (
            <DetailList title={`Changed files${dirty > changes.length ? ` · first ${changes.length} of ${dirty}` : ''}`}>
              {changes.map((change) => (
                <div key={change.path} className="flex min-w-0 gap-2 text-ui">
                  <span className="w-5 flex-shrink-0 font-code font-semibold text-foreground">{change.code.trim() || '·'}</span>
                  <span className="min-w-0 truncate font-code text-foreground" title={change.path}>{change.path}</span>
                </div>
              ))}
            </DetailList>
          )}
          {/* The commits ahead include the last one; only a branch without any shows it on its own. */}
          {commits.length > 0 ? (
            <DetailList title={`Ahead of ${base}${ahead && ahead > commits.length ? ` · newest ${commits.length} of ${ahead}` : ''}`}>
              {commits.map((commit) => <CommitRow key={commit.hash} commit={commit} now={now} />)}
            </DetailList>
          ) : lastCommit && (
            <DetailList title="Last commit">
              <CommitRow commit={lastCommit} now={now} />
            </DetailList>
          )}
        </div>
      )}
    </BrainCard>
  );
}

function CommitRow({ commit, now }: { commit: Commit; now: Date }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-ui">
      <span className="flex-shrink-0 font-code text-muted-foreground">{commit.hash}</span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={commit.subject}>{commit.subject}</span>
      <span className="flex-shrink-0 tabular-nums text-muted-foreground">{age(commit.at, now)}</span>
    </div>
  );
}

/** The sessions of a worktree, folded: their count, with the dot of the one that needs looking at most. */
function SessionsChip({ sessions }: { sessions: ProjectSession[] }) {
  const turns = useTurnStore();
  const states = sessions.map((session) => sessionState(turns, session));
  const state = states.includes('working') ? 'working' : states.includes('waiting') ? 'waiting' : states.includes('finished') ? 'finished' : null;
  return (
    <Chip title={sessions.map((session) => sessionDisplayName(session)).join('\n')}>
      <span className="flex items-center gap-1">
        <Dot state={state} />
        {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
      </span>
    </Chip>
  );
}

type SessionState = 'working' | 'waiting' | 'finished' | null;

function sessionState(turns: ReturnType<typeof useTurnStore>, session: ProjectSession): SessionState {
  const state = turns.turns[session.id]?.state ?? session.turnState ?? 'idle';
  if (state === 'working' || state === 'waiting') return state;
  return isUnseenDone(turns, session.id) ? 'finished' : null;
}

function Dot({ state }: { state: SessionState }) {
  return (
    <span
      className={cn(
        'block size-1.5 flex-shrink-0 rounded-full',
        // Waiting for you is the one amber state; finished is the text colour, idle a grey.
        state === 'working' ? 'animate-pulse bg-foreground' : state === 'waiting' ? 'bg-status-you' : state ? 'bg-foreground' : 'bg-border-strong',
      )}
    />
  );
}

function SessionRow({ session, projectId, now }: { session: ProjectSession; projectId: string; now: Date }) {
  const state = sessionState(useTurnStore(), session);
  const word = state === 'working' ? 'working' : state === 'waiting' ? 'waiting for you' : state;
  return (
    <button
      type="button"
      onClick={() => openInPane({ surface: 'terminal', projectId, sessionId: session.id })}
      className={cn("-mx-1.5 flex min-h-(--target-min) w-(--size-worktree-row) min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-ui transition-colors duration-(--duration-fast) hover:bg-muted", FOCUS)}
    >
      <span className="flex w-3 flex-shrink-0 justify-center"><Dot state={state} /></span>
      <span className="min-w-0 flex-1 truncate text-foreground">{sessionDisplayName(session)}</span>
      {word && <span className={cn('flex-shrink-0 text-caption', state === 'waiting' ? 'text-you-ink' : 'text-muted-foreground')}>{word}</span>}
      <span className="w-10 flex-shrink-0 text-right tabular-nums text-caption text-muted-foreground">{age(session.lastActivity as string | undefined, now)}</span>
    </button>
  );
}

/** The ports no worktree holds: the user's first, the system's folded away. */
function OtherPorts({ ports, now }: { ports: ListeningPort[]; now: Date }) {
  const [showSystem, setShowSystem] = useState(false);
  const own = ports.filter((port) => !port.system);
  const system = ports.filter((port) => port.system);
  return (
    <BrainCard className="p-3">
      <SectionHeader title="Other local ports" right={<Count n={ports.length} />} className="mb-1.5" />
      <div className="space-y-1">
        {own.map((port) => <PortRow key={`${port.pid}:${port.address}:${port.port}`} port={port} now={now} />)}
      </div>
      {system.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowSystem((s) => !s)}
            aria-expanded={showSystem}
            className={cn("mt-1.5 flex min-h-(--target-min) items-center gap-1 rounded-md text-caption text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground", FOCUS)}
          >
            <ChevronRight aria-hidden className={cn('size-3 transition-transform duration-(--duration-fast)', showSystem && 'rotate-90')} />
            {system.length} system {system.length === 1 ? 'port' : 'ports'}: apps and services outside your home folder
          </button>
          {showSystem && (
            <div className="mt-1 space-y-1">
              {system.map((port) => <PortRow key={`${port.pid}:${port.address}:${port.port}`} port={port} now={now} />)}
            </div>
          )}
        </>
      )}
    </BrainCard>
  );
}

const megabytes = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

function PortRow({ port, now }: { port: ListeningPort; now: Date }) {
  const local = port.address === '127.0.0.1' || port.address === '::1' || port.address === 'localhost';
  const reachable = local || port.address === '*' || port.address === '0.0.0.0' || port.address === '::';
  const { session } = port;
  return (
    <div className="group/port min-w-0 rounded-md px-1.5 py-1 hover:bg-muted">
      <div className="flex min-w-0 items-center gap-2 text-ui">
        <span className="w-14 flex-shrink-0 font-code font-medium tabular-nums text-foreground">:{port.port}</span>
        <span className="min-w-0 truncate font-medium text-foreground">{port.label ?? port.command}</span>
        {session && (
          <button
            type="button"
            onClick={() => openInPane({ surface: 'terminal', projectId: session.projectId, sessionId: session.id })}
            title="Started by this cockpit session: open it"
            className={cn("flex min-h-(--target-min) min-w-0 flex-shrink items-center gap-1 rounded-full border border-border-strong px-2 text-caption text-foreground transition-colors duration-(--duration-fast) hover:bg-muted", FOCUS)}
          >
            <Terminal aria-hidden className="size-2.5 flex-shrink-0" />
            <span className="truncate">{session.name ?? 'cockpit session'}</span>
          </button>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-caption tabular-nums text-muted-foreground">
          {!local && <Chip strong title={`Listens on ${port.address}: reachable from other machines`}>{port.address}</Chip>}
          {port.memory !== null && <span title="Memory in use">{megabytes(port.memory)}</span>}
          <span className="w-8 text-right" title={port.startedAt ? `Running since ${new Date(port.startedAt).toLocaleString()}` : undefined}>
            {age(port.startedAt, now)}
          </span>
          {reachable ? (
            <a
              href={`http://localhost:${port.port}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open http://localhost:${port.port}`}
              aria-label={`Open http://localhost:${port.port}`}
              className={cn("flex size-(--target-min) items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-muted hover:text-foreground", FOCUS)}
            >
              <ExternalLink aria-hidden className="size-3" />
            </a>
          ) : <span className="w-(--target-min)" />}
        </span>
      </div>
      {port.commandLine && (
        <div className="mt-0.5 truncate pl-16 font-code text-caption text-muted-foreground" title={`${port.commandLine}${port.cwd ? `\nin ${port.cwd}` : ''}\npid ${port.pid}`}>
          {port.commandLine}
        </div>
      )}
    </div>
  );
}

function DetailList({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className={cn(LABEL, "mb-1")}>{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

/** A worktree fact; strong (text colour, strong edge) when it is worth a look: changes, commits ahead, an open port. */
function Chip({ children, strong = false, title }: { children: React.ReactNode; strong?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn('flex-shrink-0 rounded-full border px-1.5 text-caption font-medium tabular-nums', strong ? 'border-border-strong text-foreground' : 'border-border text-muted-foreground')}
    >
      {children}
    </span>
  );
}

const Count = ({ n }: { n: number }) => <span className="text-caption tabular-nums text-muted-foreground">{n}</span>;

function PaneMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-body text-muted-foreground">
      {children}
    </div>
  );
}
