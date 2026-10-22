---
name: consolidate
description: Consolidation of the session into the EML brain. Scans the current session for store-worthy moments (decisions, status changes, tasks, events, learnings, loose ends), reconciles existing open tasks against what happened, recalls against the EML brain to dedup, writes what holds and reports it with an undo. Only a new rule waits for the user. Invoke at session end, at a handoff to a fresh session, when an EML hint asks for it, or when the user says "consolidate" / "wrap up" / "update the brain" / "konsolidieren".
---
<!-- managed-by: engramprotocol-setup -->

# consolidate

Turn a finished session into durable EML brain writes — without duplicating what's
already there and without promoting noise. This is the *save* half of the session
lifecycle (boot is the *load* half).

The judgment, not the capture, is the hard part. Most of what happened this
session should NOT become an engram. Promote only what will change a future
action or answer.

You write on your own and report what you wrote; the user can undo any of it.
Only a new rule is a question — it needs the user's yes.

## When to invoke

- The user says "consolidate", "wrap up", "update the brain".
- At a handoff to a fresh session (log first, so the next session can dock on;
  step 7 then hands over).
- An EML hint asks for it (the session grew a lot, or the context was just
  compacted), or another skill runs it as a step (getting-started at its close).

**After a compaction** the session before it is a summary. Take the candidates
from the summary; read the transcript the hint names only where the summary is
too thin to write a candidate down correctly, not from start to end.

## Steps

### 1. Gather new candidates
Scan THIS session's conversation for store-worthy moments, grouped by type:
- **decision** — a choice about what is being worked on, made between real
  alternatives, with a rationale, relevant beyond this session. Needs ≥ 1
  rejected alternative + rationale; if nothing was rejected, it isn't a
  decision. Taken inside a task → write it with task_id and binding (standing
  if it still holds once the task is done, task if it only governs the task).
- **status** — a scope's state that changed ("v1.2 shipped", "blocked on X").
- **task** — open work: action items, loose ends, abandoned-but-real
  side-quests, and open questions (→ eml_create_task with a title,
  status=planned). Done things are not tasks. Larger work becomes a hub: a
  stage (ideation → planning → ready → implementation), its decisions and plan
  linked via task_id, progress in its journal; closed with an outcome.
- **entry** — progress on an existing task (what happened, what's next, a step
  back) → eml_track_task with text on that task, not a content rewrite, not a
  new engram.
- **learning** — the user corrected you or confirmed a non-obvious approach,
  turned down a proposal or redirected you, or you noticed a mistake or a hit
  of your own → eml_learning: the lesson as an instruction to yourself, the
  incident as evidence (source user with the user's words, observed, or self).
  One learning per topic; the server finds an existing one and you add the
  incident there.
- **rule?** — the user stated a way of working explicitly ("from now on, X").
  Never written on your own: it is a question to the user whether to record it
  as a rule. A lasting constraint on the thing being worked on is a decision.
- **event** — something that happened at a timestamp (deploy, incident).
- **reference** — a pointer to an external system that exists now.
- **note** — a thought worth keeping that lives in the brain (observation,
  synthesis, working thesis). Not a choice (decision), not a state (status).
- **log** — the session narrative, one per session (eml_log): what (what this
  session was about), landed (where it landed: results, decisions, links), next
  (concrete next steps), open_threads (anything left dangling), content for the
  longer story. The server renders them as the START HERE block the next
  session docks on. Consolidated before in this session? Then update that log
  (eml_update — the eml_log error names it) instead of writing a second one.

### 2. Reconcile open tasks
Load the **open** tasks (planned + active) for each scope the session touched
(`eml_show <scope>`, or `eml_list type=task` with `status=planned` and
`status=active`). For each, check it against what actually happened this
session:
- Got finished → **RESOLVE** (status=resolved + outcome + text). Abandoned →
  **INVALIDATE** (status=invalidated + outcome (why) + text). Decisions and
  notes bound to the task close with it: check them (eml_get on the task lists
  them) and pass keep=[ids that still hold] or keep=[]. A parent closes only
  once its sub-tasks are closed or moved.
- Started this session → **ADVANCE** (status=active).
- Progress worth keeping → **ENTRY** (eml_track_task with text).
- Stage moved → **STAGE** (eml_track_task with stage and text).
- Newly blocked → set blockers; the status stays planned. Scope changed
  materially → eml_track_task with content and text.
- Untouched → leave it.

Also look for ripe learnings (`eml_list type=learning state=ripe`): each is a
**RULE?** question for the user, never a rule written by you.

### 3. Recall before write (per new candidate)
For each candidate from step 1 call `eml_recall <topic>` (or `eml_list` with
filters).
- Matching active engram, same state → **SKIP** (don't duplicate).
- Matching but outdated → **SUPERSEDE**: the new engram replaces it
  (supersedes=[old id] on the write). A task is not replaced here: close the
  old one (RESOLVE / INVALIDATE) and open the new one.
- No match → **NEW**.
- A learning candidate needs no recall of its own: eml_learning checks the
  topic and names the existing learning to add to.
Never skip this step — duplication is the #1 failure mode of consolidation.

### 4. Classify
Type-route and scope-route each candidate per the brain's system rules (scope
follows the engram's *content*, not who reported it). One topic, one engram:
never the same thing as decision + log + status. Drop anything that fails the
"will this change a future action?" test, and anything whose type, scope or
truth the session does not settle — that is a question for the user, not a
write.

### 5. Write
Write every candidate with the create tool of its type (`eml_decide` /
`eml_set_status` / `eml_create_task` / `eml_note` / `eml_event` /
`eml_reference` / `eml_learning` / `eml_log`; decisions and plans from a task
with `task_id` and `binding`; a replacement with `supersedes`), everything
about an existing task with `eml_track_task`, and corrections of other engrams
with `eml_update`. A new status supersedes the prior one by itself.

Keep, for the report, what each write changed: the new id, or the status or
stage the engram had before.

### 6. Report, with undo
End with a short report and go on with what the user asked for:

    ## Consolidated — <date>
    <#>. NEW [type] scope / title  (id: <short>)
    <#>. SUPERSEDE [type] title  (id: <short>) — replaces <old short>
    <#>. RESOLVE | INVALIDATE | ADVANCE [task] title — <before> → <after>  (id: <short>)
    <#>. STAGE [task] title — <before> → <after>  (id: <short>)
    <#>. ENTRY [task] title — "one line"  (id: <short>)
    <#>. LEARNING [learning] title — new | + evidence  (id: <short>)
    QUESTIONS (n)
    <#>. RULE? "the way of working" — from: the user's words | ripe learning <short>
    <#>. <anything you did not settle> — <what is open>
    Dropped as ephemeral: …

    → undo <#> · change <#>

**undo** takes back one write of this run:
- NEW, LEARNING new → `eml_update status=invalidated`; a task you created →
  `eml_track_task` status=invalidated, outcome "undone", text "undone", keep=[].
- SUPERSEDE → invalidate the new engram, then reactivate the old one
  (`eml_update status=active`).
- RESOLVE, INVALIDATE, ADVANCE, STAGE → back to what it was before
  (`eml_track_task` with status or stage and text "undone"); a reopen lists the
  items that closed with the task — reactivate them.
- ENTRY, `+ evidence` → a journal only grows; the entry stays. Say so.

**change** corrects the engram (`eml_update`, a task `eml_track_task`).

A RULE? the user said yes to → `eml_rule` with `title`, `applies` (plus
`trigger` when situational), `content` (what to do, ≤ 200 chars), `agreed`
(their words) and `why`; from a ripe learning with `from_learning`. A no to a
ripe learning → `eml_learning` on it with its `id`, `source=user`, `happened`,
`quote` (the user's words) and stance declined.

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
- A rule is never written without the user's yes.
- Never skip the recall in step 3.
- Who wrote it, in which session and with which model is stamped by the
  server; write only the fields the tool lists.
- project.<id> / entity.<id> scope must already exist — create first if not.
- If a candidate is borderline, drop it and name it in the report's "Dropped"
  line so the user can pull it back.
- Engram content is English (conversation language independent).
