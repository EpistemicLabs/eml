import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { writeOwnerOnly, WriteQueue } from './owner-only-file.js'
import { connectionSchema, emptySpacePlugins, spacePluginsSchema, type Connection, type SpacePlugins } from '../../domain/space-plugins.js'

const connectionsFileSchema = z.object({ connections: z.array(connectionSchema).default([]) })

/**
 * The plugin state of this cockpit under <home>/plugins/, owner-only: spaces.json (which plugin is
 * on in which space, with which connection) and connections.json (the user's sign-ins and secrets,
 * stored once, never sent to the page). Writes are atomic and one at a time.
 */
export class PluginStore {
  private readonly writes = new WriteQueue()

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
    return this.writes.run(async () => {
      const next = spacePluginsSchema.parse(await change(await this.spaces()))
      await this.write(this.spacesFile, next)
      return next
    })
  }

  updateConnections(change: (connections: Connection[]) => Connection[] | Promise<Connection[]>): Promise<Connection[]> {
    return this.writes.run(async () => {
      const next = connectionsFileSchema.parse({ connections: await change(await this.connections()) }).connections
      await this.write(this.connectionsFile, { connections: next })
      return next
    })
  }

  private write(file: string, value: unknown): Promise<void> {
    return writeOwnerOnly(file, `${JSON.stringify(value, null, 2)}\n`)
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
