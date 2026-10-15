---
name: consolidate
description: End-of-session brain consolidation. Scans the current session for store-worthy moments (decisions, status changes, tasks, events, feedback rules, loose ends), reconciles existing open tasks against what happened, recalls against the EML brain to dedup, and proposes an approve-before-write engram diff. In auto mode — asked for by an EML hint or another skill, not by the user — it writes additions without asking and reports them. Invoke at session end, at a handoff to a fresh session, or when the user says "consolidate" / "wrap up" / "update the brain" / "konsolidieren".
---
<!-- managed-by: engramprotocol-setup -->

# consolidate

Turn a finished session into durable brain writes — without duplicating what's
already there and without promoting noise. This is the *save* half of the session
lifecycle (boot is the *load* half).

The judgment, not the capture, is the hard part. Most of what happened this
session should NOT become an engram. Promote only what will change a future
action or answer.

This skill is the single end-of-session ritual: write the session log, turn
status changes into a new status, open todos into tasks, done todos into
resolved tasks.

## When to invoke

- The user says "consolidate", "wrap up", "update the brain".
- At a handoff to a fresh session (log first, so the next session can dock on;
  step 7 then hands over).
- Before context gets compacted, if the session did real work.
- An EML hint in the context asks for it "in auto mode" (the session grew a lot,
  or the context was just compacted).

## Modes

- **Default** — the user invoked the skill or asked for it in their own words.
  Present the diff and write only after approval (steps 5 and 6).
- **Auto** — an EML hint, or a skill that runs consolidate as one of its steps
  (getting-started at its close), asked for "consolidate in auto mode", and the
  user did not ask themselves. Nobody may be there to approve, so write what only adds
  and hold back what closes or replaces (step 5a).

Steps 1–4 are the same in both modes. When in doubt which mode applies, it is
the default.

**After a compaction** the session before it is a summary. Take the candidates
from the summary; read the transcript the hint names only where the summary is
too thin to write a candidate down correctly, not from start to end.

## Steps

### 1. Gather new candidates
Scan THIS session's conversation for store-worthy moments, grouped by type:
- **decision** — a choice about what is being worked on, made between real
  alternatives, with a rationale, relevant beyond this session. Needs ≥ 1
  rejected alternative + rationale; if nothing was rejected, it isn't a
  decision. Taken inside a task → write it with task_id.
- **status** — a scope's state that changed ("v1.2 shipped", "blocked on X").
- **task** — open work: action items, loose ends, abandoned-but-real
  side-quests, and open questions (→ task, status=planned). Done things are
  not tasks. Larger work becomes a hub: a stage (ideation → planning → ready →
  implementation), its decisions and plan linked via task_id, progress as entries;
  closed with an outcome.
- **entry** — progress on an existing task (what happened, what's next, a step
  back) → eml_task_entry on that task, not a content rewrite, not a new engram.
- **rule** — a way of working the user set or corrected ("when X, do Y"). A
  lasting constraint on the thing being worked on is a decision.
- **event** — something that happened at a timestamp (deploy, incident).
- **reference** — a pointer to an external system that exists now.
- **note** — a thought worth keeping that lives in the brain (observation,
  synthesis, working thesis). Not a choice (decision), not a state (status).
- **log** — the session narrative. Exactly ONE, ≤1 per session. Write it in a
  START HERE format so the next session's boot can dock onto it cleanly: WHAT
  (what this session was about), WHERE we landed, NEXT (concrete next steps),
  OPEN THREADS (anything left dangling).

### 2. Reconcile open tasks (the closing side of the lifecycle)
Load the **open** tasks (planned + active) for each scope the session touched
(`eml_show <scope>`, or `eml_list type=task` with `status=planned` and
`status=active`). For each, check it against what actually happened this
session:
- Got finished → **RESOLVE** (status=resolved, with an outcome). Abandoned →
  **INVALIDATE** (status=invalidated, the outcome says why). Don't let done
  work stay open; it makes boot inaccurate.
- Started this session → **ADVANCE** (status=active).
- Progress worth keeping → **ENTRY** on the task (eml_task_entry), not a
  content rewrite.
- Stage moved (e.g. planning → ready) → **STAGE**, recorded with the entry
  (eml_task_entry with stage).
- Decisions taken or a plan written inside the task → write them with task_id
  (they link to the task and add their own entries).
- Newly blocked → set blockers; the status stays planned. Scope changed
  materially → **UPDATE** (patch the content).
- Untouched → leave it.
Step 1 opens/creates, step 2 closes/advances. Skipping it lets
resolved-but-still-open tasks accumulate.

### 3. Recall-before-write (per new candidate)
For each candidate from step 1 call `eml_recall <topic>` (or `eml_list` with
filters).
- Matching active engram, same state → **SKIP** (don't duplicate).
- Matching but outdated → **SUPERSEDE** candidate (via `eml_update`).
- No match → **NEW** candidate.
Never skip this step — duplication is the #1 failure mode of auto-consolidation.

### 4. Classify
Type-route and scope-route each NEW/SUPERSEDE candidate per the brain's system
rules (scope follows the engram's *content*, not who reported it). Enforce
one-topic-one-engram: never store the same thing as decision + log + status.
Drop anything that fails the "will this change a future action?" test.

Significance defaults to `normal`. Reserve `high` for engrams that change
cross-session strategy or carry real downside if missed; `critical` for
must-not-lose facts (security, production-breaking); `low`/`trivial` for
ephemera. When unsure, pick `normal` — agents over-assign `high`.

### 5. Present the diff (BEFORE writing anything)
Show the user a structured diff and stop:

    ## Consolidation diff — <date>

    NEW (n)
      [type] scope / title
        "one-line content preview"
    SUPERSEDE (n)
      [type] scope / title  —  <old state> → <new state>  (id: <short>)
    RESOLVE (n)
      [task] scope / title  —  active → resolved · outcome "…"  (id: <short>)
    INVALIDATE (n)
      [task] scope / title  —  planned → invalidated · outcome "…"  (id: <short>)
    ADVANCE (n)
      [task] scope / title  —  planned → active  (id: <short>)
    ENTRY (n)
      [entry] scope / title  —  "one-line entry"  (id: <short>)
    STAGE (n)
      [stage] scope / title  —  planning → ready  (id: <short>)
    SKIP — already covered (n)
      [type] scope / title  —  active, unchanged

    → approve all · edit <#> · drop <#>

### 5a. Auto mode: write additions, hold back the rest
Instead of steps 5 and 6:

- **Write without asking:** NEW engrams, ENTRY, STAGE and ADVANCE. A new status
  counts as NEW; it supersedes the prior one by itself and the prior one stays
  in the history.
- **Do not write:** SUPERSEDE, RESOLVE and INVALIDATE, and any candidate whose
  type, scope or truth the session does not settle. They close or replace
  something that exists, or need the user's knowledge.

Then report in the diff format above, under the heading
`## Consolidated (auto) — <date>`, with the id of every written engram, the
held-back items under `HELD BACK — needs you (n)`, and this last line:

    → approve <#> · edit <#> · undo <#>

Keep the report short and go on with what the user asked for. On "approve"
write the held-back item; on "edit" patch the engram with `eml_update`; on
"undo" invalidate it (an advanced task goes back to its former status).

### 6. Write on approval only
After the user approves/edits, write via the typed tools
(`eml_decide` / `eml_set_status` / `eml_track_task` / `eml_note`; decisions and
plans from a task with `task_id`), append entries with `eml_task_entry`
(ENTRY / STAGE), and patch existing engrams with `eml_update`
(RESOLVE / INVALIDATE / ADVANCE / SUPERSEDE).
Auto-supersede handles prior status — do NOT patch the old status manually.

### 7. Hand over, if this was a handoff
Only when the consolidation is the first half of a move to a fresh session —
you proposed it or the user asked for it, and the user agreed. The work itself
then belongs to the new session, even if the user's answer also named the
next task ("ok, do B and save the state" still means: save here, B in the new
session).

- **In the EML cockpit** (`COCKPIT_SPAWN_JS` is set): open the new session with
  the `spawn-session` skill. Its prompt names the next task and the session log
  you just wrote, so the worker starts with `eml_show` on it.
- **Elsewhere:** give the user a first prompt for the new session to paste,
  naming the next task and the log.

Then end your turn with one line on where the work continues. Do not start the
next task in this session.

## Guardrails
- Default mode: nothing is written before explicit approval. The diff is a
  proposal; only the reads in steps 2–3 run automatically.
- Auto mode never closes, invalidates or supersedes an engram, and never skips
  the recall in step 3.
- Set `properties.source_id` + `properties.source_type` ("agent") on every write.
- project.<id> / entity.<id> scope must already exist — create first if not.
- If a candidate is borderline, default to DROP and mention it in the diff
  footer ("dropped as ephemeral: …") so the user can pull it back.
- Engram content is English (conversation language independent).
