import { describe, expect, it } from 'vitest';

import { escapeStops, paneShortcut, selectedText } from './useChatShortcuts';

describe('paneShortcut', () => {
  const press = (key: string, patch: object = {}) => paneShortcut({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch });

  it('takes Ctrl or Cmd with O and F', () => {
    expect(press('o', { ctrlKey: true })).toBe('expand');
    expect(press('F', { metaKey: true })).toBe('search');
  });

  it('leaves everything else alone', () => {
    expect(press('o')).toBeNull();
    expect(press('f', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press('k', { ctrlKey: true })).toBeNull();
  });
});

describe('escapeStops', () => {
  const base = { running: true, activePane: true, handled: false, dialogOpen: false, inPane: true };

  it('stops a running turn in the active pane', () => {
    expect(escapeStops(base)).toBe(true);
  });

  it.each([
    ['nothing is running', { running: false }],
    ['another pane is active', { activePane: false }],
    ['a menu took the key', { handled: true }],
    ['a dialog is open', { dialogOpen: true }],
    ['the key landed elsewhere', { inPane: false }],
  ])('leaves it alone when %s', (_why, patch) => {
    expect(escapeStops({ ...base, ...patch })).toBe(false);
  });
});

describe('selectedText', () => {
  const inside = {} as Node;
  const outside = {} as Node;
  const log = { contains: (node: Node | null) => node === inside } as unknown as Element;
  const selection = (text: string, anchorNode: Node, focusNode: Node = anchorNode, isCollapsed = false) =>
    ({ isCollapsed, anchorNode, focusNode, toString: () => text });

  it('takes a selection inside the conversation', () => {
    expect(selectedText(selection('hello', inside), log)).toBe('hello');
  });

  it('ignores the rest', () => {
    expect(selectedText(null, log)).toBeNull();
    expect(selectedText(selection('hello', inside), null)).toBeNull();
    expect(selectedText(selection('', inside, inside, true), log)).toBeNull();
    expect(selectedText(selection('   ', inside), log)).toBeNull();
    expect(selectedText(selection('hello', outside), log)).toBeNull();
    expect(selectedText(selection('hello', inside, outside), log)).toBeNull();
  });
});
