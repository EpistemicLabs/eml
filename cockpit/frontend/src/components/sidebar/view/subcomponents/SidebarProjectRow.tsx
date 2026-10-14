import { Brain, Check, ChevronDown, ChevronRight, Folder, FolderOpen, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, Tooltip } from '@/shared/view/ui';
import type { Project } from '@/types/app';
import type { SidebarController } from '../../useSidebarController';
import { SidebarSessionsArea } from './SidebarSessionsArea';

const ROW_SHAPE = 'h-7.5 w-full justify-between gap-2 rounded-md px-2 font-normal [&_svg]:size-3';

function KindIcon({ project, expanded }: { project: Project; expanded: boolean }) {
  if (project.kind === 'brain') return <Brain className="h-3 w-3 flex-shrink-0 text-muted-foreground" />;
  const Icon = expanded ? FolderOpen : Folder;
  return <Icon className="h-3 w-3 flex-shrink-0 text-muted-foreground" />;
}

function ProjectName({ project }: { project: Project }) {
  const detail = project.fullPath ? project.fullPath : project.kind === 'brain' ? 'Brain project' : null;
  return (
    <Tooltip
      position="right"
      delay={250}
      wrapperClassName="relative min-w-0"
      content={
        <div>
          <div>{project.displayName}</div>
          {detail && <div className="font-normal opacity-70">{detail}</div>}
        </div>
      }
    >
      <span className="block truncate text-xs font-medium text-foreground">{project.displayName}</span>
    </Tooltip>
  );
}

function ProjectRenameField({
  draft,
  onDraftChange,
  onSave,
  onCancel,
}: {
  draft: string;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      type="text"
      value={draft}
      autoFocus
      placeholder="Project name"
      aria-label="Project name"
      onChange={(event) => onDraftChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSave();
        else if (event.key === 'Escape') onCancel();
      }}
      className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:ring-2 focus:ring-primary/20 focus:outline-none"
    />
  );
}

export function SidebarProjectRow({
  project,
  showKindIcon,
  controller,
}: {
  project: Project;
  showKindIcon: boolean;
  controller: SidebarController;
}) {
  const isExpanded = controller.expanded.has(project.projectId);
  const isSelected = controller.selectedProjectId === project.projectId;
  const isDeleting = controller.deleting.has(project.projectId);
  const isDimmed = Boolean(project.hidden) || project.brainStatus === 'archived';
  const rename = controller.projectRename?.id === project.projectId ? controller.projectRename : null;
  const selectedTone = isSelected && 'bg-accent text-accent-foreground';

  const archivedPill = project.brainStatus === 'archived' && (
    <span className="flex-shrink-0 rounded-full border border-border px-1.5 text-[9px] leading-4 tracking-wide text-muted-foreground uppercase">
      archived
    </span>
  );

  return (
    <div
      className={cn(
        'space-y-0',
        isDeleting && 'pointer-events-none opacity-50',
        !isDeleting && isDimmed && 'opacity-60',
      )}
    >
      {rename ? (
        <div className={cn('flex items-center text-sm whitespace-nowrap', ROW_SHAPE, selectedTone)}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {showKindIcon && <KindIcon project={project} expanded={isExpanded} />}
            <ProjectRenameField
              draft={rename.draft}
              onDraftChange={controller.setProjectRenameDraft}
              onSave={() => void controller.saveProjectRename()}
              onCancel={controller.cancelProjectRename}
            />
            {archivedPill}
          </div>
          <div className="flex flex-shrink-0 items-center gap-0.5">
            <button
              type="button"
              title="Save"
              aria-label="Save"
              className="flex h-5 w-5 items-center justify-center rounded text-foreground transition-colors hover:bg-muted"
              onClick={() => void controller.saveProjectRename()}
            >
              <Check className="h-3 w-3" />
            </button>
            <button
              type="button"
              title="Cancel"
              aria-label="Cancel"
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={controller.cancelProjectRename}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          className={cn('group', ROW_SHAPE, 'hover:bg-accent/50', selectedTone, isSelected && 'hover:bg-accent')}
          onClick={() => controller.selectAndToggleProject(project)}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {showKindIcon && <KindIcon project={project} expanded={isExpanded} />}
            <ProjectName project={project} />
            {archivedPill}
          </div>
          <div className="flex flex-shrink-0 items-center">
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground transition-colors group-hover:text-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground transition-colors group-hover:text-foreground" />
            )}
          </div>
        </Button>
      )}
      {isExpanded && <SidebarSessionsArea project={project} controller={controller} />}
    </div>
  );
}
