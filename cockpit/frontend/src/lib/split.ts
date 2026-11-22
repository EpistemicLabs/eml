// Splitting a topic off a session: the host's routes (cockpit/host/src/tasks-api.ts) and the shapes
// the split dialog works with.
export type SplitRelation = 'spun' | 'sub' | 'unrelated';
export type SplitWhen = 'now' | 'park';

export interface OpenTask { id: string; title: string; project: string | null }

export interface SplitContext {
  projects: Array<{ id: string; name: string; brainProjectId?: string | null }>;
  /** The space's open tasks, to split onto one; missing from an older host. */
  openTasks?: OpenTask[];
  /** The open task the topic most likely already has. */
  matchTaskId?: string | null;
  taskSystem: boolean;
  hasTask: boolean;
}

export interface SplitDraft {
  title: string;
  relation: SplitRelation;
  projectId: string | null;
  brief: string;
  /** The open task the agent says the topic already has. */
  existingTaskId?: string | null;
}

export type DraftAnswer =
  | { ok: true; draft: SplitDraft; context: SplitContext }
  | { ok: false; message: string; context: SplitContext | null };

export interface SplitInput {
  title: string;
  brief: string;
  relation: SplitRelation;
  when: SplitWhen;
  projectId: string;
  /** Split onto this open task instead of making a new one. */
  existingTaskId?: string;
}

export type SplitAnswer =
  | { ok: true; opId: string; undoUntil: string; taskId?: string; sessionId?: string }
  | { ok: false; message: string };

const errorMessage = (body: Record<string, unknown>, status: number) =>
  ((body.error ?? {}) as { message?: string }).message ?? `The cockpit refused (HTTP ${status}).`;

/** A draft of the brief from the turns up to `upTo` (a chat item id), or up to the end. */
export async function draftSplit(sessionId: string, upTo?: string): Promise<DraftAnswer> {
  return briefRequest(sessionId, upTo ? { upTo } : {});
}

/** Only the dialog's context, for a draft the agent wrote itself: no model call on the host. */
export async function splitContext(sessionId: string, title?: string): Promise<SplitContext | null> {
  return (await briefRequest(sessionId, { contextOnly: true, ...(title ? { title } : {}) })).context;
}

async function briefRequest(sessionId: string, payload: Record<string, unknown>): Promise<DraftAnswer> {
  try {
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/split-brief`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const context = (body.context ?? null) as SplitContext | null;
    if (!res.ok || !context || typeof body.brief !== 'string') return { ok: false, message: errorMessage(body, res.status), context };
    const { context: _context, ...draft } = body as unknown as SplitDraft & { context: SplitContext };
    return { ok: true, draft, context };
  } catch {
    return { ok: false, message: 'The cockpit did not answer.', context: null };
  }
}

export async function splitOff(sessionId: string, input: SplitInput, opId = crypto.randomUUID()): Promise<SplitAnswer> {
  try {
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/split`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opId, ...input }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return { ok: false, message: errorMessage(body, res.status) };
    return { ok: true, ...(body as { opId: string; undoUntil: string; taskId?: string; sessionId?: string }) };
  } catch {
    return { ok: false, message: 'The cockpit did not answer.' };
  }
}

export async function undoSplit(opId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/v1/commands/${encodeURIComponent(opId)}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (res.ok) return { ok: true };
    return { ok: false, message: errorMessage(await res.json().catch(() => ({})) as Record<string, unknown>, res.status) };
  } catch {
    return { ok: false, message: 'The cockpit did not answer.' };
  }
}

export const SORT_PICKS = ['keep', 'sub', 'spun', 'unrelated', 'drop'] as const;
export type SortPick = typeof SORT_PICKS[number];

/** One topic of a drifted session as the agent proposed it (propose_sort). */
export interface SortRow {
  when?: string;
  topic: string;
  summary?: string;
  today?: string;
  pick: SortPick;
  taskId?: string;
  brief?: string;
}

export type SortAnswer = { ok: true; linked: number; created: number; closed: number } | { ok: false; message: string };

export async function sortSession(sessionId: string, rows: SortRow[], opId = crypto.randomUUID()): Promise<SortAnswer> {
  try {
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/sort`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opId, rows: rows.map(({ topic, pick, taskId, brief }) => ({ topic, pick, taskId, brief })) }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return { ok: false, message: errorMessage(body, res.status) };
    return { ok: true, ...(body as { linked: number; created: number; closed: number }) };
  } catch {
    return { ok: false, message: 'The cockpit did not answer.' };
  }
}
