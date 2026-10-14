// Live turn state per session (working / done / waiting), streamed from the
// host's SSE endpoint (/api/events), which Claude Code's hooks feed. Plus
// the "seen" ledger: a `done` is unseen until the user looks at the desk
// it happened in — that drives the desk-tab badges and the title count.
// Same module-store + useSyncExternalStore pattern as usePaneStore.
import { useSyncExternalStore } from 'react';

import type { LLMProvider } from '@/types/app';

export type TurnState = 'idle' | 'working' | 'done' | 'waiting';
export type TurnInfo = { state: TurnState; since: string };
export type TurnEvent = TurnInfo & { sessionId: string };

type Snapshot = {
  turns: Record<string, TurnInfo>;
  /** sessionId → `since` of the done event the user has already seen. */
  seen: Record<string, string>;
};

const SEEN_STORAGE_KEY = 'cockpit-turns-seen';

function loadSeen(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let snapshot: Snapshot = { turns: {}, seen: loadSeen() };
const listeners = new Set<() => void>();

const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function setTurns(turns: Record<string, TurnInfo>) {
  snapshot = { ...snapshot, turns };
  emit();
}

export function isUnseenDone(snap: Snapshot, sessionId: string): boolean {
  const turn = snap.turns[sessionId];
  return !!turn && turn.state === 'done' && snap.seen[sessionId] !== turn.since;
}

/**
 * Count sessions among `ids` that need the user: waiting for input (a
 * permission prompt, a question dialog) or finished without being seen.
 * Drives the desk-tab badges and the title count.
 */
export function countNeedsYou(snap: Snapshot, ids: Array<string | null | undefined>): number {
  let n = 0;
  for (const id of ids) if (id && (snap.turns[id]?.state === 'waiting' || isUnseenDone(snap, id))) n += 1;
  return n;
}

/** The user is looking at these sessions now: their current `done` counts as seen. */
export function markSeen(ids: Array<string | null | undefined>): void {
  let changed = false;
  const seen = { ...snapshot.seen };
  for (const id of ids) {
    if (!id) continue;
    const turn = snapshot.turns[id];
    if (turn?.state === 'done' && seen[id] !== turn.since) {
      seen[id] = turn.since;
      changed = true;
    }
  }
  if (!changed) return;
  snapshot = { ...snapshot, seen };
  try { localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen)); } catch { /* non-fatal */ }
  emit();
}

export function getTurnSnapshot(): Snapshot {
  return snapshot;
}

export function useTurnStore(): Snapshot {
  return useSyncExternalStore(subscribe, getTurnSnapshot);
}

/**
 * Open the host's event stream. EventSource reconnects on its own (the
 * host sends `retry: 2000`); every (re)connect starts with a full snapshot
 * so a missed event can't leave a stale state behind.
 */
/** A worker-session request from a running session (host spawn-queue.ts). */
export type SpawnRequest = {
  id: string;
  projectId: string;
  prompt: string;
  title: string | null;
  fromSessionId: string | null;
  /** 'replace-empty-desk': first run (host onboarding.ts) — takes the place of an empty desk (AppContent). */
  placement?: 'append' | 'replace-empty-desk';
  /** The brain space the worker runs in (brain id); absent = main. */
  spaceId?: string;
  createdAt: string;
  /** The agent CLI the worker runs with; unset → the cockpit's default. */
  provider?: LLMProvider;
};

export function connectTurnEvents(
  onTurn?: (event: TurnEvent) => void,
  onSpawns?: (requests: SpawnRequest[]) => void,
): () => void {
  const source = new EventSource('/api/events');

  // Worker requests ride the same stream: the pending ones on (re)connect,
  // then each new one. Every tab sees them; the host lets one tab claim each.
  source.addEventListener('spawns', (message) => {
    onSpawns?.(JSON.parse((message as MessageEvent<string>).data) as SpawnRequest[]);
  });
  source.addEventListener('spawn', (message) => {
    onSpawns?.([JSON.parse((message as MessageEvent<string>).data) as SpawnRequest]);
  });

  // Note changes (host notes-api.ts) go to whoever listens — lib/notes.ts.
  source.addEventListener('notes', (message) => {
    window.dispatchEvent(new CustomEvent('cockpit:notes', { detail: JSON.parse((message as MessageEvent<string>).data) }));
  });

  source.addEventListener('snapshot', (message) => {
    const events = JSON.parse((message as MessageEvent<string>).data) as TurnEvent[];
    const turns: Record<string, TurnInfo> = {};
    for (const { sessionId, state, since } of events) turns[sessionId] = { state, since };
    setTurns(turns);
  });

  source.addEventListener('turn', (message) => {
    const event = JSON.parse((message as MessageEvent<string>).data) as TurnEvent;
    const turns = { ...snapshot.turns };
    if (event.state === 'idle') delete turns[event.sessionId];
    else turns[event.sessionId] = { state: event.state, since: event.since };
    setTurns(turns);
    onTurn?.(event);
  });

  return () => source.close();
}
