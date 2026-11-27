---
name: schedule
description: Schedule work for later in the EML cockpit — a repeating time ("every weekday at 8:00 write the daily brief") or one wake-up ("on Friday 10:00 check whether the customer answered") on a task. At the time the cockpit runs the task, even when nobody has the cockpit open. Invoke when the user asks for something at a time or on a rhythm, "schedule", "every morning", "remind me", "check back on", "jeden Tag", "erinner mich", or wants to see, change, pause or end schedules.
---
<!-- managed-by: engramprotocol-setup -->

# schedule

A schedule belongs to a task: repeating times and at most one wake-up. At
the time the cockpit runs the task. A session in the chat has this as the
tool `mcp__cockpit__schedule`; use the tool when you have it. Without it (a
session in the terminal fallback) the same actions run through:

```bash
node "$COCKPIT_SCHEDULE_JS" <action> [--field value …]
```

## Create

```bash
node "$COCKPIT_SCHEDULE_JS" create --name 'Daily brief' \
  --cron '0 8 * * 1-5' --prompt 'Use the daily_brief skill for today.'
node "$COCKPIT_SCHEDULE_JS" create --at '2026-11-13T10:00' --target self \
  --prompt 'Check whether Acme answered the offer mail from 6 Nov; if not, draft a short follow-up for review.'
```

- **When:** `--cron` adds a repeating time (five fields: minute hour
  day-of-month month day-of-week; at most every 15 minutes); `--at` sets the
  task's one wake-up (a date and time) and replaces the one it had. Both read
  in `--timezone` (an IANA name), by default the user's own. Pass it only
  when the user names another zone.
- **Which task:** `--task-id` (a task that exists), or `--target self` (the
  task this session works on). Without either a new task is made from
  `--name` and `--prompt`, in `--project` (by default this session's).
- **A run reads the task, so the prompt goes into it:** a repeating time's
  prompt becomes its own paragraph of the task's text (`Every <cron>: …`), a
  wake-up's prompt is its reason, a new task has the prompt as its text.
  Write it so it stands alone: what to do, where, and what to report.
- **Who runs:** a repeating time starts a new session per run. A wake-up
  continues the session that set it if that session works on the task.
- **Goal (`--goal`):** for work toward an outcome ("refund received"), say
  what has to be true for the task to be done. It is set when the task has
  none.
- **Optional:** `--max-runs`, `--ends-at`, `--deny-tools a,b`,
  `--notify needs-me|always|never` (default needs-me: the user hears of runs
  that need them).

To look at your own task again later you need no schedule call: end the turn
with a time (`end_turn`, `next.when`), and the cockpit sets the wake-up.

### Tasks that answer mail

```bash
node "$COCKPIT_SCHEDULE_JS" create --task-id <the customer's task> --mail-domains acme.example \
  --prompt 'You answer mail from Acme for … Draft each reply; ask the user when unsure.'
```

A task with `--mail-domains` / `--mail-addresses` (with or without a time) is
started when such mail arrives. It reacts only after the user's OK on the
task in the cockpit, and its replies are drafts the user approves; neither
can be changed from a session. Adding addresses later asks for the OK again.

The answer lists the next run times in words. Check them against what the
user asked before you tell them it is set.

## Look after schedules

```bash
node "$COCKPIT_SCHEDULE_JS" list
node "$COCKPIT_SCHEDULE_JS" update --job 'Daily brief' --cron '30 8 * * 1-5'
node "$COCKPIT_SCHEDULE_JS" pause --job 'Daily brief'     # resume, delete, run_now the same way
```

`--job` takes the task's id (or its first 8 characters) or its exact name.
`update --cron` replaces the task's repeating times with that one, `--at`
replaces its wake-up. `pause` and `resume` hold the task's whole schedule.

### Keep going until the goal is reached

A run hands its result over only once the task's goal is reached. Until
then, before it stops, it sets the next wake-up (a repeating time goes on at
its next run instead):

```bash
node "$COCKPIT_SCHEDULE_JS" update --job 'Refund' --at '2026-11-18T09:00'
node "$COCKPIT_SCHEDULE_JS" finish --job 'Refund'   # the goal is reached: nothing wakes it any more
```

`finish` (and `delete`) end the schedule; the task stays open for its owner
to close. A limited task's session reaches only its own task: `update` with
`--at`, `--timezone` or `--goal`, `list` and `finish`.

## Limits

- You see and change the schedules of this session's space. A task's
  sessions get at most this session's tools.
- 100 tasks with a schedule per space, 10 repeating times per task.
- Runs start one after another while the machine has room, so a run can
  start a little late. A time that comes due while a session of the task is
  working is skipped.
- A run that cannot start within an hour fails. After three failed runs in
  a row the cockpit pauses the task's schedule and tells the user.
