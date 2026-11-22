import { query } from '@anthropic-ai/claude-agent-sdk'
import { tmpdir } from 'node:os'

import { CLAUDE_BIN } from './runtime.js'

/** The model of a short helper call (a split's brief): quick, and good enough to summarise. */
export const ONE_SHOT_MODEL = 'sonnet'

/**
 * One short call to Claude under a space's config folder (its sign-in): no tools, no session kept,
 * one turn. Returns the answer's text.
 */
export async function claudeOneShot(configDir: string, prompt: string): Promise<string> {
  let text = ''
  for await (const message of query({
    prompt,
    options: {
      cwd: tmpdir(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      model: ONE_SHOT_MODEL,
      tools: [],
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success') throw new Error(`the brief call ended with ${message.subtype}`)
      text = message.result
    }
  }
  return text
}
