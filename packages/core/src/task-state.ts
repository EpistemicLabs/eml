import { WAIT_KINDS, CHECKPOINTS, ISO_DATE_FIELD, isoTimestamp } from './fields'

// --- A task's hand-over and waits, mirrored (v0.23) ------------------------------
//
// Schema 23 adds two task fields next to the flat ones the task system wrote
// since 22, and removes none of them:
//
//   delegation — { agent, checkpoint?, mode, requested_at?, next_run_at? }, the
//                hand-over as one value; mirrors delegate and checkpoint.
//   waits      — [{ id, who, kind?, why?, since?, session_id? }], everyone the
//                task waits on; waiting_on is its most urgent entry.
//
// Core keeps both shapes in step on every task write (create and track), so
// every surface — MCP, REST, CLI, a cockpit that writes only the flat fields —
// reads the same state, and a replay derives it the same way. The rules:
//
// - delegation is there exactly when delegate is: agent = delegate, and its
//   checkpoint is the task's checkpoint (absent when that is absent). A flat
//   checkpoint without a delegate (written before 23) has no delegation.
// - A write of delegation sets delegate and checkpoint; null clears all three.
// - A write of delegate or checkpoint keeps mode, requested_at and next_run_at
//   while the agent stays the same; a new agent starts a new delegation
//   (mode alone, not requested).
// - A write of waits sets waiting_on to its most urgent entry (WAIT_KINDS order,
//   an entry without a kind last, then the oldest since, then list order),
//   without its id; an empty list clears both.
// - A write of waiting_on (a cockpit that knows one wait) replaces waits with
//   that one wait; one without who is no wait.
// - One call writes one shape: delegation or delegate/checkpoint, waits or waiting_on.

type Props = Record<string, unknown>
type Wait = Record<string, string>

const DELEGATION_KEYS = ['agent', 'checkpoint', 'mode', 'requested_at', 'next_run_at'] as const
const WAIT_KEYS = ['id', 'who', 'kind', 'why', 'since', 'session_id'] as const

const has = (o: Props, k: string) => o[k] !== undefined

/** An object with only `keys`, in that order, without the absent ones: the stored form is the same whatever order a caller sent. */
function ordered(value: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of keys) if (typeof value[k] === 'string') out[k] = value[k] as string
  return out
}

/** A delegation as stored: its keys in order, its timestamps as ISO-8601 UTC with milliseconds. */
function storedDelegation(d: Record<string, unknown>): Record<string, string> {
  const out = ordered(d, DELEGATION_KEYS)
  for (const k of ['requested_at', 'next_run_at']) if (out[k] !== undefined) out[k] = isoTimestamp(out[k])
  return out
}

/** A wait as stored: its keys in order, since as ISO-8601 UTC with milliseconds. */
function storedWait(w: Record<string, unknown>): Wait {
  const out = ordered(w, WAIT_KEYS)
  if (out.since !== undefined) out.since = isoTimestamp(out.since)
  return out
}

const urgency = (w: Wait) => {
  const i = (WAIT_KINDS as readonly string[]).indexOf(w.kind)
  return i === -1 ? WAIT_KINDS.length : i
}

/** The most urgent of a task's waits (see the header), or undefined for none. */
export function mostUrgentWait(waits: readonly Wait[]): Wait | undefined {
  let best: Wait | undefined
  for (const w of waits) {
    if (best === undefined) { best = w; continue }
    const d = urgency(w) - urgency(best)
    if (d < 0 || (d === 0 && w.since !== undefined && (best.since === undefined || w.since < best.since))) best = w
  }
  return best
}

/** waiting_on as the flat fields of a wait: the wait without its id. */
function waitingOnOf(w: Wait): Wait {
  const { id: _id, ...rest } = w
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
  if (typeof w.since !== 'string' || !ISO_DATE_FIELD.test(w.since) || Number.isNaN(Date.parse(w.since.replace(' ', 'T')))) delete w.since
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
      const before = old.delegation as Record<string, string> | undefined
      const same = before !== undefined && before.agent === agent
      patch.delegation = storedDelegation({
        agent,
        checkpoint: (CHECKPOINTS as readonly unknown[]).includes(checkpoint) ? checkpoint : undefined,
        mode: same ? before.mode : 'alone',
        requested_at: same ? before.requested_at : undefined,
        next_run_at: same ? before.next_run_at : undefined,
      })
    }
  }

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
