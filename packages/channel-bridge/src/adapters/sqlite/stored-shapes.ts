import { z } from 'zod'
import type { Routing } from '../../domain/routing'
import type { WakeEntry } from '../../domain/wake'
import type { OutboxState } from '../../domain/outbox'

const routingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('job'), jobId: z.string(), reason: z.enum(['thread', 'address', 'domain']) }),
  z.object({ kind: z.literal('inbox'), reason: z.enum(['no_match', 'ambiguous', 'sender_unverified']) }),
  z.object({ kind: z.literal('ignored'), reason: z.literal('automated') }),
])

const wakeEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), messageId: z.string() }),
  z.object({ kind: z.literal('draft'), outboxId: z.string(), outcome: z.enum(['sent', 'skipped', 'failed']) }),
])

const outboxStateSchema = z.enum(['draft', 'sending', 'sent', 'skipped', 'failed'])

/** Stored JSON is read back through a schema: unknown fields are dropped, a broken row fails loudly. */
export function parseRouting(json: string): Routing {
  return routingSchema.parse(JSON.parse(json))
}

export function parseWakeEntry(json: string): WakeEntry {
  return wakeEntrySchema.parse(JSON.parse(json))
}

export function parseOutboxState(value: string): OutboxState {
  return outboxStateSchema.parse(value)
}

export function parseChannel(value: string): 'mail' {
  return z.literal('mail').parse(value)
}
