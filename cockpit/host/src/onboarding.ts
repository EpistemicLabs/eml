import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME } from './paths.js'
import { updateCockpitConfig } from './config.js'
import type { ProjectRegistry } from './project-registry.js'
import type { SpawnQueue } from './spawn-queue.js'

/**
 * The first session of a fresh brain: after the first-run setup the host opens
 * a session that starts with the getting-started skill. It runs in a
 * cockpit-made folder project ("Getting started") — the user's real first
 * project is one the skill creates with them.
 *
 * A fresh home is not signed in to Claude yet, and a first message would land
 * on "Not logged in". So the page first shows its sign-in card (GET
 * /api/setup → signIn), which signs in without a session (the provider's
 * signIn, Settings › Models); the getting-started session is queued only once
 * Claude Code is installed and signed in. It runs in the chat like every
 * session (application/start-worker.ts). Onboarding counts as done once a tab
 * has opened that session; until then (no tab yet, host restarted) it starts
 * over on the next start.
 */

export const ONBOARDING_DIR = path.join(COCKPIT_HOME, 'getting-started')
export const ONBOARDING_PROMPT = '/getting-started'
const READY_POLL_MS = 3000

export interface OnboardingDeps {
  projects: ProjectRegistry
  spawns: SpawnQueue
  /** Whether the agent CLI is installed and signed in (the default provider's auth; a stub in tests). */
  isClaudeReady: () => Promise<boolean>
  pollMs?: number
}

/** The cockpit-made "Getting started" folder project (created on first use). */
export function ensureOnboardingProject(projects: ProjectRegistry): string {
  fs.mkdirSync(ONBOARDING_DIR, { recursive: true })
  return projects.create(ONBOARDING_DIR, 'Getting started').project.projectId
}

/**
 * Queue the session once Claude is ready. The project is registered only then:
 * until it exists the desk's first pane stays
 * empty, so the session can take its place. Returns a stop function.
 */
export function startOnboarding(deps: OnboardingDeps): () => void {
  const isReady = deps.isClaudeReady
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  const queue = () => {
    const request = deps.spawns.add({
      projectId: ensureOnboardingProject(deps.projects),
      prompt: ONBOARDING_PROMPT,
      title: 'Getting started',
      // The first run is a Claude Code one: its readiness check asks Claude Code.
      provider: 'claude',
      fromSessionId: null,
      // Instead of an empty desk.
      placement: 'replace-empty-desk',
    })
    const onClaimed = (id: string) => {
      if (id !== request.id) return
      deps.spawns.off('claimed', onClaimed)
      void markOnboardingDone()
    }
    deps.spawns.on('claimed', onClaimed)
  }

  const check = async () => {
    if (stopped) return
    const ready = await isReady().catch(() => false)
    if (stopped) return
    if (ready) queue()
    else timer = setTimeout(() => void check(), deps.pollMs ?? READY_POLL_MS)
  }
  void check()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

async function markOnboardingDone(): Promise<void> {
  await updateCockpitConfig((config) => (config && config.onboarding !== 'done' ? { ...config, onboarding: 'done' } : null))
}
