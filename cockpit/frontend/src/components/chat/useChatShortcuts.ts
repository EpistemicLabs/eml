// What the terminal does without being asked: a selection is copied, Esc stops the
// turn, Ctrl+O shows the latest output. Ctrl+F searches the whole conversation, which
// the browser's own search can't: folded rows aren't on the page.
import { useEffect, type RefObject } from 'react';

import { copyTextToClipboard } from '@/utils/clipboard';

/** Whether Esc is meant for the running turn; a menu or dialog that took it comes first. */
export function escapeStops(state: {
  running: boolean;
  activePane: boolean;
  handled: boolean;
  dialogOpen: boolean;
  /** The key landed in this pane, or nowhere in particular. */
  inPane: boolean;
}): boolean {
  return state.running && state.activePane && !state.handled && !state.dialogOpen && state.inPane;
}

/** The pane shortcut a key press asks for, if any. Cmd on a Mac, Ctrl elsewhere. */
export function paneShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): 'expand' | 'search' | null {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  return key === 'o' ? 'expand' : key === 'f' ? 'search' : null;
}

/** The text to copy after a mouse release: a selection inside the conversation, not the input. */
export function selectedText(selection: Pick<Selection, 'isCollapsed' | 'anchorNode' | 'focusNode' | 'toString'> | null, log: Element | null): string | null {
  if (!selection || !log || selection.isCollapsed) return null;
  if (!log.contains(selection.anchorNode) || !log.contains(selection.focusNode)) return null;
  const text = selection.toString();
  return text.trim() ? text : null;
}

export function useChatShortcuts(
  root: RefObject<HTMLElement | null>,
  running: boolean,
  activePane: boolean,
  onStop: () => void,
  onExpandLatest: () => void,
  onSearch: () => void,
): void {
  useEffect(() => {
    if (!activePane) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = paneShortcut(event);
      if (!shortcut || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      const target = event.target as Node | null;
      if (target !== document.body && target !== document.documentElement && !root.current?.contains(target)) return;
      event.preventDefault();
      if (shortcut === 'expand') onExpandLatest(); else onSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [root, activePane, onExpandLatest, onSearch]);

  useEffect(() => {
    if (!running || !activePane) return undefined;
    // On window: everything on the way there has had its say and marked it handled.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as Node | null;
      const inPane = target === document.body || target === document.documentElement || !!root.current?.contains(target);
      const dialogOpen = !!document.querySelector('[role="dialog"]');
      if (escapeStops({ running, activePane, handled: event.defaultPrevented, dialogOpen, inPane })) onStop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [root, running, activePane, onStop]);

  useEffect(() => {
    const onMouseUp = () => {
      // A tick later: a click that clears the selection has done so by then.
      setTimeout(() => {
        const text = selectedText(window.getSelection(), root.current?.querySelector('[role="log"]') ?? null);
        if (text) void copyTextToClipboard(text);
      }, 0);
    };
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [root]);
}
