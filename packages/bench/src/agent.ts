import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { startServer, type Sut } from './sut'
import type { Brain } from './fixture'
import type { Question } from './retrieval'
import { idsInOrder } from './retrieval'

// --- Stage 2: agent ------------------------------------------------------------------
//
// A Claude model answers each question the way it would in a Claude Code session
// with EML: the SUT's own session-start hook output (the boot) and prompt reminder
// as context, and the SUT's real MCP server as its tools. Everything the agent
// reads — boot, reminder, tool descriptions, tool output — is therefore the
// version under test. Each question runs on its own copy of the brain, so a
// write by one answer cannot leak into the next.
//
// Grading: deterministic first (did the tool output contain the expected
// engrams?), then a judge model compares the answer with the reference answer
// and the outdated claims listed for the question.

export interface AgentOptions {
  model: string
  judgeModel: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTurns: number
  concurrency: number
}

export interface AgentResult {
  id: string
  category: string
  answer: string
  correct: boolean
  stale: boolean
  judge_reason: string
  /** expected engrams that appeared in tool output / all expected */
  evidence_found: number
  evidence_expected: number
  tool_calls: { name: string; input: unknown }[]
  turns: number
  stop: string
  usage: { input: number; output: number; cache_read: number; cache_write: number }
  error?: string
}

// The harness part of the system prompt: the agent's situation, not EML guidance —
// what the agent knows about EML comes from the SUT (hooks, tool descriptions).
const HARNESS_SYSTEM = `You are an AI assistant working for Alex, who runs a small online ceramics shop alone. You work in a session like a coding agent: the context below was injected by the session-start hook of your memory system. Your only tools are the memory tools. You cannot deploy, send email or change anything outside the memory; if Alex asks for such an action, say what you would do and whether you would do it now. Answer in plain text, briefly.`

export async function runAgent(sut: Sut, brain: Brain, questions: Question[], workDir: string, opts: AgentOptions): Promise<AgentResult[]> {
  const client = new Anthropic()
  const qs = questions.filter(q => q.agent)
  const results: AgentResult[] = new Array(qs.length)
  let next = 0
  const worker = async () => {
    while (next < qs.length) {
      const i = next++
      results[i] = await runQuestion(client, sut, brain, qs[i], path.join(workDir, 'agent', qs[i].id), opts)
      const r = results[i]
      console.log(`  ${r.error ? '!' : r.correct ? '✓' : '✗'}${r.stale ? ' stale' : ''} ${r.id} (${r.tool_calls.length} tool calls${r.error ? `, ${r.error}` : ''})`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, qs.length) }, worker))
  return results
}

async function runQuestion(client: Anthropic, sut: Sut, brain: Brain, q: Question, dir: string, opts: AgentOptions): Promise<AgentResult> {
  const result: AgentResult = {
    id: q.id, category: q.category, answer: '', correct: false, stale: false, judge_reason: '',
    evidence_found: 0, evidence_expected: q.expect.length, tool_calls: [], turns: 0, stop: '',
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  }
  // A fresh copy of the (already migrated) brain for this question.
  const dataDir = path.join(dir, 'data')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(brain.dataDir, dataDir, { recursive: true, filter: src => !/\.log$/.test(src) })
  const server = await startServer(sut, dataDir, path.join(dir, 'server.log'))
  const configPath = path.join(dir, 'eml-config')
  fs.writeFileSync(configPath, `EML_URL=${server.url}\nEML_API_TOKEN=${brain.token}\n`, { mode: 0o600 })
  // The hooks keep per-session state under HOME; give each question its own.
  const env = { PATH: process.env.PATH ?? '', HOME: dir }
  const mcp = new Client({ name: 'eml-bench', version: '0.0.0' })
  const transcript: unknown[] = []
  try {
    const session = { session_id: `bench-${q.id}`, cwd: dir }
    const boot = hook(sut, 'session-start', configPath, env, session)
    const reminder = hook(sut, 'user-prompt-submit', configPath, env, { ...session, prompt: q.agent!.question })

    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: [sut.mcpEntry, '--url', server.url, '--token', brain.token, '--name', 'eml-bench'],
      env,
      stderr: 'ignore',
    }))
    const tools: Anthropic.Tool[] = (await mcp.listTools()).tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))

    const system = `${HARNESS_SYSTEM}\n\n<session-start-hook>\n${boot}\n</session-start-hook>`
    const userText = reminder ? `<user-prompt-submit-hook>\n${reminder}\n</user-prompt-submit-hook>\n\n${q.agent!.question}` : q.agent!.question
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userText }]
    const seenIds = new Set<string>()

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
      result.turns = turn + 1
      result.stop = response.stop_reason ?? ''
      addUsage(result, response.usage)
      messages.push({ role: 'assistant', content: response.content })
      transcript.push({ role: 'assistant', content: response.content })

      if (response.stop_reason === 'refusal') { result.error = 'refusal'; break }
      if (response.stop_reason === 'pause_turn') continue
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      if (response.stop_reason !== 'tool_use' || calls.length === 0) {
        result.answer = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim()
        break
      }
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const call of calls) {
        result.tool_calls.push({ name: call.name, input: call.input })
        const out = await mcp.callTool({ name: call.name, arguments: call.input as Record<string, unknown> })
        const text = (out.content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text).join('\n')
        for (const id of idsInOrder(text)) seenIds.add(id)
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: text, is_error: out.isError === true })
      }
      messages.push({ role: 'user', content: toolResults })
      transcript.push({ role: 'user', content: toolResults })
    }
    if (!result.answer && !result.error) result.error = `no answer after ${opts.maxTurns} turns`
    result.evidence_found = q.expect.filter(k => seenIds.has(brain.ids[k])).length

    if (result.answer) {
      const verdict = await judge(client, opts.judgeModel, q, result.answer)
      result.correct = verdict.correct
      result.stale = verdict.stale
      result.judge_reason = verdict.reason
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  } finally {
    await mcp.close().catch(() => {})
    await server.stop()
    fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({ question: q, result, transcript }, null, 2))
  }
  return result
}

export interface Surface {
  /** what the session-start hook injects (the boot), in characters */
  boot_chars: number
  /** what the prompt reminder injects on the first prompt */
  reminder_chars: number
  tools: number
  /** the tool list as the model receives it (names, descriptions, schemas) */
  tools_json_chars: number
}

/**
 * What an agent reads before it does anything: hook output and the tool list,
 * from the SUT's own MCP server and hooks. No model call.
 */
export async function measureSurface(sut: Sut, brain: Brain, workDir: string): Promise<Surface> {
  const dir = path.join(workDir, 'surface')
  const dataDir = path.join(dir, 'data')
  fs.cpSync(brain.dataDir, dataDir, { recursive: true, filter: src => !/\.log$/.test(src) })
  const server = await startServer(sut, dataDir, path.join(dir, 'server.log'))
  const configPath = path.join(dir, 'eml-config')
  fs.writeFileSync(configPath, `EML_URL=${server.url}\nEML_API_TOKEN=${brain.token}\n`, { mode: 0o600 })
  const env = { PATH: process.env.PATH ?? '', HOME: dir }
  const mcp = new Client({ name: 'eml-bench', version: '0.0.0' })
  try {
    const session = { session_id: 'bench-surface', cwd: dir }
    const boot = hook(sut, 'session-start', configPath, env, session)
    const reminder = hook(sut, 'user-prompt-submit', configPath, env, { ...session, prompt: 'hello' })
    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: [sut.mcpEntry, '--url', server.url, '--token', brain.token, '--name', 'eml-bench'],
      env,
      stderr: 'ignore',
    }))
    const tools = (await mcp.listTools()).tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }))
    fs.writeFileSync(path.join(dir, 'boot.md'), boot)
    fs.writeFileSync(path.join(dir, 'reminder.md'), reminder)
    fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(tools, null, 2))
    return { boot_chars: boot.length, reminder_chars: reminder.length, tools: tools.length, tools_json_chars: JSON.stringify(tools).length }
  } finally {
    await mcp.close().catch(() => {})
    await server.stop()
  }
}

/** Runs one of the SUT's Claude Code hooks and returns what it would inject. */
function hook(sut: Sut, name: string, configPath: string, env: Record<string, string>, input: unknown): string {
  const r = spawnSync(process.execPath, [sut.mcpEntry, 'hook', name, '--config', configPath], {
    input: JSON.stringify(input), env, encoding: 'utf8', timeout: 30_000,
  })
  return (r.stdout ?? '').trim()
}

function addUsage(r: AgentResult, u: Anthropic.Usage): void {
  r.usage.input += u.input_tokens
  r.usage.output += u.output_tokens
  r.usage.cache_read += u.cache_read_input_tokens ?? 0
  r.usage.cache_write += u.cache_creation_input_tokens ?? 0
}

const Verdict = z.object({
  correct: z.boolean(),
  stale: z.boolean(),
  reason: z.string(),
})

async function judge(client: Anthropic, model: string, q: Question, answer: string): Promise<z.infer<typeof Verdict>> {
  const a = q.agent!
  const prompt = `Grade an assistant's answer against a reference answer.

Question: ${a.question}
Reference answer: ${a.reference}
Outdated claims (true once, no longer true): ${a.stale_claims.length ? a.stale_claims.map(s => `"${s}"`).join('; ') : 'none'}

Assistant's answer:
<answer>
${answer}
</answer>

correct: the answer states the facts of the reference answer (wording may differ; extra correct detail is fine; a missing key fact or a wrong fact makes it incorrect). For a request to act, the answer must do what the reference says (e.g. hold off and say why).
stale: the answer asserts one of the outdated claims as currently true.
reason: one sentence.`
  const response = await client.messages.parse({
    model,
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(Verdict) },
    messages: [{ role: 'user', content: prompt }],
  })
  if (!response.parsed_output) throw new Error(`judge returned no verdict (stop: ${response.stop_reason})`)
  return response.parsed_output
}

export interface AgentSummary {
  model: string
  judge_model: string
  effort: string
  questions: number
  accuracy: number
  stale_rate: number
  evidence_rate: number
  errors: number
  avg_tool_calls: number
  avg_turns: number
  tokens: { input: number; output: number; cache_read: number; cache_write: number }
  by_category: Record<string, { questions: number; accuracy: number }>
}

export function summarizeAgent(results: AgentResult[], opts: AgentOptions): AgentSummary {
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : 0)
  const withEvidence = results.filter(r => r.evidence_expected > 0)
  const by_category: AgentSummary['by_category'] = {}
  for (const cat of [...new Set(results.map(r => r.category))].sort()) {
    const rs = results.filter(r => r.category === cat)
    by_category[cat] = { questions: rs.length, accuracy: mean(rs.map(r => (r.correct ? 1 : 0))) }
  }
  const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  for (const r of results) for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[k] += r.usage[k]
  return {
    model: opts.model,
    judge_model: opts.judgeModel,
    effort: opts.effort,
    questions: results.length,
    accuracy: mean(results.map(r => (r.correct ? 1 : 0))),
    stale_rate: mean(results.map(r => (r.stale ? 1 : 0))),
    evidence_rate: mean(withEvidence.map(r => r.evidence_found / r.evidence_expected)),
    errors: results.filter(r => r.error).length,
    avg_tool_calls: mean(results.map(r => r.tool_calls.length)),
    avg_turns: mean(results.map(r => r.turns)),
    tokens,
    by_category,
  }
}
