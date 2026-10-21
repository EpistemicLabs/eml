import fs from 'fs'
import path from 'path'
import { Api, startServer, sutCore, sutSqlite, type Sut } from './sut'
import { compareVersions } from './baseline'

// --- Fixture brain ----------------------------------------------------------------
//
// fixture/brain.json is written into a fresh data dir THROUGH the REST API of a
// base version (default: the SUT itself), the way an agent would have written it.
// The ids the server hands out are kept per fixture key, so questions can name
// engrams by key. Measuring a newer SUT on a brain written by an older base
// version exercises the migration path as well.

export const FIXTURE_DIR = path.resolve(__dirname, '../fixture')

export interface FixtureEngram {
  key: string
  type: string
  scope: string
  title: string
  content: string
  age_days: number
  status?: string
  significance?: string
  properties?: Record<string, unknown>
  supersedes?: string[]
}

export interface FixtureBrain {
  agent: string
  user: string
  projects: { id: string; name: string; goal?: string }[]
  engrams: FixtureEngram[]
}

export interface Brain {
  dataDir: string
  token: string
  agent: string
  /** fixture key → engram id */
  ids: Record<string, string>
  /** fixture key → title */
  titles: Record<string, string>
  baseVersion: string
}

/** brain.json (the engrams the questions are about) followed by volume.json (everything around them). */
export function readFixture(): FixtureBrain {
  const core: FixtureBrain = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'brain.json'), 'utf8'))
  const volume: Pick<FixtureBrain, 'projects' | 'engrams'> = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'volume.json'), 'utf8'))
  const brain = { ...core, projects: [...core.projects, ...volume.projects], engrams: [...core.engrams, ...volume.engrams] }
  const keys = new Set<string>()
  for (const e of brain.engrams) {
    if (keys.has(e.key)) throw new Error(`fixture: duplicate key ${e.key}`)
    keys.add(e.key)
  }
  return brain
}

const DAY_MS = 86_400_000

export async function buildBrain(base: Sut, dataDir: string): Promise<Brain> {
  const fixture = readFixture()
  fs.mkdirSync(dataDir, { recursive: true })
  const core = sutCore(base)
  const control = core.initControlDatabase(path.join(dataDir, 'control.db'))
  const prov = core.provisionUser({
    email: `${fixture.user}@example.invalid`,
    agentId: fixture.agent,
    userId: fixture.user,
    control,
    dataDir,
  })
  control.close()

  const server = await startServer(base, dataDir, path.join(dataDir, 'load.log'))
  const ids: Record<string, string> = {}
  const titles: Record<string, string> = {}
  const now = Date.now()
  try {
    const api = new Api(server.url, prov.tokenPlaintext)
    const write = compareVersions(base.version, '0.19.0') >= 0 ? writeV19 : writeLegacy
    for (const p of fixture.projects) await write.project(api, p)
    for (const e of fixture.engrams) {
      const properties: Record<string, unknown> = { ...(e.properties ?? {}) }
      if (e.type === 'event' && properties.occurred_at === undefined) {
        properties.occurred_at = new Date(now - e.age_days * DAY_MS).toISOString()
      }
      const supersedes = (e.supersedes ?? []).map(k => mustId(ids, k, e.key))
      ids[e.key] = await write.engram(api, e, properties, supersedes)
      titles[e.key] = e.title
    }
  } finally {
    await server.stop()
  }

  // Age the engrams: recency is part of the ranking, so a brain where everything
  // was written in the same second would not rank like a real one. A task's
  // journal entries are aged with it (open tasks sort by their last activity).
  const Database = sutSqlite(base)
  const db = new Database(path.join(dataDir, prov.brainFile))
  try {
    const stmt = db.prepare('UPDATE engrams SET created_at = ?, updated_at = ? WHERE id = ?')
    const table = (name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
    const entries = table('entries') ? db.prepare('UPDATE entries SET at = ? WHERE engram_id = ?')
      : table('task_entries') ? db.prepare('UPDATE task_entries SET at = ? WHERE task_id = ?') : null
    db.transaction(() => {
      for (const e of fixture.engrams) {
        const t = new Date(now - e.age_days * DAY_MS).toISOString()
        stmt.run(t, t, ids[e.key])
        entries?.run(t, ids[e.key])
      }
    })()
  } finally {
    db.close()
  }

  const brain: Brain = { dataDir, token: prov.tokenPlaintext, agent: fixture.agent, ids, titles, baseVersion: base.version }
  return brain
}

// How the fixture is written, per API generation of the base version. The
// fixture is the same; only the routes and the shape of the body differ.
interface Writer {
  project(api: Api, p: FixtureBrain['projects'][number]): Promise<void>
  /** Writes the engram, returns its id. */
  engram(api: Api, e: FixtureEngram, properties: Record<string, unknown>, supersedes: string[]): Promise<string>
}

/** Up to v0.18: POST /project and POST /context with a properties object. */
const writeLegacy: Writer = {
  async project(api, p) { await api.call('POST', '/project', p) },
  async engram(api, e, properties, supersedes) {
    if (supersedes.length) properties.supersedes = supersedes
    const stored = await api.call('POST', '/context', {
      type: e.type, scope: e.scope, title: e.title, content: e.content,
      status: e.status, significance: e.significance,
      properties: Object.keys(properties).length ? properties : undefined,
    })
    return stored.id
  },
}

/**
 * From v0.19: POST /object/project and POST /engram/<type> with the type's
 * fields flat in the body. A task is never created closed: a closed fixture
 * task is created, then closed through POST /task/<id>/track with its outcome.
 * A status has no title and supersedes the previous one by itself.
 */
const writeV19: Writer = {
  async project(api, p) { await api.call('POST', '/object/project', p) },
  async engram(api, e, properties, supersedes) {
    const { outcome, ...fields } = properties
    const closed = e.type === 'task' && (e.status === 'resolved' || e.status === 'invalidated')
    // a status has no title since v0.19 (one per scope; its history is the supersedes chain)
    const body: Record<string, unknown> = { scope: e.scope, ...(e.type === 'status' ? {} : { title: e.title }), content: e.content, ...fields }
    if (e.type === 'task') body.status = closed ? 'planned' : e.status
    else if (outcome !== undefined) body.outcome = outcome
    if (supersedes.length && e.type !== 'status') body.supersedes = supersedes
    const stored = await api.call('POST', `/engram/${e.type}`, body)
    if (closed) {
      await api.call('POST', `/task/${stored.id}/track`, { status: e.status, outcome: outcome ?? 'done', text: 'closed (fixture)', keep: [] })
    }
    return stored.id
  },
}

function mustId(ids: Record<string, string>, key: string, from: string): string {
  const id = ids[key]
  if (!id) throw new Error(`fixture: ${from} supersedes ${key}, which is not written before it`)
  return id
}
