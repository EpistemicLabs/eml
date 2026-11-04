import { Brain, Eye, EyeOff, Folder } from 'lucide-react';

import type { Project } from '@/types/app';
import { projectKey } from '../../spaceProjects';
import type { ProjectGroups as Groups } from '../../types';
import type { SidebarController } from '../../useSidebarController';
import { SidebarGroupHeader, SidebarStateBlock } from './SidebarParts';
import { SidebarProjectRow } from './SidebarProjectRow';

function HiddenToggle({ controller }: { controller: SidebarController }) {
  if (controller.hiddenCount <= 0) return null;
  return (
    <button
      type="button"
      onClick={controller.toggleShowHidden}
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
    >
      {controller.showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      {controller.showHidden ? 'Hide hidden & archived' : `Show hidden & archived (${controller.hiddenCount})`}
    </button>
  );
}

function StatePanel({ controller }: { controller: SidebarController }) {
  if (controller.isLoading) return <SidebarStateBlock spinner text="Loading projects…" />;
  if (controller.projects.length === 0) {
    return <SidebarStateBlock icon={Folder} heading="No projects yet" text="Add a project with the + icon above." />;
  }
  return (
    <SidebarStateBlock
      icon={EyeOff}
      heading="All projects hidden"
      text="Show hidden projects below to bring them back."
    />
  );
}

function ProjectGroup({
  header,
  projects,
  kindIcons,
  controller,
}: {
  header: string | null;
  projects: Project[];
  kindIcons: boolean;
  controller: SidebarController;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {header && <SidebarGroupHeader>{header}</SidebarGroupHeader>}
      {projects.map((project) => (
        <SidebarProjectRow
          key={projectKey(project)}
          project={project}
          showKindIcon={kindIcons && project.kind !== 'brain'}
          controller={controller}
        />
      ))}
    </div>
  );
}

function ProjectGroups({ groups, controller }: { groups: Groups; controller: SidebarController }) {
  const { pinned, brain, folder } = groups;
  return (
    <div className="space-y-3">
      <ProjectGroup header="Pinned" projects={pinned} kindIcons controller={controller} />
      <ProjectGroup
        header={pinned.length > 0 ? 'Projects' : null}
        projects={brain}
        kindIcons={false}
        controller={controller}
      />
      <ProjectGroup header="Folders" projects={folder} kindIcons={false} controller={controller} />
    </div>
  );
}

export function SidebarProjectTree({ controller }: { controller: SidebarController }) {
  const showStatePanel =
    controller.isLoading || controller.projects.length === 0 || controller.visibleProjects.length === 0;

  if (showStatePanel) {
    return (
      <div className="space-y-3">
        <StatePanel controller={controller} />
        <HiddenToggle controller={controller} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {controller.projectSections ? (
        controller.projectSections.map(({ space, groups }) => (
          <div key={space.id} className="space-y-1.5">
            <div className="flex items-center gap-1.5 px-2 pt-1 text-[11px] font-medium text-foreground" title={`Space: ${space.name}`}>
              <Brain className="h-3 w-3 flex-shrink-0 text-muted-foreground" strokeWidth={1.8} />
              <span className="truncate">{space.name}</span>
            </div>
            <ProjectGroups groups={groups} controller={controller} />
          </div>
        ))
      ) : (
        <ProjectGroups groups={controller.projectGroups} controller={controller} />
      )}
      <HiddenToggle controller={controller} />
    </div>
  );
}
