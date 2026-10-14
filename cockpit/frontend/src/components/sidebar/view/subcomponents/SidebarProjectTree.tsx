import { Eye, EyeOff, Folder } from 'lucide-react';

import SpaceSwitch from '@/components/app/SpaceSwitch';
import type { Project } from '@/types/app';
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
          key={project.projectId}
          project={project}
          showKindIcon={kindIcons && project.kind !== 'brain'}
          controller={controller}
        />
      ))}
    </div>
  );
}

export function SidebarProjectTree({ controller }: { controller: SidebarController }) {
  const showStatePanel =
    controller.isLoading || controller.projects.length === 0 || controller.visibleProjects.length === 0;

  if (showStatePanel) {
    return (
      <div className="space-y-3">
        <SpaceSwitch variant="sidebar" />
        <StatePanel controller={controller} />
        <HiddenToggle controller={controller} />
      </div>
    );
  }

  const { pinned, brain, folder } = controller.projectGroups;
  return (
    <div className="space-y-3">
      <SpaceSwitch variant="sidebar" />
      <ProjectGroup header="Pinned" projects={pinned} kindIcons controller={controller} />
      <ProjectGroup
        header={pinned.length > 0 ? 'Projects' : null}
        projects={brain}
        kindIcons={false}
        controller={controller}
      />
      <ProjectGroup header="Folders" projects={folder} kindIcons={false} controller={controller} />
      <HiddenToggle controller={controller} />
    </div>
  );
}
