// The update outcome from the host (GET /api/update-status), shared by the
// update banner and the space switch: per brain the newest migration report,
// and the in-app update this host runs. A space shows its own brain's report;
// the switch marks a space whose brain failed to migrate, so a failure in
// another space is not missed. One poll for all subscribers. Same module-store +
// useSyncExternalStore pattern as the other stores.
import { useSyncExternalStore } from 'react';

export type MigrationReport = {
  brainId: string;
  brainName: string;
  from: number;
  to: number;
  outcome: 'migrated' | 'brain_missing' | 'backup_failed' | 'preflight_failed' | 'restored' | 'restore_failed';
  error?: string;
  backupPath?: string;
  codeVersion?: string;
  at: string;
  reportPath: string;
};

export type BrainUpdateStatus = {
  report: MigrationReport;
  /** The report's brain by its space's name. */
  brain: string;
  acknowledged: boolean;
  resolved: boolean;
};

export type UpdateStatus = {
  /** By brain id (= space id). */
  brains: Record<string, BrainUpdateStatus>;
  updated: { outcome: 'updated' | 'rolled_back'; from: string; to: string } | null;
};

const POLL_MS = 60_000;

let status: UpdateStatus | null = null;
const listeners = new Set<() => void>();
let timer: number | null = null;

const notify = () => { for (const listener of listeners) listener(); };

async function load(): Promise<void> {
  try {
    const res = await fetch('/api/update-status');
    if (res.ok) { status = (await res.json()) as UpdateStatus; notify(); }
  } catch { /* host unreachable: keep the last state */ }
}

const onFocus = () => void load();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    void load();
    timer = window.setInterval(() => void load(), POLL_MS);
    window.addEventListener('focus', onFocus);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      window.removeEventListener('focus', onFocus);
    }
  };
};

export function useUpdateStatus(): UpdateStatus | null {
  return useSyncExternalStore(subscribe, () => status);
}

/** A brain whose migration failed and has not caught up since — it is offline. */
export const failedUnresolved = (s: BrainUpdateStatus | undefined): boolean =>
  !!s && s.report.outcome !== 'migrated' && !s.resolved;

/** Dismiss the active space's banner: its brain's report and the in-app update (the request names the space). */
export async function dismissUpdateStatus(brainId: string): Promise<void> {
  const res = await fetch('/api/update-status/ack', { method: 'POST' });
  if (!res.ok || !status) return;
  const own = status.brains[brainId];
  status = { brains: own ? { ...status.brains, [brainId]: { ...own, acknowledged: true } } : status.brains, updated: null };
  notify();
}
