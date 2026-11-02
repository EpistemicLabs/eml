import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

import { SPACE_HEADER } from '@/lib/space-fetch';
import { SESSIONS_CHANGED_EVENT } from '@/lib/session-actions';
import { openSessionInSpace, useActiveSpaceId } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import type { Project } from '@/types/app';
import { agentLabel } from '../../allSessions';
import type { SidebarController } from '../../useSidebarController';

const LAST_PROJECT_KEY = 'cockpit-new-session-project';

const FIELD = 'w-full rounded-md border border-border bg-background px-2 py-1 text-base text-foreground outline-none select-text focus:border-primary md:text-xs';
const ACTION = 'flex-1 rounded-md border border-border px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40';

function readLastProject(spaceId: string): string | null {
  try { return localStorage.getItem(`${LAST_PROJECT_KEY}:${spaceId}`); } catch { return null; }
}

function writeLastProject(spaceId: string, projectId: string): void {
  try { localStorage.setItem(`${LAST_PROJECT_KEY}:${spaceId}`, projectId); } catch { /* non-fatal */ }
}

/**
 * Start a session by hand, from any view: the agent you're in, the project you used
 * last. Without a prompt it opens an empty session in a pane; with one it runs on the
 * host, in a pane or in the background.
 */
export function SidebarNewSession({ controller }: { controller: SidebarController }) {
  const spaces = useSpaces();
  const openKey = useActiveSpaceId();
  const [open, setOpen] = useState(false);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const space: SpaceInfo | undefined = spaces.find((candidate) => candidate.id === spaceId)
    ?? spaces.find((candidate) => paneSpaceKey(candidate) === openKey)
    ?? spaces[0];

  useEffect(() => {
    if (!open || !space) return;
    let current = true;
    void fetch('/api/projects', { headers: { [SPACE_HEADER]: space.id } })
      .then((response) => (response.ok ? response.json() : { projects: [] }))
      .then((body: { projects?: Project[] }) => {
        if (!current) return;
        const list = (body.projects ?? []).filter((project) => !project.hidden && project.brainStatus !== 'archived');
        setProjects(list);
        const last = readLastProject(space.id);
        setProjectId(list.some((project) => project.projectId === last) ? last ?? '' : list[0]?.projectId ?? '');
      })
      .catch(() => { /* host unreachable: the list stays empty */ });
    return () => { current = false; };
  }, [open, space]);

  const close = () => { setOpen(false); setPrompt(''); setSpaceId(null); };

  const run = async (background: boolean) => {
    if (!space || !projectId) return;
    writeLastProject(space.id, projectId);
    const text = prompt.trim();
    const key = paneSpaceKey(space);
    if (!text) {
      openSessionInSpace(key, { surface: 'terminal', projectId });
      close();
      return;
    }
    setStarting(true);
    try {
      const response = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, prompt: text, spaceId: space.main ? undefined : space.id }),
      });
      const body = (await response.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
      if (!response.ok || !body?.id) {
        controller.reportError(body?.error?.message ?? 'The session could not start.');
        return;
      }
      if (!background) openSessionInSpace(key, { surface: 'terminal', projectId, sessionId: body.id, chat: true });
      window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED_EVENT));
      close();
    } catch {
      controller.reportError('The cockpit host did not answer. Try again.');
    } finally {
      setStarting(false);
    }
  };

  if (!open) {
    return (
      <div className="flex-shrink-0 px-2 pb-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" /> New session
        </button>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="flex-shrink-0 space-y-1.5 px-2 pb-2" onKeyDown={(event) => { if (event.key === 'Escape') close(); }}>
      {spaces.length > 1 && (
        <select aria-label="Agent" className={FIELD} value={space?.id ?? ''} onChange={(event) => setSpaceId(event.target.value)}>
          {spaces.map((candidate) => <option key={candidate.id} value={candidate.id}>{agentLabel(candidate)}</option>)}
        </select>
      )}
      <select aria-label="Project" className={FIELD} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.displayName}</option>)}
      </select>
      <textarea
        autoFocus
        rows={2}
        value={prompt}
        aria-label="What should it do?"
        placeholder="What should it do? (optional)"
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          void run(event.altKey);
        }}
        className={`${FIELD} resize-none`}
      />
      <div className="flex gap-1.5">
        <button type="button" className={ACTION} disabled={!projectId || starting} onClick={() => void run(false)}>Open</button>
        <button type="button" className={ACTION} disabled={!projectId || starting || !prompt.trim()} onClick={() => void run(true)} title="Alt+Enter">Run in background</button>
        <button type="button" className={ACTION} onClick={close}>Cancel</button>
      </div>
    </div>
  );
}
