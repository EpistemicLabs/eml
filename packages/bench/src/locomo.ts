import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { provisionBrain, type Brain } from './fixture'
import { sutSqlite, type Sut } from './sut'
import { openWorkspace, type Workspace } from './arms'
import { countWrites, pool, mean, type AgentOptions, type Answer } from './agent'
import { askClaudeCode, judgeStructured } from './runner-claude-code'

// --- Public benchmark: LoCoMo ------------------------------------------------------
//
// LoCoMo (Snap Research, ACL 2024): ten long chats between two friends, 19–32
// sessions each, with dated sessions, and questions about them. Published memory
// systems report an LLM-judge score ("J") over categories 1–4; category 5
// (adversarial) is left out, as everyone does.
//
// Two arms, same model and harness (headless Claude Code, see runner-claude-code.ts):
//
//   eml           one empty brain per conversation. Each chat session is one agent
//                 session, in order, with the session's date; the agent decides what
//                 goes into the brain, through the version's MCP tools and hooks —
//                 the way EML is used, not a bulk import. Each question then runs in
//                 a fresh session on its own copy of the finished brain.
//   full-context  the whole conversation, with dates, in the prompt; no tools. The
//                 standard baseline in the papers.
//
// The prompts below are the same for both arms where they can be, and neutral: they
// say what the situation is, not how to use the memory.
//
// Grading: the judge model with the published judge prompts, verbatim —
//   paper      the LoCoMo J prompt of the Mem0 paper (arXiv 2504.19413), used by the
//              2025 numbers (Mem0, Zep's rebuttal, Letta)
//   mem0-2026  the prompt of mem0ai/memory-benchmarks (2026), much more lenient
//              (partial credit, 14 days date tolerance) — behind the 90+ numbers
// Both are scored, so the report shows how much of a score is the judge.
//
// The dataset is CC BY-NC 4.0 and is not part of this repository: `eml-bench
// locomo-download` puts it into a cache directory, checked against its hash.

const LOCOMO_COMMIT = 'cbfbc1dba6bc53d00625212a0f22d55ffee7c1fc'
const LOCOMO_URL = `https://raw.githubusercontent.com/snap-research/locomo/${LOCOMO_COMMIT}/data/locomo10.json`
const LOCOMO_SHA256 = '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4'
export const LOCOMO_DEFAULT_FILE = path.join(os.homedir(), '.cache', 'eml-bench', 'locomo', 'locomo10.json')

/** Category numbers as in the data; names as in mem0ai/memory-benchmarks (the repo itself does not name them). */
export const LOCOMO_CATEGORIES: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop' }

export type PublicArm = 'eml' | 'full-context'
export const PUBLIC_ARMS: PublicArm[] = ['eml', 'full-context']
export type JudgeKind = 'paper' | 'mem0-2026'
export const JUDGE_KINDS: JudgeKind[] = ['paper', 'mem0-2026']

interface Turn { speaker: string; text: string; blip_caption?: string }
interface Qa { question: string; answer?: string | number; category: number; evidence?: string[] }
interface Conversation {
  sample_id: string
  conversation: Record<string, unknown> & { speaker_a: string; speaker_b: string }
  qa: Qa[]
}
export interface ChatSession { n: number; date: string; turns: Turn[] }

export async function downloadLocomo(file = LOCOMO_DEFAULT_FILE): Promise<void> {
  const res = await fetch(LOCOMO_URL)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${LOCOMO_URL}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  if (sha !== LOCOMO_SHA256) throw new Error(`locomo10.json: sha256 ${sha}, expected ${LOCOMO_SHA256}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  console.log(`LoCoMo (snap-research/locomo@${LOCOMO_COMMIT.slice(0, 7)}, CC BY-NC 4.0) → ${file}`)
}

export function readLocomo(file = LOCOMO_DEFAULT_FILE): Conversation[] {
  if (!fs.existsSync(file)) throw new Error(`${file} missing — run \`eml-bench locomo-download\` first`)
  const buf = fs.readFileSync(file)
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  if (sha !== LOCOMO_SHA256) throw new Error(`${file}: sha256 ${sha}, expected ${LOCOMO_SHA256} — download it again`)
  return JSON.parse(buf.toString('utf8'))
}

export function chatSessions(c: Conversation): ChatSession[] {
  const out: ChatSession[] = []
  for (let n = 1; Array.isArray(c.conversation[`session_${n}`]); n++) {
    out.push({ n, date: String(c.conversation[`session_${n}_date_time`]), turns: c.conversation[`session_${n}`] as Turn[] })
  }
  return out
}

/** One session as plain text; a shared photo appears as its caption (as the dataset gives it). */
export function renderSession(s: ChatSession): string {
  return s.turns.map(t => `${t.speaker}: ${t.text}${t.blip_caption ? ` [shares a photo: ${t.blip_caption}]` : ''}`).join('\n')
}

// --- Prompts ------------------------------------------------------------------------

const ANSWER_STYLE = 'Answer briefly: a short phrase, no explanation.'

function system(arm: PublicArm, a: string, b: string): string {
  return arm === 'eml'
    ? `You are an AI assistant with a long-term memory, reachable through the memory tools. You follow the conversations of ${a} and ${b}, two friends, one chat session at a time, and later answer questions about them. Answer in plain text.`
    : `You are an AI assistant. You follow the conversations of ${a} and ${b}, two friends, and answer questions about them. Answer in plain text.`
}

function ingestPrompt(s: ChatSession, a: string, b: string): string {
  return `Chat session ${s.n} between ${a} and ${b}, on ${s.date}:\n\n${renderSession(s)}\n\nKeep in your memory what may matter later.`
}

function questionPrompt(arm: PublicArm, c: Conversation, q: Qa): string {
  const { speaker_a: a, speaker_b: b } = c.conversation
  const ask = `Question about ${a} and ${b}: ${q.question}\n${ANSWER_STYLE}`
  if (arm === 'eml') return ask
  const all = chatSessions(c).map(s => `## Session ${s.n}, ${s.date}\n\n${renderSession(s)}`).join('\n\n')
  return `All chat sessions between ${a} and ${b} so far:\n\n${all}\n\n${ask}`
}

// Verbatim from mem0ai/mem0 evaluation/metrics/llm_judge.py (aae5989, Apache-2.0) — the J prompt of the Mem0 paper.
function judgePaper(question: string, gold: string, generated: string): string {
  return `
Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a ’gold’ (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: ${question}
Gold answer: ${gold}
Generated answer: ${generated}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
`
}

// Verbatim from mem0ai/memory-benchmarks benchmarks/locomo/prompts.py (Apache-2.0): JUDGE_SYSTEM_PROMPT
// followed by the judge template without evidence. Category 3 gold answers are cut at the first ';'
// (their preprocess_answer). Claude Code has no separate system message here, so it goes first.
function judgeMem02026(question: string, gold: string, generated: string): string {
  return `You are evaluating conversational AI memory recall. Return JSON only with the format requested.

Label the generated answer as CORRECT or WRONG.

## Rules

1. **PARTIAL CREDIT**: If the generated answer includes AT LEAST ONE correct item from the gold answer's list, mark CORRECT. Getting 1 out of 2, 2 out of 4, etc. is always acceptable. Only mark WRONG if NONE of the gold answer items appear.

2. **PARAPHRASES COUNT**: Same concept in different words is CORRECT. "Chocolate raspberry tart" = "chocolate cake with raspberries". "Shelter meal service" = "volunteering at a homeless shelter". Emotions and sentiments in the same positive/negative family count as paraphrases: "proud" = "fulfilled" = "accomplished"; "huge success" = "relieved" = "thrilled" (all express positive achievement). Judge semantic meaning, not exact wording.

3. **EXTRA DETAIL IS FINE**: A longer answer that includes the gold answer's key facts plus additional information is CORRECT. Never penalize for being more detailed or specific. If the generated answer adds extra descriptive details beyond the gold answer while still referencing the same core entity or concept, mark CORRECT.

4. **DATE TOLERANCE**: Dates within 14 days of each other are CORRECT. Durations within 50% are CORRECT (e.g., "5 months" matches "six months"; "19 days" matches "two weeks"). Relative dates ("few days before November") match specific dates in the same window. A specific date (e.g., "February 2020") that is consistent with a vague reference (e.g., "a few years ago" relative to 2023) is CORRECT. Converting "last year" to the actual year (e.g., "2022" when conversations are in 2023) is CORRECT.

5. **SEMANTIC OVERLAP**: Judge whether the generated answer addresses the same topic and captures the core idea of the gold answer. Different wording, phrasing, or level of detail should not result in WRONG if the underlying concept matches. For EMOTIONS and FEELINGS questions, answers expressing sentiments in the same valence (positive/negative) about the same event are CORRECT — do not require the exact same emotion word.

6. **SAME REFERENT**: If the generated answer mentions or references the same named entity, character, person, or concept as the gold answer, mark CORRECT — even if the generated answer provides a different physical description or includes additional details. The key question is: does the generated answer identify the same core entity? If yes, it is CORRECT.

7. **FOCUS ON KNOWLEDGE, NOT WORDING**: The goal is to assess whether the system recalled the right fact. Minor differences in specificity, phrasing, or scope should not result in WRONG. Only mark WRONG when the generated answer demonstrates a genuinely different or incorrect understanding.

## ONLY mark WRONG if:
- The generated answer contains ZERO correct items from the gold answer
- The answer addresses a completely different topic

## Question
Question: ${question}
Gold answer: ${gold}
Generated answer: ${generated}

Return JSON with "reasoning" (one sentence) and "label" (CORRECT or WRONG). Do NOT include both labels.`
}

const LABEL_SCHEMA = {
  type: 'object',
  properties: { reasoning: { type: 'string' }, label: { type: 'string', enum: ['CORRECT', 'WRONG'] } },
  required: ['reasoning', 'label'],
  additionalProperties: false,
} as const

function judgePrompt(kind: JudgeKind, q: Qa, generated: string): string {
  const gold = String(q.answer)
  if (kind === 'paper') return judgePaper(q.question, gold, generated)
  return judgeMem02026(q.question, q.category === 3 && gold.includes(';') ? gold.split(';')[0].trim() : gold, generated)
}

// --- Run ----------------------------------------------------------------------------

export interface LocomoOptions {
  conversations: string[] | null
  arms: PublicArm[]
  judges: JudgeKind[]
  /** questions per conversation (first n of categories 1–4), for a quick look; null = all */
  limit: number | null
  /** chat sessions ingested per conversation (first n), for a wiring check; null = all */
  sessions: number | null
  ingestTurns: number
}

export interface IngestResult {
  conversation: string
  sessions: { n: number; tool_calls: number; writes: number; usage: Answer['usage']; cost_usd: number | null; error?: string }[]
  engrams: number
  cost_usd: number
  errors: number
}

export interface QuestionResult {
  conversation: string
  index: number
  category: string
  question: string
  gold: string
  arm: PublicArm
  answer: string
  verdicts: Partial<Record<JudgeKind, { correct: boolean; reasoning: string }>>
  tool_calls: number
  writes: number
  usage: Answer['usage']
  cost_usd: number | null
  harness?: string
  error?: string
}

export async function runLocomo(sut: Sut, workDir: string, opts: AgentOptions, lo: LocomoOptions, data = readLocomo()): Promise<{ ingest: IngestResult[]; questions: QuestionResult[] }> {
  if (opts.runner !== 'claude-code') throw new Error('locomo runs on the claude-code runner')
  const convs = data.filter(c => !lo.conversations || lo.conversations.includes(c.sample_id))
  if (!convs.length) throw new Error(`no conversation matches ${lo.conversations?.join(', ')}`)

  // Ingestion: one brain per conversation, sessions in order; conversations in parallel.
  const brains = new Map<string, Brain>()
  const ingest: IngestResult[] = []
  if (lo.arms.includes('eml')) {
    console.log(`\ningest — ${convs.length} conversation(s), one agent session per chat session`)
    const done = await pool(convs, opts.concurrency, c => ingestConversation(sut, c, path.join(workDir, 'locomo', c.sample_id), opts, lo))
    for (const { brain, result } of done) { brains.set(result.conversation, brain); ingest.push(result) }
  }

  const jobs: { c: Conversation; q: Qa; index: number; arm: PublicArm }[] = []
  for (const c of convs) {
    const qs = c.qa.map((q, index) => ({ q, index })).filter(({ q }) => q.category in LOCOMO_CATEGORIES)
    for (const { q, index } of lo.limit ? qs.slice(0, lo.limit) : qs) for (const arm of lo.arms) jobs.push({ c, q, index, arm })
  }
  console.log(`\nquestions — ${jobs.length} (${lo.arms.join(', ')}), judges ${lo.judges.join(', ')}`)
  const questions = await pool(jobs, opts.concurrency, async ({ c, q, index, arm }) => {
    const r = await runQuestion(sut, brains.get(c.sample_id), c, q, index, arm, path.join(workDir, 'locomo', c.sample_id, 'q', arm, String(index)), opts, lo)
    const marks = lo.judges.map(j => (r.verdicts[j] ? (r.verdicts[j]!.correct ? '✓' : '✗') : '·')).join('')
    console.log(`  ${r.error ? '!' : marks} ${arm.padEnd(12)} ${c.sample_id} #${index} ${r.category}${r.error ? ` (${r.error})` : ''}`)
    return r
  })
  return { ingest, questions }
}

async function ingestConversation(sut: Sut, c: Conversation, dir: string, opts: AgentOptions, lo: LocomoOptions): Promise<{ brain: Brain; result: IngestResult }> {
  const { speaker_a: a, speaker_b: b } = c.conversation
  const fresh = path.join(dir, 'brain-empty')
  fs.rmSync(fresh, { recursive: true, force: true })
  const prov = provisionBrain(sut, fresh, 'reader', 'assistant')
  const empty: Brain = { dataDir: fresh, token: prov.tokenPlaintext, agent: 'assistant', ids: {}, titles: {}, baseVersion: sut.version }
  const ws = await openWorkspace('eml', sut, empty, path.join(dir, 'ingest'))
  const result: IngestResult = { conversation: c.sample_id, sessions: [], engrams: 0, cost_usd: 0, errors: 0 }
  const sessions = chatSessions(c).slice(0, lo.sessions ?? undefined)
  try {
    for (const s of sessions) {
      const ans = await askClaudeCode(ws, opts, { prompt: ingestPrompt(s, a, b), label: `session${s.n}`, writable: true, system: system('eml', a, b), maxTurns: lo.ingestTurns })
      const writes = countWrites(ans)
      result.sessions.push({ n: s.n, tool_calls: ans.tool_calls.length, writes, usage: ans.usage, cost_usd: ans.cost_usd ?? null, ...(ans.error && { error: ans.error }) })
      if (ans.error) result.errors++
      console.log(`  ${ans.error ? '!' : '+'} ${c.sample_id} session ${s.n}/${sessions.length}: ${writes} writes${ans.error ? ` (${ans.error})` : ''}`)
    }
  } finally {
    await ws.close()
  }
  result.cost_usd = Math.round(result.sessions.reduce((x, s) => x + (s.cost_usd ?? 0), 0) * 100) / 100
  const dataDir = path.join(dir, 'ingest', 'data')
  result.engrams = dumpBrain(sut, path.join(dataDir, prov.brainFile), path.join(dir, 'brain.json'))
  return { brain: { ...empty, dataDir }, result }
}

/** Writes what the agent stored (for reading), returns the number of active engrams. */
function dumpBrain(sut: Sut, brainFile: string, out: string): number {
  const Database = sutSqlite(sut)
  const db = new Database(brainFile, { readonly: true })
  try {
    const rows = db.prepare(`SELECT type, scope, title, content, status, created_at FROM engrams ORDER BY created_at`).all()
    fs.writeFileSync(out, JSON.stringify(rows, null, 2))
    return rows.filter((r: any) => r.status === 'active').length
  } finally {
    db.close()
  }
}

async function runQuestion(sut: Sut, brain: Brain | undefined, c: Conversation, q: Qa, index: number, arm: PublicArm, dir: string, opts: AgentOptions, lo: LocomoOptions): Promise<QuestionResult> {
  const { speaker_a: a, speaker_b: b } = c.conversation
  const r: QuestionResult = {
    conversation: c.sample_id, index, category: LOCOMO_CATEGORIES[q.category], question: q.question, gold: String(q.answer), arm,
    answer: '', verdicts: {}, tool_calls: 0, writes: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: null,
  }
  if (arm === 'eml' && !brain) throw new Error(`no brain for ${c.sample_id}`)
  // full-context needs no brain; the none workspace ignores it.
  const ws: Workspace = await openWorkspace(arm === 'eml' ? 'eml' : 'none', sut, brain ?? ({} as Brain), dir)
  try {
    const ans = await askClaudeCode(ws, opts, { prompt: questionPrompt(arm, c, q), label: 'session', writable: false, system: system(arm, a, b) })
    Object.assign(r, { answer: ans.answer, tool_calls: ans.tool_calls.length, writes: countWrites(ans), usage: ans.usage, cost_usd: ans.cost_usd ?? null, harness: ans.harness })
    if (ans.error) r.error = ans.error
    else if (!ans.answer) r.error = 'no answer'
    else {
      for (const kind of lo.judges) {
        const v = await judgeStructured(ws, opts, judgePrompt(kind, q, ans.answer), `judge-${kind}`, LABEL_SCHEMA)
        if (!v || (v.label !== 'CORRECT' && v.label !== 'WRONG')) throw new Error(`judge ${kind} returned no label`)
        r.verdicts[kind] = { correct: v.label === 'CORRECT', reasoning: v.reasoning }
      }
    }
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err)
  } finally {
    await ws.close()
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 2))
  }
  return r
}

// --- Summary ------------------------------------------------------------------------

export interface PublicArmSummary {
  questions: number
  errors: number
  /** judge → accuracy over all questions (an error counts as wrong) */
  accuracy: Partial<Record<JudgeKind, number>>
  /** judge → category → accuracy */
  by_category: Partial<Record<JudgeKind, Record<string, number>>>
  avg_input_tokens: number
  avg_output_tokens: number
  avg_tool_calls: number
  cost_usd: number
  /** eml: the ingestion cost on top of the questions */
  ingest_cost_usd?: number
}

export function summarizeLocomo(res: { ingest: IngestResult[]; questions: QuestionResult[] }, lo: LocomoOptions): Partial<Record<PublicArm, PublicArmSummary>> {
  const out: Partial<Record<PublicArm, PublicArmSummary>> = {}
  for (const arm of lo.arms) {
    const rs = res.questions.filter(r => r.arm === arm)
    if (!rs.length) continue
    const ok = (r: QuestionResult, j: JudgeKind) => (r.verdicts[j]?.correct ? 1 : 0)
    const s: PublicArmSummary = {
      questions: rs.length,
      errors: rs.filter(r => r.error).length,
      accuracy: {},
      by_category: {},
      avg_input_tokens: Math.round(mean(rs.map(r => r.usage.input + r.usage.cache_read + r.usage.cache_write))),
      avg_output_tokens: Math.round(mean(rs.map(r => r.usage.output))),
      avg_tool_calls: Math.round(mean(rs.map(r => r.tool_calls)) * 10) / 10,
      cost_usd: Math.round(rs.reduce((x, r) => x + (r.cost_usd ?? 0), 0) * 100) / 100,
    }
    for (const j of lo.judges) {
      s.accuracy[j] = mean(rs.map(r => ok(r, j)))
      const cats: Record<string, number> = {}
      for (const cat of Object.values(LOCOMO_CATEGORIES)) {
        const xs = rs.filter(r => r.category === cat)
        if (xs.length) cats[cat] = mean(xs.map(r => ok(r, j)))
      }
      s.by_category[j] = cats
    }
    if (arm === 'eml') s.ingest_cost_usd = Math.round(res.ingest.reduce((x, i) => x + i.cost_usd, 0) * 100) / 100
    out[arm] = s
  }
  return out
}

export function printLocomoSummary(s: Partial<Record<PublicArm, PublicArmSummary>>, res: { ingest: IngestResult[]; questions: QuestionResult[] }, lo: LocomoOptions): void {
  const arms = Object.keys(s) as PublicArm[]
  const col = (f: (a: PublicArmSummary) => string) => arms.map(a => f(s[a]!).padStart(14)).join('')
  console.log(`\nlocomo — categories 1–4`)
  console.log(`  ${''.padEnd(24)}${arms.map(a => a.padStart(14)).join('')}`)
  console.log(`  ${'questions'.padEnd(24)}${col(a => String(a.questions))}`)
  for (const j of lo.judges) {
    console.log(`  ${`J (${j})`.padEnd(24)}${col(a => (a.accuracy[j]! * 100).toFixed(1))}`)
    for (const cat of Object.values(LOCOMO_CATEGORIES)) {
      if (arms.some(a => a in s && s[a]!.by_category[j]?.[cat] !== undefined)) {
        const n = res.questions.filter(r => r.arm === arms[0] && r.category === cat).length
        console.log(`  ${`  ${cat} (n=${n})`.padEnd(24)}${col(a => ((a.by_category[j]?.[cat] ?? 0) * 100).toFixed(1))}`)
      }
    }
  }
  console.log(`  ${'errors'.padEnd(24)}${col(a => String(a.errors))}`)
  console.log(`  ${'avg input tokens'.padEnd(24)}${col(a => String(a.avg_input_tokens))}`)
  console.log(`  ${'avg output tokens'.padEnd(24)}${col(a => String(a.avg_output_tokens))}`)
  console.log(`  ${'avg tool calls'.padEnd(24)}${col(a => String(a.avg_tool_calls))}`)
  console.log(`  ${'cost $ questions'.padEnd(24)}${col(a => String(a.cost_usd))}`)
  if (s.eml) console.log(`  ${'cost $ ingest (eml)'.padEnd(24)}${String(s.eml.ingest_cost_usd).padStart(14)}`)
  for (const i of res.ingest) {
    console.log(`  ingest ${i.conversation}: ${i.sessions.length} sessions, ${i.sessions.reduce((x, y) => x + y.writes, 0)} writes, ${i.engrams} active engrams, ${i.errors} errors, $${i.cost_usd}`)
  }
}
