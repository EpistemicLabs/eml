import { TYPE_REVIEW_DEFAULTS, TASK_OPEN_STATUSES, type Engram } from '../types'
import { isBlank } from '../fields'
import { appendEntry, bumpRev } from '../entries'
import { addDays } from '../env'
import { propsOf } from '../write/context'
import { CommandError, inputObject, requireText, type CommandContext, type CommandModule } from './types'

/** engram.confirm_review — the engram and why it still holds. */
export interface EngramConfirmReviewInput {
  id: string
  text?: string
}

/** engram.confirm_review — confirm in a review that an engram still holds. Was EngramStore.confirmReview. */
export const engramConfirmReview: CommandModule<EngramConfirmReviewInput, Engram> = {
  name: 'engram.confirm_review',
  validate(input) {
    const o = inputObject('engram.confirm_review', input)
    requireText(o, 'id', 'Invalid engram: id is required.')
    if (o.text !== undefined && typeof o.text !== 'string') throw new CommandError('INVALID', 'Invalid engram: text must be text.')
    return o as unknown as EngramConfirmReviewInput
  },
  apply(ctx, input) {
    const r = confirmReview(ctx, input.id, input.text)
    if (!r) throw new CommandError('NOT_FOUND', 'engram not found')
    return r
  },
}

/**
 * Confirm in a review that an engram still holds. A decision, rule or
 * profile gets a review entry (why it still holds) and a new review_due_at;
 * a task is flagged for inactivity, so confirming it counts as a movement.
 * Either way it is no longer review_due.
 */
function confirmReview(ctx: CommandContext, id: string, text: string | undefined): Engram | null {
  const { db, stamp } = ctx
  const existing = db.prepare('SELECT * FROM engrams WHERE id = ?').get(id) as any
  if (!existing) return null
  const live = existing.type === 'task' ? (TASK_OPEN_STATUSES as readonly string[]).includes(existing.status) : existing.status === 'active'
  if (!live) throw new Error(`Invalid engram: ${id} is ${existing.status} — a review confirms an active engram${existing.type === 'task' ? ' (an open task)' : ''}.`)
  if (existing.type === 'task') {
    db.transaction(() => {
      db.prepare(`UPDATE engrams SET updated_at = ? WHERE id = ?`).run(stamp.at, id)
      bumpRev(db, stamp, id)
      if (text && text.trim() !== '') {
        appendEntry(db, id, { kind: 'note', text, stage: propsOf(ctx, id).stage as string ?? null }, stamp)
      }
    })()
    return ctx.store.getRaw(id, stamp.at)
  }
  const reviewDays = TYPE_REVIEW_DEFAULTS[existing.type as keyof typeof TYPE_REVIEW_DEFAULTS]
  if (reviewDays === undefined) {
    throw new Error(`Invalid engram: a review is confirmed for a decision, rule, profile or task (got ${existing.type}).`)
  }
  if (isBlank(text)) throw new Error('Invalid engram: confirming a review needs text — why it still holds.')
  db.transaction(() => {
    const props = existing.properties ? JSON.parse(existing.properties) : {}
    props.review_due_at = addDays(stamp.at, reviewDays)
    db.prepare(`UPDATE engrams SET properties = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(props), stamp.at, id)
    bumpRev(db, stamp, id)
    appendEntry(db, id, { kind: 'review', text: text! }, stamp)
  })()
  return ctx.store.getRaw(id, stamp.at)
}
