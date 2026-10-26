import type { EntryInput, EvidenceSource, EvidenceStance } from '../entries'
import { appendEntry, EVIDENCE_SOURCES, EVIDENCE_STANCES } from '../entries'
import { learningState } from '../learning'
import { validateNoTemplateLeak } from '../validate'
import { unknownFieldsError, isBlank } from '../fields'
import {
  CONFLICT_CANDIDATE_LIMIT, CONFLICT_COVERAGE_THRESHOLD, CONFLICT_MAX, LEARN_KEYS, LEARNING_CONTENT_MAX_CHARS,
  extractSalientTerms, termCoverage, type LearnInput, type LearnResult,
} from '../engrams'
import { validateScope } from '../write/scope'
import { normalizeAndValidateTags, normalizeAndValidateSubjects, insertEngramTags, insertEngramSubjects } from '../write/tags-subjects'
import { materializeWikilinks } from '../write/wikilinks'
import type { CommandContext } from './types'

// --- Learnings (eml_learning) -------------------------------------------------------
//
// The two writes of a learning: a new one with its first evidence (the
// learning half of engram.create) and an incident for an existing one
// (learning.add_evidence). Both check the evidence with one set of rules and
// messages.

/** The evidence rules both halves share: the input's keys, then the incident. Returns its entry. */
export function evidenceOf(ctx: CommandContext, input: LearnInput): EntryInput {
  const { db } = ctx
  const unknown = Object.keys(input).filter(k => !LEARN_KEYS.has(k) && (input as unknown as Record<string, unknown>)[k] !== undefined)
  if (unknown.length > 0) throw unknownFieldsError('learning', unknown, [...LEARN_KEYS])
  if (!(EVIDENCE_SOURCES as readonly string[]).includes(input.source as string)) {
    throw new Error(`Invalid engram: source must be one of ${EVIDENCE_SOURCES.join(', ')} — where this evidence comes from.`)
  }
  const stance = input.stance ?? 'supports'
  if (!(EVIDENCE_STANCES as readonly string[]).includes(stance)) {
    throw new Error(`Invalid engram: stance must be one of ${EVIDENCE_STANCES.join(', ')}.`)
  }
  if (isBlank(input.happened)) throw new Error('Invalid engram: happened is required — what concretely happened in this incident.')
  if ((input.source === 'user' || stance === 'declined') && isBlank(input.quote)) {
    throw new Error(`Invalid engram: ${stance === 'declined' ? 'a decline' : 'evidence from the user'} needs quote — the user's words, verbatim.`)
  }
  if (input.content !== undefined) {
    if (isBlank(input.content)) throw new Error('Invalid engram: content must not be empty — the lesson as an instruction to yourself.')
    validateNoTemplateLeak(input.content)
    if (input.content.length > LEARNING_CONTENT_MAX_CHARS) {
      throw new Error(`Invalid engram: a learning's content is at most ${LEARNING_CONTENT_MAX_CHARS} characters (got ${input.content.length}) — the lesson as an instruction to yourself.`)
    }
  }
  if (input.rule_id !== undefined) {
    const r = db.prepare('SELECT type FROM engrams WHERE id = ?').get(input.rule_id) as { type: string } | undefined
    if (r?.type !== 'rule') throw new Error(`Invalid engram: rule_id ${input.rule_id} is not a rule.`)
  }
  const evidence: EntryInput = {
    kind: 'evidence', text: input.happened, source: input.source as EvidenceSource, stance: stance as EvidenceStance,
    ...(input.quote !== undefined ? { quote: input.quote } : {}),
    ...(input.rule_id !== undefined ? { rule_id: input.rule_id } : {}),
  }
  return evidence
}

/**
 * v0.20: engram.create with type learning — a new lesson with its first
 * evidence. The topic is checked first: an active learning on the same topic
 * in the scope or the session's agent/user scopes → nothing is written, the
 * response names the match (pass its id, or new_topic=true for a different topic).
 */
export function createLearning(ctx: CommandContext, input: Omit<LearnInput, 'id'>): LearnResult {
  const { db, stamp } = ctx
  if ((input as LearnInput).id !== undefined) throw new Error('Invalid engram: a new learning has no id — evidence for an existing one is learning.add_evidence.')
  const actor = stamp.actor
  const evidence = evidenceOf(ctx, input)
  if (evidence.stance !== 'supports') throw new Error('Invalid engram: a new learning starts from supporting evidence.')
  if (isBlank(input.content)) throw new Error('Invalid engram: a new learning needs content — the lesson as an instruction to yourself.')
  if (isBlank(input.scope)) throw new Error('Invalid engram: a new learning needs scope (usually user.<id>).')
  if (isBlank(input.title)) throw new Error('Invalid engram: a new learning needs a title — the topic.')
  validateScope(ctx, input.scope!)
  if (!input.new_topic) {
    const matches = findLearningTopic(ctx, input.title!, input.content!, input.scope!, actor.handle, stamp.at)
    if (matches.length > 0) return { written: false, matches }
  }
  const tagSlugs = input.tags !== undefined ? normalizeAndValidateTags(ctx, input.tags) : undefined
  const subjectSlugs = input.subjects !== undefined ? normalizeAndValidateSubjects(ctx, input.subjects) : undefined
  const id = stamp.newId()
  const now = stamp.at
  stamp.created.add(id)
  db.prepare(`
    INSERT INTO engrams (id, content, type, scope, title, status, significance, properties,
      ingested_by, ingestion_method, session_id, model, harness, created_at, updated_at, rev)
    VALUES (?, ?, 'learning', ?, ?, 'active', 'normal', NULL, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, input.content, input.scope, input.title, actor.handle, actor.ingestion_method,
    actor.session_id, actor.model, actor.harness, now, now)
  db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`).run(id, input.content, input.scope, input.title)
  appendEntry(db, id, evidence, stamp)
  if (tagSlugs && tagSlugs.length > 0) insertEngramTags(ctx, id, tagSlugs)
  if (subjectSlugs && subjectSlugs.length > 0) insertEngramSubjects(ctx, id, subjectSlugs)
  materializeWikilinks(ctx, id, input.content!, input.scope!)
  return { written: true, engram: ctx.store.getRaw(id, stamp.at)!, learning: learningState(ctx.store.entries(id)) }
}

/**
 * The topic check of eml_learning: active learnings whose title and content
 * cover the new one's salient terms (the conflict gate, run on learnings
 * only), in the scope and the agent / user scopes of the session.
 */
function findLearningTopic(ctx: CommandContext, title: string, content: string, scope: string, caller: string | null, now: string): Array<{ id: string, scope: string, title: string | null, content: string, coverage: number }> {
  const { db } = ctx
  const salient = extractSalientTerms(title, content)
  if (salient.length === 0) return []
  const scopes = new Set<string>([scope])
  if (caller) scopes.add(`agent.${caller}`)
  for (const u of db.prepare('SELECT id FROM users').all() as Array<{ id: string }>) scopes.add(`user.${u.id}`)
  // the scope filter is part of the query, so the limit applies after it (the C0 bug class)
  const candidates = ctx.store.query({ type: 'learning', scopes: [...scopes], search: salient.join(' '), search_mode: 'or', statuses: ['active'], order_by: 'score', limit: CONFLICT_CANDIDATE_LIMIT, now })
  return candidates
    .map(c => ({ id: c.id, scope: c.scope, title: c.title, content: c.content, coverage: Math.round(termCoverage(salient, `${c.title ?? ''} ${c.content}`) * 100) / 100 }))
    .filter(c => c.coverage >= CONFLICT_COVERAGE_THRESHOLD || (c.title !== null && c.title === title))
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, CONFLICT_MAX)
}
