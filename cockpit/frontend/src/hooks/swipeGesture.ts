/**
 * The pure part of the phone's swipes: where one may start and when it counts.
 * iOS reserves the screen edge for its back gesture, so a touch there only
 * reaches the page if the page claims it at touchstart (the edge zone). A swipe
 * starting just inside that is the page's anyway, without claiming anything.
 */
export const EDGE_ZONE_PX = 20;
export const INNER_ZONE_PX = 32;
export const SWIPE_COMMIT_PX = 56;
const SWIPE_SLOP_PX = 10;

export type SwipeZone = 'edge' | 'inner';
export type SwipeDirection = 'right' | 'left' | 'down';
export type SwipeReading = 'pending' | 'cancel' | 'commit';

export function swipeZone(x: number): SwipeZone | null {
  if (x <= EDGE_ZONE_PX) return 'edge';
  if (x <= INNER_ZONE_PX) return 'inner';
  return null;
}

/** A swipe commits once far enough along its direction; a touch that sets off another way is not one. */
export function readSwipe(dx: number, dy: number, direction: SwipeDirection): SwipeReading {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP_PX) return 'pending';
  const along = direction === 'right' ? dx : direction === 'left' ? -dx : dy;
  const across = direction === 'down' ? Math.abs(dx) : Math.abs(dy);
  if (along <= across) return 'cancel';
  return along >= SWIPE_COMMIT_PX ? 'commit' : 'pending';
}
