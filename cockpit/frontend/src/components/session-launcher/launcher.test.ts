import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { Project } from '@/types/app';

import { projectFromWords, projectsByActivity, recentSessions, taskCounts } from './launcher';

const project = (projectId: string, displayName: string, brainProjectId: string | null = null): Project => ({ projectId, displayName, brainProjectId, fullPath: `/w/${projectId}` });
const PROJECTS = [project('bp-northwind', 'Northwind', 'northwind'), project('bp-qualimero', 'Qualimero'), project('bp-qualimero-website', 'Qualimero Website'), project('bp-acme', 'Acme')];
const session = (id: string, projectId: string, lastActivity: string, extra: Partial<AllSession> = {}): AllSession => ({ id, __projectId: projectId, spaceId: 'main', lastActivity, ...extra } as AllSession);

describe('the launcher', () => {
  it('finds the project a message names, by name or id, the longest name first, whole words only', () => {
    expect(projectFromWords('Check the Northwind reply', PROJECTS)?.projectId).toBe('bp-northwind');
    expect(projectFromWords('northwind: Max answered?', PROJECTS)?.projectId).toBe('bp-northwind');
    expect(projectFromWords('Fix the qualimero website hero', PROJECTS)?.projectId).toBe('bp-qualimero-website');
    expect(projectFromWords('Unnorthwinded text', PROJECTS)).toBeNull();
    expect(projectFromWords('tm stays too short to match', PROJECTS)).toBeNull();
    expect(projectFromWords('', PROJECTS)).toBeNull();
  });

  it('lists projects most recently active first, and the newest sessions of the space', () => {
    const sessions = [session('a', 'bp-qualimero', '2026-11-19T10:00:00Z'), session('b', 'bp-northwind', '2026-11-20T09:00:00Z'), session('c', 'bp-northwind', '2026-11-18T09:00:00Z', { spaceId: 'eml' }), session('d', 'bp-acme', '2026-11-20T10:00:00Z', { archivedAt: 'x' })];
    expect(projectsByActivity(PROJECTS, sessions).map((p) => p.project.projectId)).toEqual(['bp-acme', 'bp-northwind', 'bp-qualimero', 'bp-qualimero-website']);
    expect(recentSessions(sessions, 'main', 5).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('counts a project\'s open tasks and the ones that wait for the viewer', () => {
    const board = { tasks: [
      { project: 'northwind', status: 'active', turn: 'needs_you' },
      { project: 'northwind', status: 'planned', turn: 'agent_scheduled' },
      { project: 'northwind', status: 'resolved', turn: 'done' },
      { project: 'other', status: 'active', turn: 'needs_you' },
    ] } as never;
    expect(taskCounts(PROJECTS[0], board)).toEqual({ open: 2, you: 1 });
    expect(taskCounts(PROJECTS[1], board)).toEqual({ open: 0, you: 0 });
  });
});
