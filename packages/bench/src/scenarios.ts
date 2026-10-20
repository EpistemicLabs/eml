import fs from 'fs'
import path from 'path'
import { FIXTURE_DIR, type Brain } from './fixture'
import type { Sut } from './sut'
import { openWorkspace, type Arm } from './arms'
import { ask, judge, judgePrompt, countWrites, pool, mean, type AgentOptions, type Answer } from './agent'

// --- Scenarios: work over time -------------------------------------------------------
//
// One memory, several sessions, each a fresh agent (a new Claude Code process).
// Earlier sessions bring new information in passing; the check session at the
// end asks for it. A pass needs the agent to have written it into its memory
// when it heard it — EML through its tools, the claude-md arm by editing the
// file (or Claude Code's own memory) — and to find it again later. The none arm
// is the floor: it cannot carry anything over.

export interface Scenario {
  id: string
  sessions: string[]
  check: { question: string; reference: string; stale_claims: string[] }
}

export function readScenarios(): Scenario[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'scenarios.json'), 'utf8')).scenarios
}

export interface ScenarioResult {
  id: string
  arm: Arm
  run: number
  sessions: { prompt: string; answer: string; tool_calls: Answer['tool_calls']; writes: number; error?: string }[]
  answer: string
  correct: boolean
  stale: boolean
  judge_reason: string
  /** memory changes over all sessions */
  writes: number
  cost_usd: number | null
  error?: string
}

export async function runScenarios(sut: Sut, brain: Brain, scenarios: Scenario[], workDir: string, opts: AgentOptions): Promise<ScenarioResult[]> {
  const jobs: { s: Scenario; arm: Arm; run: number }[] = []
  for (let run = 1; run <= opts.repeat; run++) for (const arm of opts.arms) for (const s of scenarios) jobs.push({ s, arm, run })
  return pool(jobs, opts.concurrency, async ({ s, arm, run }) => {
    const r = await runScenario(sut, brain, s, arm, run, path.join(workDir, 'scenarios', arm, `run${run}`, s.id), opts)
    console.log(`  ${r.error ? '!' : r.correct ? '✓' : '✗'}${r.stale ? ' stale' : ''} ${arm.padEnd(9)} #${run} ${r.id} (${r.writes} writes${r.error ? `, ${r.error}` : ''})`)
    return r
  })
}

async function runScenario(sut: Sut, brain: Brain, s: Scenario, arm: Arm, run: number, dir: string, opts: AgentOptions): Promise<ScenarioResult> {
  const result: ScenarioResult = { id: s.id, arm, run, sessions: [], answer: '', correct: false, stale: false, judge_reason: '', writes: 0, cost_usd: null }
  const ws = await openWorkspace(arm, sut, brain, dir)
  let cost = 0
  try {
    const prompts = [...s.sessions, s.check.question]
    for (let i = 0; i < prompts.length; i++) {
      const label = i < s.sessions.length ? `session${i + 1}` : 'check'
      const a = await ask(ws, opts, prompts[i], label, true, 'scenario')
      cost += a.cost_usd ?? 0
      const writes = countWrites(a)
      result.writes += writes
      result.sessions.push({ prompt: prompts[i], answer: a.answer, tool_calls: a.tool_calls, writes, ...(a.error && { error: a.error }) })
      if (a.error) { result.error = `${label}: ${a.error}`; break }
      if (label === 'check') result.answer = a.answer
    }
    if (!result.error) {
      const v = await judge(ws, opts, judgePrompt(s.check, result.answer), 'judge')
      result.correct = v.correct
      result.stale = v.stale
      result.judge_reason = v.reason
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  } finally {
    await ws.close()
    result.cost_usd = Math.round(cost * 100) / 100
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ scenario: s, result }, null, 2))
  }
  return result
}

export interface ScenarioArmSummary {
  scenarios: number
  runs: number
  accuracy: number
  accuracy_by_run: number[]
  stale_rate: number
  errors: number
  avg_writes: number
  cost_usd: number
  by_scenario: Record<string, string>
}

export function summarizeScenarios(results: ScenarioResult[], arms: Arm[]): Partial<Record<Arm, ScenarioArmSummary>> {
  const out: Partial<Record<Arm, ScenarioArmSummary>> = {}
  for (const arm of arms) {
    const rs = results.filter(r => r.arm === arm)
    if (!rs.length) continue
    const runs = [...new Set(rs.map(r => r.run))].sort((a, b) => a - b)
    const by_scenario: Record<string, string> = {}
    for (const id of [...new Set(rs.map(r => r.id))]) {
      const xs = rs.filter(r => r.id === id)
      by_scenario[id] = `${xs.filter(r => r.correct).length}/${xs.length}`
    }
    out[arm] = {
      scenarios: new Set(rs.map(r => r.id)).size,
      runs: runs.length,
      accuracy: mean(rs.map(r => (r.correct ? 1 : 0))),
      accuracy_by_run: runs.map(n => mean(rs.filter(r => r.run === n).map(r => (r.correct ? 1 : 0)))),
      stale_rate: mean(rs.map(r => (r.stale ? 1 : 0))),
      errors: rs.filter(r => r.error).length,
      avg_writes: mean(rs.map(r => r.writes)),
      cost_usd: Math.round(rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0) * 100) / 100,
      by_scenario,
    }
  }
  return out
}
