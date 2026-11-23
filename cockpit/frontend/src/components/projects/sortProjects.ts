import type { ProjectSortOrder } from '@/components/settings/types/types';
import type { Project } from '@/types/app';

/** When a project was last used: its newest session's activity, 0 without one. */
export function lastActivity(project: Project): number {
  let latest = 0;
  for (const session of project.sessions ?? []) {
    const time = new Date(session.lastActivity || session.createdAt || 0).getTime();
    if (time > latest) latest = time;
  }
  return latest;
}

/** Pinned first, then by name or by last activity (Settings › Preferences › Project sorting). */
export function sortProjects<T extends { project: Project }>(rows: T[], order: ProjectSortOrder): T[] {
  const nameOf = (p: Project) => p.displayName || p.projectId;
  return [...rows].sort((a, b) => {
    const pinned = Number(Boolean(b.project.isStarred)) - Number(Boolean(a.project.isStarred));
    if (pinned !== 0) return pinned;
    if (order === 'date') return lastActivity(b.project) - lastActivity(a.project);
    return nameOf(a.project).localeCompare(nameOf(b.project));
  });
}
