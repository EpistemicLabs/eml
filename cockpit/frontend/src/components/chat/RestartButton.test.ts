import { describe, expect, it } from 'vitest';

import { restartStep } from './RestartButton';

describe('restartStep', () => {
  it('restarts at once when no turn runs', () => {
    expect(restartStep(false, false)).toBe('restart');
  });

  it('asks first during a turn, then restarts on the second click', () => {
    expect(restartStep(true, false)).toBe('confirm');
    expect(restartStep(true, true)).toBe('restart');
  });
});
