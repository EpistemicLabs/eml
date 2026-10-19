import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'
import { subjects, tags } from './_shared'

/**
 * v0.19: eml_learning (note mcp-tool-surface-v2-tool-drafts §11). One learning
 * per topic; each incident is evidence. The server checks the topic on every
 * call without id and computes ripeness; the response carries it.
 */
export function registerLearningTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_learning', {
    title: 'Record Learning',
    description:
      'Records a lesson about how you should work, with this user or in general, backed by what happened. One ' +
      'lesson per topic; each new incident is added as evidence to the existing learning. Not loaded at boot and ' +
      'never binding: it becomes a rule only when it is ripe and the user agrees.\n\n' +
      'When: the user corrects you or confirms a non-obvious approach · the user turns down a proposal or ' +
      'redirects you · you notice a mistake or a hit of your own. Consolidate also reviews the session for such ' +
      'moments.\n\n' +
      'The server always checks for an existing learning on the topic. On a match it writes nothing new and names ' +
      'it: add your incident there with id, or pass new_topic=true if it really is a different topic.\n\n' +
      'Ripe (the response says so) → at the next natural stop (end of a task, consolidate), not mid-work, ask the ' +
      'user whether to make it a rule; on yes eml_rule(from_learning=[id], agreed=…); on no, record the no with ' +
      'the user\'s words (stance declined).\n\n' +
      'NOT a learning: technical or domain knowledge → eml_note · who someone is → eml_profile · a way of working ' +
      'the user states explicitly → ask whether to make it a rule (eml_rule) · a choice about the thing being ' +
      'built → eml_decide.',
    inputSchema: z.object({
      id: z.string().optional().describe('An existing learning: adds this incident as evidence instead of creating a new learning.'),
      content: z.string().optional().describe('Required on create: the lesson as an instruction to yourself, at most 200 characters. Can be sharpened on a later call.'),
      scope: z.string().optional().describe('Required on create: user.<id> (usual) · agent.<id> · project.<id> · global.'),
      title: z.string().optional().describe('Required on create: the topic.'),
      source: z.enum(['user', 'observed', 'self']).describe('Where this evidence comes from: user (the user said it) · observed (read from the user\'s reaction) · self (you noticed it yourself).'),
      happened: z.string().describe('What concretely happened in this incident.'),
      quote: z.string().optional().describe('Required when source=user (and for a decline): the user\'s words, verbatim.'),
      stance: z.enum(['supports', 'contradicts', 'declined']).optional().describe('supports (default) · contradicts (this incident speaks against the lesson) · declined (the user said no to making it a rule).'),
      new_topic: z.boolean().optional().describe('true = create a new learning although the server found a similar one.'),
      rule_id: z.string().optional().describe('The incident concerns an existing rule (violated or not fitting); input for that rule\'s review.'),
      task_id: z.string().optional().describe('Noted in the task\'s journal.'),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(
    () => http.post('/learning', Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))),
    { prefix: learningBanner },
  ))
}

/** The topic match (nothing written) or the ripeness after the write. */
export function learningBanner(result: unknown): string | null {
  const r = result as { written?: boolean, matches?: Array<{ id: string, title: string | null, coverage: number, content: string }>, learning?: { state: string } } | null
  if (!r) return null
  if (r.written === false && r.matches) {
    return [
      `ℹ nothing written — an active learning on this topic exists:`,
      ...r.matches.map(m => `  • ${m.title ?? '(no title)'} · ${m.id} · coverage ${m.coverage} — ${m.content.slice(0, 120)}`),
      'Add your incident there with id, or pass new_topic=true if it really is a different topic.',
    ].join('\n')
  }
  const state = r.learning?.state
  const lines: string[] = []
  if (state === 'ripe') lines.push('✓ ripe — at the next natural stop, ask the user whether to make it a rule (eml_rule from_learning=[id], agreed=…).')
  if (state === 'unclear') lines.push('⚠ unclear — contradicting evidence is open. Ask the user, then sharpen content (eml_learning id + content) or invalidate it.')
  if (state === 'paused') lines.push('ℹ paused — the user declined a rule; the question waits for two more incidents from different sessions.')
  const banner = writeBanner(result)
  if (banner) lines.push(banner)
  return lines.length > 0 ? lines.join('\n\n') : null
}
