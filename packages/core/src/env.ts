import { randomUUID } from 'crypto'
import type { IngestionMethod } from './types'

// --- Env (v0.20) ---------------------------------------------------------------
//
// Everything a brain write takes from outside the DB: the clock, the id source
// and who writes. A write is a function of (DB state, input, env) — core write
// code reads no clock and draws no id on its own. EML builds the env from one
// clock (EMLConfig.clock), which reads use too.

/** Who writes: stamped on every engram and entry (attribution only). */
export interface Actor {
  handle: string | null            // the token's handle → ingested_by, entry author
  ingestion_method: IngestionMethod | null
  session_id: string | null
  model: string | null
  harness: string | null
}

export interface Env {
  /** The current time, ISO-8601 UTC with milliseconds. */
  now(): string
  /** A new id (UUID v4 by default). */
  newId(): string
  actor: Actor
}

export type Clock = () => string
export type IdSource = () => string

/** The system clock — the default of EMLConfig.clock. */
export const systemClock: Clock = () => new Date().toISOString()
/** Random UUID v4 — the default of EMLConfig.newId. */
export const randomId: IdSource = () => randomUUID()

export const NO_ACTOR: Actor = { handle: null, ingestion_method: null, session_id: null, model: null, harness: null }

/**
 * One write's stamp: the time, taken once at the start of the write and used
 * for every row it touches (engram, entries, relations, memberships, side
 * effects), the id source and the actor.
 */
export interface Stamp {
  at: string
  newId(): string
  actor: Actor
}

export function beginWrite(env: Env): Stamp {
  return { at: env.now(), newId: () => env.newId(), actor: env.actor }
}

/** `iso` plus whole days, as ISO-8601 UTC with milliseconds. */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86400_000).toISOString()
}

/** The default env of a store built without one: system clock, random ids, no actor. */
export const DEFAULT_ENV: Env = { now: systemClock, newId: randomId, actor: NO_ACTOR }

/** `env` with its clock read once: a write made of several store calls keeps one timestamp. */
export function pinClock(env: Env): Env {
  const at = env.now()
  return { ...env, now: () => at }
}
