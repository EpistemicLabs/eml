import { describe, expect, it } from 'vitest';

import { spawnProblem } from './spawn-problem';

describe('spawnProblem', () => {
  it("tells the host's reason why a worker could not start", () => {
    expect(spawnProblem({ code: 'NOT_STARTED', message: 'Codex is not signed in' })).toBe('A worker session could not start: Codex is not signed in');
  });

  it('says nothing when another tab took it, it is no longer needed, or it waits for room', () => {
    for (const code of ['ALREADY_CLAIMED', 'REVOKED', 'NO_ROOM']) expect(spawnProblem({ code, message: 'x' })).toBeNull();
    expect(spawnProblem(undefined)).toBeNull();
  });
});
