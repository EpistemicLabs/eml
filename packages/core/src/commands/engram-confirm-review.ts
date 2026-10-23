import type { Engram } from '../types'
import { CommandError, inputObject, requireText, type CommandModule } from './types'

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
  apply(ctx, input, stamp) {
    const r = ctx.engrams.confirmReview(input.id, input.text, stamp)
    if (!r) throw new CommandError('NOT_FOUND', 'engram not found')
    return r
  },
}
