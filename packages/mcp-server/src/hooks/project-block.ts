import type { EmlConfig } from '../config'

/**
 * The project block (core/project-block.ts; note rule-delivery-model-draft,
 * point 7): the project's status, open tasks, latest session and ALL its rules,
 * injected without the agent asking. Its own hook command, so it has its own
 * output limit and does not share the reminder's or the boot's.
 *
 * The project comes from EML_PROJECT_SCOPE, which a host sets per session (the
 * EML cockpit does, pty-bridge.ts). Without it the hook is silent — it does not
 * guess a project from the working directory.
 *
 * When: on every SessionStart (startup, resume, compact, clear), as a second
 * command next to `hook session-start`. The event itself brings it back after
 * a compaction or a resume, so the hook keeps no state, and every block is
 * current. The order of the two outputs is not guaranteed; each stands alone.
 * A project the brain does not know (a folder without a brain project) gets no
 * block. Every failure is silent; the boot already reports an unreachable
 * server or a rejected token.
 */

/**
 * Claude Code's limit for one hook's plain stdout, the same as the boot's
 * (hooks/index.ts, BOOT_BUDGET_CHARS): above it the model only sees a preview.
 * The limit holds per hook command, so the block does not share the boot's
 * (scripts/hook-budget-gate.sh checks that). One character below the limit for
 * the newline runHook prints after the output.
 */
export const PROJECT_BLOCK_BUDGET_CHARS = 10_000 - 1

const TIMEOUT_MS = 5000
const SAFE_SCOPE = /^project\.[A-Za-z0-9_.-]+$/

export interface ProjectBlockInput {
  source?: string
}

interface BlockBody {
  markdown?: string
  legacy?: number
  open_tasks?: number
  pending_reviews?: number
  budget?: {
    limit: number
    chars: number
    tasks_title_only: number
    tasks_left_out: number
    log_left_out: boolean
    situational_title_only: number
    always_title_only: number
    rules_left_out: number
    fits: boolean
  }
}

/** What the budget cost, for the hook log: trim=none, or the entries that gave way per kind. */
export function trimSummary(b: BlockBody['budget']): string {
  if (!b) return 'trim=unknown'
  if (!b.fits) return `trim=OVER-BUDGET limit=${b.limit}`
  const parts = ([
    ['tasks_title_only', b.tasks_title_only],
    ['tasks_left_out', b.tasks_left_out],
    ['log_left_out', b.log_left_out ? 1 : 0],
    ['situational', b.situational_title_only],
    ['always', b.always_title_only],
    ['rules_left_out', b.rules_left_out],
  ] as const).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`)
  return parts.length === 0 ? 'trim=none' : `trim=${parts.join(',')}`
}

export async function projectBlockHook(
  cfg: EmlConfig | null,
  input: ProjectBlockInput,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  budget: number = PROJECT_BLOCK_BUDGET_CHARS,
): Promise<{ output: string; log: string }> {
  const scope = env.EML_PROJECT_SCOPE ?? ''
  if (!SAFE_SCOPE.test(scope)) return { output: '', log: 'project-block: no project scope, silent' }
  if (!cfg?.EML_URL || !cfg.EML_API_TOKEN) return { output: '', log: 'project-block: skipped (no config)' }
  const source = input.source ?? '?'

  let status = 0
  let body: BlockBody = {}
  try {
    const res = await fetchImpl(`${cfg.EML_URL}/project-block`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.EML_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, budget }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = res.status
    if (res.ok) body = (await res.json()) as BlockBody
  } catch (err) {
    return { output: '', log: `project-block: unreachable ${(err as Error).message}` }
  }
  if (status === 404) return { output: '', log: `project-block: no project ${scope} in the brain (${source})` }
  if (status !== 200 || typeof body.markdown !== 'string') return { output: '', log: `project-block: http ${status} (${source})` }

  const counts = `tasks=${body.open_tasks ?? '?'} reviews=${body.pending_reviews ?? '?'} legacy=${body.legacy ?? '?'}`
  return {
    output: body.markdown,
    log: `project-block: OK ${scope} ${source} chars=${body.markdown.length} ${trimSummary(body.budget)} ${counts}`,
  }
}
