# EML Cockpit

A local web app that runs isolated Claude Code sessions next to your own brain — a typed memory
store (EML) that every session reads from and writes to. One process on your machine: brain server,
session runtime and UI, all on `127.0.0.1`. The browser never holds the brain token.

## Quick start

**You need:** macOS or Linux, Node ≥ 22 and pnpm 10 (`corepack enable`). Claude Code does not have to be
installed: the cockpit downloads and updates its own copy (see *Claude Code* below).

```bash
git clone https://github.com/EpistemicLabs/eml.git && cd eml
pnpm install
pnpm run cockpit          # builds everything, starts the cockpit, opens a browser tab
```

**First start:**

- The cockpit downloads its own **Claude Code** into `~/.eml-cockpit/claude/` (about 230 MB, once) —
  checked against Anthropic's release manifest and code signature before it's used.
- A fresh, empty **brain** is created under `~/.eml-cockpit/`. Everything stays on your machine; host
  and brain listen on `127.0.0.1` only.
- Create a project (sidebar **+**) and click **New Session**. Without a folder of its own, a project's
  sessions run in `~/.eml-cockpit/workspaces/<project>`; point it at a real repo via the folder action.
  In the first session, sign in with `/login`. The cockpit keeps its own Claude config, so your normal `~/.claude` login and
  settings are untouched. Settings › Models also takes a `claude setup-token` instead.
- The terminal prints the cockpit URL. The port is random unless you set `COCKPIT_PORT=4317`.

## Install as an app (with updates)

`pnpm run cockpit` runs the cockpit from the source checkout. To run a **release** as a login service
that updates itself, install it as an app:

```bash
curl -fsSL https://github.com/EpistemicLabs/eml/releases/latest/download/install.sh | bash
                                          # newest release, needs only Node ≥ 22 (guide: INSTALL.md)
scripts/install-app.sh latest            # the same from a checkout (needs a logged-in `gh`)
scripts/install-app.sh --from release/<v> # or local assets built with scripts/pack-release.sh
```

This installs into `~/.eml-cockpit/app/versions/<v>/`, points `~/.eml-cockpit/app/current` at it and
registers the login service on port 4317 (`--port`, `--home` to change). An existing
`~/.eml-cockpit` is kept as it is: brain, sessions, projects and the Claude login stay; the new version
migrates the brain on start (with a backup first).

**Updates:** the cockpit checks GitHub Releases every few hours. When a newer release exists, a banner
offers **Update**: it downloads both tarballs, checks their SHA-256 against `SHA256SUMS`, installs them
into their own version folder, switches `current` and restarts. Running sessions resume afterwards.
Settings › About › Updates shows the state, checks now, and goes back to the previous version (not
across a brain-schema change).

**Update channel:** Settings › About › Updates › Channel. **Stable** (the default) is offered releases
only. **Alpha (experimental)** is also offered the pre-releases built from the `alpha` branch
(`v<X.Y.Z>-alpha.<N>`), whichever version is highest. Early builds for testing: things may break, and
a shared space stays compatible only while every member runs the same alpha. The channel is stored in
`~/.eml-cockpit/app/update.json`. A cockpit on stable never sees an alpha build.

**Start over:** stop the cockpit and delete `~/.eml-cockpit/`. That removes the brain, the
session list and the cockpit's Claude login — back it up first (Settings › Spaces › Back up).

**Keep it running from source:** a source checkout can run as a login service too:

```bash
pnpm -F eml-cockpit build                                    # build the host once
COCKPIT_PORT=4317 pnpm -F eml-cockpit exec eml-cockpit service install
pnpm -F eml-cockpit exec eml-cockpit service status          # loaded? port responds? last log
pnpm -F eml-cockpit exec eml-cockpit service uninstall
```

A source-run cockpit has no updater — update it with `git pull && pnpm install && pnpm run cockpit:build`
and a service restart. The service is pinned to the port + home you install it with, and captures the
absolute `node` path at install time, so re-run `service install` if you move the repo or reinstall
node.

**Known limits:**

- Remote access is Tailscale only (`eml-cockpit remote enable`, INSTALL.md): the host stays on
  `127.0.0.1` and lets in requests that `tailscale serve` proxies for a listed tailnet user.
- Open the cockpit in **one** browser tab. A second tab takes over the running sessions, and the
  first one shows "Connect".
- The login service runs on macOS (launchd), Windows (the user's Run key with a small supervisor) and
  Linux (a systemd user unit; on a server without a login session it needs `loginctl enable-linger`).

## Architecture

Three layers, one local process:

- **`frontend/`** — Vite + React SPA: desks (top tabs) with pane grids — sessions (terminal, chat) and plugins (brain, notes, worktrees, repository, shell) —
  the sidebar with projects and sessions, the brain views. Talks only HTTP + WebSocket to the host.
- **`host/`** — owns the node-pty session spawns (isolated `claude`) in a persistent PTY registry,
  bundles and launches the brain server (`packages/server`) on loopback, and proxies `/api/brain/*`
  with the token injected host-side.
- The real `claude` CLI processes, reaching the local brain via injected MCP (`--mcp-config`).

## Develop

The cockpit packages (`cockpit/host` = the `eml-cockpit` package, `cockpit/frontend`) are members
of the pnpm workspace, so one install at the repo root covers everything:

```bash
pnpm install
```

Then, from repo root:

```bash
pnpm run cockpit          # builds core/server/mcp-server + frontend, assembles eml-cockpit, starts it, opens the tab
```

Develop against the separate dev home — never against your real cockpit:

```bash
pnpm run cockpit:dev                                              # terminal 1: host via tsx watch, EML_COCKPIT_HOME=~/.eml-cockpit-dev, port 4318
pnpm -F @engramprotocol/cockpit-frontend dev                      # terminal 2 (HMR; proxies /api + /ws to the host)
```

For checks that need a second member of a shared space, `cockpit/scripts/dev-home.sh` keeps two
fixed dev cockpits — a (`~/.eml-cockpit-dev`, 4318) and b (`~/.eml-cockpit-dev-b`, 4319), each its
own person — and serves either from the worktree it is run in (`start a|b`, in tmux). `snapshot`
and `reset` keep and restore a profile's local brains; a shared space is never part of it, since
its replica follows the relay. Each home is served by one host at a time.

The real cockpit runs from the default home `~/.eml-cockpit` (`pnpm run cockpit`, or
`COCKPIT_PORT=4317 pnpm -F eml-cockpit start` after a build). A host started without
`EML_COCKPIT_HOME` always opens `~/.eml-cockpit`, so dev work goes through `cockpit:dev`.

### What a change needs to show up

For the real cockpit (built host, `node dist/index.js`):

| Changed | Build | Host restart? |
|---|---|---|
| Frontend (`cockpit/frontend`) | `pnpm -F @engramprotocol/cockpit-frontend build`, then reload the browser | no — the workspace host serves `cockpit/frontend/dist` directly |
| Host (`cockpit/host/src`) | `pnpm -F eml-cockpit build` | yes |
| Brain server / core (`packages/server`, `packages/core`) | build those packages, then `pnpm -F eml-cockpit build` (the server is bundled into `dist/server.cjs`) | yes |
| mcp-server tools + hooks (`packages/mcp-server/src`) | `pnpm -F @engramprotocol/mcp-server build` | no — every new session starts its own MCP server and hooks; running sessions keep the old code until they restart |
| mcp-server skills (`packages/mcp-server/templates/skills`) | — | yes — the host copies them into its config on boot |
| Brain content (engrams) | — | no |

`pnpm run cockpit:build` builds everything at once; restart afterwards and everything is current.
A restart ends the running Claude sessions; after a browser reload they resume with their history
(only a turn in flight is lost). The dev host (`cockpit:dev`, tsx watch) restarts by itself on
changes under `cockpit/host/src`; server, core and mcp-server still need their builds, and a new
brain server is picked up on the dev host's next restart.

## The `eml-cockpit` package

`cockpit/host` is the `eml-cockpit` package (`npx eml-cockpit` once published). Core and server are private
workspace packages, so `scripts/build.mjs` bundles them into the package instead of depending on
them:

```
dist/index.js     host entry (bin)          tsc, ESM
dist/server.cjs   brain server + core       esbuild, CJS, better-sqlite3 external
dist/core.cjs     core (provisioning)       esbuild, CJS, better-sqlite3 external
ui/               frontend build            copied from cockpit/frontend/dist
migrations/       brain + control SQL       copied from packages/core/migrations
contracts/        contract + frozen log     copied from packages/core/contracts
```

The SQL files sit next to `dist/` because core resolves them as `__dirname/../migrations` — the
same relative location from a workspace checkout (`packages/core/migrations`) and from the bundle.
`contracts/` sits there for the same reason: the contract document of the brain schema and the
frozen log the brain server replays when it starts (its self-test, reported on `/health`).
Real dependencies are only `better-sqlite3`, `node-pty` (both prebuilt) and
`@engramprotocol/mcp-server`, whose `dist/cli.js` the host injects into each session's MCP config.
Verify a build end-to-end with `pnpm -F eml-cockpit pack`, `npm install <tgz>` in a scratch
project and `EML_COCKPIT_HOME=<scratch> npx eml-cockpit`.

Env: `COCKPIT_PORT` (host port, default a free port / 4318 in dev), `COCKPIT_NO_OPEN=1`
(don't open a browser tab), `EML_COCKPIT_HOME` (the app home, default `~/.eml-cockpit`).

## Brain spaces and agents

A **space** is one brain that holds work: projects with their rules, entities with their profiles,
tasks, decisions, notes. The cockpit starts with the brain it was set up with (the main space);
**Settings › Spaces › New space** or the space menu in the header adds a further local brain. Every
desk, session and project belongs to exactly one space, and a session only ever reaches its own
space — the boundary between spaces is the space's per-boot MCP token, not a filter. The switch in
the header (and the sidebar's group header) changes the space with its desks, projects and Brain tab.

An **agent** is its own brain: its persona, its rules, its learnings and its view of the people it
works with (scopes `agent.<id>` and `user.<handle>`). Every space binds one agent, and the same agent
may be bound to several spaces — it is the same agent in each. A session runs as its space's agent:
the host boots its identity from the agent brain and the system rules from the space, routes a
profile, rule or learning in `agent.<id>` / `user.<handle>` to the agent brain and everything else to
the space, and stamps every write with the agent (`ingested_by` names you, `agent` the agent). A
relation between a space engram and an agent-brain engram is kept in the agent brain as a
cross-brain reference. The first-run setup creates the main space and the first agent; the agent
brains' tokens are the host's alone.

Host side: `brain-space.ts` (one `BrainSpace` per brain: token, bound agent, session files under
`claude-config/spaces/<brain id>/`, project list, local registry, notes), `agents.ts` (the agent
brains), `brain-mcp.ts` (the routing); the frontend names the active space in the `x-cockpit-space`
header of every host request (missing = main).

A shared team brain (v0.21) is a space like any other: `POST /api/spaces` with `shared: {handle?}`
founds one (a creation grant from the EML account, an empty brain the brain server founds on the
relay) and with `join: {link, handle?}` joins one by its invite link; the member handle defaults to
the home's handle. The host provisions the empty brain, holds its token, binds the main space's
agent and writes the space into the config once the server took the brain; a brain the server
refused is discarded again. `GET /api/spaces/:id/team` is the server's view (state, read-only
text, members, invites), `POST …/invites {role?}` (member or owner, chosen at the invite),
`…/invites/:id/accept`, `…/cancel` the owner's invite flow, `DELETE /api/spaces/:id` removes a shared space that never came to life. At boot the host
asks the server which spaces are shared and discards an empty brain no config token holds
(`team-space.ts`).

**The task system runs in every space**, local and shared, with no switch: every session works on a
brain task, the task board shows every space's tasks, and the runner, the router, the next-step check
and the weekly cycles run in each space. In a shared space each member's cockpit works for its own
member, so two cockpits never act on the same task: the router, the next-step check and a session's
task act only for this cockpit's own sessions, and the background work acts only on the tasks this
member owns — the first person in `assignee_ids`, else the task's author (`ingested_by`), compared
with the config `handle` (`domain/task-owner.ts`). The runner starts only this member's ready steps;
the cycles carry over only this member's open tasks into the new week, also when the other member's
cockpit made the week first, and close the last week once. A space whose sharing the host could not
confirm yet counts as shared.

**Moving a project into a shared space.** On a project's page in the Brain tab of a local space,
"Move to shared space…" opens the one dialog of the move: the shared space to move into, and the
plan the brain server makes for it — the project with its sub-projects, how many engrams, journal
entries and links move, which links to things that stay behind are dropped (they stay in the
backup), the size against the 16 MiB one op carries. A plan the server refuses says why in the
server's words (entries still written under an agent's name, a space not connected, a set too
large); otherwise one confirm runs it. The host backs up the space's brain first, the server writes
one import op into the shared brain and removes the set here in the same transaction, and the
project's local state (name, pin, folder, hidden flag) follows it into the other space's sidebar.
The copy left behind is archived and points at the shared space, in the Brain tab and in `eml_show`.
A move the relay did not confirm in time removes nothing; once the space is live again, Move picks
up where it stopped. Host side: `project-move.ts` (`GET /api/projects/:id/move-plan?target=`,
`POST /api/projects/:id/move {target, plan_hash}`).

With more than one space, the sidebar's switch also offers **All spaces** (the default): one list of every
space's sessions with the sections Waiting, Pinned, Working and Recent, each row marked with its agent's
letter. It is a view of the sidebar only: the cockpit stays in one space, and a click switches to the
session's space and opens it there. The list comes from `GET /api/sessions/all` (ids and metadata, no tokens).

### A space's own agent

A further space can have its own agent: its own agent id, Claude config folder, login, MCP allowlist and
skill list. A space without one behaves as described above; the main space keeps the shared config.

```
<home>/agents/<id>/agent.json         agent id, brain id, allowed MCP servers and skills, temp folder, config folder per agent CLI
<home>/agents/<id>/mcp-servers.json   definitions of the allowed servers (chmod 600)
<home>/agents/<id>/claude-config/     generated files, transcripts, and the login Claude Code keeps there
```

Stop the cockpit, then set one up. Start it again and run `/login` once in a session of the space:

```bash
eml-cockpit agent create <id> --space <name|brain id> \
  [--mcp a,b --mcp-from <json with mcpServers>] [--skills x,y] [--skills-from <folder>]
eml-cockpit agent status [<id>]        # reads the files only; never starts `claude`
eml-cockpit agent sync-skills <id>     # copy the listed skills in again
```

- **Sessions** run with `CLAUDE_CONFIG_DIR` set to the agent's folder and its own `CLAUDE_CODE_TMPDIR`. Resume, trust,
  the sidebar's summaries and the managed skills all use that folder. The folder's path is stored in `agent.json` and
  never derived, so moving it is a one-line change.
- **MCP:** `--strict-mcp-config` with an owner-only file of the brain plus the allowed servers. Nothing else loads,
  whatever is added to the shared config, and claude.ai connectors are off. MCP servers get only the environment
  their definition names, plus a few basics (`CLAUDE_CODE_MCP_ALLOWLIST_ENV`).
- **Skills:** exactly the list plus the cockpit's managed ones, as copies. On every start the host removes anything else.
- **Browser:** an agent's sessions get no Claude in Chrome unless its `agent.json` says `"chrome": true`. Chrome reaches every site the browser is signed in to, so give an agent its own browser profile.
- **Login:** one `/login` per folder. The cockpit does not store or pass Claude tokens for this, and Settings › Models'
  setup-token mode does not apply to these sessions.
- **How long sessions run** is one rule (`domain/session-lifecycle.ts`). A session nobody looks at stops one hour
  after its last activity (Settings › Preferences › Sessions), a worker too; one with a window open after 2 hours, one
  with an open card after 4; never mid-turn or with background work. Opening a chat only shows it: the process starts
  when the input is used or a message arrives. At most 8 sessions run at once (also in Settings): at the cap the one quiet
  longest stops to make room, and when all are busy new workers wait.
- **Memory:** under the Linux autostart service every session runs in a cgroup of its own with a ceiling (2 GB RAM +
  512 MB swap by default; `infrastructure/platform/linux-cgroups.ts`). At the ceiling the kernel stops the session's
  largest process alone, normally the runaway tool, and the session shows a notice. The unit has `OOMPolicy=continue`
  and `Delegate=yes`; the host rewrites an older unit at start and reloads systemd, which applies both to the running unit.
- **Workers** a session asks for start in chat on the host, with the prompt as the first message, and a pane only
  joins (`application/start-worker.ts`). Codex, token mode, the host's own sessions and Settings › Models › Chat view off
  stay in the terminal. The same switch decides where new Claude sessions open (on by default); a browser can choose
  chat or terminal for itself in Preferences. New workers wait while free memory is below 1 GB or the running cap is reached with every session busy. In chat a worker reports
  `done`, `question`, `review` or `failed` through a status tool; a turn that says nothing is asked once, then marked
  `review`. After a host restart a worker cut off mid-turn gets one message to continue, one at a time as there is room, then is marked `failed`.
- **Messages:** `POST /api/sessions/<id or address>/message` delivers to a session and resumes it if stopped
  (`application/deliver-message.ts`); a session in a terminal answers busy. A `PreToolUse` hook (`send-message-hook.ts`) sends `SendMessage` calls for a
  stopped session through it and cancels the call with a result saying it was delivered; a running target, an unknown
  one or any failure leaves `SendMessage` as it is. `$COCKPIT_MESSAGE_JS` is the same for scripts. To find a target by what the user calls it,
  `$COCKPIT_SESSIONS_JS <words>` searches the sessions SendMessage reaches, stopped ones too, by name, first prompt,
  last status reason and project (`domain/session-directory.ts`); a `PostToolUse` hook (`list-agents-hook.ts`) adds
  pinned and desk main sessions, then the most recent, to `ListAgents`, as many as fit under Claude Code's 10,000-character cap. An outside
  service on this machine reads `<home>/message-token` and only reaches workers started with `--wakeable`.
- **Schedules:** a schedule belongs to a task and lives in the brain (`delegation.schedule`, brain schema 24): repeating
  times (crons, read in one time zone) and at most one wake-up (a time, its reason, the session that set it); one pause
  and one end for the whole schedule (`domain/task-schedule.ts`, written only through
  `application/task-schedule-write.ts`). An agent sets it in two ways. Ending a turn with a time (`end_turn`,
  `next.when`) sets the wake-up of the session's task and replaces the one it had; a turn without a time clears the
  wake-up only when that session set it, a hand-over to the owner clears it whoever did, and a task that has a next run
  needs no time (`application/turn-wake.ts`, `domain/turn-end.ts`). The `schedule` tool (in the chat view's `cockpit`
  MCP server, next to `end_turn`) or `$COCKPIT_SCHEDULE_JS` (skill `schedule`) adds a repeating time, sets the wake-up,
  pauses, resumes, ends or runs a task's schedule; the task is `task_id`, the caller's own (`target self`), or a new one
  made from name and prompt (`application/jobs.ts`, `domain/schedule-tool.ts`). What a time is for stands in the task's
  text. The cockpit of the task's owner fires it (`application/job-runner.ts`): a session of the task that works skips
  a due repeating time (a due wake-up is never skipped: it waits until that session stops, or joins a run that waits to start), one that waits on the owner's answer gets it as a message, a due wake-up continues the session that set
  it, anything else starts a new session; its prompt is built from the task, behind a line saying the cockpit sent it and
  what fired (`domain/firing-order.ts`, `domain/run-text.ts`). What only this machine needs sits in one record per
  task in `<home>/jobs.json` (`domain/job.ts`), with its last 100 runs: where the schedule stands, who hears of a run,
  the tools of the task's sessions (never more than its maker's), an end after so many runs, the channels. Runs start a
  few at a time and only with room (the worker check above); a busy session is tried again for up to an hour; a
  repeating time due more than 6 hours ago (the cockpit was down) is recorded as missed, a wake-up still fires late;
  three failures in a row pause the schedule. At most 100 open tasks of a space hold a schedule. The channel bridge
  wakes the same tasks for mail, Slack and WhatsApp. It reaches the host at
  `/v1` (`domain/job-contract.ts`) with a space's token from `<home>/job-tokens/<brain id>` (made at start for every
  space), reads the tasks listening on a channel (held ones marked, so their mail still waits for them), and wakes one
  with a short text and an idempotency key; a message is never skipped: the host decides which session it reaches and
  answers delivered, retry or refused.
- **Channel bridge:** `packages/channel-bridge`, bundled as `dist/channel-bridge.cjs`, runs next to the host once
  `<home>/channel-bridge/accounts.json` lists mailboxes; the host restarts it after a crash and stops it with itself
  (`infrastructure/channel-bridge/`). A session started for a task that listens on a channel gets, at every launch, the bridge's tools `msg_read`, `msg_new` and
  `msg_reply` (`dist/channel-bridge-mcp.cjs`), no Bash and of its space's MCP servers only the brain
  (`application/channel-job-launch.ts`). Its drafts show on the session's review card, where the user edits, sends or
  skips them; the page reaches them through `/api/bridge/*` (`channel-bridge-api.ts`), which adds the bridge's
  cockpit token in the host.
- **A schedule's controls:** there is no Jobs view. A task's panel has a **Schedule** section: its repeating times,
  each with Remove, the wake-up with its reason, the next run, one Pause or Resume, Run now and End for the whole
  schedule, the user's own decisions for this machine (their OK for new channel addresses, send or draft, the Limited
  switch, lent tools) and the last runs (a missed one stands out there). Pause, resume, run now, remove one repeating
  time and End schedule are commands on the task (`/api/v1/tasks/<id>/…`, `tasks-api.ts`); Run now is refused when no
  session could start (the task has no project), and a card or Plan row says when a channel waits for the user's OK. The user's decisions and
  the task's last runs are under `/api/v1/tasks/<id>/record` (`application/task-record.ts`). What a run needs from the
  user shows in the review section on the run's session (Needs you, Check this). A task that could not run, or whose
  schedule the cockpit paused after three failures, has no session saying so, so its newest run session (else whoever
  set it up) shows it as "Needs you". Everything that tells the user outside the cockpit goes through a `Notifier`
  (`notifications.ts`), which web push implements.
- **Notifications (web push):** Settings › Notifications turns push on per device; on an iPhone only in the cockpit
  added to the home screen, and only over HTTPS (`tailscale serve`). Needs you, Check this and a new result reach every
  subscribed device with the session's name, its project and what it said; a tap opens that session. While the user
  works in the cockpit on a device (a click or key there within ten minutes), only that device is told and the phone
  stays quiet. No push about a session someone has on screen, nor the same notice twice within two minutes. The host signs and encrypts each
  message itself (`infrastructure/push/web-push.ts`, RFC 8291/8292, no library) and sends it to the browser's push
  service, outbound only: Apple or Google see the size and time of a message, not its text. The key pair and the
  devices live in `<home>/push.json` (owner-only); the page's routes are in `push-api.ts`, the service worker in
  `frontend/public/sw.js`.
- **Goal and wake-ups:** the task's goal says when the work is done. Until it is reached a run sets its next wake-up
  before it stops (ending its turn with a time, or the schedule tool's `update` with `at`), unless a repeating time
  brings it back; once it is reached it ends the schedule (`finish`) and hands the result over. A task that has a
  schedule is never closed by a run: its owner ends the schedule and closes it. Nothing fires on a closed task.
- **Mail:** the schedule tool's `mail: { domains, addresses }` puts a mail channel on the task's record: the channel
  bridge then wakes the task when such mail arrives. Replies are drafts, and it reacts only once the user gave their OK
  on the task (Approve in the task panel's Schedule section); adding addresses later asks again. Switching a channel to send is the user's alone, never a session's.
  A session a firing starts carries the task's id in its ledger entry (`jobId`, the record's id), so its channel tools
  act for that task on every resume. A shared space's tasks get no mail channel.
- **Limited tasks and grants:** a task's sessions start with its maker's tools: a session whose own tools are narrowed
  and that sets something to wake the task (the schedule tool, or a wake-up by ending its turn) narrows the task's
  record to what it has itself, never wider (`domain/schedule-tool.ts` `narrowedProfile`). The user can mark the task's record
  **limited** (the user's alone): its sessions get no shell, no messages to other sessions and of the space's MCP
  servers only the brain; web tools stay, and the schedule tool reaches only their own task (next wake-up, goal,
  finish; `application/limited-job-scope.ts`). The user lends it Chrome or SendMessage for a while (`grants`, default 1 h); a grant
  ends at its time or when the task's session reports done, and the host restarts the session to pick it up.
- **Tool limits:** `--deny-tools` and `--mcp-servers` on a worker hold for its whole life in both views.
- **Terminal and chat view** both start from the same space (`sessionSpaceOf`), so an agent's chat session gets the same
  folder, MCP allowlist, environment and refusal. `/login` runs in a terminal session.
- **Failure:** the space's entry in the cockpit config names the agent. If its record, config folder or an MCP file is
  missing, or the record does not fit, the session does not start and the pane says why. It never falls back to the
  shared folder, and nothing recreates the folder.
- **Identity** stays in the brain: `agent create` writes nothing there and keeps the space's token. Sessions boot
  as the agent the brain is named after, and new engrams carry the person behind the token in `ingested_by`.
  Workers run in their requester's space with the same files.
- **`eml-cockpit rotate-brain-token <main|name|brain id>`** replaces a brain token with the cockpit stopped: new token
  under the same name, stored in the cockpit config, old one revoked.

**This separates context, not access.** All agents run as one OS user, so an agent's shell can still read another
agent's folder and login, every brain file and token, and can reach the cockpit's local API. Use it to keep context,
tools and provenance apart, not to contain an agent you do not trust; that takes separate OS users.

## Projects and sessions

The sidebar's project list is the brain's project list: every brain project appears
automatically (name from the brain), and the cockpit only adds local state per project — the
folder its sessions run in (assigned on the first "New Session" or via the folder action), pin,
hide. Archived and hidden projects stay out of the list until "Show hidden & archived". "+"
creates a brain project (`POST /project`) or registers a folder-only project that exists in the
cockpit alone; nothing is synced back into the brain. `GET /api/projects` serves the merged list
(host `brain-projects.ts` + `project-registry.ts`), with `kind`, `brainProjectId`, `brainStatus`.

Isolation means the app's *global* Claude environment (its own `CLAUDE_CONFIG_DIR`: settings,
`.claude.json`, sessions, MCP registration, auth) stays separate from your `~/.claude`. Sessions
themselves run in your real projects: every session starts with cwd = the project's folder, so
the project's `CLAUDE.md`, `.claude/settings.json` and `.claude/settings.local.json` apply (folders are stored resolved, so the
trust entry matches Claude's cwd). Local project state lives in
`~/.eml-cockpit/projects.json`; the host trusts each project path in the
app's `.claude.json` so the TUI opens straight into the session. The brain MCP is always attached
(`--mcp-config`, rewritten on every host start): one HTTP endpoint in the host (`/mcp`, loopback
only) serves every session instead of a process per session. A space's own per-boot token picks
its brain and the bound agent's, and the session must be one the host started in that space; no
brain token leaves the host. The session hooks (boot, project block) read through the host the same
way (`/hooks`), so the boot a session gets is its agent's identity plus the system rules. Your own MCPs load next to it as long as you set
them up *inside* the cockpit: `claude mcp add -s user …` in a cockpit session (stored in the
cockpit's `.claude.json`, survives restarts), claude.ai connectors via `/mcp`, plugins via
`/plugin`, and a project's `.mcp.json` (Claude asks before loading it). MCPs from your normal
`~/.claude.json` are not carried over.

Every terminal pane pre-mints its Claude session id. The host keeps a PTY registry keyed by
session + pane: a reload (or a second tab) reattaches to the running `claude` with a
snapshot replay of the rendered terminal state instead of spawning again; a detached PTY is
kept for 30 minutes. Across host restarts the host consults its own session ledger
(`~/.eml-cockpit/sessions.json`): known ids are spawned with `--resume`, unknown ones
with `--session-id`; a `--resume` that finds no conversation falls back to a fresh session
under the same id. Desks (the top tabs; `spaces` in the store) keep their panes mounted while hidden, so switching desks never
touches a terminal.

A desk can have one **main pane** (the toolbar's panel icon): a full-height column at the left, a third wide until its
divider is dragged, with the other panes in the even grid beside it. The width is remembered per desk. Like a pinned pane, a
main pane can't be closed or moved to another desk until main is turned off. Dragging a pane's title onto another pane swaps
the two, and whichever lands in the main column is the main pane. Panes keep a fixed DOM order and only their grid placement
changes (`components/app/paneLayout.ts`), so none of this remounts a terminal or chat or loses its scroll position.

## Brain views

The header's fixed **Brain** tab is a brain *surface*: a small mini-app (dashboard → project →
search) whose page navigation is a module store keyed per surface (`lib/brain-nav.ts`), not URL
routes — the tab and, later, brain panes share one URL, and the engram drawer already owns
`?engram=<id>`. The dashboard (`components/brain/BrainHome.tsx`) shows a snapshot with an activity heatmap,
projects by last activity, recent activity, open tasks and pending reviews; the project page
(`BrainProject.tsx`) a status banner paging through the superseded history, open tasks / decisions /
references / rules / logs, project-scoped search and the graph lenses timeline / tags / relations;
the search page (`BrainSearch.tsx`) runs `/list?search=`. The engram drawer (`engram-drawer.tsx`,
`engram-detail.tsx`) is the detail surface: back trail, ‹ › / j k paging within the list it was
opened from, resolved properties and relations, and the review triage bar (still current / retire /
new task) on flagged engrams. The `brain` pane-type (`BrainPane.tsx`) is the brain next to a
terminal: timeline | list over recent engrams, live search, type chips — no graph at pane width,
scoped to the pane's brain project (project | brain chip) or brain-wide in a folder-only project.
Pending reviews and the tab's amber badge read the brain's `review_due=true` list filter.

## Cockpit plugins

A pane's views come in two groups (`lib/pane-views.ts`): the session's — Terminal, Chat — and the
plugins, the project's views — Brain, Note, Worktrees, Repository — and Shell and Time. The tab bar and the "+" menus (pane and sidebar)
show both groups. All six are official plugins with only a pane part, switched on or off
for the whole cockpit in Settings › EML Plugins (`config` → `plugins`, `GET/PATCH /api/plugins`,
`host/src/plugins-api.ts`), per space. Brain, Note and Worktrees start on, the later ones off, until the user switches them; a switch
the user set is kept.

Every plugin has a manifest, `plugin.json` (`host/src/domain/plugin-manifest.ts`): id, name, tier and
its parts — `pane` (a built-in view), `mcp` (an MCP server, stdio or http, whose settings may name a
`secret` filled in from a connection) and `channel` (a channel bridge adapter by account type) — and
whether it starts on. The official ones live in the repo's `plugins/<id>/` and ship with the package
(the build copies the manifests to `host/plugins/`); Gmail is one, with a channel part. The user's own
custom MCP servers live in `<home>/plugins/custom.json` (owner-only), added and removed on this machine
only (`POST /api/plugins/custom`, `DELETE /api/plugins/custom/<id>`). The tier decides the parts
(decision cockpit-plugin-isolation): official, custom and dev plugins may run servers, a community
plugin is a pane only, and a custom one an MCP server only. `GET /api/plugins` shows an MCP part's
settings by name only, never their values. `host/src/infrastructure/plugins/plugin-registry.ts` reads them.

Settings › EML Plugins (`frontend/src/components/settings/view/tabs/PluginsTab.tsx`, `lib/plugins-admin.ts`)
shows them in four views: Installed (tier, parts, sign-ins, spaces), Spaces (a switch per plugin and
space, with the sign-in it uses), Connectors (the claude.ai connectors per space) and Add plugin
(a custom MCP server by command or URL, its secret values stored as a sign-in of its own); a plugin
opens on its own page with its parts, sign-ins, spaces and what its tier lets it do. Sign-ins and
custom servers are managed on the cockpit's own machine only.

**Gmail** (`plugins/gmail/`) has a channel part (the bridge's mailbox) and an MCP part (mail and
calendar tools for the user's own sessions, `plugins/gmail/mcp`) on one Google sign-in. The cockpit
signs in with the user's own OAuth "Desktop app" client (`host/src/infrastructure/plugins/google-sign-in.ts`,
`<home>/plugins/google/`, owner-only): the client JSON once, then Google's consent page and the
address the browser ended on pasted back — it needn't load, so this works over remote access too
(`/api/plugins/google/*`). A space may use several Google accounts at once; each sign-in is its own
MCP server (`gmail`, `gmail-<short name>`) and its own bridge account. An official plugin keeps its
server names, so the gmail plugin's servers replace imported servers of the same name.

**Per space** (`host/src/application/space-plugins.ts`, `<home>/plugins/spaces.json`): a plugin is on
or off in each space, all or nothing; a part can be switched off for every space. A plugin with a
sign-in uses one of the user's connections there (`<home>/plugins/connections.json`, owner-only:
the values a plugin's `{ secret }` settings stand for, never sent to the page). From this the cockpit
writes each space's session files whenever a switch changes (a running session keeps what it started
with): `mcp.json` holds the brain and the MCP servers of its plugins under their server names, and
`settings.json` lists the claude.ai connectors and Claude Code plugin servers switched off in it as
`deniedMcpServers` (Claude Code honours a name there for a single connector; `--strict-mcp-config`
would drop every connector, so a space without an agent runtime stays non-strict). An agent with a
runtime of its own keeps `--strict-mcp-config` and gets its space's plugin servers in place of its
`agent.json` list. Codex reads one `config.toml` for every space: each space's plugin servers are
written there switched off, and a session switches on its own with `--config mcp_servers.<name>.enabled=true`.

On a home's first boot with plugins the cockpit-wide switches of before carry over to every space,
and the MCP servers configured outside the plugins are imported once
(`host/src/infrastructure/plugins/mcp-import.ts`): the user-level servers of the cockpit's Claude
config (`<home>/claude-config/.claude.json`) and each agent runtime's `mcp-servers.json` (as far as its
`agent.json` lists them) become custom MCP plugins under their own server names, on in exactly the
spaces that loaded them; their values go into connections. `.claude.json` is copied to
`<home>/plugins/backups/` first and keeps only what couldn't be imported; agent files stay untouched.
The channel bridge's accounts file (`<home>/channel-bridge/accounts.json`)
is written by the cockpit from the channel plugins: one account per connection, listing every space
with a job token where the plugin is on with it; a change restarts the bridge with it. A file
written by hand before becomes the gmail plugin's connections on that first boot, each keeping its
account id (the bridge's cursors and threads carry on), after a copy to `<home>/plugins/backups/`.
`spaces.json` → `done` records each step, so it never runs twice. To undo it: copy the backup over
`<home>/claude-config/.claude.json` (and the accounts backup over `<home>/channel-bridge/accounts.json`)
and remove `<home>/plugins/` (that also resets the switches). A plugin switched off leaves the menus, its routes answer 404 (Notes:
`/api/notes`), and a pane showing it moves to the first plugin still on, or to the terminal; what it
holds stays — notes stay engrams. Brain off hides only the pane view: the header's Brain tab and the
agents' brain stay. With every plugin off, the tab bar shows only the session's views.

**Worktrees** (`components/worktrees/WorktreesPane.tsx`) shows the project folder's git worktrees
against the default branch — changes, commits ahead/behind, when it was added, the sessions working
there and the ports its processes listen on — and below them the other local ports (who started them:
a cockpit session, another cockpit, the system). Read-only: `GET /api/plugins/worktrees/git?projectId=`
takes the folder from the project registry, never from the request; `…/ports` lists the user's
listening TCP ports (`lsof` + `ps` on macOS and Linux, none on Windows yet) with command lines whose
secrets are blacked out. A session's worktree is the cwd its agent's hooks report (ledger `workdir`).

**Repository** (`components/repository/`, loaded on first use: it brings CodeMirror) is a read-only code view of
one checkout — the project folder or one of its worktrees (a worktree row opens it there): what is
uncommitted and what the branch committed since the default branch as GitHub-style diffs, the whole tree
with a file search and any file in it, the commits and each one's diff. `GET /api/plugins/repository/*`
(`host/src/plugins-repository.ts`) takes the folder from the registry, a checkout only from its
`git worktree list`, and a path only when it resolves inside the checkout (symlinks too); files that
look like they hold secrets (`.env`, keys) show only on an explicit reveal. A folder that is no
repository shows as plain files.

**Shell** (`components/shell-plugin/`) is a terminal on this computer: the user's login shell in the home
folder, as their terminal app opens it, of no project. It is the sessions' xterm and runs in the same PTY
bridge (`init` with kind `shell`), with the common variables only — none of the cockpit's (spawn token, brain,
agent config) — and no ledger entry; a reload reattaches, closing the pane ends it
(`DELETE /api/plugins/shell/<id>`), and once it exited Enter starts a new one. It opens for a client on this
machine; remote users get it only after `eml-cockpit remote shell on` (remote.json `shell`), never from the browser.

**Time** (`components/time-plugin/`, `host/src/time-tracking.ts`) counts work time on its own, with no
start or stop. The user's clock: while a cockpit tab had input in the last 5 minutes, it posts a beat every
30 seconds (`POST /api/plugins/time/beat`) naming the active pane's session or project; a hidden tab goes on
for 2 minutes (a look elsewhere still counts), then pauses. The host credits the time between two beats to
the earlier one, so several tabs feed one clock; a gap over 90 seconds, or a beat marked `fresh` (back after a
pause), counts nothing. The agents' clock: the time a session's turn runs (turn state `working` until
any other). One clock per cockpit, across its spaces: a beat names the open space, a session counts in the
space the ledger keeps it under. Both go to the project, the session and the session's task (task runs), per local day in
`time/<YYYY-MM-DD>.json` under the cockpit home: ids and seconds only, nothing while the plugin is off. The
view (`GET /api/plugins/time?days=`) shows today or the last 7 days per space and project, the agents in their own
column; the host names the spaces, projects and tasks, each in its own space's brain.
Community plugins (sandboxed, from a catalog) are a later step.

## Claude Code

The cockpit brings its own Claude Code and never uses — or changes — one installed on the computer
(`src/infrastructure/providers/claude/runtime.ts`). Each app home has its own copy:

```
~/.eml-cockpit/claude/
  versions/<v>/claude   a verified release, never modified
  current -> versions/<v>
  bin/claude            what sessions run (also first on their PATH)
  runtime.json          active + previous version, last check, last result
```

- **Source:** Anthropic's release channel (`downloads.claude.ai/claude-code-releases`, the one
  `claude.ai/install.sh` uses), channel `stable`. A binary is used only after its size and sha256 match
  the release manifest, on macOS its code signature is Anthropic's, and it answers `--version`.
- **Updates:** in the background (first check a minute after start, then every 6 hours; Settings ›
  Models › Claude Code to check now or switch it off). A new version goes into its own folder, is
  verified, and only then `current` switches — new sessions use it, running ones keep theirs. A failed
  download or check leaves `current` as it was. The active and the previous version are kept; *Go back*
  returns to the previous one and skips the abandoned version from then on.
- **No downgrade:** the first install takes the channel version, or a newer one this home's config has
  already run, so existing transcripts keep resuming.
- **Claude's own updater is off** in every session (`DISABLE_AUTOUPDATER=1`) — otherwise a cockpit-run
  `claude` would install a native copy into your `~/.local`.

## Codex

Codex is the second agent CLI a session can run with (Settings › Models › Agent; the sidebar's "+"
starts a session with either). The cockpit owns its copy the same way
(`src/infrastructure/providers/codex/`), under `~/.eml-cockpit/codex/` with the layout above
(`versions/<v>/bin/codex`).

- **Not installed unasked:** Settings › Models › Codex › *Set up now* downloads it (a few hundred MB).
  From then on it updates like Claude Code.
- **Source:** the npm registry (`registry.npmjs.org`, package `@openai/codex`, the platform build
  published as version `<v>-<platform>`), dist-tag `latest`. The package is used only after its sha512
  matches the one the registry lists, on macOS the binary's code signature is OpenAI's, and it answers
  `--version`. On Linux the checksum comes from the same registry as the package — there is no second
  check.
- **Own home:** `~/.eml-cockpit/codex-config` (`CODEX_HOME`): sign-in, `config.toml`, hooks, sessions,
  skills — separate from your `~/.codex`. Codex's own update check is off there.
- **One home, every brain space:** nothing in that home names a brain. A session gets its space
  through its environment — `COCKPIT_MCP_TOKEN` and `COCKPIT_SESSION_ID`, which `config.toml` tells
  Codex to send as headers to the host's brain MCP endpoint (`env_http_headers`), and
  `EML_HOOK_CONFIG`, the path of the space's EML hook config, which the hook commands read through
  the shell. So the hook text never changes between spaces or boots, and no brain token reaches a
  session or a file Codex rewrites.
- **Permissions** (Settings › Models › Codex permissions): a session runs in Codex's sandbox — writes
  only inside the project folder, no network for shell commands. What happens when it wants to go
  beyond that is the setting: **Auto** (default) — a second model reviews the request (Codex's
  Auto-review) and allows what the user asked for, the rest comes to the user; **Ask** — every such
  request comes to the user; **Off** — no sandbox and no questions. The reviewer judges a request
  against what the user asked for; it is not a barrier against the user's own instructions.
  *Network in the sandbox* opens the network for commands. Worker sessions and task runs always run
  in Auto.
- **Hook trust:** Codex runs the cockpit's hooks only after you confirmed them once ("Trust all") in
  the first session.
- **Workers and task runs:** a Codex session can request a worker and run a task like a Claude Code
  session. Its sandbox has no network, so `cockpit-spawn` hands the request over as a file in
  `~/.eml-cockpit/spawn-inbox` (owner-only; the request carries the same per-boot token as the HTTP
  way); that folder and `~/.eml-cockpit/tasks` are the only places outside the project a sandboxed
  session may write to.

## What it touches

State is persistent under the app home `~/.eml-cockpit/` (`EML_COCKPIT_HOME`; chmod 700 — `data/` = control.db + brains; `claude/` =
the cockpit's own Claude Code; `claude-config/` =
the app's `CLAUDE_CONFIG_DIR`, pre-seeded with onboarding/theme and per-project trust;
`codex/` and `codex-config/` = the cockpit's own Codex CLI and its `CODEX_HOME`, once Codex is set up;
`spawn-inbox/` = worker requests from sandboxed sessions, read and removed at once; `tasks/` = task-run files;
`channel-bridge/` = the channel bridge's database, tokens, address and accounts file;
`bin/node` = a link to the host's node for the session hooks (their text names it and `app/current/…`, so it survives updates);
`projects.json` = the project registry; `sessions.json` = the session ledger; `config` = the
brain tokens (the spaces' and the agents'), the human's handle and the spaces' agent bindings, chmod
600; `eml/spaces/<id>/config` = the host's hook routes + the space's MCP token for the session hooks,
rewritten each boot).
Each brain file also holds its op log: every write since brain schema 21, in order and hash-chained, and
a snapshot of the brain as it was when the log began (once, roughly a quarter of the brain's size). The log
is never rewritten — a secret that lands in a brain stays in its history, so rotate the secret.
Claude sign-in (Settings › Models): by default the regular Claude Code login (`/login` on first start), which
Claude Code keeps per config dir — separate from your own Claude login. Optionally a `claude setup-token` for
runtimes without a browser: stored as `claude-login` (chmod 600, write-only from the browser) and injected via
env only when `agents.json` switches sessions to token mode. Sessions keep the input at the bottom
of the pane: they start with Claude Code's fullscreen renderer (`CLAUDE_CODE_NO_FLICKER=1`), which `/tui`
cannot switch inside a cockpit session — Settings › Models › Terminal turns it off. Every session gets the EML
hooks (`eml-mcp-server hook session-start|user-prompt-submit|stop`: boot, reminder, consolidate before a compaction) and the EML skills
(`consolidate`, `checkpoint`, `getting-started`) from the bundled `@engramprotocol/mcp-server` — nothing is read from `~/.claude`
or `~/.eml`. The Worktrees and Repository plugins run `git` in the projects' folders (Repository without
external diff tools or textconv filters, so a repository's config can't make a read run a program), Worktrees also `lsof`/`ps` over the user's own
processes, all read-only. The agent's environment is built from an allowlist (PATH, HOME, locale, proxy/
cert vars) plus the injected isolation vars — nothing else the host inherited reaches a
session. Real `~/.claude` is never written. The PTY WS is guarded by a same-origin check + a
one-time nonce.

## License

AGPL-3.0-only — see `LICENSE` and `NOTICE` at the repository root.
