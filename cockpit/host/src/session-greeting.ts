/**
 * The first prompt of a plain new session when the greeting is on (Settings ›
 * Preferences › Sessions). It shows in the terminal as the user's message, so
 * it is short and reads as one; the reply follows the user's preferred
 * language from their profile. A folder project, or a brain project that no
 * longer exists, has no project block: the agent says so instead of searching.
 *
 * The greeting says nothing about what the session is for, so it must not
 * name the session: the provider's own title (taken from the first prompt)
 * and the first-prompt summary skip it (session-summary.ts per provider), and
 * the agent names the session itself once the user's reply shows what it is
 * about (session-title-cli.ts).
 */
export const GREETING_PROMPT =
  'Session start: greet me briefly, say which project this session is in and where it stands from the ' +
  'project block you were given (status, next step, open tasks); if there is none, say so in one line ' +
  'instead of searching. Then ask what I want to work on. Answer in my preferred language. ' +
  'Once my reply shows what this session is about, name it in a few words: node "$COCKPIT_TITLE_JS" "<title>".'

/** Every greeting so far starts with this; it identifies one in a session from before the ledger recorded it. */
const GREETING_START = 'Session start: greet me briefly'

/**
 * Whether a session's first user prompt is the greeting. `greeted` is what the
 * ledger recorded at spawn; null for a session from before it did, which falls
 * back to the prompt's text.
 */
export function firstPromptIsGreeting(greeted: boolean | null, firstPrompt: string): boolean {
  return greeted ?? firstPrompt.trimStart().startsWith(GREETING_START)
}

/**
 * Only a plain new session opens with the greeting: not a resume, not one with
 * its own first prompt (task run, hygiene, onboarding, spawned work), not a
 * worker — and only when the user turned it on.
 */
export function greetingFor(start: { resume: boolean, initialPrompt: string | null, greet: boolean, worker: boolean }): string | null {
  return start.greet && !start.resume && start.initialPrompt === null && !start.worker ? GREETING_PROMPT : null
}
