// The projects the sidebar lists: the open space's, or under All spaces every
// space's. Each carries its space, because a project id alone does not say which
// one it is: one folder has the same id in two spaces.
import { projectsOfSpace, type ProjectsBySpace } from '@/hooks/useProjectsState';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';
import type { Project } from '@/types/app';

/** What tells a listed project from one of the same id in another space. */
export const projectKey = (project: Pick<Project, 'projectId' | '__spaceId'>): string =>
  `${project.__spaceId ?? ''}:${project.projectId}`;

export function listProjects(
  projectsBySpace: ProjectsBySpace,
  openProjects: Project[],
  spaces: SpaceInfo[],
  openSpace: SpaceInfo | null,
  allView: boolean,
): Project[] {
  const tagged = (list: Project[], space: SpaceInfo | null) =>
    list.map((project) => ({ ...project, __spaceId: space?.id }));
  if (!allView) return tagged(openProjects, openSpace);
  return spaces.flatMap((space) =>
    tagged(space.id === openSpace?.id ? openProjects : projectsOfSpace(projectsBySpace, paneSpaceKey(space)), space));
}

/** Each space with what is shown of it, in the spaces' order; one with nothing stays, a project can be added to it. */
export function bySpace<T>(spaces: SpaceInfo[], projects: Project[], group: (projects: Project[]) => T): Array<{ space: SpaceInfo; groups: T }> {
  return spaces.map((space) => ({ space, groups: group(projects.filter((project) => project.__spaceId === space.id)) }));
}
