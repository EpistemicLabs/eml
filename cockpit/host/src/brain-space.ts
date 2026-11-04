import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { BrainProjectsClient } from './brain-projects.js'
import { NotesWatcher } from './notes-api.js'
import { ProjectRegistry, MAIN_REGISTRY_FILE } from './project-registry.js'
import { removeSpaceFiles, writeSpaceFiles, type SpaceFiles } from './infrastructure/providers/claude/isolation.js'
import { COCKPIT_FOLDERS_DIR, COCKPIT_HOME } from './paths.js'
import { updateCockpitConfig } from './config.js'

/**
 * A brain space is one brain the cockpit works with (decision
 * cockpit-naming-desks-spaces): its token, the session files that reach it,
 * and the host-side state that belongs to that brain — its project list, the
 * cockpit's local project registry, its notes. The main space is the local
 * brain the home was provisioned with; further local brains (Settings ›
 * Brain › New space) and, later, shared team brains join the same registry.
 *
 * A space holds work; the identity its sessions run with is the bound
 * agent's brain (agents.ts; decision cockpit-identity-agent-brain). A session
 * only ever gets the files of its own space, and those carry the space's
 * per-boot MCP token, never a brain token — the privacy boundary between
 * spaces is the token, not a filter. Every desk, session and project belongs
 * to exactly one space.
 */
export interface BrainSpace {
  /** The brain's id in control.db. */
  id: string
  /** Display name (cockpit config; "Main" for the main space unless renamed). */
  name: string
  /** The brain's name in control.db: the space's name since agent brains, the agent id on a home from before them. */
  brainName: string
  /** The agent this space binds (agents.ts), or null: its sessions then get no brain until one is bound. */
  agent: string | null
  /** Why the agent upgrade left this space unbound (agent-upgrade.ts), with the report's folder; null when bound or never tried. */
  upgrade: UpgradeState | null
  /** The space the home was provisioned with. */
  main: boolean
  /**
   * v0.21: a shared brain (team-space.ts) — true when the brain server says
   * so (GET /team), false for a local brain, null while the host could not ask.
   */
  shared: boolean | null
  /** How the session ledger keys this space: null for main (its pre-spaces entries carry no space), else the id. */
  ledgerKey: string | null
  /** Base URL of the brain server this space's brain lives on. */
  url: string
  token: string
  /**
   * Per-boot secret of this space for the host's brain MCP endpoint
   * (brain-mcp.ts): it alone picks the space, so a session can only reach its
   * own brain. In memory and in the space's mcp.json only; new on every boot.
   */
  mcpToken: string
  /** mcp.json + settings.json a session of this space starts with, and the EML hook config naming the host's hook routes. */
  files: SpaceFiles
  /** The brain's project list (cached). */
  projects: BrainProjectsClient
  /** The cockpit's local project state for this space (folders, pins, …). */
  registry: ProjectRegistry
  /** Note changes of this brain for the UI's `notes` event. */
  notes: NotesWatcher
}

/** The agent upgrade's word on a space it could not bind: the reason, where its report is, and what it waits for. */
export interface UpgradeState {
  reason: string
  report: string | null
  /** The upgrade waits for the home's handle (the banner asks for it). */
  needs?: 'handle'
}

/** What the UI gets to see of a space (GET /api/spaces). */
export interface SpaceView {
  id: string
  name: string
  main: boolean
  /** The bound agent's id, null while none is bound. */
  agent: string | null
  /** Why none is bound (the agent upgrade's reason), null when bound. */
  upgrade: UpgradeState | null
  /** v0.21: a shared brain; null when the host could not ask the brain server. */
  shared: boolean | null
}

export const spaceView = (space: BrainSpace): SpaceView => ({ id: space.id, name: space.name, main: space.main, agent: space.agent, upgrade: space.upgrade, shared: space.shared })

export interface OpenSpaceOptions {
  id: string
  name: string
  brainName: string
  agent: string | null
  upgrade?: UpgradeState | null
  main: boolean
  /** Known for a space just made (false local, true shared); absent at boot until the server was asked. */
  shared?: boolean | null
  url: string
  token: string
  /** The turn-state hook's config of this boot (isolation.ts). */
  turnHookConfig: string
  /** The host's brain MCP endpoint (brain-mcp.ts) the space's mcp.json points at. */
  mcpUrl: string
  /** The host's hook routes (brain-mcp.ts HOOKS_PATH) the space's EML hook config points at. */
  hooksUrl: string
}

/** Where a non-main space keeps its local state. */
const spaceStateDir = (spaceId: string) => path.join(COCKPIT_HOME, 'spaces', spaceId)

/** Write the space's session files and open its clients. */
export function openBrainSpace(opts: OpenSpaceOptions): BrainSpace {
  const mcpToken = randomBytes(32).toString('hex')
  const files = writeSpaceFiles(opts.id, opts.turnHookConfig, { mcpUrl: opts.mcpUrl, hooksUrl: opts.hooksUrl, mcpToken })
  // The main space keeps the pre-spaces locations (projects.json, workspaces/)
  // so an existing home carries on unchanged; other spaces live under spaces/<id>/.
  const registry = opts.main
    ? new ProjectRegistry(MAIN_REGISTRY_FILE, COCKPIT_FOLDERS_DIR)
    : new ProjectRegistry(path.join(spaceStateDir(opts.id), 'projects.json'), path.join(COCKPIT_FOLDERS_DIR, opts.id))
  return {
    id: opts.id,
    name: opts.name,
    brainName: opts.brainName,
    agent: opts.agent,
    upgrade: opts.upgrade ?? null,
    main: opts.main,
    shared: opts.shared ?? null,
    ledgerKey: opts.main ? null : opts.id,
    url: opts.url,
    token: opts.token,
    mcpToken,
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

  /** The space whose MCP token this is (compared in constant time), or null. */
  byMcpToken(token: string | undefined): BrainSpace | null {
    if (!token) return null
    const given = Buffer.from(token)
    for (const space of this.byId.values()) {
      const own = Buffer.from(space.mcpToken)
      if (own.length === given.length && timingSafeEqual(own, given)) return space
    }
    return null
  }

  /** The space with `id`, or the main space when none (or an unknown one) is named. */
  resolve(id?: string | null): BrainSpace {
    return (id && this.byId.get(id)) || this.main
  }

  /**
   * v0.21: a shared space the brain server discarded (team-space.ts) leaves
   * the registry and the cockpit config, with its session files (they carry
   * the per-boot MCP token) and its local state under spaces/<id>. The
   * folders of its projects (workspaces/) are the user's and stay. The main
   * space is never removed.
   */
  async remove(space: BrainSpace): Promise<void> {
    if (space.main) throw new Error('the main space is not removed')
    await updateCockpitConfig((config) => {
      if (!config) throw new Error('no cockpit config')
      return { ...config, spaces: (config.spaces ?? []).filter((s) => s.token !== space.token) }
    })
    this.byId.delete(space.id)
    removeSpaceFiles(space.id)
    fs.rmSync(spaceStateDir(space.id), { recursive: true, force: true })
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
