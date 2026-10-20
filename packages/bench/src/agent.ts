import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startServer, type Sut, type RunningServer } from './sut'
import type { Brain } from './fixture'
import type { Question } from './retrieval'
import { askClaudeCode, judgeClaudeCode } from './runner-claude-code'
import { askApi, judgeApi } from './runner-api'

// --- Stage 2: agent ------------------------------------------------------------------
//
// A Claude model answers each question the way it would in a session with EML:
// the SUT's own session-start hook (the boot) and prompt reminder as context, and
// the SUT's real MCP server as its tools. Everything the agent reads — boot,
// reminder, tool descriptions, tool output — is the version under test. Each
// question runs on its own copy of the brain, so a write by one answer cannot
// leak into the next.
//
// Two runners:
//   claude-code (default) — headless Claude Code (`claude -p`) in an isolated
//     config dir, with the SUT's MCP server and hooks configured: EML in the
//     harness it ships for. Signs in with a Claude Code token.
//   api — a plain tool loop over the Anthropic Messages API (ANTHROPIC_API_KEY):
//     no harness around the model, any Claude model.
//
// Grading: deterministic first (did the tool output contain the expected
// engrams?), then a judge model compares the answer with the reference answer
// and the outdated claims listed for the question.

export type Runner = 'claude-code' | 'api'

export interface AgentOptions {
  runner: Runner
  model: string
  judgeModel: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTurns: number
  concurrency: number
  /** claude-code runner: the token Claude Code signs in with (CLAUDE_CODE_OAUTH_TOKEN) */
  claudeToken?: string
}

/** What one question's session produced, before grading. */
export interface Answer {
  answer: string
  tool_calls: { name: string; input: unknown }[]
  /** engram ids that appeared in tool output */
  seen_ids: string[]
  turns: number
  stop: string
  usage: { input: number; output: number; cache_read: number; cache_write: number }
  cost_usd?: number
  /** the harness version (Claude Code), when the runner has one */
  harness?: string
  error?: string
}

/** Everything a runner needs to run one question against the SUT. */
export interface Session {
  sut: Sut
  question: Question
  dir: string
  server: RunningServer
  token: string
  /** the eml config file the SUT's hooks read (EML_URL / EML_API_TOKEN) */
  configPath: string
  /** env for everything spawned for this question: isolated HOME */
  env: Record<string, string>
}

export interface Verdict {
  correct: boolean
  stale: boolean
  reason: string
}

export interface AgentResult extends Answer {
  id: string
  category: string
  correct: boolean
  stale: boolean
  judge_reason: string
  /** expected engrams that appeared in tool output / all expected */
  evidence_found: number
  evidence_expected: number
}

// The situation the agent is in — not EML guidance: what the agent knows about
// EML comes from the SUT (hooks, tool descriptions).
export const SITUATION = `You are an AI assistant working for Alex, who runs a small online ceramics shop alone. Your only tools are the memory tools of Alex's brain. You cannot deploy, send email or change anything outside the memory; if Alex asks for such an action, say what you would do and whether you would do it now. Answer in plain text, briefly.`

export async function runAgent(sut: Sut, brain: Brain, questions: Question[], workDir: string, opts: AgentOptions): Promise<AgentResult[]> {
  const qs = questions.filter(q => q.agent)
  const results: AgentResult[] = new Array(qs.length)
  let next = 0
  const worker = async () => {
    while (next < qs.length) {
      const i = next++
      results[i] = await runQuestion(sut, brain, qs[i], path.join(workDir, 'agent', qs[i].id), opts)
      const r = results[i]
      console.log(`  ${r.error ? '!' : r.correct ? '✓' : '✗'}${r.stale ? ' stale' : ''} ${r.id} (${r.tool_calls.length} tool calls${r.error ? `, ${r.error}` : ''})`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, qs.length) }, worker))
  return results
}

async function runQuestion(sut: Sut, brain: Brain, q: Question, dir: string, opts: AgentOptions): Promise<AgentResult> {
  const result: AgentResult = {
    id: q.id, category: q.category, answer: '', tool_calls: [], seen_ids: [], turns: 0, stop: '',
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    correct: false, stale: false, judge_reason: '', evidence_found: 0, evidence_expected: q.expect.length,
  }
  fs.rmSync(dir, { recursive: true, force: true })
  const dataDir = path.join(dir, 'data')
  fs.cpSync(brain.dataDir, dataDir, { recursive: true, filter: src => !/\.log$/.test(src) })
  const server = await startServer(sut, dataDir, path.join(dir, 'server.log'))
  try {
    const configPath = path.join(dir, 'eml-config')
    fs.writeFileSync(configPath, `EML_URL=${server.url}\nEML_API_TOKEN=${brain.token}\n`, { mode: 0o600 })
    const session: Session = { sut, question: q, dir, server, token: brain.token, configPath, env: { PATH: process.env.PATH ?? '', HOME: dir } }
    const answer = opts.runner === 'claude-code' ? await askClaudeCode(session, opts) : await askApi(session, opts)
    Object.assign(result, answer)
    const seen = new Set(answer.seen_ids)
    result.evidence_found = q.expect.filter(k => seen.has(brain.ids[k])).length
    if (result.answer && !result.error) {
      const verdict = opts.runner === 'claude-code'
        ? await judgeClaudeCode(session, opts, judgePrompt(q, result.answer))
        : await judgeApi(opts, judgePrompt(q, result.answer))
      result.correct = verdict.correct
      result.stale = verdict.stale
      result.judge_reason = verdict.reason
    } else if (!result.error) {
      result.error = 'no answer'
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  } finally {
    await server.stop()
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ question: q, result }, null, 2))
  }
  return result
}

export function judgePrompt(q: Question, answer: string): string {
  const a = q.agent!
  return `Grade an assistant's answer against a reference answer. Reply only with the verdict.

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
}

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: { correct: { type: 'boolean' }, stale: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['correct', 'stale', 'reason'],
  additionalProperties: false,
} as const

// --- Agent surface ---------------------------------------------------------------

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
    const boot = runHook(sut, 'session-start', configPath, env, session)
    const reminder = runHook(sut, 'user-prompt-submit', configPath, env, { ...session, prompt: 'hello' })
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
export function runHook(sut: Sut, name: string, configPath: string, env: Record<string, string>, input: unknown): string {
  const r = spawnSync(process.execPath, [sut.mcpEntry, 'hook', name, '--config', configPath], {
    input: JSON.stringify(input), env, encoding: 'utf8', timeout: 30_000,
  })
  return (r.stdout ?? '').trim()
}

// --- Summary -----------------------------------------------------------------------

export interface AgentSummary {
  runner: Runner
  harness: string | null
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
  cost_usd: number | null
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
  const costs = results.map(r => r.cost_usd).filter((c): c is number => typeof c === 'number')
  return {
    runner: opts.runner,
    harness: results.find(r => r.harness)?.harness ?? null,
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
    cost_usd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    by_category,
  }
}
