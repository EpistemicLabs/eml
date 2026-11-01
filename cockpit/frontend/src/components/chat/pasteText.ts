// Pasted text is taken from the paste event and inserted here, as the terminal does.
// Left to itself the browser reads the clipboard a second time to insert, and a dictation
// tool that restores the clipboard right after its paste leaves that read empty: the text
// is gone without an error. Measured with Wispr Flow on Chrome for Mac.

type TextField = Pick<HTMLTextAreaElement | HTMLInputElement, 'tagName' | 'ownerDocument' | 'value' | 'selectionStart' | 'selectionEnd' | 'setRangeText' | 'dispatchEvent'>;

interface PasteEventLike {
  currentTarget: TextField;
  clipboardData: Pick<DataTransfer, 'getData'>;
  preventDefault: () => void;
}

export function pasteTextDirectly(event: PasteEventLike): void {
  const field = event.currentTarget;
  const pasted = event.clipboardData.getData('text/plain');
  if (!pasted) return;
  event.preventDefault();
  // A single-line field turns line breaks into spaces, as a browser's own paste does.
  const text = field.tagName === 'INPUT' ? pasted.replace(/\r?\n/g, ' ') : pasted;
  // Through the editing command: it keeps undo and fires the input event React listens to.
  if (field.ownerDocument.execCommand('insertText', false, text)) return;
  const end = field.selectionEnd ?? field.value.length;
  field.setRangeText(text, field.selectionStart ?? end, end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
