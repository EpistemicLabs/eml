import type { EML } from '../index'
import type { WriteContext } from '../write/context'

// --- Commands (v0.20) ------------------------------------------------------------
//
// Every brain write is one of the commands behind EML.apply(command, env)
// (decision write-command-set; v0.21 adds the cross-brain move's). A command
// module validates its input and applies it inside the one transaction apply()
// opens, with the write's one Stamp. The command names are the future op types; a payload carries only
// what the caller intends — never what the env provides (time, actor, ids the
// brain draws).

export type CommandErrorCode = 'INVALID' | 'NOT_FOUND' | 'TOPIC_EXISTS' | 'CONFLICT'

/** A rejected command. Nothing was written. */
export class CommandError extends Error {
  constructor(readonly code: CommandErrorCode, message: string, readonly data?: Record<string, unknown>) {
    super(message)
    this.name = 'CommandError'
  }
}

/**
 * What a command's apply works with: the reads (EML) and the write context of
 * the helpers in write/ — the connection, the stores and the write's one Stamp.
 */
export interface CommandContext extends WriteContext {
  eml: EML
}

export interface CommandModule<I, R> {
  name: string
  /** Checks the input's shape; returns it typed. Rules that need the brain run in apply. */
  validate(input: unknown): I
  apply(ctx: CommandContext, input: I): R
}

/**
 * The messages core's write rules reject with — a rejection by the caller's
 * input, not a fault of the brain. apply() turns them into CommandError INVALID;
 * the server answers them with 400 on a read too (was a prefix list in server.ts).
 */
export function isValidationMessage(msg: string): boolean {
  return msg.startsWith('Invalid engram:')
    || msg.startsWith('Invalid object:')
    || msg.startsWith('Invalid command:')
    || msg.startsWith('Invalid scope')
    || msg.startsWith('Scope ')
    || msg.startsWith('Missing required properties')
    || msg.startsWith('Invalid source_type')
    || msg.startsWith('tag "')              // an unknown tag on a write
    || msg.startsWith('invalid tag name')   // an unslugifiable tag name
    || msg.startsWith('subject "')          // an unknown subject on a write
    || msg.startsWith('invalid subject')    // an unslugifiable name / bad status
    || msg.startsWith('subject name must')  // an empty rename
}

/** A rejection by the caller's input as CommandError INVALID; a CommandError or a fault as it is. */
export function asCommandError(err: unknown): unknown {
  if (err instanceof CommandError) return err
  const msg = String((err as Error)?.message ?? '')
  return isValidationMessage(msg) ? new CommandError('INVALID', msg) : err
}

/** The input as a plain object, or INVALID. */
export function inputObject(command: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CommandError('INVALID', `Invalid command: ${command} takes an object.`)
  }
  return input as Record<string, unknown>
}

/** base_rev, when given, is a non-negative integer. */
export function checkBaseRev(input: Record<string, unknown>): void {
  const v = input.base_rev
  if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 0)) {
    throw new CommandError('INVALID', 'Invalid engram: base_rev must be the rev the engram had when it was read (an integer).')
  }
}

/**
 * v0.20: the base_rev precondition (decision engram-revision-counter) — the
 * writer read the engram at base_rev; if it moved on since, nothing is written.
 * An unknown id is left to the command (NOT_FOUND).
 */
export function assertBaseRev(ctx: CommandContext, id: string, baseRev: number | undefined): void {
  if (baseRev === undefined) return
  const current = ctx.eml.engrams.revOf(id)
  if (current !== undefined && current !== baseRev) {
    throw new CommandError('CONFLICT', `engram ${id} changed since rev ${baseRev}: it is at rev ${current}.`, { current_rev: current })
  }
}

/** A required text field of the input, or INVALID with `message`. */
export function requireText(input: Record<string, unknown>, field: string, message: string): string {
  const v = input[field]
  if (typeof v !== 'string' || v.trim() === '') throw new CommandError('INVALID', message)
  return v
}
