import type { StoredEngram, Engram, RelationInput } from '../types'
import type { LearningState } from '../learning'
import { beginWrite, type Env } from '../env'
import { CommandError, asCommandError, type CommandContext, type CommandModule } from './types'
import { engramCreate, type EngramCreateInput, type EngramCreateResult } from './engram-create'
import { engramUpdate, type EngramUpdateInput } from './engram-update'
import { taskTrack, type TaskTrackInput } from './task-track'
import { learningAddEvidence, type LearningAddEvidenceInput } from './learning-add-evidence'
import { engramConfirmReview, type EngramConfirmReviewInput } from './engram-confirm-review'
import { relationCreate } from './relation-create'
import { objectCreate, type ObjectCreateInput } from './object-create'
import { objectUpdate, type ObjectUpdateInput } from './object-update'
import { engramImport, type EngramImportInput, type EngramImportResult } from './engram-import'
import { engramMoveOut, type EngramMoveOutInput, type EngramMoveOutResult } from './engram-move-out'

/** The closed command set: name → [input, result]. */
export interface CommandMap {
  'engram.create': [EngramCreateInput, EngramCreateResult]
  'engram.update': [EngramUpdateInput, StoredEngram]
  'task.track': [TaskTrackInput, StoredEngram]
  'learning.add_evidence': [LearningAddEvidenceInput, { engram: Engram, learning: LearningState }]
  'engram.confirm_review': [EngramConfirmReviewInput, Engram]
  'relation.create': [RelationInput, { created: boolean }]
  'object.create': [ObjectCreateInput, { object: unknown, created: boolean }]
  'object.update': [ObjectUpdateInput, { object: unknown, diff: Record<string, [unknown, unknown]> }]
  'engram.import': [EngramImportInput, EngramImportResult]
  'engram.move_out': [EngramMoveOutInput, EngramMoveOutResult]
}
export type CommandName = keyof CommandMap
export type Command = { [N in CommandName]: { name: N, input: CommandMap[N][0] } }[CommandName]

const COMMANDS: { [N in CommandName]: CommandModule<CommandMap[N][0], CommandMap[N][1]> } = {
  'engram.create': engramCreate,
  'engram.update': engramUpdate,
  'task.track': taskTrack,
  'learning.add_evidence': learningAddEvidence,
  'engram.confirm_review': engramConfirmReview,
  'relation.create': relationCreate,
  'object.create': objectCreate,
  'object.update': objectUpdate,
  'engram.import': engramImport,
  'engram.move_out': engramMoveOut,
}

export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[]

/**
 * Run one command inside the caller's transaction: validate its input and
 * apply it with one Stamp (one time) from `env`. A rejection is a
 * CommandError. v0.21: the caller is the op log (log/apply-op.ts), whose
 * write owns the one transaction — a rejection rolls it back, so the brain
 * and its log stay as they were.
 */
export function runCommand<N extends CommandName>(stores: Omit<CommandContext, 'stamp'>, command: { name: N, input: CommandMap[N][0] }, env: Env): CommandMap[N][1] {
  const mod = COMMANDS[command?.name] as CommandModule<CommandMap[N][0], CommandMap[N][1]> | undefined
  if (!mod) throw new CommandError('INVALID', `Invalid command: unknown command "${String(command?.name)}". One of ${COMMAND_NAMES.join(', ')}.`)
  try {
    const input = mod.validate(command.input)
    return mod.apply({ ...stores, stamp: beginWrite(env) }, input)
  } catch (err) {
    throw asCommandError(err)
  }
}

export { CommandError, asCommandError, isValidationMessage, type CommandErrorCode, type CommandContext } from './types'
export type { EngramCreateInput, EngramCreateResult, LearningCreateInput } from './engram-create'
export type { EngramUpdateInput } from './engram-update'
export type { TaskTrackInput } from './task-track'
export type { LearningAddEvidenceInput } from './learning-add-evidence'
export type { EngramConfirmReviewInput } from './engram-confirm-review'
export type { ObjectCreateInput } from './object-create'
export type { ObjectUpdateInput } from './object-update'
export type { EngramImportInput, EngramImportResult } from './engram-import'
export type { EngramMoveOutInput, EngramMoveOutResult } from './engram-move-out'
