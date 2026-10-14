import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME } from './paths.js'
import { readCockpitConfig, writeCockpitConfig } from './config.js'
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
 * /api/setup → signIn; FirstRunSignIn), whose button opens a /login session
 * (queueSignInSession); the getting-started session is queued only once
 * Claude Code is installed and signed in. Onboarding counts as done once a tab
 * has opened that session; until then (no tab yet, host restarted) it starts
 * over on the next start.
 */

export const ONBOARDING_DIR = path.join(COCKPIT_HOME, 'getting-started')
export const ONBOARDING_PROMPT = '/getting-started'
export const LOGIN_PROMPT = '/login'
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
 * A session that starts with Claude Code's own sign-in (/login) — Settings ›
 * Models › Sign in. Runs in `projectId` (the user's active project) or, without
 * one, in the Getting started project. It takes the place of an empty desk.
 */
export function queueSignInSession(projects: ProjectRegistry, spawns: SpawnQueue, projectId: string | null): string {
  const target = projectId ?? ensureOnboardingProject(projects)
  return spawns.add({ projectId: target, prompt: LOGIN_PROMPT, title: 'Sign in to Claude', provider: 'claude', fromSessionId: null, placement: 'replace-empty-desk' }).id
}

/**
 * Queue the session once Claude is ready. The project is registered only then
 * (or by the sign-in session): until it exists the desk's first pane stays
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
      // The first run is a Claude Code one: the sign-in step before it is
      // Claude Code's /login, and its readiness check asks Claude Code.
      provider: 'claude',
      fromSessionId: null,
      // Instead of an empty desk; next to the sign-in session otherwise.
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
  const config = await readCockpitConfig()
  if (config && config.onboarding !== 'done') await writeCockpitConfig({ ...config, onboarding: 'done' })
}
