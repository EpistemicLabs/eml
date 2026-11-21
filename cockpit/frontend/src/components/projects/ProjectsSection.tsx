// Plan's project list: every project of the shown spaces with its actions, and Add project.
import { useRef, useState } from 'react';
import { Eye, EyeOff, FolderPlus, Pencil, Pin, PinOff, Plus, Trash2, X } from 'lucide-react';

import { readSettings } from '@/components/settings/utils/settingsStorage';
import type { ProjectsBySpace } from '@/hooks/useProjectsState';
import { cn } from '@/lib/utils';
import { Button, Chip, FOCUS, LABEL, Menu, type MenuItem } from '@/shared/view/ui';
import type { Project } from '@/types/app';

import { sortProjects } from './sortProjects';
import type { ProjectActions } from './useProjectActions';

/** A space as Plan names it, keyed like the project lists ('' is the main space). */
export type PlanSpace = { key: string; name: string };

/** What the old sidebar offered for each kind: pin and rename for all, folder and visibility for a brain project, remove for a folder. */
export function projectMenuItems(project: Project, actions: ProjectActions): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Rename', icon: Pencil, onSelect: () => actions.startRename(project) },
    { label: project.isStarred ? 'Unpin' : 'Pin', icon: project.isStarred ? PinOff : Pin, onSelect: () => void actions.togglePin(project) },
  ];
  if (project.kind === 'brain') {
    items.push(
      { label: project.fullPath ? 'Change folder' : 'Link a folder', icon: FolderPlus, onSelect: () => actions.startLink(project) },
      { label: project.hidden ? 'Show' : 'Hide', icon: project.hidden ? Eye : EyeOff, onSelect: () => void actions.toggleHidden(project) },
    );
  } else {
    items.push({ label: 'Remove from cockpit', icon: Trash2, destructive: true, onSelect: () => actions.askRemove(project) });
  }
  return items;
}

export function ProjectsSection({ projects, spaces, actions }: { projects: ProjectsBySpace; spaces: PlanSpace[]; actions: ProjectActions }) {
  const [showHidden, setShowHidden] = useState(false);
  const rows = spaces.flatMap((space) => (projects[space.key] ?? []).map((project) => ({ space, project })));
  const hiddenCount = rows.filter((r) => r.project.hidden).length;
  const shown = sortProjects(rows.filter((r) => showHidden || !r.project.hidden), readSettings().projectSortOrder);

  return (
    <section aria-labelledby="plan-projects" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="plan-projects" className={cn(LABEL, 'm-0')}>Projects · {rows.length - hiddenCount}</h3>
        {hiddenCount > 0 && (
          <label className="inline-flex min-h-(--target-min) cursor-pointer items-center gap-1.5 text-ui text-muted-foreground">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-foreground" />
            Show {hiddenCount} hidden
          </label>
        )}
        <span className="flex-1" />
        <Button variant="outline" size="sm" onClick={actions.startAdd}><Plus aria-hidden />Add project</Button>
      </div>
      {actions.error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg bg-status-stopped/10 px-3 py-1 text-ui text-stopped-ink">
          <span className="min-w-0 flex-1">{actions.error}</span>
          <button type="button" aria-label="Dismiss" onClick={actions.dismissError} className={cn('grid size-(--target-min) place-items-center rounded-md hover:bg-status-stopped/12', FOCUS)}><X aria-hidden className="size-3.5" /></button>
        </div>
      )}
      <ul className="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card p-0">
        {shown.length === 0 && <li className="px-3 py-2 text-ui text-muted-foreground">No projects yet. Add one, or start a session in a folder.</li>}
        {shown.map(({ space, project }) => (
          <li key={`${space.key}/${project.projectId}`} className={cn('flex min-h-(--target-comfortable) items-center gap-2 px-3 py-1', project.hidden && 'text-muted-foreground')}>
            {project.isStarred && <Pin aria-label="Pinned" className="size-3.5 flex-shrink-0 text-muted-foreground" />}
            {actions.renaming?.projectId === project.projectId && actions.renaming.__spaceId === project.__spaceId ? (
              <RenameField project={project} onDone={(name) => void actions.rename(project, name)} onCancel={actions.cancelRename} />
            ) : (
              <span className="min-w-0 flex-1 truncate text-body font-medium">
                {project.displayName}
                {project.fullPath && <span className="ml-2 font-code text-caption font-normal text-muted-foreground">{project.fullPath}</span>}
              </span>
            )}
            {project.hidden && <Chip>hidden</Chip>}
            {project.kind !== 'brain' && <Chip>folder</Chip>}
            {spaces.length > 1 && <Chip>{space.name}</Chip>}
            <Menu label={`${project.displayName} actions`} items={projectMenuItems(project, actions)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RenameField({ project, onDone, onCancel }: { project: Project; onDone: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(project.displayName);
  // Escape cancels; the blur that follows must not save.
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      aria-label="Project name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { cancelled.current = true; onCancel(); } }}
      onBlur={() => { if (!cancelled.current) onDone(draft); }}
      className={cn('min-h-(--target-min) min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-body text-foreground outline-none', FOCUS)}
    />
  );
}
