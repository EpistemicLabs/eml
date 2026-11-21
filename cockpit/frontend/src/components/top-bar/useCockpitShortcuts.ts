// The app-wide shortcuts that are not the desks' (DeskTabBar) or ⌘K's (CommandPalette):
// ⌘. opens the Inbox and ⌘, Settings, both in the capture phase so a focused terminal cannot
// swallow them; G then I / N / P picks a task view and ? opens the shortcut sheet, both only
// when nobody types (inputs, a terminal's hidden textarea, editable text).
import { useEffect } from 'react';

import { setTaskView, type TaskView } from '@/stores/useTaskViewStore';
import { setTopView } from '@/stores/useTopViewStore';

import { IS_MAC, setShortcutSheet } from './shortcuts';

/** How long G waits for its second key. */
const SEQUENCE_MS = 1200;
const VIEW_KEYS: Record<string, TaskView> = { i: 'inbox', n: 'now', p: 'plan' };

export function openTaskView(view: TaskView): void {
  setTaskView(view);
  setTopView('tasks');
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], .xterm'));

export function useCockpitShortcuts(openSettings: () => void): void {
  useEffect(() => {
    const onCapture = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key === '.') { e.preventDefault(); e.stopPropagation(); openTaskView('inbox'); }
      else if (e.key === ',') { e.preventDefault(); e.stopPropagation(); openSettings(); }
    };
    let waitingForView = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(e.target)) return;
      const key = e.key.toLowerCase();
      if (waitingForView) {
        window.clearTimeout(waitingForView);
        waitingForView = 0;
        const view = VIEW_KEYS[key];
        if (view) { e.preventDefault(); openTaskView(view); }
        return;
      }
      if (key === 'g') { waitingForView = window.setTimeout(() => { waitingForView = 0; }, SEQUENCE_MS); return; }
      if (e.key === '?') { e.preventDefault(); setShortcutSheet(true); }
    };
    document.addEventListener('keydown', onCapture, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onCapture, true);
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(waitingForView);
    };
  }, [openSettings]);
}
