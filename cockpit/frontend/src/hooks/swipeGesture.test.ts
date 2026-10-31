import { describe, expect, it } from 'vitest';

import { EDGE_ZONE_PX, INNER_ZONE_PX, SWIPE_COMMIT_PX, readSwipe, swipeZone } from './swipeGesture';

describe('swipeZone', () => {
  it('separates the edge, the band inside it and the rest of the screen', () => {
    expect(swipeZone(0)).toBe('edge');
    expect(swipeZone(EDGE_ZONE_PX)).toBe('edge');
    expect(swipeZone(EDGE_ZONE_PX + 1)).toBe('inner');
    expect(swipeZone(INNER_ZONE_PX)).toBe('inner');
    expect(swipeZone(INNER_ZONE_PX + 1)).toBeNull();
  });
});

describe('readSwipe', () => {
  it('waits while the finger has barely moved', () => {
    expect(readSwipe(4, 3, 'right')).toBe('pending');
  });

  it('commits once far enough along the direction', () => {
    expect(readSwipe(SWIPE_COMMIT_PX - 1, 0, 'right')).toBe('pending');
    expect(readSwipe(SWIPE_COMMIT_PX, 0, 'right')).toBe('commit');
    expect(readSwipe(-SWIPE_COMMIT_PX, 5, 'left')).toBe('commit');
    expect(readSwipe(5, SWIPE_COMMIT_PX, 'down')).toBe('commit');
  });

  it('gives up on a vertical scroll', () => {
    expect(readSwipe(12, 40, 'right')).toBe('cancel');
    expect(readSwipe(-12, 40, 'left')).toBe('cancel');
  });

  it('gives up on the opposite direction', () => {
    expect(readSwipe(-30, 0, 'right')).toBe('cancel');
    expect(readSwipe(30, 0, 'left')).toBe('cancel');
    expect(readSwipe(0, -30, 'down')).toBe('cancel');
  });
});
