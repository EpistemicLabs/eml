import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_FOLDERS_DIR } from './paths.js'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { COCKPIT_HOME } from './paths.js'

/**
 * Host-owned project registry (decisions cockpit-isolation-scope-clarified,
 * cockpit-brain-project-model).
 *
 * Two kinds of project:
 *   - `brain`: a project that exists in the brain (project.<id>). The brain is
 *     the identity; the registry keeps only the cockpit's LOCAL state for it —
 *     the folder sessions run in (assigned on first use), pin, hide, a custom
 *     display name. An entry is created lazily the first time any of that is
 *     set; brain projects without an entry are still listed (merged in http.ts).
 *   - `folder`: a directory registered directly in the cockpit, no brain
 *     counterpart ("folder only").
 *
 * Sessions run with cwd = the project's folder, so its CLAUDE.md and
 * .claude/settings.json load as intended. Persisted as
 * ~/.eml-cockpit/projects.json (chmod 600). Folder ids derive from the
 * normalised path (re-adding binds the ledger's sessions again); brain ids are
 * `bp-<brain project id>`.
 */

/** The main space's registry (pre-spaces location); other spaces keep theirs under spaces/<id>/. */
export const MAIN_REGISTRY_FILE = path.join(COCKPIT_HOME, 'projects.json')
const BRAIN_ID_PREFIX = 'bp-'

export type ProjectKind = 'brain' | 'folder'

export interface ProjectEntry {
  projectId: string
  kind: ProjectKind
  /** Brain project id for `brain` entries; null for folder-only projects. */
  brainProjectId: string | null
  /** Sessions' cwd. Always set for folder projects; null until assigned for brain projects. */
  path: string | null
  displayName: string
  customName: string | null
  starred: boolean
  hidden: boolean
  createdAt: string
}

interface RegistryFile {
  version: 2
  projects: Record<string, ProjectEntry>
}

export class ProjectPathError extends Error {
  constructor(message: string, public code: 'PATH_REQUIRED' | 'BAD_PATH' | 'NOT_FOUND') {
    super(message)
  }
}

/** `~` and `~/x` expand to the home directory; the result is absolute + normalised. */
export function normalizeProjectPath(input: string): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return ''
  const expanded = trimmed === '~' ? os.homedir()
    : trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2))
    : trimmed
  return path.resolve(expanded)
}

export function projectIdForPath(normalizedPath: string): string {
  return createHash('sha1').update(normalizedPath).digest('hex').slice(0, 12)
}

export function projectIdForBrain(brainProjectId: string): string {
  return `${BRAIN_ID_PREFIX}${brainProjectId}`
}

export function brainIdFromProjectId(projectId: string): string | null {
  return projectId.startsWith(BRAIN_ID_PREFIX) ? projectId.slice(BRAIN_ID_PREFIX.length) : null
}

/** Validate a folder for sessions: exists and is a directory. Returns the normalised path. */
function requireDirectory(inputPath: string): string {
  const normalized = normalizeProjectPath(inputPath)
  if (!normalized) throw new ProjectPathError('path is required', 'PATH_REQUIRED')
  let stats: fs.Stats
  try {
    stats = fs.statSync(normalized)
  } catch {
    throw new ProjectPathError(`Path does not exist: ${normalized}`, 'BAD_PATH')
  }
  if (!stats.isDirectory()) throw new ProjectPathError(`Not a directory: ${normalized}`, 'BAD_PATH')
  // Store the real path: Claude Code reports its cwd resolved (macOS: /tmp →
  // /private/tmp), and the trust entry in the app's .claude.json must match
  // that string or the "trust this folder?" dialog comes back.
  try { return fs.realpathSync(normalized) } catch { return normalized }
}

function load(file: string): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects?: Record<string, Partial<ProjectEntry>> }
    const projects: Record<string, ProjectEntry> = {}
    for (const [id, raw] of Object.entries(parsed.projects ?? {})) {
      if (!raw || typeof raw !== 'object' || typeof raw.projectId !== 'string') continue
      // v1 entries (folder projects without `kind`) load as folder projects.
      const brainProjectId = typeof raw.brainProjectId === 'string' ? raw.brainProjectId : brainIdFromProjectId(raw.projectId)
      const kind: ProjectKind = raw.kind === 'brain' || brainProjectId ? 'brain' : 'folder'
      const entryPath = typeof raw.path === 'string' && raw.path ? raw.path : null
      if (kind === 'folder' && !entryPath) continue
      const fallbackName = entryPath ? path.basename(entryPath) : (brainProjectId ?? raw.projectId)
      projects[id] = {
        projectId: raw.projectId,
        kind,
        brainProjectId: kind === 'brain' ? brainProjectId : null,
        path: entryPath,
        displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : fallbackName,
        customName: typeof raw.customName === 'string' ? raw.customName : null,
        starred: raw.starred === true,
        hidden: raw.hidden === true,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      }
    }
    return { version: 2, projects }
  } catch {
    return { version: 2, projects: {} }
  }
}

export class ProjectRegistry {
  private data: RegistryFile

  /**
   * One registry per brain space: `file` holds its entries, `cockpitFoldersDir`
   * is where its cockpit folders go (main: the pre-spaces locations).
   */
  constructor(
    private readonly file: string = MAIN_REGISTRY_FILE,
    private readonly cockpitFoldersDir: string = COCKPIT_FOLDERS_DIR,
  ) {
    this.data = load(file)
  }

  /** Every registered entry (folder projects + brain projects with local state). */
  list(): ProjectEntry[] {
    return Object.values(this.data.projects).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  get(projectId: string): ProjectEntry | undefined {
    return this.data.projects[projectId]
  }

  getByPath(inputPath: string): ProjectEntry | undefined {
    const normalized = normalizeProjectPath(inputPath)
    return this.data.projects[projectIdForPath(normalized)]
  }

  /**
   * Register a directory as a folder-only project. The path must exist and be
   * a directory; an existing registration is returned as-is.
   */
  create(inputPath: string, customName?: string | null): { project: ProjectEntry; created: boolean } {
    const normalized = requireDirectory(inputPath)
    const projectId = projectIdForPath(normalized)
    const existing = this.data.projects[projectId]
    if (existing) return { project: existing, created: false }

    const trimmedName = (customName ?? '').trim()
    const project: ProjectEntry = {
      projectId,
      kind: 'folder',
      brainProjectId: null,
      path: normalized,
      displayName: trimmedName || path.basename(normalized),
      customName: trimmedName || null,
      starred: false,
      hidden: false,
      createdAt: new Date().toISOString(),
    }
    this.data.projects[projectId] = project
    this.persist()
    return { project, created: true }
  }

  /**
   * The local entry for a brain project, created on first touch (pin, hide,
   * folder, rename). `name` is the brain's project name, kept as the default
   * display name.
   */
  /**
   * A project without a folder gets a cockpit-made one under
   * ~/.eml-cockpit/workspaces/<brain id> so a session can start right away
   * (no dialog — the folder is changeable later).
   */
  ensureCockpitFolder(projectId: string): ProjectEntry {
    const project = this.data.projects[projectId]
    if (!project) throw new ProjectPathError('Project not found', 'NOT_FOUND')
    if (project.path) return project
    const dir = path.join(this.cockpitFoldersDir, project.brainProjectId ?? project.projectId)
    fs.mkdirSync(dir, { recursive: true })
    return this.update(projectId, { path: dir })
  }

  ensureBrain(brainProjectId: string, name: string): ProjectEntry {
    const projectId = projectIdForBrain(brainProjectId)
    const existing = this.data.projects[projectId]
    if (existing) {
      if (!existing.customName && existing.displayName !== name) {
        existing.displayName = name
        this.persist()
      }
      return existing
    }
    const project: ProjectEntry = {
      projectId,
      kind: 'brain',
      brainProjectId,
      path: null,
      displayName: name,
      customName: null,
      starred: false,
      hidden: false,
      createdAt: new Date().toISOString(),
    }
    this.data.projects[projectId] = project
    this.persist()
    return project
  }

  update(
    projectId: string,
    patch: { displayName?: string | null; starred?: boolean; hidden?: boolean; path?: string | null; brainName?: string },
  ): ProjectEntry {
    const project = this.data.projects[projectId]
    if (!project) throw new ProjectPathError('Project not found', 'NOT_FOUND')
    if (patch.displayName !== undefined) {
      const trimmed = (patch.displayName ?? '').trim()
      project.customName = trimmed || null
      project.displayName = trimmed || (project.path ? path.basename(project.path) : (patch.brainName ?? project.brainProjectId ?? project.projectId))
    }
    if (patch.starred !== undefined) project.starred = patch.starred
    if (patch.hidden !== undefined) project.hidden = patch.hidden
    if (patch.path !== undefined) {
      if (project.kind === 'folder') throw new ProjectPathError('A folder project keeps its folder', 'BAD_PATH')
      project.path = patch.path === null ? null : requireDirectory(patch.path)
    }
    this.persist()
    return project
  }

  remove(projectId: string): boolean {
    if (!this.data.projects[projectId]) return false
    delete this.data.projects[projectId]
    this.persist()
    return true
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      fs.chmodSync(this.file, 0o600)
    } catch (err) {
      process.stderr.write(`[projects] persist failed: ${(err as Error).message}\n`)
    }
  }
}

// ── Filesystem browsing (for the folder flows) ────────────────────────
export interface FolderSuggestion {
  name: string
  path: string
  type: 'directory'
}

/** List sub-directories of `inputPath` (`~` expands). Directories only. */
export function browseFolders(inputPath: string): { path: string; suggestions: FolderSuggestion[] } {
  const base = normalizeProjectPath(inputPath || '~') || os.homedir()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    throw new ProjectPathError(`Cannot read directory: ${base}`, 'BAD_PATH')
  }
  const suggestions: FolderSuggestion[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    suggestions.push({ name: entry.name, path: path.join(base, entry.name), type: 'directory' })
  }
  return { path: base, suggestions }
}

/** Create a directory (recursive) and return its normalised path. */
export function createFolder(inputPath: string): string {
  const normalized = normalizeProjectPath(inputPath)
  if (!normalized) throw new ProjectPathError('path is required', 'PATH_REQUIRED')
  fs.mkdirSync(normalized, { recursive: true })
  return normalized
}
