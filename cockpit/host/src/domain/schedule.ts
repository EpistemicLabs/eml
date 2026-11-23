/**
 * When a job's schedule trigger is due (job.ts): a cron expression or a one-time
 * date, read in an IANA time zone. The server usually runs in UTC while its user
 * lives elsewhere, so every time is computed on the zone's wall clock, with the
 * zone's own daylight-saving rules (Node's Intl, no dependency).
 *
 * Cron has the five usual fields — minute hour day-of-month month day-of-week —
 * with `*`, lists, ranges, steps and the names JAN–DEC and SUN–SAT; day-of-week
 * 0 and 7 are both Sunday. With day-of-month and day-of-week both restricted, a
 * day matches either one (as in Vixie cron).
 */

export interface CronSpec {
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Both day fields restricted: a day matches either. */
  dayOr: boolean
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

function parseField(field: string, min: number, max: number, names: string[] | null, label: string): Set<number> {
  const value = (part: string): number => {
    const index = names ? names.indexOf(part.toUpperCase()) : -1
    const n = index >= 0 ? index + (min === 1 ? 1 : 0) : Number(part)
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: "${part}" is not between ${min} and ${max}`)
    return n
  }
  const out = new Set<number>()
  for (const item of field.split(',')) {
    const [range, stepText] = item.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`${label}: bad step in "${item}"`)
    let from: number
    let to: number
    if (range === '*') {
      from = min
      to = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      from = value(a)
      to = value(b)
      if (from > to) throw new Error(`${label}: range "${range}" runs backwards`)
    } else {
      from = value(range)
      to = stepText === undefined ? from : max
    }
    for (let n = from; n <= to; n += step) out.add(n)
  }
  return out
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron needs five fields: minute hour day-of-month month day-of-week')
  const [minute, hour, day, month, weekday] = fields
  const weekdays = parseField(weekday, 0, 7, WEEKDAYS, 'day-of-week')
  if (weekdays.has(7)) { weekdays.delete(7); weekdays.add(0) }
  return {
    minutes: [...parseField(minute, 0, 59, null, 'minute')].sort((a, b) => a - b),
    hours: [...parseField(hour, 0, 23, null, 'hour')].sort((a, b) => a - b),
    days: parseField(day, 1, 31, null, 'day-of-month'),
    months: parseField(month, 1, 12, MONTHS, 'month'),
    weekdays,
    dayOr: day !== '*' && weekday !== '*',
  }
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function wallClock(at: number, zone: string): WallClock {
  let format = formatters.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    })
    formatters.set(zone, format)
  }
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(at)) if (part.type !== 'literal') parts[part.type] = Number(part.value)
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute }
}

/** The zone's offset from UTC at `at`, in ms (to the minute). */
function offsetAt(at: number, zone: string): number {
  const c = wallClock(at, zone)
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute) - Math.floor(at / 60_000) * 60_000
}

/** The instant a wall-clock time names in the zone; null when the clock skips it (a daylight-saving gap). */
export function zonedTime(c: WallClock, zone: string): number | null {
  const naive = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute)
  let at = naive - offsetAt(naive, zone)
  const second = offsetAt(at, zone)
  if (naive - second !== at) at = naive - second
  const back = wallClock(at, zone)
  return back.day === c.day && back.hour === c.hour && back.minute === c.minute ? at : null
}

// Far enough for a 29 February on a Monday.
const SEARCH_DAYS = 366 * 28

/** The first time after `after` (exclusive) the cron matches in the zone; null if never. */
export function nextCronTime(spec: CronSpec, zone: string, after: number): number | null {
  const start = wallClock(after, zone)
  const day = new Date(Date.UTC(start.year, start.month - 1, start.day))
  for (let i = 0; i < SEARCH_DAYS; i++, day.setUTCDate(day.getUTCDate() + 1)) {
    const month = day.getUTCMonth() + 1
    if (!spec.months.has(month)) continue
    const date = day.getUTCDate()
    const inDays = spec.days.has(date)
    const inWeek = spec.weekdays.has(day.getUTCDay())
    if (spec.dayOr ? !(inDays || inWeek) : !(inDays && inWeek)) continue
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const at = zonedTime({ year: day.getUTCFullYear(), month, day: date, hour, minute }, zone)
        if (at !== null && at > after) return at
      }
    }
  }
  return null
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::00(?:\.0+)?)?$/

/**
 * A one-time date: with an offset or Z it is that instant; without, a wall-clock
 * time in the zone ("2026-11-13T10:00"). Null when it is not a date.
 */
export function parseAt(text: string, zone: string): number | null {
  const local = LOCAL.exec(text.trim())
  if (local) {
    const [, y, mo, d, h, mi] = local.map(Number)
    return zonedTime({ year: y, month: mo, day: d, hour: h, minute: mi }, zone)
  }
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text.trim())) return null
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : at
}

/** "Mon 9 Nov 08:00" in the zone: how the user reads a run time. */
export function formatInZone(at: number, zone: string): string {
  const parts: Record<string, string> = {}
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  for (const part of format.formatToParts(at)) parts[part.type] = part.value
  const thisYear = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric' }).format(Date.now())
  const year = parts.year === thisYear ? '' : ` ${parts.year}`
  return `${parts.weekday} ${parts.day} ${parts.month}${year} ${parts.hour}:${parts.minute}`
}

/** "2 h 5 min", "40 min", "3 days": a lateness or a gap. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `${h} h ${m} min` : `${h} h`
  }
  return `${Math.round(minutes / (24 * 60))} days`
}

/** The shortest gap between the next `count` runs: how often the cron fires at most. */
export function shortestGap(spec: CronSpec, zone: string, from: number, count = 30): number | null {
  let prev = nextCronTime(spec, zone, from)
  if (prev === null) return null
  let shortest: number | null = null
  for (let i = 1; i < count; i++) {
    const next = nextCronTime(spec, zone, prev)
    if (next === null) break
    shortest = shortest === null ? next - prev : Math.min(shortest, next - prev)
    prev = next
  }
  return shortest
}
