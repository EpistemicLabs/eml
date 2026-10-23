import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { provisionBrain, type Brain } from './fixture'
import type { Sut } from './sut'
import { openWorkspace, type Workspace } from './arms'
import { countWrites, pool, mean, type AgentOptions, type Answer } from './agent'
import { askClaudeCode, judgeStructured } from './runner-claude-code'
import { dumpBrain, type PublicArm } from './locomo'

// --- Public benchmark: LongMemEval -------------------------------------------------
//
// LongMemEval (Wu et al., ICLR 2025), the S variant: 500 questions, each with its
// own history of ~50 dated chat sessions between a user and an assistant (~115k
// tokens), a few of which hold the answer. Question types: single-session-user,
// single-session-assistant, single-session-preference, multi-session,
// knowledge-update, temporal-reasoning; 30 questions (id ending in _abs) are
// unanswerable from the history and test abstention.
//
// Arms as in locomo.ts, same model and harness:
//
//   eml           a fresh brain per question. The history goes in as agent sessions
//                 in order, several chat sessions per agent session (batched up to
//                 a size, each chat session with its date): one agent session per
//                 chat session would mean ~50 per question. The agent decides what
//                 to keep. Then the question in a fresh session.
//   full-context  the whole history, with dates, in the prompt; no tools.
//   recent-context  M only (its history fits no context window): the newest
//                 sessions within a budget, in the prompt; no tools.
//   bm25-context  M only: the sessions a BM25 search with the question ranks
//                 highest, within the same budget, in date order in the prompt;
//                 no tools. Search instead of memory — the retrieval baseline of
//                 the LongMemEval paper, at session granularity.
//
// All get the question's date ("current date"), as in the official reader.
//
// Sample: a stratified sample, the same n per question type, picked by a fixed hash
// of the question id — reproducible, and reported as a sample.
//
// Grading: the official type-specific judge prompts of the LongMemEval repo,
// verbatim, with the judge model (yes/no). The official judge is GPT-4o; the model
// is reported with the result.
//
// The dataset (MIT) is not part of this repository: `eml-bench
// longmemeval-download` puts it into a cache directory, checked against its hash.

const LME_REVISION = '98d7416c24c778c2fee6e6f3006e7a073259d48f'
export const LME_CACHE_DIR = path.join(os.homedir(), '.cache', 'eml-bench', 'longmemeval')

/**
 * S: ~48 sessions / ~115k tokens of history per question. M: ~500 sessions / ~1.5M
 * tokens — more than any context window, so full-context is replaced by
 * recent-context there. Both are one JSON array; M is 2.7 GB, too large to parse
 * whole, so after the download each variant is split into one file per question.
 */
export type LmeVariant = 's' | 'm'
const LME_FILES: Record<LmeVariant, { name: string; sha256: string }> = {
  s: { name: 'longmemeval_s_cleaned.json', sha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442' },
  m: { name: 'longmemeval_m_cleaned.json', sha256: '9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f' },
}

export const LME_TYPES = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'multi-session', 'knowledge-update', 'temporal-reasoning']

/** full-context: the whole history in the prompt (S). recent-context / bm25-context: the newest / best-matching sessions that fit a budget (M). */
export type LmeArm = PublicArm | 'recent-context' | 'bm25-context'
export const LME_ARMS: LmeArm[] = ['eml', 'full-context', 'recent-context', 'bm25-context']

interface LmeTurn { role: 'user' | 'assistant'; content: string }
export interface LmeQuestion {
  question_id: string
  question_type: string
  question: string
  question_date: string
  answer: string | number
  haystack_dates: string[]
  haystack_sessions: LmeTurn[][]
}

interface IndexEntry { question_id: string; question_type: string }

const splitDir = (v: LmeVariant, dir: string) => path.join(dir, v)

/**
 * Downloads the variant (unless the file is there), checks its hash and splits it
 * into <dir>/<variant>/<question_id>.json plus index.json. Streams throughout: the
 * M file does not fit into one string.
 */
export async function prepareLongMemEval(v: LmeVariant, dir = LME_CACHE_DIR): Promise<void> {
  const { name, sha256 } = LME_FILES[v]
  const file = path.join(dir, name)
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(file)) {
    const url = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${LME_REVISION}/${name}`
    console.log(`downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`)
    const part = `${file}.part`
    const out = fs.createWriteStream(part)
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()))
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    fs.renameSync(part, file)
  }
  const target = splitDir(v, dir)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  const hash = crypto.createHash('sha256')
  const index: IndexEntry[] = []
  await splitTopLevelObjects(file, hash, obj => {
    const q = JSON.parse(obj.toString('utf8')) as LmeQuestion
    fs.writeFileSync(path.join(target, `${q.question_id}.json`), obj)
    index.push({ question_id: q.question_id, question_type: q.question_type })
  })
  const sha = hash.digest('hex')
  if (sha !== sha256) {
    fs.rmSync(target, { recursive: true, force: true })
    throw new Error(`${file}: sha256 ${sha}, expected ${sha256} — delete it and download again`)
  }
  fs.writeFileSync(path.join(target, 'index.json'), JSON.stringify({ file: name, sha256, revision: LME_REVISION, questions: index }, null, 1))
  console.log(`LongMemEval_${v.toUpperCase()} (xiaowu0162/longmemeval-cleaned@${LME_REVISION.slice(0, 7)}, MIT): ${index.length} questions → ${target}`)
}

/**
 * Calls `each` with the bytes of every element of a top-level JSON array of
 * objects, hashing the whole file on the way. Works on bytes: JSON's structural
 * characters are ASCII, and no byte of a multi-byte UTF-8 character is.
 */
export async function splitTopLevelObjects(file: string, hash: crypto.Hash, each: (obj: Buffer) => void): Promise<void> {
  let depth = 0
  let inString = false
  let escaped = false
  let parts: Buffer[] = []
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 22 }) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    let start = depth >= 2 ? 0 : -1
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      if (inString) {
        if (escaped) escaped = false
        else if (c === 0x5c) escaped = true
        else if (c === 0x22) inString = false
        continue
      }
      if (c === 0x22) inString = true
      else if (c === 0x7b || c === 0x5b) {
        depth++
        if (depth === 2) start = i
      } else if (c === 0x7d || c === 0x5d) {
        if (depth === 2) {
          parts.push(chunk.subarray(start, i + 1))
          each(Buffer.concat(parts))
          parts = []
          start = -1
        }
        depth--
      }
    }
    if (depth >= 2 && start >= 0) parts.push(chunk.subarray(start))
  }
  if (depth !== 0) throw new Error(`${file}: unexpected end of the JSON array`)
}

/** The selected questions of a prepared variant: n per type (stratified), or the given ids. */
export function loadLongMemEval(v: LmeVariant, perType: number, only: string[] | null, dir = LME_CACHE_DIR): LmeQuestion[] {
  const target = splitDir(v, dir)
  const indexFile = path.join(target, 'index.json')
  if (!fs.existsSync(indexFile)) throw new Error(`${indexFile} missing — run \`eml-bench longmemeval-download --variant ${v}\` first`)
  const index: IndexEntry[] = JSON.parse(fs.readFileSync(indexFile, 'utf8')).questions
  const picked = only ? index.filter(e => only.includes(e.question_id)) : stratifiedSample(index, perType)
  return picked.map(e => JSON.parse(fs.readFileSync(path.join(target, `${e.question_id}.json`), 'utf8')))
}

/** n questions per type, picked by a hash of the question id (stable across runs and machines, the same ids in S and M). */
export function stratifiedSample<Q extends IndexEntry>(qs: Q[], perType: number): Q[] {
  const key = (q: Q) => crypto.createHash('sha256').update(`eml-bench:${q.question_id}`).digest('hex')
  return LME_TYPES.flatMap(t => qs.filter(q => q.question_type === t).sort((a, b) => key(a).localeCompare(key(b))).slice(0, perType))
}

export const isAbstention = (q: LmeQuestion) => q.question_id.endsWith('_abs')

function renderSession(turns: LmeTurn[], date: string): string {
  return `### Chat session, ${date}\n\n${turns.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n')}`
}

/**
 * The history as rendered sessions, oldest first. The dataset does not keep the
 * haystack in date order (about 40% of the S questions are shuffled), so it is
 * sorted here; the date format ("2023/05/20 (Sat) 02:21") sorts as text.
 */
export function chronological(q: LmeQuestion): string[] {
  return q.haystack_sessions
    .map((s, i) => ({ date: q.haystack_dates[i], i }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.i - b.i)
    .map(({ date, i }) => renderSession(q.haystack_sessions[i], date))
}

/** The history oldest first, cut into batches of about `chars` characters (a session is never split). */
export function batches(q: LmeQuestion, chars: number): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  let size = 0
  for (const text of chronological(q)) {
    if (cur.length && size + text.length > chars) { out.push(cur); cur = []; size = 0 }
    cur.push(text)
    size += text.length
  }
  if (cur.length) out.push(cur)
  return out
}

// --- Prompts ------------------------------------------------------------------------

/** The newest sessions whose text fits into `chars`, oldest first. */
export function recentSessions(q: LmeQuestion, chars: number): string[] {
  const all = chronological(q)
  const out: string[] = []
  let size = 0
  for (let i = all.length - 1; i >= 0 && size + all[i].length <= chars; i--) {
    out.unshift(all[i])
    size += all[i].length
  }
  return out
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const terms = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/**
 * The sessions a BM25 search with the question ranks highest, as many as fit into
 * `chars` (a session that does not fit is skipped, the next one tried), in date order.
 */
export function bm25Sessions(q: LmeQuestion, chars: number): string[] {
  const all = chronological(q)
  const docs = all.map(text => {
    const tf = new Map<string, number>()
    for (const t of terms(text)) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { tf, len: [...tf.values()].reduce((s, n) => s + n, 0) }
  })
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1)
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const query = [...new Set(terms(q.question))]
  const score = (d: (typeof docs)[number]) => query.reduce((s, t) => {
    const f = d.tf.get(t)
    if (!f) return s
    const n = df.get(t)!
    const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
    return s + idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * d.len / avgLen))
  }, 0)
  const ranked = docs.map((d, i) => ({ i, s: score(d) })).sort((a, b) => b.s - a.s || b.i - a.i)
  const picked: number[] = []
  let size = 0
  for (const { i } of ranked) {
    if (size + all[i].length > chars) continue
    picked.push(i)
    size += all[i].length
  }
  return picked.sort((a, b) => a - b).map(i => all[i])
}

function system(arm: LmeArm): string {
  if (arm === 'eml') return `You are the user's AI assistant, with a long-term memory reachable through the memory tools. You are shown your earlier chat sessions with the user, a few at a time and in order, and later answer the user's questions. Answer in plain text.`
  return `You are the user's AI assistant. You are given your earlier chat sessions with the user and answer the user's questions. Answer in plain text.`
}

function ingestPrompt(batch: string[], k: number, of: number): string {
  return `Earlier chat sessions with the user (part ${k} of ${of}):\n\n${batch.join('\n\n')}\n\nKeep in your memory what may matter later.`
}

function questionPrompt(arm: LmeArm, q: LmeQuestion, contextChars: number): string {
  const ask = `Current date: ${q.question_date}\nThe user asks: ${q.question}`
  if (arm === 'eml') return ask
  if (arm === 'recent-context') {
    return `Your most recent chat sessions with the user (older ones do not fit and are left out):\n\n${recentSessions(q, contextChars).join('\n\n')}\n\n${ask}`
  }
  if (arm === 'bm25-context') {
    return `The chat sessions with the user that a search for the question found (the others do not fit and are left out):\n\n${bm25Sessions(q, contextChars).join('\n\n')}\n\n${ask}`
  }
  return `Your earlier chat sessions with the user:\n\n${chronological(q).join('\n\n')}\n\n${ask}`
}

// Verbatim from xiaowu0162/LongMemEval src/evaluation/evaluate_qa.py (d6dc8b5, MIT), get_anscheck_prompt.
function judgePrompt(task: string, question: string, answer: string, response: string, abstention: boolean): string {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
  }
  if (['single-session-user', 'single-session-assistant', 'multi-session'].includes(task)) {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === 'temporal-reasoning') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === 'knowledge-update') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === 'single-session-preference') {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  throw new Error(`unknown question type ${task}`)
}

const YES_NO_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string', enum: ['yes', 'no'] } },
  required: ['answer'],
  additionalProperties: false,
} as const

// --- Run ----------------------------------------------------------------------------

export interface LmeOptions {
  variant: LmeVariant
  arms: LmeArm[]
  perType: number
  /** only these question ids (instead of the sample) */
  only: string[] | null
  batchChars: number
  /** recent-context, bm25-context: the history budget in characters */
  contextChars: number
  ingestTurns: number
}

export interface LmeResult {
  question_id: string
  type: string
  abstention: boolean
  question: string
  gold: string
  arm: LmeArm
  answer: string
  correct: boolean
  ingest?: { batches: number; writes: number; engrams: number; cost_usd: number; errors: number }
  tool_calls: number
  usage: Answer['usage']
  cost_usd: number | null
  harness?: string
  error?: string
}

export async function runLongMemEval(sut: Sut, workDir: string, opts: AgentOptions, lo: LmeOptions, qs: LmeQuestion[]): Promise<LmeResult[]> {
  if (opts.runner !== 'claude-code') throw new Error('longmemeval runs on the claude-code runner')
  if (!qs.length) throw new Error('no question selected')
  const jobs = qs.flatMap(q => lo.arms.map(arm => ({ q, arm })))
  console.log(`\nlongmemeval_${lo.variant} — ${qs.length} questions × ${lo.arms.join(', ')}`)
  return pool(jobs, opts.concurrency, async ({ q, arm }) => {
    const r = await runOne(sut, q, arm, path.join(workDir, 'longmemeval', q.question_id, arm), opts, lo)
    const ing = r.ingest ? ` (${r.ingest.batches} batches, ${r.ingest.writes} writes, ${r.ingest.engrams} engrams)` : ''
    console.log(`  ${r.error ? '!' : r.correct ? '✓' : '✗'} ${arm.padEnd(12)} ${q.question_id} ${q.question_type}${ing}${r.error ? ` — ${r.error}` : ''}`)
    return r
  })
}

async function runOne(sut: Sut, q: LmeQuestion, arm: LmeArm, dir: string, opts: AgentOptions, lo: LmeOptions): Promise<LmeResult> {
  const r: LmeResult = {
    question_id: q.question_id, type: q.question_type, abstention: isAbstention(q), question: q.question, gold: String(q.answer), arm,
    answer: '', correct: false, tool_calls: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: null,
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  let ws: Workspace | undefined
  try {
    let brain: Brain | undefined
    if (arm === 'eml') {
      const fresh = path.join(dir, 'brain-empty')
      const prov = provisionBrain(sut, fresh, 'user', 'assistant')
      const empty: Brain = { dataDir: fresh, token: prov.tokenPlaintext, agent: 'assistant', ids: {}, titles: {}, baseVersion: sut.version }
      const ingestWs = await openWorkspace('eml', sut, empty, path.join(dir, 'ingest'))
      const bs = batches(q, lo.batchChars)
      const ing = { batches: bs.length, writes: 0, engrams: 0, cost_usd: 0, errors: 0 }
      try {
        for (let k = 0; k < bs.length; k++) {
          const a = await askClaudeCode(ingestWs, opts, { prompt: ingestPrompt(bs[k], k + 1, bs.length), label: `ingest${k + 1}`, writable: true, system: system('eml'), maxTurns: lo.ingestTurns })
          ing.writes += countWrites(a)
          ing.cost_usd += a.cost_usd ?? 0
          if (a.error) ing.errors++
        }
      } finally {
        await ingestWs.close()
      }
      ing.cost_usd = Math.round(ing.cost_usd * 100) / 100
      const dataDir = path.join(dir, 'ingest', 'data')
      ing.engrams = dumpBrain(sut, path.join(dataDir, prov.brainFile), path.join(dir, 'brain.json'))
      r.ingest = ing
      brain = { ...empty, dataDir }
    }
    ws = await openWorkspace(arm === 'eml' ? 'eml' : 'none', sut, brain ?? ({} as Brain), path.join(dir, 'ask'))
    const a = await askClaudeCode(ws, opts, { prompt: questionPrompt(arm, q, lo.contextChars), label: 'session', writable: false, system: system(arm) })
    Object.assign(r, { answer: a.answer, tool_calls: a.tool_calls.length, usage: a.usage, cost_usd: a.cost_usd ?? null, harness: a.harness })
    if (a.error) r.error = a.error
    else if (!a.answer) r.error = 'no answer'
    else {
      const v = await judgeStructured(ws, opts, judgePrompt(q.question_type, q.question, String(q.answer), a.answer, isAbstention(q)), 'judge', YES_NO_SCHEMA)
      if (!v || (v.answer !== 'yes' && v.answer !== 'no')) throw new Error('judge returned no answer')
      r.correct = v.answer === 'yes'
    }
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err)
  } finally {
    await ws?.close()
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 2))
  }
  return r
}

// --- Summary ------------------------------------------------------------------------

export interface LmeArmSummary {
  questions: number
  errors: number
  /** each question counts once */
  accuracy: number
  /** mean over the question types (some vendors report this one) */
  accuracy_macro: number
  by_type: Record<string, { n: number; accuracy: number }>
  abstention: { n: number; accuracy: number }
  avg_input_tokens: number
  avg_tool_calls: number
  cost_usd: number
  ingest_cost_usd?: number
  avg_engrams?: number
}

export function summarizeLongMemEval(rs: LmeResult[], arms: LmeArm[]): Partial<Record<LmeArm, LmeArmSummary>> {
  const out: Partial<Record<LmeArm, LmeArmSummary>> = {}
  for (const arm of arms) {
    const xs = rs.filter(r => r.arm === arm)
    if (!xs.length) continue
    const acc = (ys: LmeResult[]) => mean(ys.map(r => (r.correct ? 1 : 0)))
    const by_type: LmeArmSummary['by_type'] = {}
    for (const t of LME_TYPES) {
      const ys = xs.filter(r => r.type === t)
      if (ys.length) by_type[t] = { n: ys.length, accuracy: acc(ys) }
    }
    const abs = xs.filter(r => r.abstention)
    const ing = xs.filter(r => r.ingest)
    out[arm] = {
      questions: xs.length,
      errors: xs.filter(r => r.error).length,
      accuracy: acc(xs),
      accuracy_macro: mean(Object.values(by_type).map(t => t.accuracy)),
      by_type,
      abstention: { n: abs.length, accuracy: abs.length ? acc(abs) : 0 },
      avg_input_tokens: Math.round(mean(xs.map(r => r.usage.input + r.usage.cache_read + r.usage.cache_write))),
      avg_tool_calls: Math.round(mean(xs.map(r => r.tool_calls)) * 10) / 10,
      cost_usd: Math.round(xs.reduce((s, r) => s + (r.cost_usd ?? 0), 0) * 100) / 100,
      ...(ing.length && {
        ingest_cost_usd: Math.round(ing.reduce((s, r) => s + r.ingest!.cost_usd, 0) * 100) / 100,
        avg_engrams: Math.round(mean(ing.map(r => r.ingest!.engrams)) * 10) / 10,
      }),
    }
  }
  return out
}

export function printLongMemEvalSummary(s: Partial<Record<LmeArm, LmeArmSummary>>, variant: LmeVariant): void {
  const arms = Object.keys(s) as LmeArm[]
  const col = (f: (a: LmeArmSummary) => string) => arms.map(a => f(s[a]!).padStart(14)).join('')
  console.log(`\nlongmemeval_${variant} — sample`)
  console.log(`  ${''.padEnd(30)}${arms.map(a => a.padStart(14)).join('')}`)
  console.log(`  ${'questions'.padEnd(30)}${col(a => String(a.questions))}`)
  console.log(`  ${'accuracy'.padEnd(30)}${col(a => (a.accuracy * 100).toFixed(1))}`)
  console.log(`  ${'accuracy (mean over types)'.padEnd(30)}${col(a => (a.accuracy_macro * 100).toFixed(1))}`)
  for (const t of LME_TYPES) {
    const n = s[arms[0]]!.by_type[t]?.n
    if (n) console.log(`  ${`  ${t} (n=${n})`.padEnd(30)}${col(a => ((a.by_type[t]?.accuracy ?? 0) * 100).toFixed(1))}`)
  }
  console.log(`  ${`  abstention (n=${s[arms[0]]!.abstention.n})`.padEnd(30)}${col(a => (a.abstention.accuracy * 100).toFixed(1))}`)
  console.log(`  ${'errors'.padEnd(30)}${col(a => String(a.errors))}`)
  console.log(`  ${'avg input tokens / question'.padEnd(30)}${col(a => String(a.avg_input_tokens))}`)
  console.log(`  ${'avg tool calls'.padEnd(30)}${col(a => String(a.avg_tool_calls))}`)
  console.log(`  ${'cost $ questions'.padEnd(30)}${col(a => String(a.cost_usd))}`)
  if (s.eml) console.log(`  ${'cost $ ingest (eml)'.padEnd(30)}${String(s.eml.ingest_cost_usd ?? 0).padStart(14)}   avg engrams ${s.eml.avg_engrams}`)
}
