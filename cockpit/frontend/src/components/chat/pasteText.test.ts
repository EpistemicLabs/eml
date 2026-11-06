import { describe, expect, it, vi } from 'vitest';

import { pasteTextDirectly } from './pasteText';

function paste(pasted: string, { tagName = 'TEXTAREA', command = true } = {}) {
  const execCommand = vi.fn(() => command);
  const setRangeText = vi.fn();
  const dispatchEvent = vi.fn();
  const preventDefault = vi.fn();
  const currentTarget = {
    tagName, value: 'abc', selectionStart: 1, selectionEnd: 2, setRangeText, dispatchEvent, ownerDocument: { execCommand },
  } as unknown as Parameters<typeof pasteTextDirectly>[0]['currentTarget'];
  pasteTextDirectly({ currentTarget, clipboardData: { getData: () => pasted }, preventDefault });
  return { execCommand, setRangeText, dispatchEvent, preventDefault };
}

describe('pasteTextDirectly', () => {
  it('inserts the text of the event instead of leaving it to the browser', () => {
    const { execCommand, preventDefault, setRangeText } = paste('hello\nworld');
    expect(preventDefault).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'hello\nworld');
    expect(setRangeText).not.toHaveBeenCalled();
  });

  it('turns line breaks into spaces in a single-line field', () => {
    expect(paste('a\r\nb\nc', { tagName: 'INPUT' }).execCommand).toHaveBeenCalledWith('insertText', false, 'a b c');
  });

  it('leaves a paste without text to the browser', () => {
    const { execCommand, preventDefault } = paste('');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('replaces the selection itself when the editing command is refused', () => {
    const { setRangeText, dispatchEvent } = paste('x', { command: false });
    expect(setRangeText).toHaveBeenCalledWith('x', 1, 2, 'end');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
