// The launcher's choices, kept apart from the screen so they can be tested: which project a
// new session starts in, and what the "Recent projects" and "Continue a session" lists hold.
import type { AllSession } from '@/components/sidebar/allSessions';
import type { Board } from '@/lib/task-board';
import type { Project } from '@/types/app';

/** Why the picker shows its project: the desk's last one, the user's words, or the user's pick. */
export type PickReason = 'desk' | 'words' | 'manual';

const activityOf = (s: Pick<AllSession, 'lastActivity' | 'createdAt'>) => s.lastActivity ?? s.createdAt ?? '';

/** Lower case, accents and punctuation gone, so "Steiger-Naturals" matches "steiger naturals". */
const plain = (text: string) => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The project the message names: its display name or its id, as whole words. The longest name
 * wins ("Qualimero Website" over "Qualimero"); a name of three letters or less only as itself.
 */
export function projectFromWords(text: string, projects: Project[]): Project | null {
  const said = ` ${plain(text)} `;
  if (said.trim().length === 0) return null;
  let best: { project: Project; length: number } | null = null;
  for (const project of projects) {
    for (const name of new Set([project.displayName, project.projectId, project.brainProjectId ?? ''].map(plain))) {
      if (name.length < 3 || !said.includes(` ${name} `)) continue;
      if (!best || name.length > best.length) best = { project, length: name.length };
    }
  }
  return best?.project ?? null;
}

/** When a project was last active: its newest session. */
export function lastActivityOf(projectId: string, sessions: AllSession[]): string | null {
  const times = sessions.filter((s) => s.__projectId === projectId).map(activityOf).filter(Boolean).sort();
  return times.at(-1) ?? null;
}

/** The space's projects, most recently active first; never-used ones after, by name. */
export function projectsByActivity(projects: Project[], sessions: AllSession[]): Array<{ project: Project; last: string | null }> {
  return projects
    .filter((p) => !p.hidden)
    .map((project) => ({ project, last: lastActivityOf(project.projectId, sessions) }))
    .sort((a, b) => (b.last ?? '').localeCompare(a.last ?? '') || a.project.displayName.localeCompare(b.project.displayName));
}

/** A project's open tasks and how many of them wait for the viewer, from the task board. */
export function taskCounts(project: Project, board: Board | undefined): { open: number; you: number } {
  const brainId = project.brainProjectId;
  if (!board || !brainId) return { open: 0, you: 0 };
  const tasks = board.tasks.filter((t) => t.project === brainId && t.status !== 'resolved' && t.status !== 'invalidated');
  return { open: tasks.length, you: tasks.filter((t) => t.turn === 'needs_you' || t.turn === 'review').length };
}

/** The newest sessions of the space, for "Continue a session". */
export function recentSessions(sessions: AllSession[], spaceId: string, count: number): AllSession[] {
  return sessions.filter((s) => s.spaceId === spaceId && !s.archivedAt).sort((a, b) => activityOf(b).localeCompare(activityOf(a))).slice(0, count);
}

/** A session that asks the viewer something. */
export const asksYou = (session: AllSession) => session.attention?.kind === 'question' || session.attention?.kind === 'failed';
