import { EmlApiError } from '../http-client'

/**
 * Tool handler wrapper (v0.9-PROPOSAL §6.4 "Error handling — two channels").
 *
 * - Backend errors (e.g. 401/500) → `isError: true` with a message for the
 *   LLM (ideally phrased so the model can self-correct).
 * - Protocol errors (malformed request, unknown tool) are left to the SDK.
 *
 * The CallToolResult type comes from the SDK; we just return the plain object —
 * no type assertion needed (registerTool handles that).
 */
export async function callTool<T>(
  fn: () => Promise<T>,
  // v0.10.9: optional prefix prepended to a successful result's rendered text
  // (the write tools use it to surface the potential_conflicts banner).
  opts?: { prefix?: (result: T) => string | null },
): Promise<{
  content: Array<{ type: 'text', text: string }>
  isError?: boolean
}> {
  try {
    const result = await fn()
    const pre = opts?.prefix?.(result)
    const body = JSON.stringify(result, null, 2)
    return { content: [{ type: 'text', text: pre ? `${pre}\n\n${body}` : body }] }
  } catch (err: unknown) {
    if (err instanceof EmlApiError) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `EML API error (HTTP ${err.status}): ${err.message}`,
        }],
      }
    }
    const e = err as Error
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool execution failed: ${e.message}` }],
    }
  }
}

// v0.10.9: write-time conflict guardrail rendering. The store response may carry an
// advisory `potential_conflicts` array (see core findPotentialConflicts). When present,
// the write tools prepend a banner so the resolve instruction reaches the agent at the
// exact moment of the write. Confidence escalation: a near-identical candidate (coverage
// ≥ ESCALATION) gets sharper wording. Advisory only — the write already succeeded.
export const CONFLICT_ESCALATION_COVERAGE = 0.8

interface ConflictCandidateView {
  id: string
  type: string
  title: string | null
  gist: string
  coverage: number
}

export function conflictBanner(result: unknown): string | null {
  const pc = (result as { potential_conflicts?: ConflictCandidateView[] } | null)?.potential_conflicts
  if (!pc || pc.length === 0) return null

  const top = Math.max(...pc.map(c => c.coverage))
  const header = top >= CONFLICT_ESCALATION_COVERAGE
    ? `⚠ near-identical active engram${pc.length > 1 ? 's' : ''} already exist${pc.length > 1 ? '' : 's'} — resolve before continuing.`
    : `⚠ ${pc.length} possibly conflicting/duplicate active engram${pc.length > 1 ? 's' : ''} found (advisory).`

  const lines = pc.map(c =>
    `  • [${c.type}] ${c.title ?? '(no title)'} · ${c.id.slice(0, 8)} · coverage ${c.coverage} — ${c.gist.slice(0, 120)}`,
  )

  return [
    header,
    ...lines,
    'Evaluate each: supersede (eml_update status=superseded) / merge (eml_update content) / ' +
    'relate (contradicts | related_to) / dismiss — before continuing.',
  ].join('\n')
}

// v0.14: filing into a CLOSED subject is allowed (late filing) — the server flags it
// as `closed_subjects` on the write response. Surface it so the agent notices when it
// meant an active strand (then fix via eml_update subjects, or reopen the subject).
export function closedSubjectBanner(result: unknown): string | null {
  const closed = (result as { closed_subjects?: string[] } | null)?.closed_subjects
  if (!closed || closed.length === 0) return null
  return `ℹ filed into closed subject${closed.length > 1 ? 's' : ''} ${closed.join(', ')} — fine for late filing; ` +
    'if the strand is ongoing again, reopen via eml_subject_update(status=active).'
}

// v0.14 Cluster C: `[[targets]]` in content that resolved to no engram. Surfaced
// as a line (parallel to closed_subjects) so the agent notices a broken link — the
// edge was NOT drawn, and add-only means it won't retry unless the link resolves later.
export function unresolvedLinksBanner(result: unknown): string | null {
  const links = (result as { unresolved_links?: string[] } | null)?.unresolved_links
  if (!links || links.length === 0) return null
  return `ℹ unresolved wikilink${links.length > 1 ? 's' : ''} ${links.map(l => `[[${l}]]`).join(' ')} — no edge drawn; ` +
    'create the target (or fix the title/id) then re-save to link it.'
}

// v0.15: superseding a parent task does not cascade — its open sub-tasks stay open
// and the server lists them as `open_subtasks`. Surface them so the agent moves each
// to the successor (eml_relate part_of) or closes it.
export function openSubtasksBanner(result: unknown): string | null {
  const subs = (result as { open_subtasks?: Array<{ parent_id: string, id: string, title: string | null }> } | null)?.open_subtasks
  if (!subs || subs.length === 0) return null
  return [
    `⚠ ${subs.length} open sub-task${subs.length > 1 ? 's' : ''} of the superseded task stay${subs.length > 1 ? '' : 's'} open:`,
    ...subs.map(s => `  • ${s.title ?? '(no title)'} · ${s.id}`),
    'Move each to the successor (eml_relate part_of) or close it.',
  ].join('\n')
}

/** v0.14: all write-response banners (conflicts + closed subjects + unresolved links + v0.15 open sub-tasks), in that order. */
export function writeBanner(result: unknown): string | null {
  const parts = [conflictBanner(result), closedSubjectBanner(result), unresolvedLinksBanner(result), openSubtasksBanner(result)]
    .filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join('\n\n') : null
}
