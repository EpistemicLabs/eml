/**
 * Copy `text` to the system clipboard. Tries the async Clipboard API first
 * and falls back to a hidden textarea + `document.execCommand('copy')` when
 * the API is missing, not permitted, or fails. Resolves to whether the copy
 * (as far as the browser reports) succeeded; never rejects.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (await writeViaClipboardApi(text)) return true;
  return writeViaExecCommand(text);
}

async function writeViaClipboardApi(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const writeText = navigator.clipboard?.writeText;
  if (typeof writeText !== 'function') return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Permission denied, insecure context, or unsupported — fall through.
    return false;
  }
}

function writeViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.readOnly = true;
  scratch.setAttribute('aria-hidden', 'true');
  // Keep it out of layout and out of sight without scrolling the page.
  Object.assign(scratch.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    padding: '0',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  document.body.appendChild(scratch);
  try {
    scratch.focus();
    scratch.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    scratch.remove();
  }
}
