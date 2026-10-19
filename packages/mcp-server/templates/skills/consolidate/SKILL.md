---
name: consolidate
description: End-of-session brain consolidation. Scans the current session for store-worthy moments (decisions, status changes, tasks, events, learnings, loose ends), reconciles existing open tasks against what happened, recalls against the EML brain to dedup, and proposes an approve-before-write engram diff. In auto mode — asked for by an EML hint or another skill, not by the user — it writes additions without asking and reports them. Invoke at session end, at a handoff to a fresh session, or when the user says "consolidate" / "wrap up" / "update the brain" / "konsolidieren".
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

### 2. Reconcile open tasks (the closing side of the lifecycle)
Load the **open** tasks (planned + active) for each scope the session touched
(`eml_show <scope>`, or `eml_list type=task` with `status=planned` and
`status=active`). For each, check it against what actually happened this
session:
- Got finished → **RESOLVE** (status=resolved, an outcome and the story as
  text). Abandoned → **INVALIDATE** (status=invalidated, the outcome says why).
  Decisions and notes bound to the task close with it: check them (eml_get on
  the task lists them) and keep the ones that still hold. Don't let done work
  stay open.
- Started this session → **ADVANCE** (status=active).
- Progress worth keeping → **ENTRY** on the task (eml_track_task with text),
  not a content rewrite.
- Stage moved (e.g. planning → ready) → **STAGE** (eml_track_task with stage
  and text).
- Decisions taken or a plan written inside the task → write them with task_id
  and binding (they link to the task and note themselves in its journal).
- Newly blocked → set blockers; the status stays planned. Scope changed
  materially → **UPDATE** (eml_track_task with content and text).
- Untouched → leave it.

Also look at the learnings of the scopes you touched (`eml_show` lists the ripe
ones): a ripe learning is a question for the user — **RULE?** in the diff —
never a rule written by you.
Step 1 opens/creates, step 2 closes/advances. Skipping it lets
resolved-but-still-open tasks accumulate.

### 3. Recall-before-write (per new candidate)
For each candidate from step 1 call `eml_recall <topic>` (or `eml_list` with
filters).
- Matching active engram, same state → **SKIP** (don't duplicate).
- Matching but outdated → **SUPERSEDE** candidate: the new engram replaces it
  (supersedes=[old id] on the write).
- No match → **NEW** candidate.
- A learning candidate needs no recall of its own: eml_learning checks the
  topic and names the existing learning to add to.
Never skip this step — duplication is the #1 failure mode of auto-consolidation.

### 4. Classify
Type-route and scope-route each NEW/SUPERSEDE candidate per the brain's system
rules (scope follows the engram's *content*, not who reported it). Enforce
one-topic-one-engram: never store the same thing as decision + log + status.
Drop anything that fails the "will this change a future action?" test.

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
    LEARNING (n)
      [learning] scope / title  —  new | + evidence (source)  ·  ripe?  (id: <short>)
    RULE? — ask the user (n)
      "the way of working" — from: the user's words | ripe learning <short>
    SKIP — already covered (n)
      [type] scope / title  —  active, unchanged

    → approve all · edit <#> · drop <#>

### 5a. Auto mode: write additions, hold back the rest
Instead of steps 5 and 6:

- **Write without asking:** NEW engrams, ENTRY, STAGE, ADVANCE and LEARNING.
  A new status counts as NEW; it supersedes the prior one by itself and the
  prior one stays in the history.
- **Do not write:** SUPERSEDE, RESOLVE and INVALIDATE, and any candidate whose
  type, scope or truth the session does not settle. They close or replace
  something that exists, or need the user's knowledge. A rule is never written
  in auto mode: RULE? items stay questions.

Then report in the diff format above, under the heading
`## Consolidated (auto) — <date>`, with the id of every written engram, the
held-back items under `HELD BACK — needs you (n)`, and this last line:

    → approve <#> · edit <#> · undo <#>

Keep the report short and go on with what the user asked for. On "approve"
write the held-back item; on "edit" correct the engram (`eml_update`, a task
`eml_track_task`); on "undo" invalidate it (`eml_update status=invalidated`; a
task you created: `eml_track_task` status=invalidated, outcome "undone"; an
advanced task goes back to its former status with `eml_track_task`).

### 6. Write on approval only
After the user approves/edits, write with the create tool of each type
(`eml_decide` / `eml_set_status` / `eml_create_task` / `eml_note` / `eml_event` /
`eml_reference` / `eml_learning` / `eml_log`; decisions and plans from a task
with `task_id` and `binding`; a replacement with `supersedes`), everything
about an existing task with `eml_track_task` (ENTRY / STAGE / ADVANCE /
RESOLVE / INVALIDATE), and corrections of other engrams with `eml_update`.
A RULE? the user said yes to → `eml_rule` with `agreed` (their words) and
`why`; from a ripe learning with `from_learning`. A no to a ripe learning →
`eml_learning` on it with stance declined and the user's words.
A new status supersedes the prior one by itself — do not patch the old one.

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
- Who wrote it, in which session and with which model is stamped by the
  server; write only the fields the tool lists.
- project.<id> / entity.<id> scope must already exist — create first if not.
- If a candidate is borderline, default to DROP and mention it in the diff
  footer ("dropped as ephemeral: …") so the user can pull it back.
- Engram content is English (conversation language independent).
