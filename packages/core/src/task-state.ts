import { WAIT_KINDS, CHECKPOINTS, ISO_DATE_FIELD, SNOOZED_OPEN, isoTimestamp } from './fields'

// --- A task's hand-over, schedule and waits, mirrored (v0.23, v0.25) -------------
//
// Schema 23 adds two task fields next to the flat ones the task system wrote
// since 22, and removes none of them; schema 25 adds a third:
//
//   delegation — { agent, checkpoint?, requested_at? }, the hand-over to an agent
//                that works on its own; mirrors delegate and checkpoint.
//   schedule   — { crons?, at?, why?, by?, by_session?, time_zone?, paused?,
//                ends_at? }: the task's
//                repeating times and its one wake-up, owned by `by` (a handle:
//                an agent's wake-up is a run, a person's a reminder) and set in
//                by_session. It stands on its own: who works on a task and when
//                someone looks again are separate.
//   waits      — [{ id, who, kind?, why?, since?, session_id?, snoozed_until?,
//                due? }], everyone the task waits on; waiting_on is its most
//                urgent entry.
//
// Core keeps the shapes in step on every task write (create and track), so
// every surface — MCP, REST, CLI, a cockpit that writes only the flat fields —
// reads the same state, and a replay derives it the same way. The rules:
//
// - delegation is there exactly when delegate is: agent = delegate, and its
//   checkpoint is the task's checkpoint (absent when that is absent). A flat
//   checkpoint without a delegate (written before 23) has no delegation.
// - A write of delegation sets delegate and checkpoint; null clears all three.
// - A write of delegate or checkpoint keeps requested_at while the agent stays
//   the same. A new agent starts unrequested.
// - v0.25: no write of delegation, delegate or checkpoint touches the schedule,
//   and a write of the schedule touches no delegation.
// - A schedule has at least one of crons and at. Stored: its keys in the order
//   above, the absent ones left out; crons without the white space around an
//   entry, each once, in the order given; at and ends_at as ISO-8601 UTC with
//   milliseconds; why, by and by_session only next to at (they belong to the
//   wake-up).
// - A write of waits sets waiting_on to its most urgent entry (a wait that is
//   not parked first, then WAIT_KINDS order, an entry without a kind last, then
//   the oldest since, then list order), without its id and snoozed_until; an
//   empty list clears both. Parked is data, not the clock: a replay must derive
//   the same state, so a snooze that has run out still counts as parked here.
//   A wait's due (v0.25) is stored as given when it is a date, as ISO-8601 UTC
//   with milliseconds when it has a time.
// - A write of waiting_on (a cockpit that knows one wait) replaces waits with
//   that one wait; one without who is no wait.
// - One call writes one shape: delegation or delegate/checkpoint, waits or waiting_on.

type Props = Record<string, unknown>
type Wait = Record<string, string>
type Schedule = { crons?: string[], at?: string, why?: string, by?: string, by_session?: string, time_zone?: string, paused?: boolean, ends_at?: string }
type Delegation = { agent: string, checkpoint?: string, requested_at?: string }

/** v0.25: a schedule's stored keys, in their stored order. */
const SCHEDULE_KEYS = ['crons', 'at', 'why', 'by', 'by_session', 'time_zone', 'paused', 'ends_at'] as const
const WAIT_KEYS = ['id', 'who', 'kind', 'why', 'since', 'session_id', 'snoozed_until', 'due'] as const

const has = (o: Props, k: string) => o[k] !== undefined

/** An object with only `keys`, in that order, without the absent ones: the stored form is the same whatever order a caller sent. */
function ordered<T extends string>(value: Record<string, unknown>, keys: readonly string[], take: (v: unknown) => v is T): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of keys) if (take(value[k])) out[k] = value[k] as T
  return out
}
const isText = (v: unknown): v is string => typeof v === 'string'

/**
 * A schedule as stored (see the header): its keys in order; crons trimmed, each
 * once, in the order given; at and ends_at as ISO-8601 UTC with milliseconds;
 * why, by and by_session only with at. Throws when it has neither a repeating
 * time nor a wake-up.
 */
function storedSchedule(s: Record<string, unknown>): Schedule {
  const out: Schedule = {}
  if (Array.isArray(s.crons)) {
    const crons = [...new Set(s.crons.filter(isText).map(c => c.trim()).filter(c => c !== ''))]
    if (crons.length > 0) out.crons = crons
  }
  if (isText(s.at)) {
    out.at = isoTimestamp(s.at)
    if (isText(s.why)) out.why = s.why
    if (isText(s.by)) out.by = s.by
    if (isText(s.by_session)) out.by_session = s.by_session
  }
  if (out.crons === undefined && out.at === undefined) {
    throw new Error('Invalid engram: schedule needs a repeating time (crons) or a wake-up (at).')
  }
  if (isText(s.time_zone)) out.time_zone = s.time_zone
  if (typeof s.paused === 'boolean') out.paused = s.paused
  if (isText(s.ends_at)) out.ends_at = isoTimestamp(s.ends_at)
  return Object.fromEntries(SCHEDULE_KEYS.filter(k => out[k] !== undefined).map(k => [k, out[k]])) as Schedule
}

/** A delegation as stored: its keys in order, its timestamps as ISO-8601 UTC with milliseconds. */
function storedDelegation(d: Record<string, unknown>): Delegation {
  const out: Delegation = { agent: d.agent as string }
  if (isText(d.checkpoint)) out.checkpoint = d.checkpoint
  if (isText(d.requested_at)) out.requested_at = isoTimestamp(d.requested_at)
  return out
}

/**
 * A wait as stored: its keys in order, since and a dated snoozed_until as ISO-8601
 * UTC with milliseconds, due as given when it is a date and as ISO-8601 UTC with
 * milliseconds when it has a time. Throws on a snoozed_until that is neither a
 * date nor "open".
 */
function storedWait(w: Record<string, unknown>): Wait {
  const out = ordered(w, WAIT_KEYS, isText)
  if (out.since !== undefined) out.since = isoTimestamp(out.since)
  if (out.due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(out.due)) out.due = isoTimestamp(out.due)
  if (out.snoozed_until !== undefined && out.snoozed_until !== SNOOZED_OPEN) {
    if (!isDate(out.snoozed_until)) throw new Error(`Invalid engram: a wait's snoozed_until is an ISO date or "${SNOOZED_OPEN}".`)
    out.snoozed_until = isoTimestamp(out.snoozed_until)
  }
  return out
}

const isDate = (v: string) => ISO_DATE_FIELD.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T')))

const urgency = (w: Wait) => {
  const i = (WAIT_KINDS as readonly string[]).indexOf(w.kind)
  return i === -1 ? WAIT_KINDS.length : i
}

/** The most urgent of a task's waits (see the header), or undefined for none. */
export function mostUrgentWait(waits: readonly Wait[]): Wait | undefined {
  let best: Wait | undefined
  const parked = (w: Wait) => (w.snoozed_until === undefined ? 0 : 1)
  for (const w of waits) {
    if (best === undefined) { best = w; continue }
    const p = parked(w) - parked(best)
    if (p !== 0) { if (p < 0) best = w; continue }
    const d = urgency(w) - urgency(best)
    if (d < 0 || (d === 0 && w.since !== undefined && (best.since === undefined || w.since < best.since))) best = w
  }
  return best
}

/** waiting_on as the flat fields of a wait: the wait without its id. */
function waitingOnOf(w: Wait): Wait {
  const { id: _id, snoozed_until: _snoozed, ...rest } = w
  return rest
}

/**
 * The one wait a flat waiting_on stands for. Its values are taken as far as
 * they fit a wait (a kind outside WAIT_KINDS or a since that is no date is left
 * out); its id is its session_id, else "waiting_on". Undefined without who.
 */
function waitOf(waitingOn: Record<string, unknown>): Wait | undefined {
  const who = waitingOn.who
  if (typeof who !== 'string' || who.trim() === '') return undefined
  const w: Record<string, unknown> = { ...waitingOn }
  if (!(WAIT_KINDS as readonly unknown[]).includes(w.kind)) delete w.kind
  if (typeof w.since !== 'string' || !isDate(w.since)) delete w.since
  delete w.snoozed_until
  const sessionId = typeof w.session_id === 'string' && w.session_id.trim() !== '' ? w.session_id : 'waiting_on'
  return storedWait({ ...w, id: sessionId })
}

/**
 * The mirror of one task write: `patch` holds the typed fields the call sets
 * (validated; null clears one), `old` the task's stored properties ({} on
 * create). Adds to `patch` what the other shape becomes — null where it is
 * cleared — and brings the new shapes to their stored form. Throws `Invalid
 * engram: …` for a call that writes both shapes of one thing.
 */
export function mirrorTaskState(old: Props, patch: Props): void {
  if (has(patch, 'delegation') && (has(patch, 'delegate') || has(patch, 'checkpoint'))) {
    throw new Error('Invalid engram: pass delegation or delegate/checkpoint, not both — delegation carries the agent and the checkpoint.')
  }
  if (has(patch, 'waits') && has(patch, 'waiting_on')) {
    throw new Error('Invalid engram: pass waits or waiting_on, not both — waiting_on follows the most urgent wait.')
  }

  if (has(patch, 'delegation')) {
    if (patch.delegation === null) {
      patch.delegate = null
      patch.checkpoint = null
    } else {
      const d = storedDelegation(patch.delegation as Props)
      patch.delegation = d
      patch.delegate = d.agent
      patch.checkpoint = d.checkpoint ?? null
    }
  } else if (has(patch, 'delegate') || has(patch, 'checkpoint')) {
    const agent = (has(patch, 'delegate') ? patch.delegate : old.delegate) as string | null | undefined
    const checkpoint = (has(patch, 'checkpoint') ? patch.checkpoint : old.checkpoint) as string | null | undefined
    if (!agent) {
      patch.delegation = null
    } else {
      const before = old.delegation as Delegation | undefined
      const same = before !== undefined && before.agent === agent
      patch.delegation = storedDelegation({
        agent,
        checkpoint: (CHECKPOINTS as readonly unknown[]).includes(checkpoint) ? checkpoint : undefined,
        requested_at: same ? before.requested_at : undefined,
      })
    }
  }

  // v0.25: the schedule on its own; null ends it
  if (has(patch, 'schedule') && patch.schedule !== null) patch.schedule = storedSchedule(patch.schedule as Props)

  if (has(patch, 'waits')) {
    const waits = patch.waits === null ? [] : (patch.waits as Props[]).map(storedWait)
    const urgent = mostUrgentWait(waits)
    patch.waits = waits.length > 0 ? waits : null
    patch.waiting_on = urgent ? waitingOnOf(urgent) : null
  } else if (has(patch, 'waiting_on')) {
    const wait = patch.waiting_on === null ? undefined : waitOf(patch.waiting_on as Props)
    patch.waits = wait ? [wait] : null
  }
}

/** The patch's fields applied to stored properties: null deletes one, a value sets it. */
export function applyPatch(props: Props, patch: Props): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete props[k]
    else if (v !== undefined) props[k] = v
  }
}

/**
 * v0.23: a task created with a delegation that has a checkpoint, no schedule and
 * no request is requested at its creation (`at`, the write's time), so a planned
 * step starts as it did before 23. A delegation without a checkpoint is not: the
 * owner hands it over first. v0.25: the schedule is the task's own field.
 */
export function requestOnCreate(props: Props, at: string): void {
  const d = props.delegation as Delegation | undefined
  if (!d || d.checkpoint === undefined || props.schedule !== undefined || d.requested_at !== undefined) return
  props.delegation = { ...d, requested_at: at }
}
