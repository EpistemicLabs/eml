import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { SITUATION, VERDICT_SCHEMA, type AgentOptions, type Answer, type Session, type Verdict } from './agent'
import { idsInOrder } from './retrieval'

// --- Runner: Claude Code -------------------------------------------------------------
//
// Headless Claude Code (`claude -p`) per question, configured the way the cockpit
// configures a session with EML: the SUT's MCP server as `eml_brain`, its
// SessionStart and UserPromptSubmit hooks. Isolated from the machine it runs on:
// HOME and CLAUDE_CONFIG_DIR point into the question's directory (no user
// CLAUDE.md, settings, MCP servers or memory), no built-in tools, only the
// eml_brain tools are allowed. Signs in with a Claude Code token
// (CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`).

const MCP_NAME = 'eml_brain'

export async function askClaudeCode(s: Session, opts: AgentOptions): Promise<Answer> {
  const q = s.question
  const hookCmd = (name: string) => `${shq(process.execPath)} ${shq(s.sut.mcpEntry)} hook ${name} --config ${shq(s.configPath)}`
  const mcpConfig = path.join(s.dir, 'mcp.json')
  fs.writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: {
      [MCP_NAME]: { command: process.execPath, args: [s.sut.mcpEntry, '--url', s.server.url, '--token', s.token, '--name', 'eml-bench'] },
    },
  }, null, 2), { mode: 0o600 })
  const settings = path.join(s.dir, 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('session-start') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('user-prompt-submit') }] }],
    },
  }, null, 2))

  const lines = await claude(s, opts, [
    '-p', q.agent!.question,
    '--output-format', 'stream-json', '--verbose',
    '--model', opts.model,
    '--effort', opts.effort,
    '--tools', '',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--settings', settings,
    '--allowedTools', `mcp__${MCP_NAME}`,
    '--permission-mode', 'dontAsk',
    '--max-turns', String(opts.maxTurns),
    '--append-system-prompt', SITUATION,
    '--no-session-persistence',
  ], path.join(s.dir, 'stream.jsonl'))

  const out: Answer = { answer: '', tool_calls: [], seen_ids: [], turns: 0, stop: '', usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
  const seen = new Set<string>()
  for (const ev of lines) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.harness = `claude-code ${ev.claude_code_version ?? '?'}`
      const status = (ev.mcp_servers ?? []).find((m: any) => m.name === MCP_NAME)?.status
      if (status !== 'connected') out.error = `MCP server ${MCP_NAME}: ${status ?? 'missing'}`
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
  if (!lines.some(ev => ev.type === 'result') && !out.error) out.error = 'claude ended without a result'
  out.seen_ids = [...seen]
  return out
}

export async function judgeClaudeCode(s: Session, opts: AgentOptions, prompt: string): Promise<Verdict> {
  const lines = await claude(s, opts, [
    '-p', prompt,
    '--output-format', 'json',
    '--model', opts.judgeModel,
    '--effort', 'low',
    '--tools', '',
    '--strict-mcp-config',
    '--json-schema', JSON.stringify(VERDICT_SCHEMA),
    '--no-session-persistence',
  ], path.join(s.dir, 'judge.json'))
  const v = lines.find(ev => ev.type === 'result')?.structured_output
  if (!v || typeof v.correct !== 'boolean') throw new Error('judge returned no verdict')
  return v as Verdict
}

/** Runs `claude` isolated in the question's directory; returns the JSON events it printed. */
function claude(s: Session, opts: AgentOptions, args: string[], logFile: string): Promise<any[]> {
  if (!opts.claudeToken) throw new Error('claude-code runner: no Claude Code token (CLAUDE_CODE_OAUTH_TOKEN or --claude-token-file)')
  const env = {
    ...s.env,
    CLAUDE_CONFIG_DIR: path.join(s.dir, 'claude-config'),
    CLAUDE_CODE_OAUTH_TOKEN: opts.claudeToken,
  }
  return new Promise((resolve, reject) => {
    // A neutral working directory: the prompt reminder derives a project from its name.
    const cwd = path.join(s.dir, 'workspace')
    fs.mkdirSync(cwd, { recursive: true })
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
