import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Brain, ChevronDown, Folder, Plus, X } from 'lucide-react';

import { SPACE_HEADER } from '@/lib/space-fetch';
import { SESSIONS_CHANGED_EVENT } from '@/lib/session-actions';
import { spaceTone } from '@/lib/space-color';
import { cn } from '@/lib/utils';
import { FIELD, FOCUS } from '@/shared/view/ui';
import { openSessionInSpace, useActiveSpaceId } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import type { Project } from '@/types/app';
import type { SidebarController } from '../../useSidebarController';

const LAST_PROJECT_KEY = 'cockpit-new-session-project';

// Phone: text at the size iOS does not zoom into; from md on, the sidebar's own size.
const PICK = cn(FIELD, 'min-h-(--target-min) rounded-md px-2 text-(length:--text-field-touch) select-text md:text-ui');
const ACTION = cn('min-h-(--target-min) rounded-md px-2 text-ui font-medium text-foreground transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:text-muted-foreground', FOCUS);

/** A select with what it picks shown as an icon, in the panel's own style. */
function PickField({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center">{icon}</span>
      {children}
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}


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

  // In the colour of the space it starts in, so it stands apart from the rows around it.
  const tone = spaceTone(space);
  const toneStyle = tone ? ({ '--space-tone': tone } as CSSProperties) : undefined;

  if (!open) {
    return (
      <div className="flex-shrink-0 px-2 pb-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={toneStyle}
          data-active
          className={cn('space-band flex min-h-(--target-comfortable) w-full items-center justify-center gap-1.5 rounded-lg px-2 text-ui font-semibold text-foreground transition-[filter] duration-(--duration-fast) hover:brightness-125', FOCUS)}
        >
          <Plus aria-hidden className="size-3.5" /> New session
        </button>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 px-2 pb-2">
      <div
        ref={panelRef}
        style={toneStyle}
        data-active
        className="space-band space-y-1.5 rounded-lg p-2"
        onKeyDown={(event) => { if (event.key === 'Escape') close(); }}
      >
        <div className="flex items-center justify-between pl-0.5">
          <span className="text-ui font-semibold text-foreground">New session</span>
          <button
            type="button"
            aria-label="Cancel"
            title="Cancel"
            onClick={close}
            className={cn('flex size-(--target-min) items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-foreground/10 hover:text-foreground', FOCUS)}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
        {spaces.length > 1 && (
          <PickField icon={<Brain className="size-3.5" strokeWidth={1.8} style={{ color: tone }} />}>
            <select aria-label="Space" className={cn(PICK, 'appearance-none pr-6 pl-7')} value={space?.id ?? ''} onChange={(event) => setSpaceId(event.target.value)}>
              {spaces.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </PickField>
        )}
        <PickField icon={<Folder className="size-3.5 text-muted-foreground" strokeWidth={1.8} />}>
          <select aria-label="Project" className={cn(PICK, 'appearance-none pr-6 pl-7')} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.displayName}</option>)}
          </select>
        </PickField>
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
          className={cn(PICK, 'resize-none py-1')}
        />
        <div className="flex gap-1.5">
          <button type="button" className={cn(ACTION, 'space-tab-active flex-1 font-semibold hover:brightness-125')} disabled={!projectId || starting} onClick={() => void run(false)}>Open</button>
          <button type="button" className={cn(ACTION, 'hover:bg-foreground/10')} disabled={!projectId || starting || !prompt.trim()} onClick={() => void run(true)} title="Run in the background (Alt+Enter)">Background</button>
        </div>
      </div>
    </div>
  );
}
