import { afterEach, describe, expect, it, vi } from 'vitest';

import { decideDraft, listDrafts, saveDraft } from '@/lib/drafts';

// A job's drafts as the review card reads and decides them, through the host's /api/bridge.

function answer(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status < 300, status, json: async () => body }) as Response);
}

afterEach(() => vi.unstubAllGlobals());

describe('drafts', () => {
  it('lists a job\'s drafts', async () => {
    const fetchMock = answer(200, { kind: 'drafts', drafts: [{ outboxId: 'o-1', to: 'a@b.example', subject: 'Re: x', text: 'Hi', replyTo: null }] });
    vi.stubGlobal('fetch', fetchMock);
    expect(await listDrafts('job 1')).toEqual({ drafts: [{ outboxId: 'o-1', to: 'a@b.example', subject: 'Re: x', text: 'Hi', replyTo: null }], error: null });
    expect(fetchMock).toHaveBeenCalledWith('/api/bridge/jobs/job%201/drafts');
  });

  it('says the bridge is off instead of showing an empty list', async () => {
    vi.stubGlobal('fetch', answer(503, { kind: 'unavailable', reason: 'bridge_off', retryable: true }));
    expect(await listDrafts('job-1')).toEqual({ drafts: [], error: 'The channel bridge is not running.' });
  });

  it('sends, skips and saves, and says plainly what went wrong', async () => {
    vi.stubGlobal('fetch', answer(200, { kind: 'sent', outboxId: 'o-1' }));
    expect(await decideDraft('o-1', 'approve')).toBeNull();
    vi.stubGlobal('fetch', answer(409, { kind: 'refused', reason: 'not_a_draft', retryable: false }));
    expect(await decideDraft('o-1', 'skip')).toBe('This draft was already decided.');
    vi.stubGlobal('fetch', answer(503, { kind: 'failed', reason: 'rate_limited', retryable: true }));
    expect(await decideDraft('o-1', 'approve')).toBe('Not sent yet (rate_limited). Try Send again in a while.');
    vi.stubGlobal('fetch', answer(200, { kind: 'edited', outboxId: 'o-1' }));
    expect(await saveDraft('o-1', 'New text')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await saveDraft('o-1', 'x')).toBe('The cockpit host did not answer. Try again.');
  });
});
