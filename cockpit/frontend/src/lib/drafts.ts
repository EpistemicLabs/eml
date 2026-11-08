// A channel job's drafts, as the review card reads and decides them. The host passes these on to
// the channel bridge with its own token; the page never holds one.

export interface Draft {
  outboxId: string;
  to: string;
  subject: string | null;
  text: string;
  /** The message it answers: text from outside, shown as text only. */
  replyTo: { id: string; from: string; subject: string | null; receivedAt: string; text: string } | null;
}

const FALLBACK = 'The cockpit host did not answer. Try again.';

type Answer = { kind?: string; reason?: string; retryable?: boolean; drafts?: Draft[] };

export async function listDrafts(jobId: string): Promise<{ drafts: Draft[]; error: string | null }> {
  try {
    const response = await fetch(`/api/bridge/jobs/${encodeURIComponent(jobId)}/drafts`);
    const body = (await response.json().catch(() => null)) as Answer | null;
    if (response.ok && body?.kind === 'drafts') return { drafts: body.drafts ?? [], error: null };
    return { drafts: [], error: problem(body) };
  } catch {
    return { drafts: [], error: FALLBACK };
  }
}

/** Send or skip a draft; null when it worked, else what to tell the user. */
export async function decideDraft(outboxId: string, action: 'approve' | 'skip'): Promise<string | null> {
  return post(`/api/bridge/outbox/${encodeURIComponent(outboxId)}/${action}`);
}

export async function saveDraft(outboxId: string, text: string): Promise<string | null> {
  return post(`/api/bridge/outbox/${encodeURIComponent(outboxId)}/edit`, { text });
}

async function post(url: string, body?: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) return null;
    return problem((await response.json().catch(() => null)) as Answer | null);
  } catch {
    return FALLBACK;
  }
}

function problem(body: Answer | null): string {
  if (body?.reason === 'bridge_off' || body?.reason === 'bridge_unreachable') return 'The channel bridge is not running.';
  if (body?.reason === 'not_a_draft') return 'This draft was already decided.';
  if (body?.kind === 'failed') {
    return body.retryable ? `Not sent yet (${body.reason}). Try Send again in a while.` : `Not sent: the channel refused it (${body.reason}).`;
  }
  return body?.reason ? `That did not work (${body.reason}).` : FALLBACK;
}
