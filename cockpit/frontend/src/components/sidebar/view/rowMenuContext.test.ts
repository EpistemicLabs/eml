import { describe, expect, it } from 'vitest';

import { rowMenuPosition } from './rowMenuContext';

const view = { width: 400, height: 800 };
const menu = { width: 150, height: 60 };

describe('rowMenuPosition', () => {
  it('opens under the row, ending at its right side', () => {
    expect(rowMenuPosition({ top: 100, bottom: 140, right: 320 }, menu, view)).toEqual({ top: 148, left: 170 });
  });

  it('opens over the row where it would not fit under it', () => {
    expect(rowMenuPosition({ top: 700, bottom: 740, right: 320 }, menu, view).top).toBe(632);
  });

  it('stays on screen', () => {
    expect(rowMenuPosition({ top: 100, bottom: 140, right: 100 }, menu, view).left).toBe(8);
    expect(rowMenuPosition({ top: 30, bottom: 790, right: 320 }, menu, view).top).toBe(8);
  });
});
