// The pane grid's geometry, without React: the even grid, and the main + stack
// layout that puts one pane in a full-height column at the left and runs the
// even grid over the rest.

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

/** What a main pane starts with, as a share of the desk's width. */
export const DEFAULT_MAIN_WIDTH = 1 / 3;

/** The main column never gets narrower than its toolbar and a usable terminal. */
export const MIN_MAIN_PX = 320;

/** Below this a pane's body (MainContent's min-w-[280px]) starts to clip. */
export const MIN_STACK_PANE_PX = 280;

// Grid geometry for a pane at index `i` of `n` total. ≤3 panes share one row;
// 4+ split into a top row of ceil(n/2) and a bottom row of floor(n/2).
// Returned as explicit grid placement so every pane stays a flat sibling of
// ONE grid container — crossing the 3→4 boundary only moves a pane's grid
// cell, it never reparents (and thus never unmounts/remounts) the pane, so
// terminal state survives the reflow.
export function paneGridGeometry(i: number, n: number) {
  const twoRows = n > 3;
  const top = twoRows ? Math.ceil(n / 2) : n;
  const bottom = n - top;
  const cols = twoRows ? lcm(top, bottom) : n;
  const inTopRow = !twoRows || i < top;
  const rowCount = inTopRow ? top : bottom;
  const posInRow = inTopRow ? i : i - top;
  const span = cols / rowCount;
  return {
    cols,
    twoRows,
    gridRow: inTopRow ? 1 : 2,
    gridColumn: `${posInRow * span + 1} / span ${span}`,
    isLastInRow: posInRow === rowCount - 1,
    inTopRow,
  };
}

export type PanePlacement = {
  gridRow: string;
  gridColumn: string;
  borderRight: boolean;
  borderBottom: boolean;
};

export type DeskLayout = {
  /** A main column is shown (a lone main pane just fills the even grid). */
  hasMain: boolean;
  gridTemplateColumns: string;
  gridTemplateRows: string;
  /** One per pane, in the order of the desk's panes. */
  placements: PanePlacement[];
};

/** How wide the stack must stay for its fullest row to fit. */
const minStackPx = (stackCount: number): number => {
  const { twoRows } = paneGridGeometry(0, stackCount);
  return (twoRows ? Math.ceil(stackCount / 2) : stackCount) * MIN_STACK_PANE_PX;
};

/**
 * The main column's width as CSS. Clamped here and not when it is stored, so it
 * follows the window and the number of panes without anything being rewritten.
 * When the two limits collide (a narrow window, many panes) the main pane's wins.
 */
export function mainColumnWidth(share: number | undefined, stackCount: number): string {
  const percent = (share ?? DEFAULT_MAIN_WIDTH) * 100;
  return `clamp(${MIN_MAIN_PX}px, ${percent}%, calc(100% - ${minStackPx(stackCount)}px))`;
}

/** The share a divider drag ends on, within the same limits as mainColumnWidth. */
export function mainWidthAtPointer(pointerX: number, gridLeft: number, gridWidth: number, stackCount: number): number {
  const px = Math.max(MIN_MAIN_PX, Math.min(pointerX - gridLeft, gridWidth - minStackPx(stackCount)));
  return Math.min(px / gridWidth, 1);
}

/**
 * The layout of a desk with `n` panes. The main pane is the first one
 * (usePaneStore keeps it there); alone on its desk it simply fills it.
 */
export function deskLayout(n: number, hasMainPane: boolean, mainWidth: number | undefined): DeskLayout {
  const hasMain = hasMainPane && n > 1;
  const stackCount = hasMain ? n - 1 : n;
  const { cols, twoRows } = paneGridGeometry(0, stackCount);
  const stackCols = `repeat(${cols}, minmax(0, 1fr))`;
  const offset = hasMain ? 1 : 0;
  const placements: PanePlacement[] = [];
  if (hasMain) placements.push({ gridRow: '1 / -1', gridColumn: '1', borderRight: true, borderBottom: false });
  for (let i = 0; i < stackCount; i++) {
    const geo = paneGridGeometry(i, stackCount);
    placements.push({
      gridRow: String(geo.gridRow),
      // Past the main column; a span stays the same width in stack columns.
      gridColumn: geo.gridColumn.replace(/^\d+/, (start) => String(Number(start) + offset)),
      borderRight: !geo.isLastInRow,
      borderBottom: geo.twoRows && geo.inTopRow,
    });
  }
  return {
    hasMain,
    gridTemplateColumns: hasMain ? `minmax(0, var(--main-width)) ${stackCols}` : stackCols,
    gridTemplateRows: twoRows ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
    placements,
  };
}
