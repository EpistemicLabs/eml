import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { situation, type Workspace } from './arms'
import { VERDICT_SCHEMA, type AgentOptions, type Answer, type Verdict } from './agent'
import { idsInOrder } from './retrieval'

// --- Runner: Claude Code -------------------------------------------------------------
//
// Headless Claude Code (`claude -p`), one process per session, isolated from the
// machine it runs on: HOME points into the workspace, which lies outside any
// repository (Claude Code reads CLAUDE.md files from parent directories), and
// every session gets a fresh CLAUDE_CONFIG_DIR — a scenario's sessions share one
// (see SessionSpec.configKey). No user CLAUDE.md, settings or MCP servers. Per arm:
//
//   eml        the SUT's MCP server as `eml_brain` and its SessionStart /
//              UserPromptSubmit hooks, the way the cockpit configures a session;
//              only the eml_brain tools
//   claude-md  CLAUDE.md in the working directory (Claude Code loads it); in a
//              scenario also Read/Edit/Write, to keep the file
//   none       no tools
//
// Signs in with a Claude Code token (CLAUDE_CODE_OAUTH_TOKEN, `claude setup-token`).

const MCP_NAME = 'eml_brain'

export interface SessionSpec {
  prompt: string
  /** names the session's files (stream log, config dir) */
  label: string
  /** scenario sessions: the arm may change its memory (claude-md gets file tools) */
  writable: boolean
  /**
   * Sessions with the same config key share a CLAUDE_CONFIG_DIR — a scenario's
   * sessions do, so Claude Code's own memory carries over as it would for a user.
   * Default: the label (a fresh config dir).
   */
  configKey?: string
}

export async function askClaudeCode(ws: Workspace, opts: AgentOptions, spec: SessionSpec): Promise<Answer> {
  const args = [
    '-p', spec.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', opts.model,
    '--effort', opts.effort,
    '--permission-mode', 'dontAsk',
    '--max-turns', String(opts.maxTurns),
    '--append-system-prompt', situation(ws.arm),
    '--no-session-persistence',
    '--strict-mcp-config',
  ]
  // Claude Code's own auto-memory only where it is part of the arm: the claude-md
  // arm in a scenario keeps it (it is part of the free alternative); everywhere
  // else it is off — the eml arm measures EML alone, and without file tools the
  // model would write its memory calls as text.
  const settings: Record<string, unknown> = { autoMemoryEnabled: ws.arm === 'claude-md' && spec.writable }
  if (ws.arm === 'eml') {
    const hookCmd = (name: string) => `${shq(process.execPath)} ${shq(ws.sut.mcpEntry)} hook ${name} --config ${shq(ws.configPath!)}`
    const mcpConfig = path.join(ws.dir, 'mcp.json')
    fs.writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: { [MCP_NAME]: { command: process.execPath, args: [ws.sut.mcpEntry, '--url', ws.server!.url, '--token', ws.token!, '--name', 'eml-bench'] } },
    }, null, 2), { mode: 0o600 })
    settings.hooks = {
      SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('session-start') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('user-prompt-submit') }] }],
    }
    args.push('--tools', '', '--mcp-config', mcpConfig, '--allowedTools', `mcp__${MCP_NAME}`)
  } else if (ws.arm === 'claude-md' && spec.writable) {
    args.push('--tools', 'Read,Edit,Write', '--allowedTools', 'Read', 'Edit', 'Write')
  } else {
    args.push('--tools', '')
  }
  const settingsFile = path.join(ws.dir, `settings-${spec.label}.json`)
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
  args.push('--settings', settingsFile)

  const events = await claude(ws, opts, args, spec.label, spec.configKey ?? spec.label)
  const out: Answer = { answer: '', tool_calls: [], seen_ids: [], turns: 0, stop: '', usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
  const seen = new Set<string>()
  for (const ev of events) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.harness = `claude-code ${ev.claude_code_version ?? '?'}`
      if (ws.arm === 'eml') {
        const status = (ev.mcp_servers ?? []).find((m: any) => m.name === MCP_NAME)?.status
        if (status !== 'connected') out.error = `MCP server ${MCP_NAME}: ${status ?? 'missing'}`
      }
    } else if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'tool_use') out.tool_calls.push({ name: String(b.name).replace(`mcp__${MCP_NAME}__`, ''), input: b.input })
      }
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== 'tool_result') continue
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: any) => c.text ?? '').join('\n')
        for (const id of idsInOrder(text)) seen.add(id)
      }
    } else if (ev.type === 'result') {
      out.answer = typeof ev.result === 'string' ? ev.result.trim() : ''
      out.turns = ev.num_turns ?? 0
      out.stop = ev.stop_reason ?? ev.subtype ?? ''
      out.cost_usd = ev.total_cost_usd
      out.usage = {
        input: ev.usage?.input_tokens ?? 0,
        output: ev.usage?.output_tokens ?? 0,
        cache_read: ev.usage?.cache_read_input_tokens ?? 0,
        cache_write: ev.usage?.cache_creation_input_tokens ?? 0,
      }
      if (ev.is_error) out.error = `claude: ${ev.subtype}${ev.api_error_status ? ` (${ev.api_error_status})` : ''}`
    }
  }
  if (!events.some(ev => ev.type === 'result') && !out.error) out.error = 'claude ended without a result'
  out.seen_ids = [...seen]
  return out
}

export async function judgeClaudeCode(ws: Workspace, opts: AgentOptions, prompt: string, label: string): Promise<Verdict> {
  const events = await claude(ws, opts, [
    '-p', prompt,
    '--output-format', 'json',
    '--model', opts.judgeModel,
    '--effort', 'low',
    '--tools', '',
    '--strict-mcp-config',
    '--json-schema', JSON.stringify(VERDICT_SCHEMA),
    '--settings', JSON.stringify({ autoMemoryEnabled: false }),
    '--no-session-persistence',
  ], label, label, true)
  const v = events.find(ev => ev.type === 'result')?.structured_output
  if (!v || typeof v.correct !== 'boolean') throw new Error('judge returned no verdict')
  return v as Verdict
}

/** Runs `claude` isolated; returns the JSON events it printed. The judge runs outside the workspace (no CLAUDE.md). */
// Rate limits and overload end a session with an error result; wait and run it again.
const RETRY_STATUS = new Set([429, 529])
const RETRIES = 4

async function claude(ws: Workspace, opts: AgentOptions, args: string[], label: string, configKey: string, judge = false): Promise<any[]> {
  for (let attempt = 0; ; attempt++) {
    const events = await claudeOnce(ws, opts, args, label, configKey, judge)
    const status = events.find(ev => ev.type === 'result')?.api_error_status
    if (!RETRY_STATUS.has(status) || attempt >= RETRIES) return events
    const wait = 30_000 * 2 ** attempt
    console.log(`  … ${label}: API ${status}, retry in ${wait / 1000}s (${path.relative(path.dirname(path.dirname(ws.dir)), ws.dir)})`)
    await new Promise(r => setTimeout(r, wait))
  }
}

function claudeOnce(ws: Workspace, opts: AgentOptions, args: string[], label: string, configKey: string, judge: boolean): Promise<any[]> {
  if (!opts.claudeToken) throw new Error('claude-code runner: no Claude Code token (CLAUDE_CODE_OAUTH_TOKEN or --claude-token-file)')
  const env = {
    ...ws.env,
    CLAUDE_CONFIG_DIR: path.join(ws.dir, `claude-config-${configKey}`),
    CLAUDE_CODE_OAUTH_TOKEN: opts.claudeToken,
  }
  const cwd = judge ? path.join(ws.dir, 'judge') : ws.cwd
  fs.mkdirSync(cwd, { recursive: true })
  const logFile = path.join(ws.dir, `${label}.jsonl`)
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', () => {
      clearTimeout(timer)
      fs.writeFileSync(logFile, stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''))
      const events: any[] = []
      for (const line of stdout.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try { events.push(JSON.parse(t)) } catch { /* partial line */ }
      }
      if (!events.length) return reject(new Error(`claude printed no events — see ${logFile}`))
      resolve(events)
    })
  })
}

/** Single-quote for the shell that runs hook commands. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
