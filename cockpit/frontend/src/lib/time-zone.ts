// The user's time zone: one per cockpit (one person). Times are stored as instants (UTC) and read and
// shown in this zone, on every device, whatever zone the browser runs in. The host keeps it (jobs.json
// timeZone, host jobs-api.ts); Settings › Preferences changes it, and a browser fills it in only while
// none is saved. Until the host answered, the page uses the browser's zone.
import { useSyncExternalStore } from 'react';

import { DAY_MS } from './time';

/** The zone this browser runs in. */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

let saved: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function setSaved(zone: string | null): void {
  if (zone === saved) return;
  saved = zone;
  for (const listener of listeners) listener();
}

/** The zone every time is read and shown in: the saved setting, else this browser's. */
export const userTimeZone = (): string => saved ?? browserTimeZone();

/** The saved setting (null until the host told the page) and the zone in use; re-renders when it changes. */
export function useTimeZone(): { saved: string | null; zone: string } {
  const current = useSyncExternalStore(subscribe, () => saved);
  return { saved: current, zone: current ?? browserTimeZone() };
}

/**
 * Reads the setting from the host. With none saved, this browser's zone fills it in; a saved one is never
 * replaced here (only Settings does that, explicitly). An older host without the setting leaves the
 * browser's zone in use.
 */
export async function loadTimeZone(fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetcher('/api/jobs/time-zone');
    if (!res.ok) return;
    const body = await res.json() as { timeZone?: string | null };
    if (body.timeZone) { setSaved(body.timeZone); return; }
    const filled = await fetcher('/api/jobs/time-zone', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeZone: browserTimeZone() }),
    });
    if (filled.ok) setSaved(((await filled.json()) as { timeZone?: string }).timeZone ?? null);
  } catch { /* the browser's zone stays in use */ }
}

/** The user chose a zone in Settings: it replaces the saved one. Answers the host's error, or null. */
export async function chooseTimeZone(zone: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher('/api/jobs/time-zone', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeZone: zone, explicit: true }),
    });
    const body = await res.json().catch(() => null) as { timeZone?: string; error?: { message?: string } } | null;
    if (!res.ok) return body?.error?.message ?? 'Could not save the time zone';
    setSaved(body?.timeZone ?? zone);
    return null;
  } catch {
    return 'Could not reach the cockpit host';
  }
}

/** For tests: the setting as if the host had answered it. */
export const setTimeZoneForTest = (zone: string | null): void => setSaved(zone);

// ---- wall clocks ----

export interface WallClock { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** What the clock on the wall shows at `at` in the zone. */
export function wallClock(at: number, zone: string): WallClock {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    formatters.set(zone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(at)) if (part.type !== 'literal') parts[part.type] = part.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

/** The zone's offset from UTC at `at`, in ms (to the minute). */
function offsetAt(at: number, zone: string): number {
  const c = wallClock(at, zone);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute) - Math.floor(at / 60_000) * 60_000;
}

/** The instant a wall-clock time names in the zone; null when the clock skips it (a daylight-saving gap). As the host's domain/schedule.ts. */
export function zonedTime(c: Pick<WallClock, 'year' | 'month' | 'day' | 'hour' | 'minute'>, zone: string): number | null {
  const naive = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute);
  let at = naive - offsetAt(naive, zone);
  const second = offsetAt(at, zone);
  if (naive - second !== at) at = naive - second;
  const back = wallClock(at, zone);
  return back.day === c.day && back.hour === c.hour && back.minute === c.minute ? at : null;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::00(?:\.0+)?)?$/;

/**
 * A time as an agent or the user writes it: with an offset or Z it is that instant; without, a wall-clock
 * time in the zone ("2026-11-26T20:15"), the way the host reads it (domain/schedule.ts parseAt). Null when it is no time.
 */
export function parseInZone(text: string, zone: string): number | null {
  const local = LOCAL.exec(text.trim());
  if (local) {
    const [, y, mo, d, h, mi] = local.map(Number);
    return zonedTime({ year: y, month: mo, day: d, hour: h, minute: mi }, zone);
  }
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text.trim())) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
}

/** The calendar day `at` falls on in the zone, as a day count: two of them subtract to whole days. */
export function dayNumber(at: number, zone: string): number {
  const c = wallClock(at, zone);
  return Math.round(Date.UTC(c.year, c.month - 1, c.day) / DAY_MS);
}

/** "UTC+7", "UTC+5:30", "UTC-3", "UTC": the zone's offset from UTC now. */
export function utcOffset(zone: string): string {
  const minutes = Math.round(offsetAt(Date.now(), zone) / 60_000);
  if (minutes === 0) return 'UTC';
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? '-' : '+'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

/** "Asia/Bangkok (UTC+7)". */
export const zoneLabel = (zone: string): string => `${zone} (${utcOffset(zone)})`;

/** Every IANA zone this browser knows, for the Settings picker; at least the given ones. */
export function knownTimeZones(...include: string[]): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const all = intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
  return [...new Set([...all, ...include.filter(Boolean)])].sort();
}

// ---- formatting ----

const pad = (n: number) => String(n).padStart(2, '0');

/** "09:05" in the zone. */
export function clock(at: number, zone: string = userTimeZone()): string {
  const c = wallClock(at, zone);
  return `${pad(c.hour)}:${pad(c.minute)}`;
}

/** The moment formatted in the zone with Intl's options, en-GB. */
export function formatInZone(at: number | string | Date, options: Intl.DateTimeFormatOptions, zone: string = userTimeZone()): string {
  const ms = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).format(ms);
}

/** "2026-11-26" and "09:05": a moment as the date and time inputs take it, in the zone. */
export function inputStamp(at: number, zone: string = userTimeZone()): { date: string; time: string } {
  const c = wallClock(at, zone);
  return { date: `${c.year}-${pad(c.month)}-${pad(c.day)}`, time: `${pad(c.hour)}:${pad(c.minute)}` };
}

/** "Mon 9 Nov 08:00", with the year when it is not this one; in the user's time zone. */
export function formatWhen(iso: string): string {
  const zone = userTimeZone();
  const at = Date.parse(iso);
  const sameYear = wallClock(at, zone).year === wallClock(Date.now(), zone).year;
  return formatInZone(at, {
    weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }, zone).replace(/,/g, '');
}
