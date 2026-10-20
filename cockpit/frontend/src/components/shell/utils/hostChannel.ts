import { OUTPUT_FRAME_TYPE } from '../constants';

export interface InitFrame {
  type: 'init';
  paneId: string | null;
  projectId: string;
  sessionId: string;
  cols: number;
  rows: number;
  initialCommand: string | null;
  /** Settings › Preferences › Sessions; the host greets only a plain new session. */
  greet: boolean;
  taskId: string | null;
  provider: 'claude' | 'codex' | null;
  spaceId: string | null;
  isDarkMode: boolean;
}

export type ClientFrame =
  | InitFrame
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type HostMessage =
  | { kind: 'output'; data: string }
  | { kind: 'error'; message: string }
  | { kind: 'ignored' };

/** Sends a frame if the socket is open; otherwise drops it. Returns whether it went out. */
export function sendFrame(socket: WebSocket | null, frame: ClientFrame): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

export type NonceResult = { ok: true; nonce: string } | { ok: false };

/** Asks the host for a single-use shell nonce. */
export async function requestShellNonce(): Promise<NonceResult> {
  try {
    const res = await fetch('/api/pty', { method: 'POST' });
    if (!res.ok) {
      console.error('[Shell] Could not mint a shell nonce:', res.status);
      return { ok: false };
    }
    const body: unknown = await res.json().catch(() => null);
    const nonce = body && typeof body === 'object' ? (body as { nonce?: unknown }).nonce : undefined;
    if (typeof nonce !== 'string' || !nonce) return { ok: false };
    return { ok: true, nonce };
  } catch (error) {
    console.error('[Shell] Could not mint a shell nonce:', error);
    return { ok: false };
  }
}

export function shellSocketUrl(nonce: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/shell?nonce=${encodeURIComponent(nonce)}`;
}

const decoder = new TextDecoder();

/** Decodes a binary output frame; null for empty or unknown frame types. */
export function decodeBinaryFrame(buffer: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0 || bytes[0] !== OUTPUT_FRAME_TYPE) return null;
  return decoder.decode(bytes.subarray(1));
}

/** Parses a JSON text frame. Throws on malformed JSON. */
export function parseTextFrame(raw: string): HostMessage {
  const msg: unknown = JSON.parse(raw);
  if (!msg || typeof msg !== 'object') return { kind: 'ignored' };
  const { type, data, message } = msg as { type?: unknown; data?: unknown; message?: unknown };
  if (type === 'output') return { kind: 'output', data: typeof data === 'string' ? data : '' };
  if (type === 'error') {
    return { kind: 'error', message: typeof message === 'string' && message ? message : 'Shell error' };
  }
  return { kind: 'ignored' };
}

/** Uploads a pasted image; resolves to its path on the host or null on failure. */
export async function uploadPastedImage(blob: Blob, mimeType: string): Promise<string | null> {
  const res = await fetch('/api/paste-image', {
    method: 'POST',
    headers: { 'Content-Type': mimeType },
    body: blob,
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const path = body && typeof body === 'object' ? (body as { path?: unknown }).path : undefined;
  return typeof path === 'string' && path ? path : null;
}
