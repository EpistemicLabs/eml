---
name: spawn-session
description: Open a worker session in the EML cockpit — a new agent session in its own pane next to this one, started with a prompt you write. Use it to delegate self-contained work (a build step, an investigation, a review) so it runs in parallel while this session continues. Invoke when the user says "spawn a worker", "start a parallel session", "delegate this", "hand this to a fresh session", "neue Session dafür", "mach das parallel", or when a fresh-session handoff should continue in the cockpit.
---
<!-- managed-by: engramprotocol-setup -->

# spawn-session

Starts a worker: a new cockpit session in its own pane on this desk, next to
this session. It boots from the same brain (identity, rules, open tasks) and
starts with your prompt as its first message. You keep working here.

## When it fits

- The task is self-contained: a fresh session with the prompt plus the brain
  can do it without this conversation's context.
- It would otherwise block or bloat this session (long build, broad
  investigation, a review with fresh eyes).
- A fresh-session handoff: consolidate first (the log is what the worker docks
  onto), then spawn the continuation.

Not for tiny steps — doing them here is cheaper than briefing a worker.

## Write the prompt

The worker has the brain, not this conversation. The prompt must stand alone:

1. **Goal** — what "done" looks like, in one or two sentences.
2. **Context pointers** — the brain engrams to load first (`eml_show project.<id>`,
   a session log's title, task titles), files and branches involved.
3. **Constraints** — what not to touch, decisions already made, how the user
   wants to work (plan before build, commit rules).
4. **Hand-back** — where the result goes (commit, brain status/log, a message
   in its own pane) and that it stops and asks when it hits a real decision.

## Run it

Write the prompt to a file (keeps multi-line prompts safe), then:

```bash
node "$COCKPIT_SPAWN_JS" --project <project> --prompt-file <file> --title "<short pane title>"
```

- `--project`: the brain project id (as in `eml_show project.<id>` — pass just
  `<id>`), the project's name, or a folder path the cockpit knows. An unknown
  project fails with the list of known ones.
- `--title`: optional, a few words — shown as the pane title.
- `--provider`: optional, `claude` or `codex` — the agent CLI the worker runs with. Leave it out
  unless the user asked for a specific one; the worker then uses the cockpit's default.

If `COCKPIT_SPAWN_JS` is not set, this session is not running in the cockpit —
say so instead of trying another way.

## After spawning

Tell the user what the worker was asked to do and that its pane opened next to
this one (or opens as soon as a cockpit tab is open). Don't wait for it; its
results arrive through its own pane and the brain.
