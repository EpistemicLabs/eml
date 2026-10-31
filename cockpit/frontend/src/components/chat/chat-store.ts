// One store per session (never a shared stream buffer): the folded chat state,
// the connection, and the events waiting for the next animation frame.
import { useSyncExternalStore } from 'react';

import { EMPTY_CHAT, reduceChat, type ChatEvent, type ChatState } from './chat-state';

export type Connection = 'connecting' | 'open' | 'closed' | 'superseded';

export interface ChatSnapshot {
  chat: ChatState;
  connection: Connection;
  /** A handoff is under way; the view switch stays blocked and this says why. */
  switching: string | null;
  /** The host refused or failed something outside the conversation. */
  problem: string | null;
}

interface SessionStore {
  snapshot: ChatSnapshot;
  epoch: number | null;
  seq: number;
  pending: Array<{ seq: number; event: ChatEvent }>;
  frame: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
}

const INITIAL: ChatSnapshot = { chat: EMPTY_CHAT, connection: 'connecting', switching: null, problem: null };
// requestAnimationFrame stops in a hidden tab; the events must still arrive.
const HIDDEN_FLUSH_MS = 250;

const stores = new Map<string, SessionStore>();

function storeOf(sessionId: string): SessionStore {
  let store = stores.get(sessionId);
  if (!store) {
    store = { snapshot: INITIAL, epoch: null, seq: 0, pending: [], frame: null, timer: null, listeners: new Set() };
    stores.set(sessionId, store);
  }
  return store;
}

function publish(store: SessionStore, patch: Partial<ChatSnapshot>): void {
  store.snapshot = { ...store.snapshot, ...patch };
  store.listeners.forEach((listener) => listener());
}

function flush(store: SessionStore): void {
  if (store.frame !== null) cancelAnimationFrame(store.frame);
  if (store.timer !== null) clearTimeout(store.timer);
  store.frame = null;
  store.timer = null;
  if (store.pending.length === 0) return;
  let { chat } = store.snapshot;
  for (const { seq, event } of store.pending) chat = reduceChat(chat, event, seq);
  store.pending = [];
  publish(store, { chat });
}

export function receiveEvent(sessionId: string, seq: number, event: ChatEvent): void {
  const store = storeOf(sessionId);
  if (seq <= store.seq) return; // a replay overlapping what is already here
  store.seq = seq;
  store.pending.push({ seq, event });
  if (store.frame === null) {
    store.frame = requestAnimationFrame(() => flush(store));
    store.timer = setTimeout(() => flush(store), HIDDEN_FLUSH_MS);
  }
}

/** The host starts the numbers over: drop the view, the log follows. */
export function resetChat(sessionId: string, epoch: number): void {
  const store = storeOf(sessionId);
  flush(store);
  store.epoch = epoch;
  store.seq = 0;
  publish(store, { chat: EMPTY_CHAT, switching: null, problem: null });
}

export function setConnection(sessionId: string, connection: Connection): void {
  const store = storeOf(sessionId);
  flush(store);
  publish(store, { connection, ...(connection === 'open' ? {} : { switching: null }) });
}

export function setSwitching(sessionId: string, switching: string | null): void {
  publish(storeOf(sessionId), { switching });
}

export function setProblem(sessionId: string, problem: string | null): void {
  publish(storeOf(sessionId), { problem, switching: null });
}

/** Where a reconnect picks up. */
export function resumePoint(sessionId: string): { epoch: number | null; after: number } {
  const store = storeOf(sessionId);
  return { epoch: store.epoch, after: store.seq };
}

export function useChatSession(sessionId: string): ChatSnapshot {
  const store = storeOf(sessionId);
  return useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.snapshot,
  );
}

/** Why this session's view can't be switched right now; null when it can. */
export function useSwitchBlocked(sessionId: string | null): string | null {
  const store = sessionId ? stores.get(sessionId) ?? null : null;
  return useSyncExternalStore(
    (listener) => {
      store?.listeners.add(listener);
      return () => store?.listeners.delete(listener);
    },
    () => store?.snapshot.switching ?? null,
  );
}

// ── Drafts ───────────────────────────────────────────────────────────
const DRAFT_PREFIX = 'cockpit-chat-draft:';

export function readDraft(sessionId: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + sessionId) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(sessionId: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_PREFIX + sessionId, text);
    else localStorage.removeItem(DRAFT_PREFIX + sessionId);
  } catch { /* drafts are a convenience */ }
}
