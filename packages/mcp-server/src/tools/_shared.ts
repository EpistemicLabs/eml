import { z } from 'zod'

// v0.19: the parameters several tools share, with one wording. Every tool's
// schema is strict (z.object(...).strict()): an unknown key errors instead of
// being dropped silently, and the server checks the same fields again in core.

export const ENGRAM_TYPES = [
  'decision', 'rule', 'profile', 'status', 'task', 'event', 'log', 'reference', 'note', 'learning',
] as const
export const STAGES = ['ideation', 'planning', 'ready', 'implementation'] as const
export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export const BINDINGS = ['task', 'standing'] as const
export const CHANGE_TYPES = [
  'created', 'started', 'completed', 'released', 'deployed', 'failed', 'incident', 'paused', 'resumed', 'deleted', 'other',
] as const
export const RULE_TYPES = ['constraint', 'process', 'convention', 'behavior', 'security'] as const

export const content = (what: string) => z.string().describe(what)
export const scope = (what: string) => z.string().describe(what)
export const title = (what = 'Kebab-case recall anchor, unique enough to find it again.') => z.string().describe(what)

export const tags = () => z.array(z.string()).optional().describe(
  'Registered tag ids — what it is ABOUT (eml_read_object object=tag lists them; reuse before creating).',
)
export const subjects = () => z.array(z.string()).optional().describe(
  'Registered subject ids — the strand it BELONGS TO (eml_read_object object=subject lists them).',
)
export const supersedes = (what = 'Ids of engrams this one replaces: an open one is set to superseded, a closed one keeps its status; each is linked.') =>
  z.array(z.string()).optional().describe(what)
export const taskId = (what = 'The task this was done in; noted in the task\'s journal.') =>
  z.string().optional().describe(what)
export const detail = () => z.string().optional().describe(
  'Specifics beyond content: hosts, commit ids, numbers, examples. Plain text, one item per line.',
)
export const isoDate = (what: string) => z.string().describe(what)
export const optIsoDate = (what: string) => z.string().optional().describe(what)

export const SCOPE_ANY = 'Narrowest true scope: project.<id> (usual) · entity.<id> · agent.<id> · user.<id> · global.'
