// The `worktrees` pane view (decision cockpit-builtin-plugins-first): the
// project folder's git worktrees, each with its branch, changes, distance to
// the default branch, last commit, the cockpit sessions working in it and the
// local ports its processes listen on; a worktree opens to its changed files
// and its commits ahead. Read-only; a session opens on click. Data:
// /api/plugins/worktrees/git and /ports (host plugins-api.ts), the sessions
// from the project list (their workdir, from the agent's hooks). Drawn with
// the brain surface's cards (../brain/ui.tsx).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, GitBranch, Loader2, RefreshCw, Terminal } from 'lucide-react';

import { BrainCard, SectionHeader } from '@/components/brain/ui';
import { compactAge, sessionDisplayName } from '@/components/sidebar/utils';
import { cn } from '@/lib/utils';
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
const CHANGED = 'var(--color-review)';
const AHEAD = 'var(--color-primary)';

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
  });

  if (!project) return <PaneMessage>Pick a project for this pane to see its worktrees.</PaneMessage>;
  if (!project.path) return <PaneMessage>This project has no folder yet — worktrees are a git folder's checkouts.</PaneMessage>;
  if (git.isPending) return <PaneMessage><Loader2 className="h-4 w-4 animate-spin" /></PaneMessage>;
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
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {!worktrees ? (
          <BrainCard className="p-4 text-sm text-muted-foreground">The project folder is no git repository.</BrainCard>
        ) : (
          rows(worktrees).map(({ wt, here, at }) => (
            <WorktreeCard key={wt.path} worktree={wt} base={base} projectId={project.projectId} sessions={here} ports={portsOf(wt)} lastActive={at} now={now} />
          ))
        )}
        {ports.data?.ports === null ? (
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
  const { branch, dirty, ahead, behind, lastCommit, changes, commits } = worktree;
  const accent = dirty > 0 ? CHANGED : ahead ? AHEAD : 'var(--color-muted-foreground)';

  return (
    <BrainCard className="border-l-[3px] px-2.5 py-2" style={{ borderLeftColor: accent }}>
      {/* Folded: one line to scan — branch, its state, who works there, what runs there. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={worktree.path}>
          {branch ?? `detached at ${worktree.head.slice(0, 7)}`}
        </span>
        {worktree.isProjectFolder && <Chip>project folder</Chip>}
        <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
          {dirty > 0 && <Chip color={CHANGED}>{dirty} changed</Chip>}
          {ahead !== null && behind !== null && (ahead > 0 || behind > 0) && (
            <Chip color={ahead > 0 ? AHEAD : undefined} title={`${ahead} commits ahead of ${base}, ${behind} behind`}>
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

      {open && (
        <div className="mt-2 space-y-2.5 pl-[22px]">
          <div className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
            <span className="min-w-0 truncate font-mono" title={worktree.path}>{worktree.path}</span>
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
                <div key={change.path} className="flex min-w-0 gap-2 text-xs">
                  <span className="w-5 flex-shrink-0 font-mono" style={{ color: CHANGED }}>{change.code.trim() || '·'}</span>
                  <span className="min-w-0 truncate font-mono text-foreground/85" title={change.path}>{change.path}</span>
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
    <div className="flex min-w-0 items-baseline gap-2 text-xs">
      <span className="flex-shrink-0 font-mono text-muted-foreground">{commit.hash}</span>
      <span className="min-w-0 flex-1 truncate text-foreground/85" title={commit.subject}>{commit.subject}</span>
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
        'block h-1.5 w-1.5 flex-shrink-0 rounded-full',
        state === 'working' ? 'animate-pulse bg-foreground' : state ? 'bg-primary' : 'bg-foreground/25',
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
      className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-foreground/5"
    >
      <span className="flex w-3 flex-shrink-0 justify-center"><Dot state={state} /></span>
      <span className="min-w-0 flex-1 truncate text-foreground">{sessionDisplayName(session)}</span>
      {word && <span className="flex-shrink-0 text-caption text-primary">{word}</span>}
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
            className="mt-1.5 flex items-center gap-1 text-caption text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', showSystem && 'rotate-90')} />
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
    <div className="group/port min-w-0 rounded-md px-1.5 py-1 hover:bg-foreground/[0.03]">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="w-14 flex-shrink-0 font-mono font-medium tabular-nums text-foreground">:{port.port}</span>
        <span className="min-w-0 truncate font-medium text-foreground/90">{port.label ?? port.command}</span>
        {session && (
          <button
            type="button"
            onClick={() => openInPane({ surface: 'terminal', projectId: session.projectId, sessionId: session.id })}
            title="Started by this cockpit session: open it"
            className="flex min-w-0 flex-shrink items-center gap-1 rounded-full border border-primary/40 px-1.5 py-px text-[10px] text-primary transition-colors hover:bg-primary/10"
          >
            <Terminal className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate">{session.name ?? 'cockpit session'}</span>
          </button>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-caption tabular-nums text-muted-foreground">
          {!local && <Chip color={CHANGED} title={`Listens on ${port.address}: reachable from other machines`}>{port.address}</Chip>}
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
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : <span className="w-5" />}
        </span>
      </div>
      {port.commandLine && (
        <div className="mt-0.5 truncate pl-16 font-mono text-[11px] text-muted-foreground" title={`${port.commandLine}${port.cwd ? `\nin ${port.cwd}` : ''}\npid ${port.pid}`}>
          {port.commandLine}
        </div>
      )}
    </div>
  );
}

function DetailList({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Chip({ children, color, title }: { children: React.ReactNode; color?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn('flex-shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium tabular-nums', !color && 'border-foreground/15 text-muted-foreground')}
      style={color ? { color, borderColor: `color-mix(in srgb, ${color} 40%, transparent)` } : undefined}
    >
      {children}
    </span>
  );
}

const Count = ({ n }: { n: number }) => <span className="text-caption tabular-nums text-muted-foreground">{n}</span>;

function PaneMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
