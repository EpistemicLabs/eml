import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPACE_HEADER } from '@/lib/space-header';
import { api } from './api';

// A project id says nothing about its space: an action on a project listed from
// another space must not reach a project of the same id in the open one.

const sentHeaders = (fetchMock: ReturnType<typeof vi.fn>) => new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);

afterEach(() => vi.unstubAllGlobals());

describe('the project calls', () => {
  it.each([
    ['rename', () => api.renameProject('p1', 'New', 'space-b')],
    ['pin', () => api.setProjectStar('p1', true, 'space-b')],
    ['hide', () => api.setProjectHidden('p1', true, 'space-b')],
    ['set folder', () => api.setProjectPath('p1', '/tmp/x', 'space-b')],
    ['delete', () => api.deleteProject('p1', false, 'space-b')],
  ])('%s names the project\'s space', async (_name, call) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await call();
    expect(sentHeaders(fetchMock).get(SPACE_HEADER)).toBe('space-b');
  });

  it('leaves the space to the open one when none is named', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await api.deleteProject('p1');
    expect(sentHeaders(fetchMock).has(SPACE_HEADER)).toBe(false);
  });
});
