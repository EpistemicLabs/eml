// The brain task a session works on, in a space with the task system on: what
// the Your turn list and the review bar show next to the session. Read through
// the host's brain proxy in the session's own space, which may not be the
// active one; kept for a short while, so a list of rows asks once per task.
import { useEffect, useState } from 'react';

import { SPACE_HEADER } from '@/lib/space-header';
import type { SpaceInfo } from '@/stores/useSpaceStore';

export type SessionTask = {
  id: string;
  title: string;
  status: string;
  stage: string | null;
  checkpoint: string | null;
  /** Whose turn it is, written by the host's router: who, why, since. */
  waitingOn: { who: string; why: string; since: string } | null;
};

const FRESH_MS = 20_000;
const cache = new Map<string, { at: number; task: Promise<SessionTask | null> }>();

type Raw = {
  id: string; title: string | null; content: string; status: string;
  properties?: { stage?: string; checkpoint?: string; waiting_on?: { who?: string; why?: string; since?: string } };
};

export function toSessionTask(raw: Raw): SessionTask {
  const waiting = raw.properties?.waiting_on;
  return {
    id: raw.id,
    title: raw.title ?? raw.content.slice(0, 80),
    status: raw.status,
    stage: raw.properties?.stage ?? null,
    checkpoint: raw.properties?.checkpoint ?? null,
    waitingOn: waiting?.who ? { who: waiting.who, why: waiting.why ?? '', since: waiting.since ?? '' } : null,
  };
}

function load(taskId: string, space: SpaceInfo): Promise<SessionTask | null> {
  const key = `${space.id}|${taskId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.task;
  const task = fetch(`/api/brain/engram/${encodeURIComponent(taskId)}`, {
    headers: { Accept: 'application/json', ...(space.main ? {} : { [SPACE_HEADER]: space.id }) },
  })
    .then((res) => (res.ok ? res.json() as Promise<Raw> : null))
    .then((raw) => (raw ? toSessionTask(raw) : null))
    .catch(() => null);
  cache.set(key, { at: Date.now(), task });
  return task;
}

/** The session's task; null while loading, without a task, or where the task system is off. */
export function useSessionTask(taskId: string | null | undefined, space: SpaceInfo | undefined): SessionTask | null {
  const [task, setTask] = useState<SessionTask | null>(null);
  const on = Boolean(taskId && space?.taskSystem);
  useEffect(() => {
    setTask(null);
    if (!on || !taskId || !space) return;
    let live = true;
    void load(taskId, space).then((loaded) => { if (live) setTask(loaded); });
    return () => { live = false; };
  }, [on, taskId, space]);
  return task;
}
