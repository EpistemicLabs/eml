---
name: task-run
description: Advance one brain task stage by stage (ideation → planning → ready → implementation → resolved), stopping at a checkpoint after each stage so the user decides whether to go on. Invoke when a session starts with "Use the task-run skill for task …" (the cockpit's "Advance task" button), or when the user says "advance this task", "work through this task", "bring the task forward", "Task weiterbringen", "Task abarbeiten".
---
<!-- managed-by: engramprotocol-setup -->

# task-run

You run one task. You do one stage, write its result to the brain, stop at a
checkpoint, and continue only when the user says so. The whole run stays in
this one session.

## Start

1. `eml_get <task id>` — content, stage, status, journal, linked notes and
   decisions. Then `eml_show <the task's scope>` for the project around it.
2. If the task is resolved or invalidated: say so and stop.
3. If its status is `planned`: set it to `active` (`eml_update`).
4. `eml_task_entry`: "Task run started in session $COCKPIT_SESSION_ID."
5. Say in two or three lines what the task is, which stage it is in and what
   this stage will produce — then do that stage.

## One stage at a time

The stage is how mature the task is; your step takes it from where it stands
to the next checkpoint:

| Stage now | What you do | Result in the brain |
|---|---|---|
| (none) / ideation | Sharpen the problem, collect options, name the open questions. Read code and context; change nothing. | A note on the task (`eml_note` with `task_id`): problem, options, open questions. |
| planning | Settle the open questions with the user, one at a time. Write the plan: steps, files, how it is verified. Change nothing. | Each choice via `eml_decide` (`task_id`); the plan via `eml_note` (`task_id`). |
| ready / implementation | Do the work in the place given under *Where to work* (below), step by step as planned. Verify it (tests, a real run). | Progress via `eml_task_entry`; the result where it belongs (commits, files, drafts). |
| done | Summarise what was delivered and what is left. | On the user's go: `eml_update` status `resolved` with `properties.outcome`. |

A stage that turns out to need a question only the user can answer is a
checkpoint too — ask instead of guessing.

## Checkpoint

At the end of every stage:

1. Write the stage result to the brain (table above).
2. Summarise in this pane: what was done, what the next stage would do, what
   you need from the user.
3. Stop. Do not start the next stage.

When the user says go: `eml_task_entry` with `stage` set to the next stage
(this moves the task), then do that stage.

Only the user's explicit go moves the stage. The start message ("Use the
task-run skill for task …") arriving again — after a restart or a reconnect —
is not a go: re-read the task, say where it stands, and wait.

When the user stops the run: an `eml_task_entry` saying where it stands, and
the task keeps its stage.

## Where to work

Ideation and planning only read; they run where the session started. From
`implementation` on, work here:

- **Project folder is a git repo:** a worktree on branch `task/<title>`
  (`git -C <repo> worktree add <repo>-task-<title> -b task/<title>`), and work
  there. Use absolute paths or `git -C`; the shell's cwd resets to the project.
- **Project folder without git:** the folder itself.
- **No project folder** (an email, research, organising): `$COCKPIT_TASKS_DIR/<title>/`
  for drafts and files; results that matter go into the brain.

`<title>` is the task's title (its kebab-case anchor), or its short id if it
has none.

## Never without the user's explicit go

Anything that leaves this machine or can't be undone is its own checkpoint, in
every stage: send, push, publish, deploy, merge, delete, pay. Prepare it, show
it, wait for the go.
