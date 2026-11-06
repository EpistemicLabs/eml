// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { spaceTone } from './space-color';

describe('a space\'s tone', () => {
  it('is the token of its colour', () => {
    expect(spaceTone({ color: 'violet' })).toBe('var(--space-violet)');
  });

  it('leaves the element alone without a colour', () => {
    expect(spaceTone({})).toBeUndefined();
    expect(spaceTone(null)).toBeUndefined();
  });
});
