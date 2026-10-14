import type { Project } from '@/types/app';

/** One session of any project, flattened for the palette. */
export interface SessionEntry {
  id: string;
  projectId: string;
  projectName: string;
  label: string;
  /** Parsed activity time in ms; NaN when missing or unparseable. */
  activityMs: number;
}

/** Lowercased, whitespace-separated words of a query (empty for a blank query). */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word occurs in the text, case-insensitively. No words matches everything. */
export function matchesWords(words: string[], ...fields: Array<string | null | undefined>): boolean {
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Final non-empty segment of a folder path, or '' without a path. */
export function folderName(fullPath: string | null): string {
  if (!fullPath) return '';
  const parts = fullPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** All loaded sessions, newest activity first; missing or unparseable times last. */
export function collectSessions(projects: Project[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      const stamp = session.lastActivity || session.createdAt || '';
      entries.push({
        id: session.id,
        projectId: project.projectId,
        projectName: project.displayName,
        label: session.title || session.summary || 'New Session',
        activityMs: stamp ? Date.parse(stamp) : Number.NaN,
      });
    }
  }
  return entries.sort((a, b) => {
    const aKnown = !Number.isNaN(a.activityMs);
    const bKnown = !Number.isNaN(b.activityMs);
    if (aKnown && bKnown) return b.activityMs - a.activityMs;
    if (aKnown) return -1;
    if (bKnown) return 1;
    return 0;
  });
}

/** The given project first, the rest in their original order. */
export function currentProjectFirst(projects: Project[], currentId: string | null): Project[] {
  if (!currentId) return projects;
  const current = projects.filter((p) => p.projectId === currentId);
  if (current.length === 0) return projects;
  return [...current, ...projects.filter((p) => p.projectId !== currentId)];
}

/** macOS (Cmd-based shortcuts) vs. everything else (Ctrl-based). */
export function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}
