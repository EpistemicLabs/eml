import type { ReactNode } from 'react';
import { Brain, Eye, EyeOff, Folder, Plus } from 'lucide-react';

import type { SpaceInfo } from '@/stores/useSpaceStore';
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

/** A heading with the plus that adds a project: where it goes is what the heading names. */
function AddProjectHeading({
  children,
  space,
  controller,
}: {
  children: ReactNode;
  space: SpaceInfo | null;
  controller: SidebarController;
}) {
  return (
    <div className="flex items-center justify-between gap-1 pr-1">
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        title={space ? `Add project to ${space.name}` : 'Add project'}
        aria-label={space ? `Add project to ${space.name}` : 'Add project'}
        onClick={() => controller.addProjectTo(space)}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ProjectGroup({
  header,
  projects,
  kindIcons,
  controller,
}: {
  header: ReactNode;
  projects: Project[];
  kindIcons: boolean;
  controller: SidebarController;
}) {
  if (projects.length === 0 && !header) return null;
  return (
    <div className="space-y-0.5">
      {header}
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

function ProjectGroups({
  groups,
  projectsHeader,
  controller,
}: {
  groups: Groups;
  projectsHeader: ReactNode;
  controller: SidebarController;
}) {
  const { pinned, brain, folder } = groups;
  return (
    <div className="space-y-3">
      {pinned.length > 0 && (
        <ProjectGroup header={<SidebarGroupHeader>Pinned</SidebarGroupHeader>} projects={pinned} kindIcons controller={controller} />
      )}
      <ProjectGroup header={projectsHeader} projects={brain} kindIcons={false} controller={controller} />
      {folder.length > 0 && (
        <ProjectGroup header={<SidebarGroupHeader>Folders</SidebarGroupHeader>} projects={folder} kindIcons={false} controller={controller} />
      )}
    </div>
  );
}

export function SidebarProjectTree({ controller }: { controller: SidebarController }) {
  const openProjectsHeader = (
    <AddProjectHeading space={null} controller={controller}>
      <SidebarGroupHeader>Projects</SidebarGroupHeader>
    </AddProjectHeading>
  );
  const showStatePanel =
    controller.isLoading ||
    (!controller.projectSections && (controller.projects.length === 0 || controller.visibleProjects.length === 0));

  if (showStatePanel) {
    return (
      <div className="space-y-3">
        {!controller.isLoading && openProjectsHeader}
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
            <AddProjectHeading space={space} controller={controller}>
              <div className="flex items-center gap-1.5 px-2 pt-1 text-[11px] font-medium text-foreground" title={`Space: ${space.name}`}>
                <Brain className="h-3 w-3 flex-shrink-0 text-muted-foreground" strokeWidth={1.8} />
                <span className="truncate">{space.name}</span>
              </div>
            </AddProjectHeading>
            <ProjectGroups
              groups={groups}
              projectsHeader={groups.pinned.length > 0 && groups.brain.length > 0 ? <SidebarGroupHeader>Projects</SidebarGroupHeader> : null}
              controller={controller}
            />
          </div>
        ))
      ) : (
        <ProjectGroups groups={controller.projectGroups} projectsHeader={openProjectsHeader} controller={controller} />
      )}
      <HiddenToggle controller={controller} />
    </div>
  );
}
