// App updates from the host (GET/POST /api/app-update…), shared by the update
// banner and Settings › About › Updates. Installing restarts the host; the hook
// then waits for /api/about to report the new version and reloads the page.
import { useCallback, useEffect, useState } from 'react';

export type AppUpdateStatus = {
  managed: boolean;
  current: string;
  previous: string | null;
  latest: { version: string; url: string; publishedAt: string | null } | null;
  available: boolean;
  lastCheckAt: string | null;
  error: string | null;
  lastResult: { at: string; outcome: 'updated' | 'rolled_back' | 'failed'; from?: string; to?: string; error?: string } | null;
  token: { source: 'file' | 'gh' | 'none' };
  canRollback: boolean;
  rollbackBlocked: string | null;
  busy: boolean;
};

export type UpdatePhase = 'idle' | 'checking' | 'installing' | 'restarting' | 'installed-restart-needed';

const POLL_MS = 60_000;
const RESTART_POLL_MS = 2_000;
const RESTART_TIMEOUT_MS = 3 * 60_000;

const post = (path: string, body?: unknown) =>
  fetch(path, {
    method: body === undefined ? 'POST' : 'PUT',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Poll /api/about until the host reports `version`, then reload the page. */
function waitForVersion(version: string, onTimeout: () => void): void {
  const started = Date.now();
  const tick = async () => {
    try {
      const res = await fetch('/api/about', { cache: 'no-store' });
      if (res.ok && ((await res.json()) as { version?: string }).version === version) {
        window.location.reload();
        return;
      }
    } catch { /* host restarting */ }
    if (Date.now() - started > RESTART_TIMEOUT_MS) onTimeout();
    else window.setTimeout(() => void tick(), RESTART_POLL_MS);
  };
  window.setTimeout(() => void tick(), RESTART_POLL_MS);
}

export function useAppUpdate() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/app-update');
      if (res.ok) setStatus((await res.json()) as AppUpdateStatus);
    } catch { /* host unreachable: keep the last state */ }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const check = useCallback(async () => {
    setPhase('checking');
    setError(null);
    try {
      const res = await post('/api/app-update/check');
      if (res.ok) setStatus((await res.json()) as AppUpdateStatus);
      else setError(await errorMessage(res));
    } finally {
      setPhase('idle');
    }
  }, []);

  const runAndRestart = useCallback(async (path: string, body: unknown, target: string) => {
    setPhase('installing');
    setError(null);
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      setError(await errorMessage(res));
      setPhase('idle');
      void refresh();
      return;
    }
    const result = (await res.json()) as { restarting: boolean; status: AppUpdateStatus };
    setStatus(result.status);
    if (!result.restarting) {
      setPhase('installed-restart-needed');
      return;
    }
    setPhase('restarting');
    waitForVersion(target, () => {
      setError('The cockpit did not come back with the new version — check host.log in the cockpit home.');
      setPhase('idle');
    });
  }, [refresh]);

  const apply = useCallback((version: string) => runAndRestart('/api/app-update/apply', { version }, version), [runAndRestart]);
  const rollback = useCallback(() => {
    if (status?.previous) void runAndRestart('/api/app-update/rollback', {}, status.previous);
  }, [runAndRestart, status?.previous]);

  const setToken = useCallback(async (token: string | null) => {
    setError(null);
    const res = token === null
      ? await fetch('/api/app-update/token', { method: 'DELETE' })
      : await post('/api/app-update/token', { token });
    if (res.ok) setStatus((await res.json()) as AppUpdateStatus);
    else setError(await errorMessage(res));
    return res.ok;
  }, []);

  return { status, phase, error, refresh, check, apply, rollback, setToken };
}
