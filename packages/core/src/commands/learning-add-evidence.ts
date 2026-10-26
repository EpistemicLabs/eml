import type { Engram } from '../types'
import { learningState, LEARNING_SHARPENED, type LearningState } from '../learning'
import { appendEntry, bumpRev } from '../entries'
import type { LearnInput } from '../engrams'
import { CommandError, inputObject, requireText, type CommandContext, type CommandModule } from './types'
import { evidenceOf } from './learning'

/** learning.add_evidence — an incident for an existing learning (and optionally a sharper lesson). */
export interface LearningAddEvidenceInput {
  id: string
  source: string
  happened: string
  quote?: string
  stance?: string
  rule_id?: string
  content?: string
}

/** learning.add_evidence — journal-style, like task.track. Was the evidence half of EngramStore.learn. */
export const learningAddEvidence: CommandModule<LearningAddEvidenceInput, { engram: Engram, learning: LearningState }> = {
  name: 'learning.add_evidence',
  validate(input) {
    const o = inputObject('learning.add_evidence', input)
    requireText(o, 'id', 'Invalid engram: id is required (the learning).')
    return o as unknown as LearningAddEvidenceInput
  },
  apply(ctx, input) {
    if (!ctx.eml.engrams.exists(input.id)) throw new CommandError('NOT_FOUND', 'learning not found')
    return addEvidence(ctx, input)
  },
}

/** v0.20: learning.add_evidence — an incident added to an existing learning (journal-style, like task.track). */
function addEvidence(ctx: CommandContext, input: LearnInput & { id: string }): { engram: Engram, learning: LearningState } {
  const { db, stamp } = ctx
  const evidence = evidenceOf(ctx, input)
  const existing = db.prepare('SELECT * FROM engrams WHERE id = ?').get(input.id) as any
  if (existing.type !== 'learning') throw new Error(`Invalid engram: ${input.id} is a ${existing.type}, not a learning.`)
  if (existing.status !== 'active') throw new Error(`Invalid engram: learning ${input.id} is ${existing.status} — evidence goes to an active learning.`)
  const extra = ['scope', 'title', 'new_topic', 'tags', 'subjects'].filter(k => (input as unknown as Record<string, unknown>)[k] !== undefined)
  if (extra.length > 0) throw new Error(`Invalid engram: ${extra.join(', ')} only on create — adding evidence takes source, happened, quote, stance, rule_id (and content to sharpen the lesson).`)
  appendEntry(db, input.id!, evidence, stamp)
  if (input.content !== undefined && input.content !== existing.content) {
    db.prepare(`UPDATE engrams SET content = ?, updated_at = ? WHERE id = ?`).run(input.content, stamp.at, input.id)
    bumpRev(db, stamp, input.id!)
    db.prepare('DELETE FROM engrams_fts WHERE id = ?').run(input.id)
    db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(input.id)
    appendEntry(db, input.id!, { kind: 'change', text: LEARNING_SHARPENED }, stamp)
  } else {
    db.prepare(`UPDATE engrams SET updated_at = ? WHERE id = ?`).run(stamp.at, input.id)
    bumpRev(db, stamp, input.id!)
  }
  const engram = ctx.store.getRaw(input.id, stamp.at)!
  return { engram, learning: learningState(ctx.store.entries(input.id)) }
}
