import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { SITUATION, runHook, type AgentOptions, type Answer, type Session, type Verdict } from './agent'
import { idsInOrder } from './retrieval'

// --- Runner: Messages API ---------------------------------------------------------------
//
// A plain tool loop: the SUT's hook output goes into the system prompt and the
// first user turn the way Claude Code injects it, the SUT's MCP tools are passed
// through as-is. No harness around the model — for comparing models, not for
// measuring EML in Claude Code. Needs ANTHROPIC_API_KEY (or another credential
// the SDK resolves).
//
// Refusal fallbacks are deliberately off: a fallback would silently measure a
// different model. A refusal is recorded as an error.

let client: Anthropic | undefined

export async function askApi(s: Session, opts: AgentOptions): Promise<Answer> {
  client ??= new Anthropic()
  const q = s.question
  const out: Answer = { answer: '', tool_calls: [], seen_ids: [], turns: 0, stop: '', usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
  const hookSession = { session_id: `bench-${q.id}`, cwd: path.join(s.dir, 'workspace') }
  const boot = runHook(s.sut, 'session-start', s.configPath, s.env, hookSession)
  const reminder = runHook(s.sut, 'user-prompt-submit', s.configPath, s.env, { ...hookSession, prompt: q.agent!.question })

  const mcp = new Client({ name: 'eml-bench', version: '0.0.0' })
  const seen = new Set<string>()
  try {
    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: [s.sut.mcpEntry, '--url', s.server.url, '--token', s.token, '--name', 'eml-bench'],
      env: s.env,
      stderr: 'ignore',
    }))
    const tools: Anthropic.Tool[] = (await mcp.listTools()).tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))
    const system = `${SITUATION}\n\n<session-start-hook>\n${boot}\n</session-start-hook>`
    const userText = reminder ? `<user-prompt-submit-hook>\n${reminder}\n</user-prompt-submit-hook>\n\n${q.agent!.question}` : q.agent!.question
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userText }]

    for (let turn = 0; turn < opts.maxTurns; turn++) {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 16000,
        output_config: { effort: opts.effort },
        cache_control: { type: 'ephemeral' },
        system,
        tools,
        messages,
      })
      out.turns = turn + 1
      out.stop = response.stop_reason ?? ''
      out.usage.input += response.usage.input_tokens
      out.usage.output += response.usage.output_tokens
      out.usage.cache_read += response.usage.cache_read_input_tokens ?? 0
      out.usage.cache_write += response.usage.cache_creation_input_tokens ?? 0
      messages.push({ role: 'assistant', content: response.content })

      if (response.stop_reason === 'refusal') { out.error = 'refusal'; break }
      if (response.stop_reason === 'pause_turn') continue
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      if (response.stop_reason !== 'tool_use' || calls.length === 0) {
        out.answer = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim()
        break
      }
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const call of calls) {
        out.tool_calls.push({ name: call.name, input: call.input })
        const res = await mcp.callTool({ name: call.name, arguments: call.input as Record<string, unknown> })
        const text = (res.content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text).join('\n')
        for (const id of idsInOrder(text)) seen.add(id)
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: text, is_error: res.isError === true })
      }
      messages.push({ role: 'user', content: toolResults })
    }
    if (!out.answer && !out.error) out.error = `no answer after ${opts.maxTurns} turns`
  } finally {
    await mcp.close().catch(() => {})
  }
  out.seen_ids = [...seen]
  return out
}

const VerdictZ = z.object({ correct: z.boolean(), stale: z.boolean(), reason: z.string() })

export async function judgeApi(opts: AgentOptions, prompt: string): Promise<Verdict> {
  client ??= new Anthropic()
  const response = await client.messages.parse({
    model: opts.judgeModel,
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(VerdictZ) },
    messages: [{ role: 'user', content: prompt }],
  })
  if (!response.parsed_output) throw new Error(`judge returned no verdict (stop: ${response.stop_reason})`)
  return response.parsed_output
}
