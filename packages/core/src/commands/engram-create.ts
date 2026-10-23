import type { EngramInput, StoredEngram } from '../types'
import type { LearningState } from '../learning'
import { CommandError, inputObject, type CommandModule } from './types'

/** engram.create for a learning: the lesson and its first evidence (the topic check runs first). */
export interface LearningCreateInput {
  type: 'learning'
  scope: string
  title: string
  content: string
  tags?: string[]
  subjects?: string[]
  new_topic?: boolean
  evidence: { source: string, happened: string, quote?: string, stance?: string, rule_id?: string }
}

export type EngramCreateInput = EngramInput | LearningCreateInput
export type EngramCreateResult = StoredEngram & { learning?: LearningState }

/** engram.create — a new engram of any type. Was EngramStore.store and the create half of learn. */
export const engramCreate: CommandModule<EngramCreateInput, EngramCreateResult> = {
  name: 'engram.create',
  validate(input) {
    const o = inputObject('engram.create', input)
    if (typeof o.type !== 'string') throw new CommandError('INVALID', 'Invalid engram: type is required.')
    if (o.type === 'learning') {
      const e = o.evidence
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        throw new CommandError('INVALID', 'Invalid engram: a learning is written with eml_learning, which checks the topic first.')
      }
    }
    return o as unknown as EngramCreateInput
  },
  apply(ctx, input, stamp) {
    if (input.type !== 'learning') return ctx.engrams.store(input as EngramInput, stamp)
    const { type: _type, evidence, ...lesson } = input as LearningCreateInput
    const r = ctx.engrams.createLearning({ ...lesson, ...evidence }, stamp)
    if (!r.written) {
      throw new CommandError('TOPIC_EXISTS',
        'Invalid engram: an active learning on this topic exists — add the incident to it (learning.add_evidence with its id), or pass new_topic for a different topic.',
        { matches: r.matches })
    }
    return { ...r.engram, learning: r.learning } as EngramCreateResult
  },
}
