import { z } from 'zod'

/** The bridge API's answers to the job tools, checked where they enter the tools' process. */
const messageSchema = z.object({
  id: z.string(),
  from: z.string(),
  subject: z.string().nullable(),
  receivedAt: z.string(),
  text: z.string(),
})
const refusalSchema = z.object({ kind: z.enum(['refused', 'unavailable']), reason: z.string(), retryable: z.boolean() })
const readAnswerSchema = z.union([z.object({ kind: z.literal('messages'), messages: z.array(messageSchema) }), refusalSchema])
const replyAnswerSchema = z.union([
  z.object({ kind: z.enum(['drafted', 'sent']), outboxId: z.string() }),
  z.object({ kind: z.literal('failed'), outboxId: z.string(), reason: z.string(), retryable: z.boolean() }),
  refusalSchema,
])

export type BridgeMessage = z.infer<typeof messageSchema>
type Unreachable = { kind: 'unreachable' }
export type ReadAnswer = z.infer<typeof readAnswerSchema> | Unreachable
export type ReplyAnswer = z.infer<typeof replyAnswerSchema> | Unreachable

export interface BridgeApiClientOptions {
  url: string
  token: string
  jobId: string
}

/** One job's side of the bridge API. A bridge that is away or answers unreadably is unreachable. */
export class BridgeApiClient {
  private readonly base: string

  constructor(private readonly options: BridgeApiClientOptions) {
    this.base = `${options.url}/v1/jobs/${encodeURIComponent(options.jobId)}`
  }

  async read(ack: string[]): Promise<ReadAnswer> {
    return this.call('/messages/read', { ack }, readAnswerSchema)
  }

  async reply(messageId: string, text: string): Promise<ReplyAnswer> {
    return this.call(`/messages/${encodeURIComponent(messageId)}/reply`, { text }, replyAnswerSchema)
  }

  private async call<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T | Unreachable> {
    try {
      const response = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const parsed = schema.safeParse(await response.json())
      return parsed.success ? parsed.data : { kind: 'unreachable' }
    } catch {
      return { kind: 'unreachable' }
    }
  }
}
