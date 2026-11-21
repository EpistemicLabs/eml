import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { connectionSchema, emptySpacePlugins, spacePluginsSchema, type Connection, type SpacePlugins } from '../../domain/space-plugins.js'

const connectionsFileSchema = z.object({ connections: z.array(connectionSchema).default([]) })

/**
 * The plugin state of this cockpit under <home>/plugins/, owner-only: spaces.json (which plugin is
 * on in which space, with which connection) and connections.json (the user's sign-ins and secrets,
 * stored once, never sent to the page). Writes are atomic and one at a time.
 */
export class PluginStore {
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {}

  get spacesFile(): string {
    return path.join(this.dir, 'spaces.json')
  }

  get connectionsFile(): string {
    return path.join(this.dir, 'connections.json')
  }

  /** The state, or the empty one when there is none yet. A broken file throws: switching from nothing would lose what it held. */
  async spaces(): Promise<SpacePlugins> {
    const raw = await readJson(this.spacesFile)
    return raw === null ? emptySpacePlugins() : spacePluginsSchema.parse(raw)
  }

  async connections(): Promise<Connection[]> {
    const raw = await readJson(this.connectionsFile)
    return raw === null ? [] : connectionsFileSchema.parse(raw).connections
  }

  updateSpaces(change: (state: SpacePlugins) => SpacePlugins | Promise<SpacePlugins>): Promise<SpacePlugins> {
    return this.serialised(async () => {
      const next = spacePluginsSchema.parse(await change(await this.spaces()))
      await this.write(this.spacesFile, next)
      return next
    })
  }

  updateConnections(change: (connections: Connection[]) => Connection[] | Promise<Connection[]>): Promise<Connection[]> {
    return this.serialised(async () => {
      const next = connectionsFileSchema.parse({ connections: await change(await this.connections()) }).connections
      await this.write(this.connectionsFile, { connections: next })
      return next
    })
  }

  private async write(file: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await fs.chmod(this.dir, 0o700)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(tmp, file)
  }

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work)
    this.writes = next.catch(() => undefined)
    return next
  }
}

async function readJson(file: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return JSON.parse(text)
}
