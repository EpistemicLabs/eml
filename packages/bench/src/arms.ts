import fs from 'fs'
import path from 'path'
import { startServer, type Sut, type RunningServer } from './sut'
import { readFixture, type Brain, type FixtureEngram } from './fixture'

// --- Arms -----------------------------------------------------------------------------
//
// The same knowledge, three ways to have it — the comparison that answers "does
// EML help", not only "does EML work":
//
//   eml        the brain, through the version's MCP server and hooks
//   claude-md  the same knowledge as a flat CLAUDE.md in the working directory,
//              which Claude Code loads by itself — the free alternative
//   none       no memory — the floor
//
// The CLAUDE.md is built generously: every engram that is current in EML, by
// project, with its date — superseded entries are left out, as if someone had
// kept the file tidy by hand. Silent contradictions stay in, because EML does not
// know about them either. In multi-session scenarios the agent may edit the file
// (Read/Edit/Write in the working directory), the way it would keep a CLAUDE.md.

export type Arm = 'eml' | 'claude-md' | 'none'
export const ARMS: Arm[] = ['eml', 'claude-md', 'none']

const MEMORY_LINE: Record<Arm, string> = {
  'eml': `Your memory is Alex's brain, reachable through the memory tools.`,
  'claude-md': `Your memory is the project file CLAUDE.md in the working directory.`,
  'none': `You have no memory of earlier sessions.`,
}

/** The agent's situation — not guidance on how to use the memory. */
export function situation(arm: Arm): string {
  return `You are an AI assistant working for Alex, who runs a small online ceramics shop alone. ${MEMORY_LINE[arm]} You cannot deploy, send email or change anything outside your memory; if Alex asks for such an action, say what you would do and whether you would do it now. Answer in plain text, briefly.`
}

/** One arm's environment for one question or one scenario. */
export interface Workspace {
  arm: Arm
  sut: Sut
  dir: string
  /** the agent's working directory (neutral name: the prompt reminder derives a project from it) */
  cwd: string
  /** eml only */
  server?: RunningServer
  token?: string
  /** eml only: the config file the SUT's hooks read */
  configPath?: string
  /** env for everything spawned here: isolated HOME */
  env: Record<string, string>
  close(): Promise<void>
}

export async function openWorkspace(arm: Arm, sut: Sut, brain: Brain, dir: string): Promise<Workspace> {
  fs.rmSync(dir, { recursive: true, force: true })
  const cwd = path.join(dir, 'workspace')
  fs.mkdirSync(cwd, { recursive: true })
  const ws: Workspace = { arm, sut, dir, cwd, env: { PATH: process.env.PATH ?? '', HOME: dir }, close: async () => {} }
  if (arm === 'eml') {
    const dataDir = path.join(dir, 'data')
    fs.cpSync(brain.dataDir, dataDir, { recursive: true, filter: src => !/\.log$/.test(src) })
    const server = await startServer(sut, dataDir, path.join(dir, 'server.log'))
    ws.server = server
    ws.token = brain.token
    ws.configPath = path.join(dir, 'eml-config')
    fs.writeFileSync(ws.configPath, `EML_URL=${server.url}\nEML_API_TOKEN=${brain.token}\n`, { mode: 0o600 })
    ws.close = () => server.stop()
  } else if (arm === 'claude-md') {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), renderClaudeMd())
  }
  return ws
}

const DAY_MS = 86_400_000

/** The fixture as a hand-kept CLAUDE.md (see the header comment for what goes in). */
export function renderClaudeMd(now = Date.now()): string {
  const fixture = readFixture()
  const superseded = new Set<string>()
  for (const e of fixture.engrams) for (const k of e.supersedes ?? []) superseded.add(k)
  // A status replaces the previous status of its scope (what EML does on write).
  const lastStatus = new Map<string, string>()
  for (const e of fixture.engrams) {
    if (e.type !== 'status') continue
    const prev = lastStatus.get(e.scope)
    if (prev) superseded.add(prev)
    lastStatus.set(e.scope, e.key)
  }
  const current = fixture.engrams.filter(e => !superseded.has(e.key))
  const date = (e: FixtureEngram) => new Date(now - e.age_days * DAY_MS).toISOString().slice(0, 10)
  const line = (e: FixtureEngram): string => {
    const p = e.properties ?? {}
    let head = e.type
    if (e.type === 'task') head = e.status === 'resolved' ? `task, done${p.outcome && p.outcome !== 'done' ? `: ${p.outcome}` : ''}` : e.status === 'active' ? 'task, in progress' : 'task, open'
    if (e.type === 'rule') head = p.applies === 'situational' ? `rule, when ${p.trigger}` : 'rule'
    let text = e.content
    if (e.type === 'decision' && p.rationale) text += ` Why: ${p.rationale}`
    return `- ${date(e)} (${head}) ${text}`
  }
  const byScope = new Map<string, FixtureEngram[]>()
  for (const e of current) {
    const list = byScope.get(e.scope) ?? []
    list.push(e)
    byScope.set(e.scope, list)
  }
  const out = [`# Alex — ceramics shop`, '', 'Project memory. Newest entries last within each section.', '']
  const projectName = new Map(fixture.projects.map(p => [`project.${p.id}`, p.name]))
  const order = [...byScope.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const scope of order) {
    const title = scope === 'global' ? 'General' : scope.startsWith('user.') ? 'About Alex' : projectName.get(scope) ?? scope
    out.push(`## ${title}`, '')
    for (const e of byScope.get(scope)!.sort((a, b) => b.age_days - a.age_days)) out.push(line(e))
    out.push('')
  }
  return out.join('\n')
}

function rank(scope: string): number {
  return scope.startsWith('user.') ? 0 : scope === 'global' ? 1 : 2
}
