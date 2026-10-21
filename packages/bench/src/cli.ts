#!/usr/bin/env node
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openSut, startServer, Api } from './sut'
import { buildBrain } from './fixture'
import { readQuestions, runRetrieval, summarize, RECALL_K, type RetrievalSummary } from './retrieval'
import { runAgent, summarizeAgent, measureSurface, type AgentOptions, type AgentSummary, type Surface } from './agent'
import { readScenarios, runScenarios, summarizeScenarios, type ScenarioArmSummary } from './scenarios'
import { ARMS, type Arm } from './arms'
import { RESULTS_DIR, fixtureHash, findBaseline, knownHashes, retrievalRegressions } from './baseline'

const USAGE = `eml-bench — measure a build of EML against the fixture brain

  eml-bench check --eml <checkout>
      Release gate (CI): stage 1 (retrieval) and the agent surface, no model.
      Compared with the newest checked-in result on the same fixture, up to
      this version. Exits 1 if any stage-1 number got worse — stage 1 is
      deterministic, so a drop is a real change in what the agent reads.

  eml-bench release --eml <checkout> [--no-agent] [--claude-token-file <file>]
      Measures a release: stage 1, surface and the agent stage (eml arm,
      --repeat 3 unless given). Writes results/<version>.json and prints the
      change from the previous release. A report for the release notes, not a
      gate: read the per-run spread before reading one question's change.
      After an intended stage-1 change, or a changed fixture, this is also how
      the baseline is renewed.

  eml-bench run --eml <checkout> [--base <checkout>] [--agent] [--scenarios] [--out <file>]
      Builds the fixture brain with --base (default: --eml), then measures --eml
      on it. A base older than --eml measures the brain as a user has it after
      updating (the server migrates it at startup).

      Stage 1 (retrieval) always runs. --agent adds stage 2: a Claude model
      answers the questions over the SUT's hooks and MCP tools. --scenarios
      runs the multi-session scenarios (work over time). Both take:
        --arms <a,b>        eml (default), claude-md (the same knowledge as a
                            CLAUDE.md), none (no memory); e.g. eml,claude-md,none
        --repeat <n>        runs per question / scenario (default 1)
        --runner <r>        claude-code (default): headless Claude Code, signed in
                            with a Claude Code token — CLAUDE_CODE_OAUTH_TOKEN or
                            --claude-token-file <file> (from \`claude setup-token\`)
                            api: plain tool loop over the Anthropic API
                            (ANTHROPIC_API_KEY); costs API credit
        --model <id>        agent model (default claude-opus-5-5)
        --judge <id>        judge model (default claude-opus-5-5)
        --effort <level>    low|medium|high|xhigh|max (default medium)
        --concurrency <n>   questions in parallel (default 4)
        --only <id,id>      only these questions / scenarios
      --work-dir <dir>      where runs keep their data, logs and transcripts
                            (default: <tmp>/eml-bench; must be outside the repo)

  eml-bench compare <a.json> <b.json>
      Prints the change from result a to result b.

  run writes its result into the work dir unless --out is given; only release
  writes to results/.
`

const BENCH_DIR = path.resolve(__dirname, '..')

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

interface Measurement {
  result: Record<string, unknown>
  workDir: string
  version: string
  baseVersion: string
}

async function measure(args: string[]): Promise<Measurement> {
  const emlPath = arg(args, 'eml')
  if (!emlPath) throw new Error('--eml <checkout> is required')
  const sut = openSut(emlPath)
  const base = openSut(arg(args, 'base') ?? emlPath)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Outside the repository: Claude Code would read the repo's CLAUDE.md from a parent directory.
  const workRoot = path.resolve(arg(args, 'work-dir') ?? path.join(os.tmpdir(), 'eml-bench'))
  if (isInside(workRoot, sut.root) || isInside(workRoot, BENCH_DIR)) throw new Error(`--work-dir must lie outside the repository (${workRoot})`)
  const workDir = path.join(workRoot, `${sut.version}-${stamp}`)
  console.log(`work dir:      ${workDir}`)
  const dataDir = path.join(workDir, 'data')
  console.log(`fixture brain: written by ${base.version} (${base.root})`)
  const brain = await buildBrain(base, dataDir)

  console.log(`measuring:     ${sut.version} (${sut.root})`)
  const server = await startServer(sut, dataDir, path.join(workDir, 'server.log'))
  let results
  try {
    results = await runRetrieval(new Api(server.url, brain.token), brain, readQuestions(), path.join(workDir, 'probes'))
  } finally {
    await server.stop()
  }
  const summary = summarize(results)
  printSummary(summary)
  const surface = await measureSurface(sut, brain, workDir)
  printSurface(surface)

  let agent: { summary: AgentSummary; results: unknown[] } | undefined
  let scenarios: { summary: Partial<Record<Arm, ScenarioArmSummary>>; results: unknown[] } | undefined
  if (args.includes('--agent') || args.includes('--scenarios')) {
    const runner = (arg(args, 'runner') ?? 'claude-code') as AgentOptions['runner']
    const tokenFile = arg(args, 'claude-token-file')
    const arms = (arg(args, 'arms') ?? 'eml').split(',') as Arm[]
    for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a} (${ARMS.join(', ')})`)
    const opts: AgentOptions = {
      runner,
      arms,
      repeat: parseInt(arg(args, 'repeat') ?? '1', 10),
      claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || (tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : undefined),
      model: arg(args, 'model') ?? 'claude-opus-5-5',
      judgeModel: arg(args, 'judge') ?? 'claude-opus-5-5',
      effort: (arg(args, 'effort') ?? 'medium') as AgentOptions['effort'],
      maxTurns: 12,
      concurrency: parseInt(arg(args, 'concurrency') ?? '4', 10),
    }
    const only = arg(args, 'only')?.split(',')
    const header = `${opts.runner} · ${opts.model} (effort ${opts.effort}), judge ${opts.judgeModel} · arms ${arms.join(', ')} · ${opts.repeat} run(s)`
    if (args.includes('--agent')) {
      const questions = readQuestions().filter(q => !only || only.includes(q.id))
      console.log(`\nagent — ${header}`)
      const agentResults = await runAgent(sut, brain, questions, workDir, opts)
      const agentSummary = summarizeAgent(agentResults, opts)
      printAgentSummary(agentSummary)
      agent = { summary: agentSummary, results: agentResults }
    }
    if (args.includes('--scenarios')) {
      const list = readScenarios().filter(s => !only || only.includes(s.id))
      console.log(`\nscenarios — ${header}`)
      const scenarioResults = await runScenarios(sut, brain, list, workDir, opts)
      const scenarioSummary = summarizeScenarios(scenarioResults, arms)
      printScenarioSummary(scenarioSummary)
      scenarios = { summary: scenarioSummary, results: scenarioResults }
    }
  }

  const result = {
    version: sut.version,
    base_version: base.version,
    fixture_hash: fixtureHash(),
    measured_at: new Date().toISOString(),
    surface,
    retrieval: { k: RECALL_K, summary, results },
    ...(agent && { agent }),
    ...(scenarios && { scenarios }),
  }
  return { result, workDir, version: sut.version, baseVersion: base.version }
}

function writeResult(file: string, result: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n')
  console.log(`\nresult: ${path.relative(process.cwd(), file)}`)
}

async function run(args: string[]): Promise<void> {
  const m = await measure(args)
  writeResult(path.resolve(arg(args, 'out') ?? path.join(m.workDir, 'result.json')), m.result)
}

async function check(args: string[]): Promise<void> {
  const m = await measure(args.filter(a => a !== '--agent' && a !== '--scenarios'))
  writeResult(path.join(m.workDir, 'result.json'), m.result)
  const hash = m.result.fixture_hash as string
  const baseline = findBaseline(m.version, hash, true)
  if (!baseline) {
    const known = knownHashes()
    console.log(`\nno baseline: no checked-in result on this fixture (${hash}) up to ${m.version}.`)
    console.log('Measure the last release with `eml-bench release --eml <its checkout>` and commit results/<version>.json.')
    // Results exist, just none on this fixture: the fixture or the questions
    // changed without a renewed baseline. Passing here would switch the gate off
    // without anyone noticing, so it fails. Only a repository without any
    // result yet passes without one.
    if (known.length) {
      console.log(`\nFAIL — the checked-in results are on another fixture (${known.join(', ')}); renew the baseline in the same change.`)
      process.exitCode = 1
    }
    return
  }
  console.log(`\nbaseline: ${path.relative(process.cwd(), baseline.file)}\n`)
  compareResults(baseline.data, m.result)
  const regressions = retrievalRegressions(baseline.data.retrieval.summary, (m.result as any).retrieval.summary)
  if (regressions.length) {
    console.log(`\nFAIL — stage 1 got worse than ${baseline.data.version}: ${regressions.join('; ')}`)
    console.log('If the change is intended, renew the baseline: eml-bench release --eml <checkout> [--no-agent], commit results/<version>.json.')
    process.exitCode = 1
  } else {
    console.log(`\nOK — stage 1 not worse than ${baseline.data.version}`)
  }
}

async function release(args: string[]): Promise<void> {
  const agentArgs = args.includes('--no-agent') ? [] : ['--agent', ...(arg(args, 'repeat') ? [] : ['--repeat', '3'])]
  // The release measures the eml arm only; other arms and scenarios belong to `run`.
  const own = args.filter((a, i) => a !== '--scenarios' && a !== '--arms' && args[i - 1] !== '--arms')
  const m = await measure([...own, ...agentArgs])
  if (m.baseVersion !== m.version) throw new Error('release measures a version on a brain it wrote itself (no --base)')
  writeResult(path.join(RESULTS_DIR, `${m.version}.json`), m.result)
  const baseline = findBaseline(m.version, m.result.fixture_hash as string, false)
  if (!baseline) {
    console.log('\nno previous release on this fixture to compare with.')
    return
  }
  console.log(`\nchange from ${baseline.data.version}:\n`)
  compareResults(baseline.data, m.result)
  const regressions = retrievalRegressions(baseline.data.retrieval.summary, (m.result as any).retrieval.summary)
  if (regressions.length) console.log(`\nstage 1 got worse: ${regressions.join('; ')}`)
}

function isInside(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function printSummary(s: RetrievalSummary): void {
  console.log(`\nretrieval — ${s.questions} questions`)
  console.log(`  recall@${RECALL_K}     ${s.recall_at_k.toFixed(3)}`)
  console.log(`  MRR          ${s.mrr.toFixed(3)}`)
  console.log(`  coverage     ${s.coverage.toFixed(3)}   (share of expected engrams surfaced)`)
  console.log(`  stale rate   ${s.stale_rate.toFixed(3)}   (outdated engram above the current one)`)
  console.log(`  absent rate  ${s.absent_rate.toFixed(3)}   (engram shown that must not be)`)
  console.log(`  avg chars    ${Object.entries(s.avg_chars).map(([t, c]) => `${t} ${c}`).join(' · ')}`)
  console.log(`  avg ms       ${s.avg_ms}`)
  console.log('  by category')
  for (const [cat, c] of Object.entries(s.by_category)) {
    console.log(`    ${cat.padEnd(20)} n=${String(c.questions).padEnd(3)} recall@${RECALL_K} ${c.recall_at_k.toFixed(2)}  MRR ${c.mrr.toFixed(2)}`)
  }
}

function printSurface(s: Surface): void {
  console.log('\nagent surface — what an agent reads before it acts')
  console.log(`  boot (session-start hook)   ${s.boot_chars} chars`)
  console.log(`  prompt reminder             ${s.reminder_chars} chars`)
  console.log(`  tools                       ${s.tools} tools, ${s.tools_json_chars} chars`)
}

function printAgentSummary(s: AgentSummary): void {
  const arms = Object.keys(s.arms) as Arm[]
  const col = (f: (a: NonNullable<AgentSummary['arms'][Arm]>) => string) => arms.map(a => f(s.arms[a]!).padStart(12)).join('')
  const any = s.arms[arms[0]]!
  console.log(`\nagent — ${any.questions} questions × ${s.repeat} run(s) · ${s.runner}${s.harness ? ` (${s.harness})` : ''} · ${s.model} · effort ${s.effort}`)
  console.log(`  ${''.padEnd(22)}${arms.map(a => a.padStart(12)).join('')}`)
  console.log(`  ${'accuracy'.padEnd(22)}${col(a => a.accuracy.toFixed(3))}`)
  console.log(`  ${'  per run'.padEnd(22)}${col(a => a.accuracy_by_run.map(x => x.toFixed(2)).join('/'))}`)
  console.log(`  ${'stale rate'.padEnd(22)}${col(a => a.stale_rate.toFixed(3))}`)
  console.log(`  ${'evidence rate'.padEnd(22)}${col(a => (a.evidence_rate === null ? '–' : a.evidence_rate.toFixed(3)))}`)
  console.log(`  ${'avg tool calls'.padEnd(22)}${col(a => String(a.avg_tool_calls))}`)
  console.log(`  ${'answers with writes'.padEnd(22)}${col(a => String(a.answers_with_writes))}`)
  console.log(`  ${'errors'.padEnd(22)}${col(a => String(a.errors))}`)
  console.log(`  ${'cost $ (API-equiv.)'.padEnd(22)}${col(a => (a.cost_usd === null ? '–' : String(a.cost_usd)))}`)
  console.log('  by category')
  for (const cat of Object.keys(any.by_category)) {
    console.log(`    ${cat.padEnd(20)}${col(a => (a.by_category[cat] ?? 0).toFixed(2))}`)
  }
  const unstable = Object.keys(any.by_question).filter(id => arms.some(a => {
    const [ok, n] = s.arms[a]!.by_question[id].split('/').map(Number)
    return ok !== n
  }))
  if (unstable.length) {
    console.log('  questions not passed every run')
    for (const id of unstable) console.log(`    ${id.padEnd(20)}${col(a => a.by_question[id])}`)
  }
}

function printScenarioSummary(s: Partial<Record<Arm, ScenarioArmSummary>>): void {
  const arms = Object.keys(s) as Arm[]
  const col = (f: (a: ScenarioArmSummary) => string) => arms.map(a => f(s[a]!).padStart(12)).join('')
  const any = s[arms[0]]!
  console.log(`\nscenarios — ${any.scenarios} scenarios × ${any.runs} run(s)`)
  console.log(`  ${''.padEnd(22)}${arms.map(a => a.padStart(12)).join('')}`)
  console.log(`  ${'accuracy'.padEnd(22)}${col(a => a.accuracy.toFixed(3))}`)
  console.log(`  ${'  per run'.padEnd(22)}${col(a => a.accuracy_by_run.map(x => x.toFixed(2)).join('/'))}`)
  console.log(`  ${'stale rate'.padEnd(22)}${col(a => a.stale_rate.toFixed(3))}`)
  console.log(`  ${'avg writes'.padEnd(22)}${col(a => String(a.avg_writes))}`)
  console.log(`  ${'errors'.padEnd(22)}${col(a => String(a.errors))}`)
  console.log(`  ${'cost $ (API-equiv.)'.padEnd(22)}${col(a => String(a.cost_usd))}`)
  for (const id of Object.keys(any.by_scenario)) console.log(`    ${id.padEnd(20)}${col(a => a.by_scenario[id])}`)
}

function compare(aPath: string, bPath: string): void {
  compareResults(JSON.parse(fs.readFileSync(aPath, 'utf8')), JSON.parse(fs.readFileSync(bPath, 'utf8')))
}

function compareResults(a: any, b: any): void {
  if (a.fixture_hash !== b.fixture_hash) console.log('  (different fixtures — the numbers are not comparable)\n')
  const sa: RetrievalSummary = a.retrieval.summary
  const sb: RetrievalSummary = b.retrieval.summary
  const row = (name: string, x: number, y: number, digits = 3) => {
    const d = y - x
    console.log(`  ${name.padEnd(16)} ${x.toFixed(digits).padStart(9)} ${y.toFixed(digits).padStart(9)} ${(d >= 0 ? '+' : '') + d.toFixed(digits)}`)
  }
  console.log(`  ${''.padEnd(16)} ${a.version.padStart(9)} ${b.version.padStart(9)}   Δ`)
  row(`recall@${a.retrieval.k}`, sa.recall_at_k, sb.recall_at_k)
  row('MRR', sa.mrr, sb.mrr)
  row('coverage', sa.coverage, sb.coverage)
  row('stale rate', sa.stale_rate, sb.stale_rate)
  row('absent rate', sa.absent_rate, sb.absent_rate)
  for (const tool of Object.keys({ ...sa.avg_chars, ...sb.avg_chars })) {
    row(`chars ${tool}`, sa.avg_chars[tool] ?? 0, sb.avg_chars[tool] ?? 0, 0)
  }
  if (a.surface && b.surface) {
    row('boot hook chars', a.surface.boot_chars, b.surface.boot_chars, 0)
    row('reminder chars', a.surface.reminder_chars, b.surface.reminder_chars, 0)
    row('tools', a.surface.tools, b.surface.tools, 0)
    row('tools chars', a.surface.tools_json_chars, b.surface.tools_json_chars, 0)
  }
  // Stage 2 and scenarios: the eml arm is the version under test.
  const ea = a.agent?.summary?.arms?.eml
  const eb = b.agent?.summary?.arms?.eml
  if (ea && eb) {
    row('agent accuracy', ea.accuracy, eb.accuracy)
    console.log(`  ${'  per run'.padEnd(16)} ${ea.accuracy_by_run.map((x: number) => x.toFixed(2)).join('/').padStart(9)} ${eb.accuracy_by_run.map((x: number) => x.toFixed(2)).join('/').padStart(9)}`)
    row('agent stale', ea.stale_rate, eb.stale_rate)
    if (ea.evidence_rate !== null && eb.evidence_rate !== null) row('agent evidence', ea.evidence_rate, eb.evidence_rate)
    row('agent tool calls', ea.avg_tool_calls, eb.avg_tool_calls, 1)
    row('agent writes', ea.answers_with_writes, eb.answers_with_writes, 0)
  }
  const sa2 = a.scenarios?.summary?.eml
  const sb2 = b.scenarios?.summary?.eml
  if (sa2 && sb2) {
    row('scenario accuracy', sa2.accuracy, sb2.accuracy)
    row('scenario writes', sa2.avg_writes, sb2.avg_writes, 1)
  }
  // Per question: what moved.
  const byId = new Map<string, any>(a.retrieval.results.map((r: any) => [r.id, r]))
  for (const r of b.retrieval.results) {
    const o = byId.get(r.id)
    if (o && (o.rank !== r.rank || o.stale_hit !== r.stale_hit || o.absent_hit !== r.absent_hit)) {
      console.log(`  ${r.id}: rank ${o.rank ?? '–'} → ${r.rank ?? '–'}${o.stale_hit !== r.stale_hit ? `, stale ${o.stale_hit} → ${r.stale_hit}` : ''}${o.absent_hit !== r.absent_hit ? `, absent ${o.absent_hit} → ${r.absent_hit}` : ''}`)
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'run') return run(args)
  if (cmd === 'check') return check(args)
  if (cmd === 'release') return release(args)
  if (cmd === 'compare' && args.length === 2) return compare(args[0], args[1])
  process.stdout.write(USAGE)
  process.exitCode = cmd ? 1 : 0
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
