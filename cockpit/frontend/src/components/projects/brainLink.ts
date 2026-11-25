// Every cockpit project is a brain project (decision cockpit-brain-project-model). What the add-project
// wizard and the link dialogs share: minting a new brain project's id, making it, the brain projects a
// folder can join, and the host calls that link a folder-only project or remove it.
import type { QueryClient } from '@tanstack/react-query';

import { brainGet, brainPost } from '@/lib/api';
import { hostErrorMessage } from '@/lib/host-error';
import { SPACE_HEADER } from '@/lib/space-header';
import type { Project as BrainProject, ProjectsResponse as BrainProjectsResponse } from '@/lib/types';
import type { Project } from '@/types/app';
import { api, type ProjectsResponse } from '@/utils/api';

export const slugify = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** First free id: `slug`, then `slug-2`, `slug-3`, … against the ids the brain already has. */
export const uniqueId = (slug: string, taken: ReadonlySet<string>) => {
  if (!slug || !taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** The brain views read the project list through react-query: drop it so a new project shows up there right away. */
export function invalidateBrainProjects(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ['projects'] });
  void queryClient.invalidateQueries({ queryKey: ['stats'] });
}

/**
 * Make a brain project (POST /object/project). The id is minted from the name against the ids the brain has
 * now (all statuses); `taken` skips that read when the caller has them.
 */
export async function createBrainProject(
  fields: { name: string; goal?: string; description?: string },
  options: { space?: string; taken?: ReadonlySet<string> } = {},
): Promise<{ id: string; project: Record<string, unknown> }> {
  const name = fields.name.trim();
  const taken = options.taken ?? await brainGet<BrainProjectsResponse>('/projects', undefined, options.space)
    .then((res) => new Set(res.projects.map((p) => p.id)))
    // Unreachable brain: the server's 400 ("already exists") still guards the id.
    .catch(() => new Set<string>());
  const id = uniqueId(slugify(name), taken);
  if (!name || !id) throw new Error('Please provide a project name.');
  const { object } = await brainPost<{ object: Record<string, unknown>; created: boolean }>('/object/project', {
    id,
    name,
    goal: fields.goal?.trim() || undefined,
    description: fields.description?.trim() || undefined,
    status: 'active',
  }, options.space);
  return { id, project: object };
}

/** A brain project a folder can join; one that runs in another folder cannot (the host answers FOLDER_TAKEN). */
export type LinkTarget = { id: string; name: string; elsewhere: boolean };

/** The open brain projects of a space, and the cockpit's view of its projects (which folder each runs in). */
export async function loadLinkTargets(space?: string): Promise<{ brain: BrainProject[]; cockpit: Project[] }> {
  const [brain, cockpit] = await Promise.all([
    brainGet<BrainProjectsResponse>('/projects', undefined, space).then((res) => res.projects.filter((p) => p.status !== 'archived')),
    fetch('/api/projects', space ? { headers: { [SPACE_HEADER]: space } } : undefined)
      .then((res) => (res.ok ? (res.json() as Promise<ProjectsResponse>) : { projects: [] }))
      .then((body) => (Array.isArray(body.projects) ? body.projects : []))
      .catch(() => [] as Project[]),
  ]);
  return { brain, cockpit };
}

/** The brain projects the folder at `folderPath` can join, by name; those that run in another folder marked. */
export function linkTargets(brain: BrainProject[], cockpit: Project[], folderPath: string | null): LinkTarget[] {
  return brain
    .map((b) => {
      const path = cockpit.find((p) => p.kind === 'brain' && p.brainProjectId === b.id)?.fullPath ?? null;
      return { id: b.id, name: b.name, elsewhere: Boolean(path) && path !== folderPath };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The target that plainly is this folder's project: free and named like it. */
export function matchingTarget(targets: LinkTarget[], project: Project): LinkTarget | undefined {
  const slug = slugify(project.displayName);
  return targets.find((t) => !t.elsewhere && (slugify(t.name) === slug || t.id === slug));
}

/** The brain project takes the folder and its sessions; the folder-only entry goes. Rejects with the host's message. */
export async function linkFolder(project: Project, brainId: string): Promise<void> {
  const response = await api.linkProject(project.projectId, brainId, project.__spaceId);
  if (!response.ok) throw new Error(await hostErrorMessage(response));
}

/** Remove a folder-only project from the cockpit; its transcripts stay. Rejects with the host's message. */
export async function removeFolder(project: Project): Promise<void> {
  const response = await api.deleteProject(project.projectId, false, project.__spaceId);
  if (!response.ok) throw new Error(await hostErrorMessage(response));
}

export const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
