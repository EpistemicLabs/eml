import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { Project } from '@/types/app';

import { projectFromWords, projectsByActivity, recentSessions, taskCounts } from './launcher';

const project = (projectId: string, displayName: string, brainProjectId: string | null = null): Project => ({ projectId, displayName, brainProjectId, fullPath: `/w/${projectId}` });
const PROJECTS = [project('bp-verapur', 'Verapur', 'verapur'), project('bp-qualimero', 'Qualimero'), project('bp-qualimero-website', 'Qualimero Website'), project('bp-tm', 'TM')];
const session = (id: string, projectId: string, lastActivity: string, extra: Partial<AllSession> = {}): AllSession => ({ id, __projectId: projectId, spaceId: 'main', lastActivity, ...extra } as AllSession);

describe('the launcher', () => {
  it('finds the project a message names, by name or id, the longest name first, whole words only', () => {
    expect(projectFromWords('Check the Verapur reply', PROJECTS)?.projectId).toBe('bp-verapur');
    expect(projectFromWords('verapur: Max answered?', PROJECTS)?.projectId).toBe('bp-verapur');
    expect(projectFromWords('Fix the qualimero website hero', PROJECTS)?.projectId).toBe('bp-qualimero-website');
    expect(projectFromWords('Unverapured text', PROJECTS)).toBeNull();
    expect(projectFromWords('tm stays too short to match', PROJECTS)).toBeNull();
    expect(projectFromWords('', PROJECTS)).toBeNull();
  });

  it('lists projects most recently active first, and the newest sessions of the space', () => {
    const sessions = [session('a', 'bp-qualimero', '2026-11-19T10:00:00Z'), session('b', 'bp-verapur', '2026-11-20T09:00:00Z'), session('c', 'bp-verapur', '2026-11-18T09:00:00Z', { spaceId: 'eml' }), session('d', 'bp-tm', '2026-11-20T10:00:00Z', { archivedAt: 'x' })];
    expect(projectsByActivity(PROJECTS, sessions).map((p) => p.project.projectId)).toEqual(['bp-tm', 'bp-verapur', 'bp-qualimero', 'bp-qualimero-website']);
    expect(recentSessions(sessions, 'main', 5).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('counts a project\'s open tasks and the ones that wait for the viewer', () => {
    const board = { tasks: [
      { project: 'verapur', status: 'active', turn: 'needs_you' },
      { project: 'verapur', status: 'planned', turn: 'agent_scheduled' },
      { project: 'verapur', status: 'resolved', turn: 'done' },
      { project: 'other', status: 'active', turn: 'needs_you' },
    ] } as never;
    expect(taskCounts(PROJECTS[0], board)).toEqual({ open: 2, you: 1 });
    expect(taskCounts(PROJECTS[1], board)).toEqual({ open: 0, you: 0 });
  });
});
