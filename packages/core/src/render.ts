import type { Engram, ScopedBrainState } from './types'

/** v0.10.5 DISPLAY: content-preview caps (characters). */
export const RECALL_PREVIEW_CHARS = 200
export const SHOW_PREVIEW_CHARS = 160

/** Collapse all whitespace/newlines to single spaces and cap to maxChars (… if truncated). */
export function previewText(content: string | null | undefined, maxChars: number): string {
  const flat = (content ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? flat.slice(0, maxChars) + '…' : flat
}

/**
 * v0.10.5 DISPLAY: render recall hits as "identify, don't dump". Per hit: a meta
 * line (type | significance | scope | title), a capped content preview, and the
 * full id for eml_get. No full body, no properties dump — the full engram is one
 * eml_get away.
 */
export function renderRecallMarkdown(query: string, results: Engram[]): string {
  const lines = [`# EML Recall — "${query}"`, '', `_${results.length} engram(s)_`, '']
  for (const c of results) {
    // v0.19: significance is no longer written (all normal), so it is not shown.
    const meta: string[] = [c.type]
    if (c.scope) meta.push(c.scope)
    if (c.title) meta.push(c.title)
    lines.push(`- **[${meta.join(' | ')}]**`)
    lines.push(`  ${previewText(c.content, RECALL_PREVIEW_CHARS)}`)
    // v0.11 team-brains: surface authorship when present (shared-brain "who wrote this").
    const by = c.ingested_by ? ` · by ${c.ingested_by}` : ''
    lines.push(`  id: ${c.id}${by} · eml_get for full content`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * v0.10.5 DISPLAY: compact orientation dashboard for one scope. Identify-don't-
 * dump — status/tasks/logs show meta + a capped preview + id; decisions and rules
 * are titles only. Full body always via eml_get.
 *
 * v0.10.8: rules render by applicability — `always` rules full, `situational`
 * rules name-only (eml_get for the body).
 */
export function renderBrainStateMarkdown(state: ScopedBrainState): string {
  const lines: string[] = [`# ${state.scope} — brain state`, '']

  lines.push('## Status')
  // v0.19: what this scope's status is about (the object's status_tracks).
  if (state.status_tracks) lines.push(`_tracks: ${state.status_tracks}_`)
  if (state.current_status.length === 0) lines.push('_none_')
  for (const s of state.current_status) {
    const st = s.properties?.state ? `[${s.properties.state}] ` : ''
    const next = s.properties?.next_step ? ` · next: ${s.properties.next_step}` : ''
    const by = s.ingested_by ? ` · by ${s.ingested_by}` : ''
    lines.push(`- ${st}${previewText(s.content, SHOW_PREVIEW_CHARS)}${next}${by} · ${s.id}`)
  }
  lines.push('')

  lines.push(`## Open tasks (${state.open_tasks.length})`)
  if (state.open_tasks.length === 0) lines.push('_none_')
  for (const t of state.open_tasks) {
    const prio = (t.properties?.priority as string) ?? 'normal'
    // v0.11 team-brains: show assignee handle when present (who owns this task).
    const asg = t.properties?.assignee_id ? ` → ${t.properties.assignee_id as string}` : ''
    // v0.15: the task's stage, when set — [prio·status·stage]
    const stage = t.properties?.stage ? `·${t.properties.stage as string}` : ''
    lines.push(`- [${prio}·${t.status}${stage}]${asg} ${t.title ?? '(no title)'} — ${previewText(t.content, SHOW_PREVIEW_CHARS)} · ${t.id}`)
  }
  lines.push('')

  if (state.recent_logs.length > 0) {
    lines.push('## Latest session')
    for (const l of state.recent_logs) {
      const by = l.ingested_by ? ` · by ${l.ingested_by}` : ''
      // v0.19: a log written with eml_log has its next steps as a field.
      const next = typeof l.properties?.next === 'string' ? ` · next: ${previewText(l.properties.next as string, SHOW_PREVIEW_CHARS)}` : ''
      const body = typeof l.properties?.what === 'string' ? l.properties.what as string : l.content
      lines.push(`- ${l.title ?? '(no title)'} — ${previewText(body, SHOW_PREVIEW_CHARS)}${next}${by} · ${l.id}`)
    }
    lines.push('')
  }

  // v0.10.8: rules render by applicability. `always` rules (ambient in this scope)
  // are shown FULL — you need them whenever you work here. `situational` rules
  // (context-gated playbooks) are a name-only list; eml_get for the full body.
  const rules = state.rules ?? []
  if (rules.length > 0) {
    const always = rules.filter(r => r.properties?.applies === 'always')
    const situational = rules.filter(r => r.properties?.applies !== 'always')
    lines.push('## Rules')
    if (always.length > 0) {
      lines.push('### Always (apply whenever working here)')
      for (const r of always) {
        lines.push(`- **${r.title ?? '(no title)'}** — ${r.content}`)
        lines.push(`  · ${r.id}`)
      }
    }
    if (situational.length > 0) {
      lines.push('### Situational (eml_get when the trigger applies)')
      for (const r of situational) {
        // v0.19: with the trigger, until the project block delivers project rules.
        const trigger = typeof r.properties?.trigger === 'string' ? ` — when: ${r.properties.trigger as string}` : ''
        lines.push(`- ${r.title ?? '(no title)'}${trigger} · ${r.id}`)
      }
    }
    lines.push('')
  }

  // v0.19: learnings ripe for the user's yes (ask at a natural stop, not mid-work).
  const ripe = state.ripe_learnings ?? []
  if (ripe.length > 0) {
    lines.push('## Ripe learnings (ask the user at a natural stop whether to make each a rule)')
    for (const l of ripe) lines.push(`- ${l.title ?? '(no title)'} — ${previewText(l.content, SHOW_PREVIEW_CHARS)} · ${l.id}`)
    lines.push('')
  }

  // v0.19: the project's or entity's stable facts.
  const meta = state.metadata && typeof state.metadata === 'object' ? Object.entries(state.metadata) : []
  if (meta.length > 0) {
    lines.push('## Metadata')
    for (const [k, v] of meta) lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    lines.push('')
  }

  if (state.recent_decisions.length > 0) {
    lines.push('## Decisions')
    for (const d of state.recent_decisions) {
      lines.push(`- ${d.title ?? '(no title)'} · ${d.id}`)
    }
    lines.push('')
  }

  lines.push('_full content: eml_get <id>_')
  return lines.join('\n')
}
