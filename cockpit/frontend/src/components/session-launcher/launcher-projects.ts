// The open space's projects for the launcher. AppContent holds them (useProjectsState) and
// hands them over here, so an empty pane does not load the project list a second time.
import type { Project } from '@/types/app';

let projects: Project[] = [];
const listeners = new Set<() => void>();

export function setLauncherProjects(next: Project[]): void {
  if (next === projects) return;
  projects = next;
  for (const listener of listeners) listener();
}

export const getLauncherProjects = (): Project[] => projects;

export function subscribeLauncherProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
