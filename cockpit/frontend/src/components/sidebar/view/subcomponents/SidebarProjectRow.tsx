import { useRef } from 'react';
import { Brain, Check, ChevronDown, ChevronRight, Folder, FolderOpen, MoreHorizontal, X } from 'lucide-react';

import { useLongPress } from '@/hooks/useLongPress';
import { cn } from '@/lib/utils';
import { FIELD, FOCUS, ROW, Tooltip } from '@/shared/view/ui';
import type { Project } from '@/types/app';
import { projectKey } from '../../spaceProjects';
import type { SidebarController } from '../../useSidebarController';
import { useRowMenu } from '../rowMenuContext';
import { SidebarSessionsArea } from './SidebarSessionsArea';

const ROW_SHAPE = 'h-7.5 w-full justify-between gap-2 rounded-md px-2 font-normal [&_svg]:size-3';
/** A small square action next to the rename field, at the minimum target. */
const FIELD_ACTION = cn('flex size-(--target-min) items-center justify-center rounded-md transition-colors duration-(--duration-fast) hover:bg-muted', FOCUS);

function KindIcon({ project, expanded }: { project: Project; expanded: boolean }) {
  if (project.kind === 'brain') return <Brain className="size-3 flex-shrink-0 text-muted-foreground" />;
  const Icon = expanded ? FolderOpen : Folder;
  return <Icon className="size-3 flex-shrink-0 text-muted-foreground" />;
}

/** The name; a hidden or archived project shows it in the muted text colour, never dimmed. */
function ProjectName({ project, muted }: { project: Project; muted: boolean }) {
  const detail = project.fullPath ? project.fullPath : project.kind === 'brain' ? 'Brain project' : null;
  return (
    <Tooltip
      position="right"
      delay={250}
      wrapperClassName="relative min-w-0"
      content={
        <div>
          <div>{project.displayName}</div>
          {detail && <div className="font-normal">{detail}</div>}
        </div>
      }
    >
      <span className={cn('block truncate text-ui font-medium', muted ? 'text-muted-foreground' : 'text-foreground')}>{project.displayName}</span>
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
      className={cn(FIELD, 'min-h-(--target-min) min-w-0 rounded-md px-1.5 text-ui')}
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
  const key = projectKey(project);
  const isExpanded = controller.isExpanded(project);
  const isSelected = controller.selectedProjectKey === key;
  const isDeleting = controller.deleting.has(key);
  const isDimmed = Boolean(project.hidden) || project.brainStatus === 'archived';
  const menu = useRowMenu();
  const rowRef = useRef<HTMLDivElement>(null);
  const openMenu = () => {
    controller.enterSpace(project);
    menu?.open({ kind: 'project', project }, rowRef.current);
  };
  const longPress = useLongPress(openMenu);
  // In the compact layout the menu does the renaming.
  const rename = !menu && controller.projectRename?.id === key ? controller.projectRename : null;
  const selectedTone = isSelected && 'bg-muted';

  const archivedPill = project.brainStatus === 'archived' && (
    <span className="flex-shrink-0 rounded-full border border-border px-1.5 text-caption tracking-label text-muted-foreground uppercase">
      archived
    </span>
  );

  return (
    <div
      className={cn(
        'space-y-0',
        isDeleting && 'pointer-events-none opacity-50',
      )}
    >
      {rename ? (
        <div className={cn('flex items-center text-body whitespace-nowrap', ROW_SHAPE, selectedTone)}>
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
              className={cn(FIELD_ACTION, 'text-foreground')}
              onClick={() => void controller.saveProjectRename()}
            >
              <Check className="size-3" />
            </button>
            <button
              type="button"
              title="Cancel"
              aria-label="Cancel"
              className={cn(FIELD_ACTION, 'text-muted-foreground hover:text-foreground')}
              onClick={controller.cancelProjectRename}
            >
              <X className="size-3" />
            </button>
          </div>
        </div>
      ) : (
        <div ref={rowRef} className="relative" {...(menu ? longPress : {})}>
        <button
          type="button"
          className={cn('group', ROW, ROW_SHAPE, selectedTone, menu && 'h-10 pr-10')}
          onClick={() => controller.selectAndToggleProject(project)}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {showKindIcon && <KindIcon project={project} expanded={isExpanded} />}
            <ProjectName project={project} muted={isDimmed} />
            {archivedPill}
          </div>
          <div className="flex flex-shrink-0 items-center">
            {isExpanded ? (
              <ChevronDown aria-hidden className="size-3 text-muted-foreground transition-colors duration-(--duration-fast) group-hover:text-foreground" />
            ) : (
              <ChevronRight aria-hidden className="size-3 text-muted-foreground transition-colors duration-(--duration-fast) group-hover:text-foreground" />
            )}
          </div>
        </button>
        {menu && (
          <button
            type="button"
            aria-label={`Actions for ${project.displayName}`}
            className={cn('absolute top-0 right-0 flex size-10 items-center justify-center rounded-md text-muted-foreground active:text-foreground', FOCUS)}
            onClick={openMenu}
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </button>
        )}
        </div>
      )}
      {isExpanded && <SidebarSessionsArea project={project} controller={controller} />}
    </div>
  );
}
