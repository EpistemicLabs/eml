import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserTimeZone, chooseTimeZone, dayNumber, inputStamp, loadTimeZone, parseInZone, setTimeZoneForTest, userTimeZone, utcOffset, zoneLabel } from './time-zone';

/** A fake host for /api/jobs/time-zone: it keeps the zone as the host does (jobs-api.ts). */
function host(saved: string | null) {
  const state = { saved, puts: [] as Array<Record<string, unknown>> };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init || init.method !== 'PUT') return new Response(JSON.stringify({ timeZone: state.saved }));
    const body = JSON.parse(String(init.body)) as { timeZone: string; explicit?: boolean };
    state.puts.push(body);
    if (body.explicit === true || state.saved === null) state.saved = body.timeZone;
    return new Response(JSON.stringify({ timeZone: state.saved }));
  });
  return { state, fetcher: fetcher as unknown as typeof fetch };
}

describe('the user\'s time zone', () => {
  afterEach(() => setTimeZoneForTest(null));

  it('runs these tests in UTC, so every zone below differs from the browser\'s', () => {
    expect(browserTimeZone()).toBe('UTC');
    expect(userTimeZone()).toBe('UTC');
  });

  it('is never overwritten by a page load: a saved zone stays, whatever zone the browser runs in', async () => {
    const { state, fetcher } = host('Asia/Bangkok');
    await loadTimeZone(fetcher);
    expect(userTimeZone()).toBe('Asia/Bangkok');
    expect(state.saved).toBe('Asia/Bangkok');
    expect(state.puts).toEqual([]);
  });

  it('is filled in by the browser only while none is saved, and without the explicit flag', async () => {
    const { state, fetcher } = host(null);
    await loadTimeZone(fetcher);
    expect(state.puts).toEqual([{ timeZone: 'UTC' }]);
    expect(state.saved).toBe('UTC');
    expect(userTimeZone()).toBe('UTC');
  });

  it('changes only when the user chooses one, explicitly', async () => {
    const { state, fetcher } = host('UTC');
    expect(await chooseTimeZone('Asia/Makassar', fetcher)).toBeNull();
    expect(state.puts).toEqual([{ timeZone: 'Asia/Makassar', explicit: true }]);
    expect(userTimeZone()).toBe('Asia/Makassar');
  });

  it('reads a written time as a wall-clock time in the zone, as the host does', () => {
    expect(new Date(parseInZone('2026-11-26T20:15', 'Asia/Bangkok')!).toISOString()).toBe('2026-11-26T13:15:00.000Z');
    expect(new Date(parseInZone('2026-11-26T20:15', 'Asia/Makassar')!).toISOString()).toBe('2026-11-26T12:15:00.000Z');
    expect(new Date(parseInZone('2026-11-26T20:15Z', 'Asia/Bangkok')!).toISOString()).toBe('2026-11-26T20:15:00.000Z');
    expect(parseInZone('tomorrow', 'Asia/Bangkok')).toBeNull();
  });

  it('names a zone with its offset, and gives the day and the input stamp of a moment in it', () => {
    expect(utcOffset('Asia/Bangkok')).toBe('UTC+7');
    expect(utcOffset('Asia/Kolkata')).toBe('UTC+5:30');
    expect(utcOffset('UTC')).toBe('UTC');
    expect(utcOffset('America/Sao_Paulo')).toBe('UTC-3');
    expect(zoneLabel('Asia/Makassar')).toBe('Asia/Makassar (UTC+8)');
    const late = Date.parse('2026-11-19T22:00:00Z');
    expect(dayNumber(late, 'Asia/Bangkok') - dayNumber(late, 'UTC')).toBe(1);
    expect(inputStamp(late, 'Asia/Bangkok')).toEqual({ date: '2026-11-20', time: '05:00' });
  });

  it('keeps the zone it has when the host refuses a choice or has no setting', async () => {
    setTimeZoneForTest('Asia/Bangkok');
    const refusing = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'INVALID_TIME_ZONE', message: 'timeZone must be an IANA time zone' } }), { status: 400 }));
    expect(await chooseTimeZone('Mars/Olympus', refusing as unknown as typeof fetch)).toBe('timeZone must be an IANA time zone');
    expect(userTimeZone()).toBe('Asia/Bangkok');
    setTimeZoneForTest(null);
    const older = vi.fn(async () => new Response('not found', { status: 404 }));
    await loadTimeZone(older as unknown as typeof fetch);
    expect(older).toHaveBeenCalledTimes(1);
    expect(userTimeZone()).toBe('UTC');
  });
});
