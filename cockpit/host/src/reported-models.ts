import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ModelOption } from './domain/session-runtime.js'

/**
 * chat-models.json: the models each agent's last chat offered (its `capabilities` event), by provider id.
 * A provider that cannot list its models without a session (Claude Code: the Agent SDK names them only
 * once a session runs) is offered these in the launchers' picker, also after a restart. Nothing here is
 * secret: model ids, names and descriptions.
 */

// More than a picker shows; a list longer than this is cut.
const MAX_MODELS = 50

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max ? value : null)

/** A model as the file keeps it: the fields of ModelOption, each checked; null when it is not one. */
function modelOf(value: unknown): ModelOption | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id, 200)
  const label = text(raw.label, 200)
  if (!id || !label) return null
  const efforts = Array.isArray(raw.efforts)
    ? raw.efforts.flatMap((one: unknown) => {
      const effort = one as Record<string, unknown> | null
      const effortId = text(effort?.id, 100)
      const effortLabel = text(effort?.label, 100)
      return effortId && effortLabel ? [{ id: effortId, label: effortLabel, description: text(effort?.description, 500) ?? '' }] : []
    })
    : null
  return {
    id, label, description: text(raw.description, 500) ?? '', resolved: text(raw.resolved, 200),
    ...(efforts && efforts.length > 0 ? { efforts, defaultEffort: text(raw.defaultEffort, 100) } : {}),
  }
}

export class ReportedModels {
  private byProvider: Record<string, ModelOption[]> | null = null

  constructor(private file: string) {}

  /** The models this provider's last chat offered; empty when none ever ran here. */
  read(provider: string): ModelOption[] {
    return this.all()[provider] ?? []
  }

  /** A chat of this provider offered these; written only when the list changed. An empty list says nothing. */
  remember(provider: string, models: ModelOption[]): void {
    const kept = models.map(modelOf).filter((model): model is ModelOption => model !== null).slice(0, MAX_MODELS)
    if (kept.length === 0) return
    const all = this.all()
    if (JSON.stringify(all[provider] ?? []) === JSON.stringify(kept)) return
    this.byProvider = { ...all, [provider]: kept }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.file, JSON.stringify(this.byProvider, null, 2) + '\n', { mode: 0o600 })
    } catch { /* the list stays in memory; the next chat writes it again */ }
  }

  private all(): Record<string, ModelOption[]> {
    if (this.byProvider) return this.byProvider
    let parsed: unknown = null
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { /* none yet, or unreadable: start empty */ }
    const lists: Record<string, ModelOption[]> = {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [provider, models] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(models)) lists[provider] = models.map(modelOf).filter((model): model is ModelOption => model !== null).slice(0, MAX_MODELS)
      }
    }
    this.byProvider = lists
    return lists
  }
}
