import { describe, expect, it } from 'vitest';

import { deskLayout, mainColumnWidth, mainWidthAtPointer, MIN_MAIN_PX, MIN_STACK_PANE_PX, paneGridGeometry } from './paneLayout';

describe('deskLayout', () => {
  it('is the even grid without a main pane', () => {
    for (let n = 1; n <= 8; n++) {
      const layout = deskLayout(n, false, undefined);
      expect(layout.hasMain).toBe(false);
      layout.placements.forEach((placement, i) => {
        const geo = paneGridGeometry(i, n);
        expect(placement.gridColumn).toBe(geo.gridColumn);
        expect(placement.gridRow).toBe(String(geo.gridRow));
      });
    }
  });

  it('lets a lone main pane fill the desk, without a column of its own', () => {
    const layout = deskLayout(1, true, 0.4);
    expect(layout.hasMain).toBe(false);
    expect(layout.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))');
    expect(layout.placements[0].gridColumn).toBe('1 / span 1');
  });

  it('gives the main pane the first column at full height', () => {
    const layout = deskLayout(5, true, undefined);
    expect(layout.gridTemplateColumns).toBe('minmax(0, var(--main-width)) repeat(2, minmax(0, 1fr))');
    expect(layout.gridTemplateRows).toBe('repeat(2, minmax(0, 1fr))');
    expect(layout.placements[0]).toMatchObject({ gridColumn: '1', gridRow: '1 / -1', borderRight: true });
  });

  it('runs the even grid over the other panes, past the main column', () => {
    for (let n = 2; n <= 8; n++) {
      const { placements } = deskLayout(n, true, undefined);
      expect(placements).toHaveLength(n);
      placements.slice(1).forEach((placement, i) => {
        const geo = paneGridGeometry(i, n - 1);
        const [start, span] = geo.gridColumn.split(' / span ').map(Number);
        expect(placement.gridColumn).toBe(`${start + 1} / span ${span}`);
        expect(placement.gridRow).toBe(String(geo.gridRow));
      });
    }
  });
});

describe('the main column width', () => {
  it('starts at a third', () => {
    expect(mainColumnWidth(undefined, 1)).toMatch(/, 33\.3+\d*%,/);
  });

  it('keeps room for the fullest row of the stack', () => {
    expect(mainColumnWidth(0.5, 2)).toBe(`clamp(${MIN_MAIN_PX}px, 50%, calc(100% - ${2 * MIN_STACK_PANE_PX}px))`);
    // Five panes in the stack: three on top.
    expect(mainColumnWidth(0.5, 5)).toContain(`calc(100% - ${3 * MIN_STACK_PANE_PX}px)`);
  });

  it('follows the pointer inside the limits', () => {
    expect(mainWidthAtPointer(600, 100, 1500, 1)).toBeCloseTo(500 / 1500);
  });

  it('stops at the minimum on the left and the stack on the right', () => {
    expect(mainWidthAtPointer(0, 100, 1500, 1)).toBeCloseTo(MIN_MAIN_PX / 1500);
    expect(mainWidthAtPointer(1600, 100, 1500, 2)).toBeCloseTo((1500 - 2 * MIN_STACK_PANE_PX) / 1500);
  });

  it('keeps the main minimum when a narrow desk has room for neither', () => {
    expect(mainWidthAtPointer(300, 0, 500, 3)).toBeCloseTo(MIN_MAIN_PX / 500);
  });
});
