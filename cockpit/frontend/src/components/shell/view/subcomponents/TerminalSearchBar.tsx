import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { buttonVariants } from '@/shared/view/ui';

import type { ShellSearch } from '../../hooks/useShellRuntime';
import { stepTerminalFontSize } from '../../utils/terminalFontSize';
import { matchTerminalShortcut } from '../../utils/terminalShortcuts';

function resultLabel(term: string, results: ShellSearch['results']): string {
  if (!term || !results) return '';
  if (results.resultCount === 0) return 'No results';
  if (results.resultIndex < 0) return `${results.resultCount}`;
  return `${results.resultIndex + 1}/${results.resultCount}`;
}

/**
 * The find bar over a terminal (⌘F): searches the scrollback as you type.
 * Enter = next, Shift+Enter = previous, Escape closes and gives the terminal
 * its focus back.
 */
export default function TerminalSearchBar({ search }: { search: ShellSearch }) {
  const { focusRequest, results, find, close } = search;
  const [term, setTerm] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const shortcut = matchTerminalShortcut(event.nativeEvent);
    if (event.key === 'Enter') {
      event.preventDefault();
      find(term, event.shiftKey ? 'previous' : 'next');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (shortcut === 'find') {
      // ⌘F again selects the term instead of opening the browser's find.
      event.preventDefault();
      inputRef.current?.select();
    } else if (shortcut) {
      // The zoom keys size the terminal here too, not the page.
      event.preventDefault();
      stepTerminalFontSize(shortcut === 'zoom-in' ? 1 : shortcut === 'zoom-out' ? -1 : 0);
    }
  };

  const iconButton = buttonVariants({ variant: 'ghost', size: 'icon-sm' });

  return (
    <div
      role="search"
      data-ui="v2"
      className="glass-thick absolute top-3 right-5 z-(--z-sticky) flex items-center gap-1 rounded-xl py-1 pr-1 pl-2 shadow-overlay"
    >
      <input
        ref={inputRef}
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          find(event.target.value, 'next', true);
        }}
        onKeyDown={onKeyDown}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        spellCheck={false}
        className="h-(--target-min) w-44 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span className="min-w-(--size-find-count) text-right text-caption text-muted-foreground tabular-nums" aria-live="polite">
        {resultLabel(term, results)}
      </span>
      <button
        type="button"
        className={iconButton}
        disabled={!term}
        onClick={() => find(term, 'previous')}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp aria-hidden className="size-3.5" />
      </button>
      <button
        type="button"
        className={iconButton}
        disabled={!term}
        onClick={() => find(term, 'next')}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <ChevronDown aria-hidden className="size-3.5" />
      </button>
      <button type="button" className={iconButton} onClick={close} aria-label="Close find" title="Close (Escape)">
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
