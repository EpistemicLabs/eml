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
registers the launchd service on port 4317 (`--port`, `--home` to change). An existing
`~/.eml-cockpit` is kept as it is: brain, sessions, projects and the Claude login stay; the new version
migrates the brain on start (with a backup first).

**Updates:** the cockpit checks GitHub Releases every few hours. When a newer release exists, a banner
offers **Update**: it downloads both tarballs, checks their SHA-256 against `SHA256SUMS`, installs them
into their own version folder, switches `current` and restarts. Running sessions resume afterwards.
Settings › About › Updates shows the state, checks now, and goes back to the previous version (not
across a brain-schema change).

**Start over:** stop the cockpit and delete `~/.eml-cockpit/`. That removes the brain, the
session list and the cockpit's Claude login — back it up first (Settings › Brain › Back up).

**Keep it running from source (macOS):** a source checkout can run as a login service too:

```bash
pnpm -F eml-cockpit build                                    # build the host once
COCKPIT_PORT=4317 pnpm -F eml-cockpit exec eml-cockpit service install
pnpm -F eml-cockpit exec eml-cockpit service status          # loaded? port responds? last log
pnpm -F eml-cockpit exec eml-cockpit service uninstall
```

A source-run cockpit has no updater — update it with `git pull && pnpm install && pnpm run cockpit:build`
and a service restart. The service is pinned to the port + home you install it with, and captures the
absolute `node` path at install time, so re-run `service install` if you move the repo or reinstall
node. (Linux `systemd --user` is not built yet.)

**Known limits:**

- Open the cockpit in **one** browser tab. A second tab takes over the running sessions, and the
  first one shows "Connect".
- The login service runs on macOS (launchd) and Windows (the user's Run key with a small supervisor); Linux `systemd --user` is not built yet.

## Architecture

Three layers, one local process:

- **`frontend/`** — Vite + React SPA: desks (top tabs) with pane grids, terminal and brain panes,
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
```

The SQL files sit next to `dist/` because core resolves them as `__dirname/../migrations` — the
same relative location from a workspace checkout (`packages/core/migrations`) and from the bundle.
Real dependencies are only `better-sqlite3`, `node-pty` (both prebuilt) and
`@engramprotocol/mcp-server`, whose `dist/cli.js` the host injects into each session's MCP config.
Verify a build end-to-end with `pnpm -F eml-cockpit pack`, `npm install <tgz>` in a scratch
project and `EML_COCKPIT_HOME=<scratch> npx eml-cockpit`.

Env: `COCKPIT_PORT` (host port, default a free port / 4318 in dev), `COCKPIT_NO_OPEN=1`
(don't open a browser tab), `EML_COCKPIT_HOME` (the app home, default `~/.eml-cockpit`).

## Brain spaces

A **space** is one brain. The cockpit starts with the brain it was set up with (the main space);
**Settings › Brain › New space** or the space menu in the header adds a further local brain with the same
agent and profile. Every desk, session and project belongs to exactly one space, and a session only
ever gets its own space's brain token — the boundary between spaces is the token, not a filter. The
switch in the header (and the sidebar's group header) changes the space with its desks, projects and
Brain tab. Host side: `brain-space.ts` (one `BrainSpace` per brain: token, session files under
`claude-config/spaces/<brain id>/`, project list, local registry, notes); the frontend names the active
space in the `x-cockpit-space` header of every host request (missing = main). Shared team brains join the
same registry later (task `cockpit-brain-spaces`).

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
(`--mcp-config`, rewritten on every host start). Your own MCPs load next to it as long as you set
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
Pending reviews and the tab's amber badge read the brain's `label=review` list filter.

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
- **One home, every brain space:** nothing in that home names a brain. A session gets its space's
  brain through its environment — `EML_API_URL` and `EML_API_TOKEN`, which `config.toml` tells Codex
  to forward to the brain MCP server (`env_vars`), and `EML_HOOK_CONFIG`, the path of the space's EML
  hook config, which the hook commands read through the shell. So the hook text never changes
  between spaces or boots, and no brain token sits in a file Codex rewrites.
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
`bin/node` = a link to the host's node for the session hooks (their text names it and `app/current/…`, so it survives updates);
`projects.json` = the project registry; `sessions.json` = the session ledger; `config` = the
local brain token, chmod 600; `eml/config` = brain URL + token for the session hooks, rewritten each boot).
Claude sign-in (Settings › Models): by default the regular Claude Code login (`/login` on first start), which
Claude Code keeps per config dir — separate from your own Claude login. Optionally a `claude setup-token` for
runtimes without a browser: stored as `claude-login` (chmod 600, write-only from the browser) and injected via
env only when `agents.json` switches sessions to token mode. Sessions keep the input at the bottom
of the pane: they start with Claude Code's fullscreen renderer (`CLAUDE_CODE_NO_FLICKER=1`), which `/tui`
cannot switch inside a cockpit session — Settings › Models › Terminal turns it off. Every session gets the EML
hooks (`eml-mcp-server hook session-start|user-prompt-submit|stop`: boot, reminder, consolidate before a compaction) and the EML skills
(`consolidate`, `checkpoint`, `getting-started`) from the bundled `@engramprotocol/mcp-server` — nothing is read from `~/.claude`
or `~/.eml`. The agent's environment is built from an allowlist (PATH, HOME, locale, proxy/
cert vars) plus the injected isolation vars — nothing else the host inherited reaches a
session. Real `~/.claude` is never written. The PTY WS is guarded by a same-origin check + a
one-time nonce.

## License

AGPL-3.0-only — see `LICENSE` and `NOTICE` at the repository root.
