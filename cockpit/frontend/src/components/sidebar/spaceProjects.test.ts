// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { Project } from '@/types/app';
import { bySpace, listProjects, projectKey } from './spaceProjects';

const main: SpaceInfo = { id: 'main-id', name: 'Main', main: true, agent: null, upgrade: null, shared: false };
const other: SpaceInfo = { id: 'other-id', name: 'Privat', main: false, agent: null, upgrade: null, shared: false };
const project = (projectId: string): Project => ({ projectId, displayName: projectId }) as Project;

describe('the projects the sidebar lists', () => {
  it('is the open space\'s without All spaces', () => {
    const listed = listProjects({ 'other-id': [project('b')] }, [project('a')], [main, other], main, false);
    expect(listed.map((entry) => [entry.projectId, entry.__spaceId])).toEqual([['a', 'main-id']]);
  });

  it('is every space\'s under All spaces, main under its empty key', () => {
    const listed = listProjects({ '': [project('a')], 'other-id': [project('b')] }, [project('b')], [main, other], other, true);
    expect(listed.map((entry) => [entry.projectId, entry.__spaceId])).toEqual([['a', 'main-id'], ['b', 'other-id']]);
  });

  it('tells apart one id in two spaces', () => {
    const listed = listProjects({ '': [project('same')], 'other-id': [project('same')] }, [project('same')], [main, other], main, true);
    expect(new Set(listed.map(projectKey)).size).toBe(2);
  });

  it('keeps a space with nothing to show: a project can be added to it', () => {
    const listed = listProjects({ '': [project('a')] }, [project('a')], [main, other], main, true);
    expect(bySpace([main, other], listed, (own) => own.length)).toEqual([{ space: main, groups: 1 }, { space: other, groups: 0 }]);
  });
});
