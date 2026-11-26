// @vitest-environment jsdom
// The times the journal, the Inbox, the Jobs view, a learning's evidence and the terminal's status bar show:
// in the user's time zone, while the tests run in UTC.
import { afterEach, describe, expect, it } from 'vitest';

import { setTimeZoneForTest } from '@/lib/time-zone';
import { entryDate } from './engram-detail';
import { formatWhen } from '@/lib/time-zone';
import { formatClock } from './main-content/view/subcomponents/TerminalStatusBar';
import { dayOf } from './task-board/InboxView';
import { formatAt, shortAt } from './task-sections';

// Thu 19 Nov 2026 22:00 UTC is Fri 20 Nov 05:00 in Bangkok.
const NOW = Date.parse('2026-11-19T22:00:00Z');

afterEach(() => setTimeZoneForTest(null));

describe('times in the user\'s time zone', () => {
  it('a journal\'s newest time counts today on the user\'s calendar', () => {
    setTimeZoneForTest('Asia/Bangkok');
    expect(shortAt('2026-11-19T22:30:00Z', NOW)).toBe('05:30');
    expect(shortAt('2026-11-19T16:00:00Z', NOW)).toBe('19 Nov');
    expect(formatAt('2026-11-19T22:30:00Z')).toBe('20 Nov 05:30');
    setTimeZoneForTest('UTC');
    expect(shortAt('2026-11-19T16:00:00Z', NOW)).toBe('16:00');
  });

  it('the Inbox groups by the user\'s day', () => {
    setTimeZoneForTest('Asia/Bangkok');
    expect(dayOf('2026-11-19T16:00:00Z', NOW)).toBe('Yesterday');
    expect(dayOf('2026-11-19T21:00:00Z', NOW)).toBe('Today');
    setTimeZoneForTest('UTC');
    expect(dayOf('2026-11-19T16:00:00Z', NOW)).toBe('Today');
  });

  it('the Jobs view, the evidence date and the status bar', () => {
    setTimeZoneForTest('Asia/Bangkok');
    expect(formatWhen('2026-11-19T22:00:00Z')).toBe('Fri 20 Nov 05:00');
    expect(formatWhen('2030-01-01T01:00:00Z')).toBe('Tue 1 Jan 2030 08:00');
    expect(entryDate('2026-11-19T22:00:00Z')).toBe('2026-11-20');
    expect(formatClock('2026-11-19T22:00:00Z')).toBe('20 Nov 05:00');
  });
});
