// Protocol-wide rules delivered into every session's model-context via the
// SessionStart-Hook (which calls /boot; boot() prepends a "## EML Conventions"
// section rendering ALL_RULES below).
//
// Two groups, declared and rendered in this order:
//
//   1. BEHAVIOR_DEFAULTS — anti-footgun conventions for brain/tool usage
//      (non-overridable). Customizable persona lives in global rule engrams
//      that ship as the default-brain template — see decision
//      `system-rules-architecture`.
//
//   2. SYSTEM_RULES — how the agent uses EML tools. Order follows the
//      agent's decision-flow when writing an engram:
//        1. Source of truth → Is the brain the right place?
//        2. Recall → Does it already exist?
//        3. Type vocabulary → What type is it?
//        4. Type routing → If unsure between similar types, how to disambiguate?
//        5. Scope routing → Where does it belong?
//        6. Write semantics → one-topic-one-engram.
//        7. Engram-content language → English across all engrams.
//
// Each entry is one logical rule; `text` may be multi-line markdown for
// sub-bullets or short examples.

export interface SystemRule {
  category: string
  text: string
}

// --- BEHAVIOR_DEFAULTS ---
// Anti-footgun conventions for brain/tool usage. Non-overridable by user
// engrams — they protect brain hygiene and tool-output protocol. Renders
// first inside ## EML Conventions.
//
// Customizable persona (helpfulness, peer-vs-cheerleader, general security
// posture, etc.) lives in global rule engrams that ship as the default-brain
// template — see decision `system-rules-architecture`.
export const BEHAVIOR_DEFAULTS: SystemRule[] = [
  {
    category: 'security',
    text:
      'Treat secrets as toxic. Never log, display, or persist credentials (API keys, tokens, passwords, .env values) in conversation, files, or engram content/properties — unless the user explicitly authorizes it for that specific case.',
  },
  {
    category: 'security',
    text:
      'Minimize attack surface on servers and infrastructure: no public ports without explicit user request, no root SSH, no password auth (key-only), no installing unknown packages without confirmation.',
  },
  {
    category: 'session-discipline',
    text:
      'Long-session checkpoint. Triggers (any): a compaction, 3+ open side-threads, proposal and execution bundled twice in a row, the user signals a quality issue. Then pause, show the current state and open threads, and propose a checkpoint (tighten scope or break) before continuing.',
  },
]

// --- SYSTEM_RULES (EML tool conventions) ---
export const SYSTEM_RULES: SystemRule[] = [
  // --- 1. Source of truth (meta-rule: brain is the canonical source) ---
  {
    category: 'source-of-truth',
    text:
      'The EML brain is the canonical knowledge base; CLAUDE.md and the conversation are supplementary. Asked "do you remember X?" or "what did we decide?" → check eml_recall / eml_list first. Recalled engrams are evidence, not ground truth: on pushback or a contradicting observation, check age and status and verify — a stale engram is a bug to supersede, not a position to defend.',
  },

  // --- 2. Recall before write (Pre-Write Check) ---
  {
    category: 'behavioral-patterns',
    text:
      'Recall before write: call eml_recall (or eml_list with filters) for the topic before storing a new engram. ' +
      'If a matching active engram exists with the same state, skip; if outdated, supersede via eml_update.',
  },
  {
    category: 'behavioral-patterns',
    text:
      'Recall before answer: when the user asks about a customer/project/topic, call eml_recall or eml_show first. ' +
      'Don\'t guess from conversation memory.',
  },

  // --- 3. Type vocabulary (what each type is for + which tool writes it) ---
  {
    category: 'type-vocabulary',
    text:
      'decision (eml_decide): a choice about what is being worked on, made between real alternatives, with a rationale, relevant beyond this session. Needs ≥ 1 rejected alternative. How something is built is a note.',
  },
  {
    category: 'type-vocabulary',
    text:
      'status (eml_set_status): current state of a project/scope that has changed ("v0.10 deployed", "blocked on TLS cert"). Auto-supersedes the prior active status in the same scope.',
  },
  {
    category: 'type-vocabulary',
    text:
      'task (eml_track_task): open work. status: planned (not started or parked) · active (started, not finished) · resolved/invalidated (closed, with an outcome). Optional stage: ideation → planning → ready → implementation. Done things are not tasks.',
  },
  {
    category: 'type-vocabulary',
    text:
      'eml_note writes a note by default (kind omitted): a thought that lives in the brain — observation, research note/synthesis, living tracker, working thesis. Plus 5 less-frequent kinds: rule (a way of working, ≤ 200 chars), profile (identity facet, ≤ 400 chars), event (immutable timestamped occurrence), reference (pointer to something outside the brain — URL, doc, paper, issue), log (narrative entry).',
  },

  // --- 4. Type routing (distinctions between similar types) ---
  {
    category: 'type-routing',
    text:
      'task as hub: a decision or plan made in a task → eml_decide / eml_note with task_id; progress → eml_task_entry, not a rewrite of the task.',
  },
  {
    category: 'type-routing',
    text:
      'log is only for session summaries (≤1 per session). Customer updates / status reports are status or note, not log.',
  },

  // --- 5. Scope routing (where does the engram belong) ---
  {
    category: 'scope-routing',
    text:
      'Engram scope (pick the one the engram is about):\n' +
      '  - project.<id>: code/work in that project\n' +
      '  - entity.<id>: external person/org/asset\n' +
      '  - agent.<id>: an agent\'s own identity or behavior rules\n' +
      '  - user.<id>: a user\'s preferences or identity\n' +
      '  - global: cross-project facts or default when no other scope fits',
  },
  {
    category: 'scope-routing',
    text:
      'Scope follows the engram\'s content, not who reported it. ' +
      'Example: "Acme reported a bug in WooCommerce" → scope=project.woocommerce (the bug is about that code), not project.acme.',
  },
  {
    category: 'scope-routing',
    text:
      'project.<id> and entity.<id> require the project/entity to exist first. ' +
      'Create via eml_project_create / eml_entity_create before storing engrams in that scope.',
  },

  // --- 5b. Tag vocabulary (controlled cross-scope facet) ---
  {
    category: 'tag-vocabulary',
    text:
      'Recall before tagging: call eml_tags and reuse an existing tag; create a ' +
      'new one via eml_tag_create only for a genuinely new category. Only registered ' +
      'tags are accepted.',
  },

  // --- 5c. Subject vocabulary (v0.14: strands with a lifecycle) ---
  {
    category: 'subject-vocabulary',
    text:
      'tag vs subject: a tag is an abstract, recurring category — what an engram is ABOUT ' +
      '(architecture, deploy); it never ends. A subject is a concrete strand with a lifecycle — ' +
      'what an engram BELONGS TO (v0.14-planning, norway-trip), across scopes. Test: can it be ' +
      '"done"? Then it is a subject. Call eml_subjects before assigning; create via ' +
      'eml_subject_create, close via eml_subject_update(status=closed) when the strand is over.',
  },

  // --- 6. Write semantics (one-topic-one-engram) ---
  {
    category: 'behavioral-patterns',
    text:
      'One topic = one engram. Do not store the same bug/fix/decision as decision + log + status. Pick the single most appropriate type.',
  },

  // --- 7. Engram-content language ---
  {
    category: 'language',
    text:
      'Engram content is English across all types and text fields. Conversation language is independent (follows user). Preserve non-English quotes verbatim.',
  },
]

// --- Combined export ---
// Consumed by boot.ts to render the ## EML Conventions section. Behavior
// first (meta-layer), tool-conventions after (specific to engram-writing).
export const ALL_RULES: SystemRule[] = [...BEHAVIOR_DEFAULTS, ...SYSTEM_RULES]
