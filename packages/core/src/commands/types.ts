import type { EML } from '../index'
import type { EngramWriter } from '../engram-writer'
import type { ObjectWriter } from '../object-writer'
import type { Stamp } from '../env'

// --- Commands (v0.20) ------------------------------------------------------------
//
// Every brain write is one of eight commands behind EML.apply(command, env)
// (decision write-command-set). A command module validates its input and
// applies it inside the one transaction apply() opens, with the write's one
// Stamp. The command names are the future op types; a payload carries only
// what the caller intends — never what the env provides (time, actor, ids the
// brain draws).

export type CommandErrorCode = 'INVALID' | 'NOT_FOUND' | 'TOPIC_EXISTS'

/** A rejected command. Nothing was written. */
export class CommandError extends Error {
  constructor(readonly code: CommandErrorCode, message: string, readonly data?: Record<string, unknown>) {
    super(message)
    this.name = 'CommandError'
  }
}

/** What a command's apply works with: the reads (EML) and the internal writers. */
export interface CommandContext {
  eml: EML
  engrams: EngramWriter
  objects: ObjectWriter
}

export interface CommandModule<I, R> {
  name: string
  /** Checks the input's shape; returns it typed. Rules that need the brain run in apply. */
  validate(input: unknown): I
  apply(ctx: CommandContext, input: I, stamp: Stamp): R
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

/** The input as a plain object, or INVALID. */
export function inputObject(command: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CommandError('INVALID', `Invalid command: ${command} takes an object.`)
  }
  return input as Record<string, unknown>
}

/** A required text field of the input, or INVALID with `message`. */
export function requireText(input: Record<string, unknown>, field: string, message: string): string {
  const v = input[field]
  if (typeof v !== 'string' || v.trim() === '') throw new CommandError('INVALID', message)
  return v
}
