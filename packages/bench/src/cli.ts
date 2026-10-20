#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { openSut, startServer, Api } from './sut'
import { buildBrain } from './fixture'
import { readQuestions, runRetrieval, summarize, RECALL_K, type RetrievalSummary } from './retrieval'
import { runAgent, summarizeAgent, measureSurface, type AgentOptions, type AgentSummary, type Surface } from './agent'

const USAGE = `eml-bench — measure a build of EML against the fixture brain

  eml-bench run --eml <checkout> [--base <checkout>] [--agent] [--out <file>]
      Builds the fixture brain with --base (default: --eml), then measures --eml
      on it. A base older than --eml measures the brain as a user has it after
      updating (the server migrates it at startup).

      Stage 1 (retrieval) always runs. --agent adds stage 2: a Claude model
      answers the questions over the SUT's hooks and MCP tools. It calls the
      Anthropic API (credentials from the environment, e.g. ANTHROPIC_API_KEY)
      and costs money per run.
        --model <id>        agent model (default claude-opus-5-5)
        --judge <id>        judge model (default claude-opus-5-5)
        --effort <level>    low|medium|high|xhigh|max (default medium)
        --concurrency <n>   questions in parallel (default 4)
        --only <id,id>      only these questions

  eml-bench compare <a.json> <b.json>
      Prints the change from result a to result b.
`

const BENCH_DIR = path.resolve(__dirname, '..')

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function run(args: string[]): Promise<void> {
  const emlPath = arg(args, 'eml')
  if (!emlPath) throw new Error('--eml <checkout> is required')
  const sut = openSut(emlPath)
  const base = openSut(arg(args, 'base') ?? emlPath)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workDir = path.join(BENCH_DIR, 'work', `${sut.version}-${stamp}`)
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
  if (args.includes('--agent')) {
    const opts: AgentOptions = {
      model: arg(args, 'model') ?? 'claude-opus-5-5',
      judgeModel: arg(args, 'judge') ?? 'claude-opus-5-5',
      effort: (arg(args, 'effort') ?? 'medium') as AgentOptions['effort'],
      maxTurns: 12,
      concurrency: parseInt(arg(args, 'concurrency') ?? '4', 10),
    }
    const only = arg(args, 'only')?.split(',')
    const questions = readQuestions().filter(q => !only || only.includes(q.id))
    console.log(`\nagent — ${opts.model} (effort ${opts.effort}), judge ${opts.judgeModel}`)
    const agentResults = await runAgent(sut, brain, questions, workDir, opts)
    const agentSummary = summarizeAgent(agentResults, opts)
    printAgentSummary(agentSummary)
    agent = { summary: agentSummary, results: agentResults }
  }

  const out = arg(args, 'out') ?? path.join(BENCH_DIR, 'results', `${sut.version}${base.version !== sut.version ? `-from-${base.version}` : ''}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({
    version: sut.version,
    base_version: base.version,
    measured_at: new Date().toISOString(),
    surface,
    retrieval: { k: RECALL_K, summary, results },
    ...(agent && { agent }),
  }, null, 2) + '\n')
  console.log(`\nresult: ${path.relative(process.cwd(), out)}`)
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
  console.log(`\nagent — ${s.questions} questions`)
  console.log(`  accuracy       ${s.accuracy.toFixed(3)}`)
  console.log(`  stale rate     ${s.stale_rate.toFixed(3)}   (answer asserts an outdated claim)`)
  console.log(`  evidence rate  ${s.evidence_rate.toFixed(3)}   (expected engrams the agent actually retrieved)`)
  console.log(`  errors         ${s.errors}`)
  console.log(`  avg tool calls ${s.avg_tool_calls}   avg turns ${s.avg_turns}`)
  console.log(`  tokens         in ${s.tokens.input} · out ${s.tokens.output} · cache read ${s.tokens.cache_read} · cache write ${s.tokens.cache_write}`)
  console.log('  by category')
  for (const [cat, c] of Object.entries(s.by_category)) {
    console.log(`    ${cat.padEnd(20)} n=${String(c.questions).padEnd(3)} accuracy ${c.accuracy.toFixed(2)}`)
  }
}

function compare(aPath: string, bPath: string): void {
  const a = JSON.parse(fs.readFileSync(aPath, 'utf8'))
  const b = JSON.parse(fs.readFileSync(bPath, 'utf8'))
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
  if (a.agent && b.agent) {
    row('agent accuracy', a.agent.summary.accuracy, b.agent.summary.accuracy)
    row('agent stale', a.agent.summary.stale_rate, b.agent.summary.stale_rate)
    row('agent evidence', a.agent.summary.evidence_rate, b.agent.summary.evidence_rate)
    row('agent tool calls', a.agent.summary.avg_tool_calls, b.agent.summary.avg_tool_calls, 1)
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
  if (cmd === 'compare' && args.length === 2) return compare(args[0], args[1])
  process.stdout.write(USAGE)
  process.exitCode = cmd ? 1 : 0
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
