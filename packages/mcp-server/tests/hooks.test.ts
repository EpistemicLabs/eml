import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { sessionStart, shouldRemind, reminderFor, userPromptSubmit, REMINDER_TEXT, formatHookOutput, BOOT_BUDGET_CHARS } from '../src/hooks/index'

const CFG = { EML_URL: 'http://127.0.0.1:1', EML_API_TOKEN: 'eml_test' }

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('hook session-start', () => {
  it('emits the boot markdown', async () => {
    const r = await sessionStart(CFG, '/x/config', fakeFetch(200, { markdown: '# EML Boot — assistant', version: '0.13.0' }))
    expect(r.output).toBe('# EML Boot — assistant')
    expect(r.log).toMatch(/^OK/)
  })

  it('boots as the agent the embedding app names', async () => {
    let sent: unknown
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ markdown: 'boot', version: '0.20.5' }), { status: 200 })
    }) as unknown as typeof fetch
    await sessionStart({ ...CFG, EML_AGENT: 'helper' }, '/x', f)
    expect(sent).toEqual({ budget: BOOT_BUDGET_CHARS, agent: 'helper' })
  })

  it('asks /boot for the Claude Code budget and logs what the trim cost', async () => {
    let sent: unknown
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        markdown: 'boot', version: '0.17.18', legacy: 3,
        budget: { limit: 10000, chars: 4, situational_title_only: 2, always_title_only: 1, profiles_title_only: 0, left_out: 0, fits: true },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await sessionStart(CFG, '/x', f)
    expect(sent).toEqual({ budget: BOOT_BUDGET_CHARS })
    // The output plus the newline runHook prints stays within Claude Code's 10,000.
    expect(BOOT_BUDGET_CHARS + 1).toBe(10_000)
    expect(r.output).toBe('boot')
    expect(r.log).toBe('OK ver=0.17.18 chars=4 trim=situational:2,always:1 legacy=3')
  })

  it('logs trim=none for an untouched boot and flags one over budget', async () => {
    const untouched = fakeFetch(200, { markdown: 'boot', budget: { limit: 10000, chars: 4, situational_title_only: 0, always_title_only: 0, profiles_title_only: 0, left_out: 0, fits: true } })
    expect((await sessionStart(CFG, '/x', untouched)).log).toMatch(/trim=none$/)
    const leftOut = fakeFetch(200, { markdown: 'boot', budget: { limit: 10000, chars: 4, situational_title_only: 0, always_title_only: 60, profiles_title_only: 0, left_out: 120, fits: true } })
    expect((await sessionStart(CFG, '/x', leftOut)).log).toMatch(/trim=always:60,left_out:120$/)
    const over = fakeFetch(200, { markdown: 'boot', budget: { limit: 10000, chars: 12000, situational_title_only: 5, fits: false } })
    expect((await sessionStart(CFG, '/x', over)).log).toMatch(/trim=OVER-BUDGET limit=10000$/)
    const old = fakeFetch(200, { markdown: 'boot' })
    expect((await sessionStart(CFG, '/x', old)).log).toMatch(/trim=unknown$/)
    // A pre-0.18 server answers with the cut-ladder report.
    const ladder = fakeFetch(200, { markdown: 'boot', budget: { limit: 10000, chars: 4, rule_cap: 600, rules_named_only: 0, profiles_named_only: 0, fits: true } })
    expect((await sessionStart(CFG, '/x', ladder)).log).toMatch(/trim=unknown$/)
  })

  it('tells a rejected token apart from an unreachable server', async () => {
    expect((await sessionStart(CFG, '/x/config', fakeFetch(401, {}))).output).toMatch(/token was rejected \(HTTP 401\)/)
    const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect((await sessionStart(CFG, '/x/config', down)).output).toMatch(/unreachable/)
    expect((await sessionStart(CFG, '/x/config', fakeFetch(500, {}))).output).toMatch(/HTTP 500/)
  })

  it('reports a missing or incomplete config instead of failing', async () => {
    expect((await sessionStart(null, '/x/config')).output).toMatch(/no EML config at \/x\/config/)
    expect((await sessionStart({ EML_URL: 'http://a' }, '/x/config')).output).toMatch(/missing/)
  })
})

describe('hook user-prompt-submit', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eml-hook-test-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const ctx = () => ({ configPath: path.join(dir, 'config'), logDir: path.join(dir, 'logs'), stateDir: path.join(dir, 'state') })

  it('reminds on turn 1, every 5th turn and after a long pause', () => {
    expect(shouldRemind(1, null)).toBe(true)
    expect(shouldRemind(2, 1000)).toBe(false)
    expect(shouldRemind(5, 1000)).toBe(true)
    expect(shouldRemind(3, 2 * 60 * 60 * 1000)).toBe(true)
  })

  it('counts turns per session in its own state dir', () => {
    const input = { session_id: 'abc-123', cwd: '/work/eml' }
    const outs = [1, 2, 3, 4, 5].map(() => userPromptSubmit(ctx(), input).output)
    expect(outs.map(Boolean)).toEqual([true, false, false, false, true])
    expect(fs.readFileSync(path.join(dir, 'state', 'turns', 'abc-123'), 'utf8')).toBe('5')
  })

  it('stays silent without a usable session id', () => {
    expect(userPromptSubmit(ctx(), {}).output).toBe('')
    expect(userPromptSubmit(ctx(), { session_id: '../escape' }).output).toBe('')
  })

  it('names the project from cwd, but not for the home dir', () => {
    expect(reminderFor('/work/eml', '/home/u')).toMatch(/eml_show project\.eml/)
    expect(reminderFor('/home/u', '/home/u')).toBe(REMINDER_TEXT)
  })

  it('drops the cwd nudge when the host delivers the project block', () => {
    expect(reminderFor('/work/eml', '/home/u', false)).toBe(REMINDER_TEXT)
    const input = { session_id: 'abc-456', cwd: '/work/eml' }
    expect(userPromptSubmit(ctx(), input, Date.now(), false).output).toBe(REMINDER_TEXT)
  })
})

// v0.15: the reminder lives twice — REMINDER_TEXT (node hook) and the heredoc in
// the bash template. They must stay in lockstep; this catches a one-sided edit.

describe('hook output format', () => {
  it('prints the context as it is by default', () => {
    expect(formatHookOutput('user-prompt-submit', '[EML Reminder]\n- x', false)).toBe('[EML Reminder]\n- x')
  })

  it('wraps it in the hook JSON envelope with --json', () => {
    expect(JSON.parse(formatHookOutput('user-prompt-submit', '[EML Reminder]\n- x', true))).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[EML Reminder]\n- x' },
    })
    expect(JSON.parse(formatHookOutput('session-start', '# EML Boot', true)).hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(JSON.parse(formatHookOutput('project-block', '# Project', true)).hookSpecificOutput.hookEventName).toBe('SessionStart')
  })
})
