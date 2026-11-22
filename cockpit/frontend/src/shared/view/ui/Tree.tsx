import { createContext, useContext, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A tree (WAI-ARIA tree view): rows that fold, read and moved through by keyboard. One row is in the tab
 * order at a time; the arrows move between the rows that show, Right opens a row or goes to its first
 * child, Left folds it or goes to its parent, Home and End jump, Enter or Space activates. A child row
 * hangs from its parent by a connector line, solid or dashed.
 */

const Depth = createContext(0);

const ITEM = '[role="treeitem"]';

function rows(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>(ITEM)];
}

function focusRow(tree: HTMLElement, row: HTMLElement | undefined) {
  if (!row) return;
  for (const r of rows(tree)) r.tabIndex = r === row ? 0 : -1;
  row.focus();
}

export function Tree({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLUListElement>(null);

  // Exactly one row in the tab order: the one last focused, else the first.
  useEffect(() => {
    const tree = ref.current;
    if (!tree) return;
    const all = rows(tree);
    if (all.length > 0 && !all.some((r) => r.tabIndex === 0)) all[0].tabIndex = 0;
  });

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const tree = ref.current;
    const row = (e.target as HTMLElement).closest<HTMLElement>(ITEM);
    if (!tree || !row || e.target !== row) return;
    const all = rows(tree);
    const at = all.indexOf(row);
    const expanded = row.getAttribute('aria-expanded');
    const handled = (() => {
      switch (e.key) {
        case 'ArrowDown': focusRow(tree, all[at + 1]); return true;
        case 'ArrowUp': focusRow(tree, all[at - 1]); return true;
        case 'Home': focusRow(tree, all[0]); return true;
        case 'End': focusRow(tree, all.at(-1)); return true;
        case 'ArrowRight':
          if (expanded === 'false') row.querySelector<HTMLElement>(':scope > [data-tree-row] [data-tree-toggle]')?.click();
          else if (expanded === 'true') focusRow(tree, row.querySelector<HTMLElement>(`:scope > [role="group"] ${ITEM}`) ?? undefined);
          return true;
        case 'ArrowLeft':
          if (expanded === 'true') row.querySelector<HTMLElement>(':scope > [data-tree-row] [data-tree-toggle]')?.click();
          else focusRow(tree, row.parentElement?.closest<HTMLElement>(ITEM) ?? undefined);
          return true;
        case 'Enter':
        case ' ':
          row.querySelector<HTMLElement>(':scope > [data-tree-row]')?.click();
          return true;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  };

  return (
    <ul
      ref={ref}
      role="tree"
      aria-label={label}
      onKeyDown={onKeyDown}
      onFocus={(e) => { const row = (e.target as HTMLElement).closest<HTMLElement>(ITEM); if (row && ref.current && e.target === row) for (const r of rows(ref.current)) r.tabIndex = r === row ? 0 : -1; }}
      className={cn('flex flex-col', className)}
    >
      <Depth.Provider value={1}>{children}</Depth.Provider>
    </ul>
  );
}

export type TreeLine = 'solid' | 'dashed';

/**
 * One row and the rows under it. `expanded` is left out for a row without children. `line` is how it
 * hangs from its parent row; a top-level row has none. `content` is the row itself (no buttons inside:
 * the row is the control).
 */
export function TreeItem({
  content, label, expanded, onToggle, onSelect, selected = false, line, children,
}: {
  content: ReactNode;
  /** The row's accessible name when its content says more than the name (an icon's title, say). */
  label?: string;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect?: () => void;
  selected?: boolean;
  line?: TreeLine;
  children?: ReactNode;
}) {
  const depth = useContext(Depth);
  const hasChildren = expanded !== undefined;
  return (
    <li
      role="treeitem"
      tabIndex={-1}
      aria-level={depth}
      aria-label={label}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      className={cn(
        'relative outline-none [&:focus-visible>[data-tree-row]]:outline-2 [&:focus-visible>[data-tree-row]]:outline-offset-(--focus-offset) [&:focus-visible>[data-tree-row]]:outline-ring',
        line && cn(
          'pl-(--tree-indent)',
          // The connector: down along the siblings (to the elbow on the last one), then across to the row.
          'before:absolute before:top-0 before:left-0 before:h-full before:border-l before:border-border-strong last:before:h-(--tree-elbow)',
          'after:absolute after:top-(--tree-elbow) after:left-0 after:w-(--tree-tick) after:border-t after:border-border-strong',
          line === 'dashed' && 'before:border-dashed after:border-dashed',
        ),
      )}
    >
      <div
        data-tree-row
        onClick={onSelect}
        className={cn(
          // The picked row has a bar in the text colour and a heavier title, not only a fill (3:1 against the card).
          'flex min-h-(--target-min) min-w-0 cursor-pointer items-center gap-1 rounded-md border-l-2 border-transparent pr-2 text-ui text-foreground hover:bg-muted',
          selected && 'border-foreground bg-muted font-semibold',
        )}
      >
        {hasChildren ? (
          <span
            data-tree-toggle
            aria-hidden
            onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
            className="flex size-(--target-min) flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3 transition-transform duration-(--duration-fast)', expanded && 'rotate-90')} />
          </span>
        ) : (
          <span aria-hidden className="size-(--target-min) flex-shrink-0" />
        )}
        {content}
      </div>
      {hasChildren && expanded && children && (
        <ul role="group" className="ml-(--tree-elbow) flex flex-col">
          <Depth.Provider value={depth + 1}>{children}</Depth.Provider>
        </ul>
      )}
    </li>
  );
}
