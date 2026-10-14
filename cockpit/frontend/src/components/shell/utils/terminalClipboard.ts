import type { IDisposable, Terminal } from '@xterm/xterm';

import { copyTextToClipboard } from '@/utils/clipboard';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, KILL_LINE } from '../constants';
import { uploadPastedImage } from './hostChannel';

/**
 * Copies text and, if the terminal held focus before, gives it back: the
 * clipboard fallback focuses a scratch textarea and removes it, which would
 * otherwise leave the terminal unfocused.
 */
async function copyKeepingFocus(terminal: Terminal, container: HTMLElement, text: string): Promise<void> {
  const hadFocus = container.contains(document.activeElement);
  await copyTextToClipboard(text);
  if (hadFocus && !container.contains(document.activeElement)) terminal.focus();
}

/**
 * Pastes from the system clipboard: an image is uploaded to the host and its
 * path typed as a bracketed paste; otherwise text goes through xterm's own
 * paste so bracketed-paste markers follow the TUI's mode.
 */
async function pasteFromClipboard(terminal: Terminal, sendInput: (data: string) => void): Promise<void> {
  const clipboard = navigator.clipboard;
  try {
    if (clipboard && typeof clipboard.read === 'function') {
      const items = await clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const path = await uploadPastedImage(blob, imageType);
        if (path) {
          // The trailing space leaves room for a caption.
          sendInput(`${BRACKETED_PASTE_START}${path}${BRACKETED_PASTE_END} `);
          return;
        }
        break;
      }
    }
  } catch {
    // Read denied, unsupported or upload failed: fall back to text.
  }
  try {
    if (clipboard && typeof clipboard.readText === 'function') {
      const text = await clipboard.readText();
      if (text) terminal.paste(text);
    }
  } catch {
    // Nothing to paste.
  }
}

interface ClipboardOptions {
  terminal: Terminal;
  container: HTMLElement;
  /** Returns a sender bound to the socket that is current at call time. */
  bindInput: () => (data: string) => void;
  /** Other keys the terminal handles itself (find, font size); true = handled. */
  onShortcut?: (event: KeyboardEvent) => boolean;
}

/**
 * Installs copy-on-select, the native copy event, and the custom key handler
 * (selection copy, paste, Cmd+Backspace, plus `onShortcut` — xterm takes only
 * one key handler). Returns a disposer.
 */
export function installClipboardHandling({ terminal, container, bindInput, onShortcut }: ClipboardOptions): () => void {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const key = event.key.toLowerCase();
    const primary = event.ctrlKey || event.metaKey;
    let handled = false;

    if (onShortcut?.(event)) {
      handled = true;
    } else if (primary && key === 'c' && terminal.hasSelection()) {
      void copyKeepingFocus(terminal, container, terminal.getSelection());
      handled = true;
    } else if (primary && key === 'v') {
      void pasteFromClipboard(terminal, bindInput());
      handled = true;
    } else if (event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Backspace') {
      bindInput()(KILL_LINE);
      handled = true;
    }

    if (!handled) return true;
    event.preventDefault();
    event.stopPropagation();
    return false;
  });

  const selection: IDisposable = terminal.onSelectionChange(() => {
    const text = terminal.getSelection();
    // Empty selections (plain clicks, programmatic clears) keep the clipboard as is.
    if (text) void copyKeepingFocus(terminal, container, text);
  });

  const onCopy = (event: ClipboardEvent) => {
    const text = terminal.getSelection();
    if (!text) return;
    event.preventDefault();
    if (event.clipboardData) {
      event.clipboardData.setData('text/plain', text);
    } else {
      void copyTextToClipboard(text);
    }
  };
  container.addEventListener('copy', onCopy);

  return () => {
    selection.dispose();
    container.removeEventListener('copy', onCopy);
  };
}
