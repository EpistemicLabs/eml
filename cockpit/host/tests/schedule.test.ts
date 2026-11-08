import { describe, it, expect } from 'vitest'
import { formatInZone, nextCronTime, parseAt, parseCron, shortestGap } from '../src/domain/schedule.js'

// A job's schedule reads on its user's wall clock, not the server's: the
// server runs in UTC while the user may be eight hours ahead.

const utc = (text: string) => Date.parse(`${text}Z`)
const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString().slice(0, 16))

describe('cron', () => {
  it('fires on weekdays at 8:00 in the job’s zone', () => {
    const spec = parseCron('0 8 * * 1-5')
    // Friday 6 Nov 2026, 01:00 UTC = 09:00 in UTC+8: today's 8:00 has passed, the weekend is skipped.
    expect(iso(nextCronTime(spec, 'Asia/Makassar', utc('2026-11-06T01:00')))).toBe('2026-11-09T00:00')
    expect(iso(nextCronTime(spec, 'Europe/Berlin', utc('2026-11-06T01:00')))).toBe('2026-11-06T07:00')
  })

  it('reads lists, steps and names, and Sunday as 0 or 7', () => {
    const spec = parseCron('15,45 9-17/4 * JAN-MAR sun')
    expect(spec.minutes).toEqual([15, 45])
    expect(spec.hours).toEqual([9, 13, 17])
    expect([...spec.months]).toEqual([1, 2, 3])
    expect([...spec.weekdays]).toEqual([0])
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0])
  })

  it('matches either day field when both are set', () => {
    // The 1st of the month or any Monday.
    const spec = parseCron('0 12 1 * 1')
    expect(iso(nextCronTime(spec, 'UTC', utc('2026-11-02T13:00')))).toBe('2026-11-09T12:00')
    expect(iso(nextCronTime(spec, 'UTC', utc('2026-11-30T13:00')))).toBe('2026-12-01T12:00')
  })

  it('skips a time a daylight-saving change leaves out', () => {
    // 29 March 2026: Berlin's clocks jump from 02:00 to 03:00.
    const spec = parseCron('30 2 * * *')
    expect(iso(nextCronTime(spec, 'Europe/Berlin', utc('2026-03-28T02:00')))).toBe('2026-03-30T00:30')
  })

  it('refuses what is not cron', () => {
    expect(() => parseCron('0 8 * *')).toThrow(/five fields/)
    expect(() => parseCron('61 8 * * *')).toThrow(/minute/)
    expect(() => parseCron('0 8 * * 1-9')).toThrow(/day-of-week/)
    expect(() => parseCron('0 8 * * 5-1')).toThrow(/backwards/)
  })

  it('knows its shortest gap', () => {
    expect(shortestGap(parseCron('*/10 * * * *'), 'UTC', utc('2026-11-06T00:00'))).toBe(10 * 60_000)
    expect(shortestGap(parseCron('0 8 * * 1-5'), 'UTC', utc('2026-11-06T00:00'))).toBe(24 * 60 * 60_000)
  })
})

describe('one-time dates', () => {
  it('reads a date without offset on the zone’s clock, with one as that instant', () => {
    expect(iso(parseAt('2026-11-13T10:00', 'Asia/Makassar'))).toBe('2026-11-13T02:00')
    expect(iso(parseAt('2026-11-13 10:00', 'Europe/Berlin'))).toBe('2026-11-13T09:00')
    expect(iso(parseAt('2026-11-13T10:00+02:00', 'Asia/Makassar'))).toBe('2026-11-13T08:00')
    expect(parseAt('next friday', 'UTC')).toBeNull()
  })

  it('formats a time as the user reads it', () => {
    expect(formatInZone(utc('2027-01-04T00:00'), 'Asia/Makassar')).toBe('Mon 4 Jan 2027 08:00')
  })
})
