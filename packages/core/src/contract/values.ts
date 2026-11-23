// --- Enums and patterns the commands check values against (schema 22) -------------
//
// The ones that had no table of their own, or one per command file. The field
// enums live with the fields (fields.ts), the scope patterns and the length
// limits with the format rules (validate.ts), the evidence enums with the
// entries (entries.ts); the contract document (document.ts) lists them all.

/** The relation verbs the DB accepts; supersedes and part_of come from writes (relation.create says so). */
export const RELATION_VERBS = ['supports', 'contradicts', 'supersedes', 'derived_from', 'refines', 'related_to', 'blocks', 'part_of'] as const
export const DETECTION_METHODS = ['manual', 'agent_declared', 'auto_temporal', 'auto_semantic'] as const

/** The status a task may be created with. */
export const TASK_CREATE_STATUSES = ['planned', 'active'] as const
/** The status engram.update may set; superseded comes from supersedes. */
export const UPDATE_STATUSES = ['invalidated', 'active'] as const
/** The status task.track may set. */
export const TASK_TRACK_STATUSES = ['planned', 'active', 'resolved', 'invalidated'] as const

/** A brain id: the lowercase UUID its genesis carries. */
export const BRAIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A member handle or an agent as provenance names it (protocol §6; the charset of agent.<id>). */
export const HANDLE = /^[a-z0-9_-]{1,63}$/
/** A set hash: sha256 as lowercase hex. */
export const SET_HASH = /^[0-9a-f]{64}$/
/** The id of a project, entity, user or agent: it becomes the scope <object>.<id>. */
export const OBJECT_ID = /^[a-z0-9_-]+$/i
