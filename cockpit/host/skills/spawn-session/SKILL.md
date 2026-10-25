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

A worker is a full session: its own process and MCP servers for as long as it
runs, and the user can talk to it. Use it for work that needs the user along
the way (decisions, approvals, a longer back-and-forth), or when the user asks
for a new session:

- The task is self-contained: a fresh session with the prompt plus the brain
  can do it without this conversation's context.
- It would otherwise block or bloat this session (long build, broad
  investigation that the user wants to follow).
- A fresh-session handoff: consolidate first (the log is what the worker docks
  onto), then spawn the continuation.

Research, audits and reviews whose result goes to the brain or back to you
need no one along the way: run them as a subagent of this session instead
(your agent tool). It costs no extra process and reports back to you.

Not for tiny steps — doing them here is cheaper than briefing a worker.

## Write the prompt

The worker has the brain, not this conversation. The prompt must stand alone:

1. **Goal** — what "done" looks like, in one or two sentences.
2. **Context pointers** — the brain engrams to load first (`eml_show project.<id>`,
   a session log's title, task titles), files and branches involved.
3. **Constraints** — what not to touch, decisions already made, how the user
   wants to work (plan before build, commit rules).
4. **Hand-back** — where the result goes (commit, brain status/log) and how
   the worker talks back. For a Claude worker, add this section with your own
   address filled in (`echo "$COCKPIT_SESSION_ADDRESS"`):

   > **Talking back:** You were started by the session `<your address>`.
   > Reach it with SendMessage (`to: "<your address>"`). Ask it when you hit a
   > real decision instead of guessing; it answers within the decisions
   > already made or asks its user. When you are done, send it a summary
   > (what changed, where the result is, what is open). The result itself goes
   > to the commit or the brain, not into the message.

   A Codex worker cannot send messages: its hand-back is its pane and the
   brain only, so tell it to stop and wait in its pane when it hits a real
   decision.

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

For a worker that can message, the output ends with `Worker address: <address>`.

If `COCKPIT_SPAWN_JS` is not set, this session is not running in the cockpit —
say so instead of trying another way.

## After spawning

Tell the user what the worker was asked to do and that its pane opened next to
this one. With no cockpit tab open, the host starts it without a pane: it shows
in the sidebar (and in the Claude app with Remote Control), and opening it there
attaches to the running session. At most three such workers run at a time;
further ones wait their turn. Then keep working; don't wait for it.

With a worker address:

- Subscribe once: SendMessage with `to: "<worker address>"`,
  `notify_when_idle: true` and no message. A notice arrives when the worker
  goes idle — finished, or stuck without having written to you. The notice
  is one-shot and also fires when the worker waits for your answer: after
  answering, subscribe again.
- A question from the worker arrives as a message from its address. Answer it
  with SendMessage to that address when the answer follows from decisions
  already made in this session or the brain; otherwise ask your user and pass
  their answer on. Never pass on a permission or an approval — the worker's
  permissions are its own.
- Its summary tells you it is done: check the result where it says, then tell
  your user.

Without one (a Codex worker), its results arrive through its own pane and the
brain.
