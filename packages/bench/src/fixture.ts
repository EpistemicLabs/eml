import fs from 'fs'
import path from 'path'
import { Api, startServer, sutCore, sutSqlite, type Sut } from './sut'

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
    for (const p of fixture.projects) await api.call('POST', '/project', p)
    for (const e of fixture.engrams) {
      const properties: Record<string, unknown> = { ...(e.properties ?? {}) }
      if (e.supersedes?.length) properties.supersedes = e.supersedes.map(k => mustId(ids, k, e.key))
      if (e.type === 'event' && properties.occurred_at === undefined) {
        properties.occurred_at = new Date(now - e.age_days * DAY_MS).toISOString()
      }
      const stored = await api.call('POST', '/context', {
        type: e.type, scope: e.scope, title: e.title, content: e.content,
        status: e.status, significance: e.significance,
        properties: Object.keys(properties).length ? properties : undefined,
      })
      ids[e.key] = stored.id
      titles[e.key] = e.title
    }
  } finally {
    await server.stop()
  }

  // Age the engrams: recency is part of the ranking, so a brain where everything
  // was written in the same second would not rank like a real one.
  const Database = sutSqlite(base)
  const db = new Database(path.join(dataDir, prov.brainFile))
  try {
    const stmt = db.prepare('UPDATE engrams SET created_at = ?, updated_at = ? WHERE id = ?')
    db.transaction(() => {
      for (const e of fixture.engrams) {
        const t = new Date(now - e.age_days * DAY_MS).toISOString()
        stmt.run(t, t, ids[e.key])
      }
    })()
  } finally {
    db.close()
  }

  const brain: Brain = { dataDir, token: prov.tokenPlaintext, agent: fixture.agent, ids, titles, baseVersion: base.version }
  return brain
}

function mustId(ids: Record<string, string>, key: string, from: string): string {
  const id = ids[key]
  if (!id) throw new Error(`fixture: ${from} supersedes ${key}, which is not written before it`)
  return id
}
