// The empty pane (mockup new session pane): say what you want to do and press Enter. The
// session starts in the project shown next to the box, picked from the desk, from your words
// or by you, as a chat of the agent and model in the picker (components/agent-picker). Under
// it, the space's recent projects and the sessions to continue. Tokens v2; colour only for
// "waits for you".
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { AgentPicker, useAgentChoice } from '@/components/agent-picker/AgentPicker';
import { queueChatStart } from '@/components/chat/chat-start';
import { ADD_PROJECT_EVENT } from '@/components/projects/useProjectActions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { Chip, FOCUS, LABEL } from '@/shared/view/ui';
import { MOD } from '@/components/top-bar/shortcuts';
import { readable, useTaskBoard, when } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { getDeskOfPane, lastProjectOfDesk, newCliSessionId, newSessionView, resumeSessionInPane, startSessionInPane } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces } from '@/stores/useSpaceStore';
import type { Project } from '@/types/app';

import { asksYou, projectFromWords, projectsByActivity, recentSessions, taskCounts, type PickReason } from './launcher';
import { getLauncherProjects, subscribeLauncherProjects } from './launcher-projects';

const RECENT_PROJECTS = 6;
const RECENT_SESSIONS = 5;
const REASON: Record<PickReason, string | null> = { desk: 'last used on this desk', words: 'from your words', manual: null };

export function SessionLauncher({ paneId }: { paneId: string }) {
  const projects = useSyncExternalStore(subscribeLauncherProjects, getLauncherProjects);
  const { sessions } = useAllSessions(true);
  const { data: board } = useTaskBoard();
  const spaces = useSpaces();
  const deskSpace = getDeskOfPane(paneId)?.spaceId ?? null;
  const space = spaces.find((s) => paneSpaceKey(s) === deskSpace);
  const now = Date.now();

  const ranked = useMemo(() => projectsByActivity(projects, sessions ?? []), [projects, sessions]);
  const deskDefault = useMemo(() => {
    const id = lastProjectOfDesk(paneId);
    return projects.find((p) => p.projectId === id) ?? ranked[0]?.project ?? null;
  }, [paneId, projects, ranked]);

  const [text, setText] = useState('');
  const [manual, setManual] = useState<Project | null>(null);
  const agents = useAgentChoice();
  const [picking, setPicking] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);

  const fromWords = manual ? null : projectFromWords(text, projects);
  const project = manual ?? fromWords ?? deskDefault;
  const reason: PickReason = manual ? 'manual' : fromWords ? 'words' : 'desk';

  const start = () => {
    if (!project) { setPicking(true); return; }
    const prompt = text.trim() || null;
    const sessionId = newCliSessionId();
    const choice = agents.choice;
    // No agent with a chat set up: the session starts as a new session always did, with the default agent in its view.
    if (!choice) { startSessionInPane(paneId, { projectId: project.projectId, view: newSessionView(), prompt, sessionId }); return; }
    queueChatStart(sessionId, { provider: choice.provider, prompt, model: choice.model });
    startSessionInPane(paneId, { projectId: project.projectId, view: 'chat', prompt, sessionId, provider: choice.provider });
  };

  const continueList = space ? recentSessions(sessions ?? [], space.id, RECENT_SESSIONS) : [];

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-background px-5 pt-14 pb-8">
      <div className="flex w-full max-w-(--container-measure) flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-display font-bold tracking-title">New session</h2>
          <p className="m-0 text-body text-muted-foreground">Say what you want to do. It starts in the project shown below, as a chat with the agent you pick.</p>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); start(); }}
          className="rounded-2xl border border-border bg-card shadow-card focus-within:border-border-strong"
        >
          <textarea
            ref={box}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); start(); } }}
            placeholder="What do you want to work on?"
            aria-label="First message"
            className="block min-h-20 w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-heading outline-none"
          />
          <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2.5">
            <ProjectPicker
              open={picking}
              onOpen={setPicking}
              project={project}
              reason={REASON[reason]}
              ranked={ranked}
              spaceName={space?.name ?? 'This space'}
              now={now}
              onPick={(p) => { setManual(p); setPicking(false); box.current?.focus(); }}
            />
            <AgentPicker groups={agents.groups} choice={agents.choice} onChoose={agents.choose} />
            <button type="submit" className={cn('ml-auto inline-flex h-(--target-comfortable) items-center gap-2 rounded-full bg-primary px-3.5 text-body font-semibold text-primary-foreground hover:opacity-90', FOCUS)}>
              Start <kbd aria-hidden className="text-caption opacity-70">↵</kbd>
            </button>
          </div>
        </form>

        {ranked.length > 0 && (
          <section aria-label="Recent projects" className="flex flex-col gap-2">
            <span className={LABEL}>Recent projects</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ranked.slice(0, RECENT_PROJECTS).map(({ project: p, last }) => {
                const counts = taskCounts(p, board);
                return (
                  <button key={p.projectId} type="button" aria-pressed={p.projectId === project?.projectId}
                    onClick={() => { setManual(p); box.current?.focus(); }}
                    className={cn('flex min-w-0 flex-col gap-0.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left hover:border-border-strong aria-pressed:border-foreground aria-pressed:ring-1 aria-pressed:ring-foreground', FOCUS)}>
                    <span className="truncate text-body font-semibold">{p.displayName}</span>
                    <span className="truncate text-ui text-muted-foreground">
                      {[counts.open ? `${counts.open} open task${counts.open === 1 ? '' : 's'}` : null, counts.you ? `${counts.you} wait${counts.you === 1 ? 's' : ''} for you` : null, last ? when(last, now) : null].filter(Boolean).join(' · ') || 'No session yet'}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {continueList.length > 0 && (
          <section aria-label="Continue a session" className="flex flex-col gap-2">
            <span className={LABEL}>Continue a session</span>
            <div className="flex flex-col overflow-hidden rounded-xl border border-border">
              {continueList.map((s) => (
                <button key={s.id} type="button"
                  onClick={() => resumeSessionInPane(paneId, { projectId: s.__projectId ?? '', sessionId: s.id, chat: s.runtime === 'sdk' })}
                  className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-border bg-card px-3 py-2 text-left first:border-t-0 hover:bg-muted', FOCUS)}>
                  <span className="flex min-w-0 items-center gap-2 text-body font-medium">
                    <span className="truncate">{readable(sessionDisplayName(s) || 'Untitled session')}</span>
                    {asksYou(s) && <Chip hue="you">waits for you</Chip>}
                  </span>
                  <time className="row-span-2 self-center text-ui text-muted-foreground tabular-nums">{when(s.lastActivity ?? s.createdAt, now)}</time>
                  <span className="truncate text-ui text-muted-foreground">{projects.find((p) => p.projectId === s.__projectId)?.displayName ?? s.__projectId}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <p className="m-0 text-center text-ui text-muted-foreground">
          Enter on an empty box starts with the greeting · <kbd className="rounded-sm border border-b-2 border-border px-1 text-caption">{MOD} K</kbd> finds any project or session
        </p>
      </div>
    </div>
  );
}

function ProjectPicker({ open, onOpen, project, reason, ranked, spaceName, now, onPick }: {
  open: boolean; onOpen: (open: boolean) => void; project: Project | null; reason: string | null;
  ranked: Array<{ project: Project; last: string | null }>; spaceName: string; now: number; onPick: (project: Project) => void;
}) {
  const [filter, setFilter] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setFilter('');
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) onOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open, onOpen]);
  const shown = ranked.filter(({ project: p }) => !filter || `${p.displayName} ${p.projectId}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div ref={root} className="relative">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => onOpen(!open)}
        aria-label={project ? `Project: ${project.displayName}${reason ? ` (${reason})` : ''}` : 'Pick a project'}
        className={cn('flex h-(--target-comfortable) max-w-72 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-body', FOCUS)}>
        <span className="truncate font-medium">{project?.displayName ?? 'Pick a project'}</span>
        {project && reason && <span className="whitespace-nowrap text-ui text-muted-foreground">· {reason}</span>}
        <span aria-hidden className="text-muted-foreground">▾</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Pick a project" className="absolute top-full left-0 z-(--z-popover) mt-1.5 flex w-80 flex-col gap-1.5 rounded-2xl border border-border bg-card p-1.5 shadow-modal">
          <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search projects" aria-label="Search projects"
            onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); onPick(shown[0].project); } }}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-body outline-none focus:border-border-strong" />
          <div role="listbox" aria-label="Projects" className="flex max-h-64 flex-col overflow-y-auto">
            <span className={cn(LABEL, 'px-2 pt-1.5 pb-1')}>{spaceName} · recent first</span>
            {shown.map(({ project: p, last }) => (
              <button key={p.projectId} type="button" role="option" aria-selected={p.projectId === project?.projectId} onClick={() => onPick(p)}
                className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body hover:bg-muted aria-selected:bg-muted', FOCUS)}>
                <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
                {last && <span className="ml-auto shrink-0 whitespace-nowrap text-ui text-muted-foreground">{when(last, now)}</span>}
              </button>
            ))}
            {shown.length === 0 && <span className="px-2 py-1.5 text-body text-muted-foreground">No project matches.</span>}
            <span className={cn(LABEL, 'px-2 pt-2.5 pb-1')}>Other</span>
            <button type="button" onClick={() => { onOpen(false); window.dispatchEvent(new Event(ADD_PROJECT_EVENT)); }}
              className={cn('rounded-lg px-2 py-1.5 text-left text-body hover:bg-muted', FOCUS)}>New project…</button>
          </div>
        </div>
      )}
    </div>
  );
}
