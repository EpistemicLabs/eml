import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startServer, type Sut } from './sut'
import type { Brain } from './fixture'
import type { Question } from './retrieval'
import { openWorkspace, type Arm, type Workspace } from './arms'
import { askClaudeCode, judgeClaudeCode } from './runner-claude-code'
import { askApi, judgeApi } from './runner-api'

// --- Stage 2: agent ------------------------------------------------------------------
//
// A Claude model answers each question in a fresh session, once per arm (see
// arms.ts: eml / claude-md / none) and `repeat` times, so a version comparison
// rests on more than one sample and EML is compared with the free alternative.
// In the eml arm everything the agent reads — boot, reminder, tool descriptions,
// tool output — is the version under test. Each run gets its own copy of the
// brain, so a write by one answer cannot leak into the next.
//
// Two runners: claude-code (default, all arms — runner-claude-code.ts) and api
// (eml arm only, a plain Messages API loop for comparing models — runner-api.ts).
//
// Grading: deterministic where possible (did the tool output contain the
// expected engrams?), then a judge model compares the answer with the reference
// answer and the outdated claims listed for the question.

export type Runner = 'claude-code' | 'api'

export interface AgentOptions {
  runner: Runner
  arms: Arm[]
  repeat: number
  model: string
  judgeModel: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTurns: number
  concurrency: number
  /** claude-code runner: the token Claude Code signs in with (CLAUDE_CODE_OAUTH_TOKEN) */
  claudeToken?: string
}

/** What one session produced, before grading. */
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

export interface Verdict {
  correct: boolean
  stale: boolean
  reason: string
}

export interface AgentResult extends Answer {
  id: string
  category: string
  arm: Arm
  run: number
  correct: boolean
  stale: boolean
  judge_reason: string
  /** tool calls that change the memory (not a read) */
  writes: number
  /** expected engrams that appeared in tool output / all expected (eml arm) */
  evidence_found: number
  evidence_expected: number
}

export async function runAgent(sut: Sut, brain: Brain, questions: Question[], workDir: string, opts: AgentOptions): Promise<AgentResult[]> {
  const jobs: { q: Question; arm: Arm; run: number }[] = []
  for (let run = 1; run <= opts.repeat; run++) {
    for (const arm of opts.arms) for (const q of questions.filter(q => q.agent)) jobs.push({ q, arm, run })
  }
  return pool(jobs, opts.concurrency, async ({ q, arm, run }) => {
    const r = await runQuestion(sut, brain, q, arm, run, path.join(workDir, 'agent', arm, `run${run}`, q.id), opts)
    console.log(`  ${r.error ? '!' : r.correct ? '✓' : '✗'}${r.stale ? ' stale' : ''} ${arm.padEnd(9)} #${run} ${r.id} (${r.tool_calls.length} tool calls${r.writes ? `, ${r.writes} writes` : ''}${r.error ? `, ${r.error}` : ''})`)
    return r
  })
}

async function runQuestion(sut: Sut, brain: Brain, q: Question, arm: Arm, run: number, dir: string, opts: AgentOptions): Promise<AgentResult> {
  const result: AgentResult = {
    id: q.id, category: q.category, arm, run, answer: '', tool_calls: [], seen_ids: [], turns: 0, stop: '',
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    correct: false, stale: false, judge_reason: '', writes: 0, evidence_found: 0, evidence_expected: arm === 'eml' ? q.expect.length : 0,
  }
  const ws = await openWorkspace(arm, sut, brain, dir)
  try {
    const answer = await ask(ws, opts, q.agent!.question, 'session')
    Object.assign(result, answer)
    result.writes = countWrites(answer)
    if (arm === 'eml') {
      const seen = new Set(answer.seen_ids)
      result.evidence_found = q.expect.filter(k => seen.has(brain.ids[k])).length
    }
    if (result.answer && !result.error) {
      const verdict = await judge(ws, opts, judgePrompt(q.agent!, result.answer), 'judge')
      result.correct = verdict.correct
      result.stale = verdict.stale
      result.judge_reason = verdict.reason
    } else if (!result.error) {
      result.error = 'no answer'
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  } finally {
    await ws.close()
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ question: q, result }, null, 2))
  }
  return result
}

export function ask(ws: Workspace, opts: AgentOptions, prompt: string, label: string, writable = false, configKey?: string): Promise<Answer> {
  return opts.runner === 'claude-code' ? askClaudeCode(ws, opts, { prompt, label, writable, configKey }) : askApi(ws, opts, prompt)
}

export function judge(ws: Workspace, opts: AgentOptions, prompt: string, label: string): Promise<Verdict> {
  return opts.runner === 'claude-code' ? judgeClaudeCode(ws, opts, prompt, label) : judgeApi(opts, prompt)
}

// Read-only tools across versions; any other tool call (an eml write, or Edit /
// Write on CLAUDE.md) changes the memory.
const READ_TOOLS = new Set([
  'eml_boot', 'eml_recall', 'eml_get', 'eml_list', 'eml_show', 'eml_stats',
  'eml_projects', 'eml_entities', 'eml_tags', 'eml_subjects', 'eml_search', 'Read',
])

export function countWrites(a: Answer): number {
  return a.tool_calls.filter(c => !READ_TOOLS.has(c.name)).length
}

export function judgePrompt(a: { question: string; reference: string; stale_claims: string[] }, answer: string): string {
  return `Grade an assistant's answer against a reference answer. Reply only with the verdict.

Question: ${a.question}
Reference answer: ${a.reference}
Outdated claims (true once, no longer true): ${a.stale_claims.length ? a.stale_claims.map(s => `"${s}"`).join('; ') : 'none'}

Assistant's answer:
<answer>
${answer}
</answer>

correct: the answer states the facts of the reference answer (wording may differ; extra correct detail is fine; a missing key fact or a wrong fact makes it incorrect). For a request to act, the answer must do what the reference says (e.g. hold off and say why).
If the reference says the information is not in the memory, correct means the answer says so and invents nothing (mentioning related facts that are recorded is fine).
stale: the answer asserts one of the outdated claims as currently true.
reason: one sentence.`
}

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: { correct: { type: 'boolean' }, stale: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['correct', 'stale', 'reason'],
  additionalProperties: false,
} as const

/** Runs jobs with at most `n` in flight; results in job order. */
export async function pool<J, R>(jobs: J[], n: number, fn: (job: J) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(jobs.length)
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      out[i] = await fn(jobs[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker))
  return out
}

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
    const session = { session_id: 'bench-surface', cwd: path.join(dir, 'workspace') }
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

export interface ArmSummary {
  questions: number
  runs: number
  /** share of correct answers over all runs */
  accuracy: number
  /** accuracy of each run — the spread says how much one run can be trusted */
  accuracy_by_run: number[]
  stale_rate: number
  /** eml arm: expected engrams the agent actually retrieved */
  evidence_rate: number | null
  errors: number
  avg_tool_calls: number
  /** answers where the agent changed its memory while answering */
  answers_with_writes: number
  tokens: { input: number; output: number; cache_read: number; cache_write: number }
  cost_usd: number | null
  by_category: Record<string, number>
  /** question id → correct runs / runs */
  by_question: Record<string, string>
}

export interface AgentSummary {
  runner: Runner
  harness: string | null
  model: string
  judge_model: string
  effort: string
  repeat: number
  arms: Partial<Record<Arm, ArmSummary>>
}

export const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : 0)

export function summarizeAgent(results: AgentResult[], opts: AgentOptions): AgentSummary {
  const arms: AgentSummary['arms'] = {}
  for (const arm of opts.arms) {
    const rs = results.filter(r => r.arm === arm)
    if (!rs.length) continue
    const runs = [...new Set(rs.map(r => r.run))].sort((a, b) => a - b)
    const by_category: Record<string, number> = {}
    for (const cat of [...new Set(rs.map(r => r.category))].sort()) by_category[cat] = mean(rs.filter(r => r.category === cat).map(r => (r.correct ? 1 : 0)))
    const by_question: Record<string, string> = {}
    for (const id of [...new Set(rs.map(r => r.id))]) {
      const qs = rs.filter(r => r.id === id)
      by_question[id] = `${qs.filter(r => r.correct).length}/${qs.length}`
    }
    const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    for (const r of rs) for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[k] += r.usage[k]
    const costs = rs.map(r => r.cost_usd).filter((c): c is number => typeof c === 'number')
    const withEvidence = rs.filter(r => r.evidence_expected > 0)
    arms[arm] = {
      questions: new Set(rs.map(r => r.id)).size,
      runs: runs.length,
      accuracy: mean(rs.map(r => (r.correct ? 1 : 0))),
      accuracy_by_run: runs.map(n => mean(rs.filter(r => r.run === n).map(r => (r.correct ? 1 : 0)))),
      stale_rate: mean(rs.map(r => (r.stale ? 1 : 0))),
      evidence_rate: withEvidence.length ? mean(withEvidence.map(r => r.evidence_found / r.evidence_expected)) : null,
      errors: rs.filter(r => r.error).length,
      avg_tool_calls: mean(rs.map(r => r.tool_calls.length)),
      answers_with_writes: rs.filter(r => r.writes > 0).length,
      tokens,
      cost_usd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
      by_category,
      by_question,
    }
  }
  return {
    runner: opts.runner,
    harness: results.find(r => r.harness)?.harness ?? null,
    model: opts.model,
    judge_model: opts.judgeModel,
    effort: opts.effort,
    repeat: opts.repeat,
    arms,
  }
}
