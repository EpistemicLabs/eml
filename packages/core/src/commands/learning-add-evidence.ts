import type { Engram } from '../types'
import type { LearningState } from '../learning'
import { inputObject, requireText, type CommandModule } from './types'

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
  apply(ctx, input, stamp) {
    const r = ctx.engrams.addEvidence(input, stamp)
    return { engram: r.engram, learning: r.learning }
  },
}
