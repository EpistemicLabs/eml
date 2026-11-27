import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as readline from 'node:readline'
import type { QwenProcess, QwenSpawn, SpawnQwen } from '../../src/infrastructure/providers/qwen/chat-runtime.js'

/**
 * A Qwen Code CLI that is none, speaking its stream-json protocol over a process's stdio
 * (as recorded from Qwen Code 0.28.4 with @qwen-code/sdk 0.1.35): it answers the SDK's
 * control requests, takes user messages and answers, and asks for a permission or sends
 * messages when a test says so.
 */
export class FakeQwenCli extends EventEmitter implements QwenProcess {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /** The user messages' text, in order. */
  readonly texts: string[] = []
  /** The answers to its control requests (can_use_tool), by request id. */
  readonly answers = new Map<string, unknown>()
  /** The control requests the SDK sent, by subtype. */
  readonly controls: string[] = []
  private asked = 0
  private closed = false

  constructor(readonly spawned: QwenSpawn) {
    super()
    const lines = readline.createInterface({ input: this.stdin })
    lines.on('line', (line) => this.take(line))
    this.stdin.on('finish', () => this.exit(0))
  }

  private take(line: string): void {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    if (message.type === 'control_request') {
      const request = message.request as { subtype: string }
      this.controls.push(request.subtype)
      const answer = request.subtype === 'get_available_models' ? { models: [] }
        : request.subtype === 'get_context_usage' ? { totalTokens: 0, contextWindowSize: 200_000 }
          : request.subtype === 'mcp_server_status' ? { status: { eml_brain: 'connected' } }
            : {}
      this.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: answer } })
    } else if (message.type === 'control_response') {
      const response = message.response as { request_id: string; response?: unknown }
      this.answers.set(response.request_id, response.response)
    } else if (message.type === 'user') {
      const content = (message.message as { content: unknown }).content
      this.texts.push(typeof content === 'string' ? content : (content as Array<{ text?: string }>).map((part) => part.text ?? '').join(''))
    }
  }

  /** One protocol message to the SDK. */
  send(message: unknown): void {
    if (!this.closed) this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  /** Asks for a permission to run a command; resolves to the request id. */
  ask(toolName = 'run_shell_command', input: Record<string, unknown> = { command: 'touch x' }): string {
    const requestId = `cli-${++this.asked}`
    this.send({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName, tool_use_id: `call_${this.asked}`, input, permission_suggestions: null, blocked_path: null } })
    return requestId
  }

  /** The process ends on its own (or was asked to). */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.emit('close', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    queueMicrotask(() => this.exit(null, signal))
    return true
  }
}

export function fakeQwenSpawn(): { spawn: SpawnQwen; clis: FakeQwenCli[] } {
  const clis: FakeQwenCli[] = []
  return {
    clis,
    spawn: (options) => {
      const cli = new FakeQwenCli(options)
      clis.push(cli)
      return cli
    },
  }
}
