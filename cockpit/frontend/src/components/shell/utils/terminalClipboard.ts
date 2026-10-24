import type { IDisposable, Terminal } from '@xterm/xterm';

import { copyTextToClipboard } from '@/utils/clipboard';
import { KILL_LINE } from '../constants';
import { imageReference } from '../domain/terminalKeys';
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
 * The text of an OSC 52 clipboard write (`ESC ] 52 ; <targets> ; <base64> BEL`),
 * or null for a query (`?`) or anything malformed. A program that cannot reach
 * a clipboard of its own — Claude Code on a server reached through remote
 * access — copies this way, as over SSH.
 */
export function osc52Text(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const payload = data.slice(sep + 1);
  if (!payload || payload === '?') return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
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
          sendInput(imageReference(path));
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
 * Installs copy-on-select, the native copy event, OSC 52 clipboard writes, and
 * the custom key handler (selection copy, paste, Cmd+Backspace, plus
 * `onShortcut` — xterm takes only one key handler). Returns a disposer.
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

  // A program in the terminal writes the clipboard (OSC 52). Writes only: a
  // query would let terminal output read what the user copied, so it is ignored.
  const osc52: IDisposable = terminal.parser.registerOscHandler(52, (data) => {
    const text = osc52Text(data);
    if (text) void copyKeepingFocus(terminal, container, text);
    return true;
  });

  return () => {
    selection.dispose();
    osc52.dispose();
    container.removeEventListener('copy', onCopy);
  };
}
