---
name: schedule
description: Schedule work for later in the EML cockpit — a repeating job ("every weekday at 8:00 write the daily brief") or a one-time task ("on Friday 10:00 check whether the customer answered"). At the time the cockpit wakes a session with the job's prompt, even when nobody has the cockpit open. Invoke when the user asks for something at a time or on a rhythm, "schedule", "every morning", "remind me", "check back on", "jeden Tag", "erinner mich", or wants to see, change, pause or delete scheduled jobs.
---
<!-- managed-by: engramprotocol-setup -->

# schedule

The cockpit keeps jobs and wakes a session for each run. A session in the
chat view has this as the tool `mcp__cockpit__schedule`; use the tool when you
have it. Without it (a terminal session, Codex) the same actions run through:

```bash
node "$COCKPIT_SCHEDULE_JS" <action> [--field value …]
```

## Create

```bash
node "$COCKPIT_SCHEDULE_JS" create --name 'Daily brief' \
  --cron '0 8 * * 1-5' --prompt 'Use the daily_brief skill for today.'
node "$COCKPIT_SCHEDULE_JS" create --name 'Check Acme reply' \
  --at '2026-11-13T10:00' --target self \
  --prompt 'Check whether Acme answered the offer mail from 6 Nov; if not, draft a short follow-up for review.'
```

- **When:** `--cron` for repeating (five fields: minute hour day-of-month
  month day-of-week; at most every 15 minutes) or `--at` for one time (a date
  and time). Both read in `--timezone` (an IANA name), by default the user's
  own. Pass it only when the user names another zone.
- **Whom it wakes (`--target`):**
  - `worker` (default): a new session per run, in `--project` (by default
    this session's).
  - `job-session`: one session of its own, woken again on every run; it
    remembers earlier runs.
  - `self`: this session.
  - `session`: another session of this space (`--session <address>`).
- **The prompt is all the woken session gets.** Write it so it stands alone:
  what to do, where, and what to report.
- **Optional:** `--max-runs`, `--ends-at`, `--task-id` (the brain task it
  belongs to), `--deny-tools a,b`, `--notify needs-me|always|never`
  (default needs-me: the user hears of runs that need them).

The answer lists the next run times in words. Check them against what the
user asked before you tell them it is set.

## Look after jobs

```bash
node "$COCKPIT_SCHEDULE_JS" list
node "$COCKPIT_SCHEDULE_JS" update --job 'Daily brief' --cron '30 8 * * 1-5'
node "$COCKPIT_SCHEDULE_JS" pause --job 'Daily brief'     # resume, delete, run_now the same way
```

`--job` takes the id (or its first 8 characters) or the exact name.

## Limits

- A job runs in this session's space, with at most this session's tools.
  You see and change only this space's jobs.
- 25 jobs per space.
- Runs start one after another while the machine has room, so a run can
  start a little late.
- A run that cannot start within an hour fails. After three failed runs in
  a row the job pauses itself, and whoever made it hears of it.
