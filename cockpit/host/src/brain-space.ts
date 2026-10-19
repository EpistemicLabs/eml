import * as path from 'node:path'
import { BrainProjectsClient } from './brain-projects.js'
import { NotesWatcher } from './notes-api.js'
import { ProjectRegistry, MAIN_REGISTRY_FILE } from './project-registry.js'
import { writeSpaceFiles, type SpaceFiles } from './infrastructure/providers/claude/isolation.js'
import { COCKPIT_FOLDERS_DIR, COCKPIT_HOME } from './paths.js'
import { updateCockpitConfig } from './config.js'

/**
 * A brain space is one brain the cockpit works with (decision
 * cockpit-naming-desks-spaces): its token, the session files that carry it,
 * and the host-side state that belongs to that brain — its project list, the
 * cockpit's local project registry, its notes. The main space is the local
 * brain the home was provisioned with; further local brains (Settings ›
 * Brain › New space) and, later, shared team brains join the same registry.
 *
 * A session only ever gets the files of its own space — the privacy
 * boundary between spaces is the token, not a filter. Every desk, session
 * and project belongs to exactly one space.
 */
export interface BrainSpace {
  /** The brain's id in control.db. */
  id: string
  /** Display name (cockpit config; "Main" for the main space unless renamed). */
  name: string
  /** The brain's name in control.db — the agent id the main brain was set up with; the identity a new space copies. */
  brainName: string
  /** The space the home was provisioned with. */
  main: boolean
  /** How the session ledger keys this space: null for main (its pre-spaces entries carry no space), else the id. */
  ledgerKey: string | null
  /** Base URL of the brain server this space's brain lives on. */
  url: string
  token: string
  /** mcp.json + settings.json a session of this space starts with, and its EML hook config. */
  files: SpaceFiles
  /** The brain's project list (cached). */
  projects: BrainProjectsClient
  /** The cockpit's local project state for this space (folders, pins, …). */
  registry: ProjectRegistry
  /** Note changes of this brain for the UI's `notes` event. */
  notes: NotesWatcher
}

/** What the UI gets to see of a space (GET /api/spaces). */
export interface SpaceView {
  id: string
  name: string
  main: boolean
}

export const spaceView = (space: BrainSpace): SpaceView => ({ id: space.id, name: space.name, main: space.main })

export interface OpenSpaceOptions {
  id: string
  name: string
  brainName: string
  main: boolean
  url: string
  token: string
  /** The turn-state hook's config of this boot (isolation.ts). */
  turnHookConfig: string
}

/** Where a non-main space keeps its local state. */
const spaceStateDir = (spaceId: string) => path.join(COCKPIT_HOME, 'spaces', spaceId)

/** Write the space's session files and open its clients. */
export function openBrainSpace(opts: OpenSpaceOptions): BrainSpace {
  const files = writeSpaceFiles(opts.id, opts.url, opts.token, opts.turnHookConfig)
  // The main space keeps the pre-spaces locations (projects.json, workspaces/)
  // so an existing home carries on unchanged; other spaces live under spaces/<id>/.
  const registry = opts.main
    ? new ProjectRegistry(MAIN_REGISTRY_FILE, COCKPIT_FOLDERS_DIR)
    : new ProjectRegistry(path.join(spaceStateDir(opts.id), 'projects.json'), path.join(COCKPIT_FOLDERS_DIR, opts.id))
  return {
    id: opts.id,
    name: opts.name,
    brainName: opts.brainName,
    main: opts.main,
    ledgerKey: opts.main ? null : opts.id,
    url: opts.url,
    token: opts.token,
    files,
    projects: new BrainProjectsClient(opts.url, opts.token),
    registry,
    notes: new NotesWatcher({ loopbackUrl: opts.url, brainToken: opts.token }),
  }
}

export class BrainSpaces {
  private readonly byId = new Map<string, BrainSpace>()
  private readonly addListeners = new Set<(space: BrainSpace) => void>()

  constructor(readonly main: BrainSpace) {
    this.byId.set(main.id, main)
  }

  add(space: BrainSpace): void {
    this.byId.set(space.id, space)
    for (const listener of this.addListeners) listener(space)
  }

  /** Called with every space added after now (the /api/events stream follows new spaces). Returns the detach. */
  onAdd(listener: (space: BrainSpace) => void): () => void {
    this.addListeners.add(listener)
    return () => { this.addListeners.delete(listener) }
  }

  list(): BrainSpace[] {
    return [...this.byId.values()]
  }

  get(id: string): BrainSpace | undefined {
    return this.byId.get(id)
  }

  /** The space with `id`, or the main space when none (or an unknown one) is named. */
  resolve(id?: string | null): BrainSpace {
    return (id && this.byId.get(id)) || this.main
  }

  /** Rename a space (display name only; the brain keeps its name) and persist it in the cockpit config. */
  async rename(space: BrainSpace, name: string): Promise<void> {
    await updateCockpitConfig((config) => {
      if (!config) throw new Error('no cockpit config')
      return space.main
        ? { ...config, mainName: name }
        : { ...config, spaces: (config.spaces ?? []).map((s) => (s.token === space.token ? { ...s, name } : s)) }
    })
    space.name = name
  }

  /**
   * The space a request means: its `x-cockpit-space` header, else main. A
   * header naming an unknown space is a request for nothing — null.
   */
  fromHeader(header: string | string[] | undefined): BrainSpace | null {
    const id = Array.isArray(header) ? header[0] : header
    if (!id) return this.main
    return this.byId.get(id) ?? null
  }
}
