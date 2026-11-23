# EML — Repo instructions

EML (Epistemic Memory Layer, brand: Engram Protocol) is a typed memory store for AI agents: typed
engrams, graph relations, provenance, lifecycle. This repo is the local product — the **EML Cockpit**
(`cockpit/host` = the `eml-cockpit` package, `cockpit/frontend`) and its building blocks
(`packages/core`, `packages/server`, `packages/mcp-server`).

## Where to find what

- `README.md` — overview and quick start; `cockpit/README.md` — cockpit architecture, dev setup, what it touches.
- `packages/core/migrations/brain/` — `v0.<N>.sql` (fresh-brain schema) + `v0.<N>_migrate.sql` (one step each, from v0.13).
- `packages/mcp-server/README.md` — MCP tool inventory and hooks.
- `packages/bench/README.md` — the release benchmark (stage 1 is a CI gate against the last release's result).
- `scripts/bump-version.sh` — the one version bump; `scripts/pack-release.sh` — release assets (tarballs + SHA256SUMS) for the GitHub release the updater reads; `scripts/install-app.sh` — install a release as the app.

## Conventions

- `main` is development; a tag `vX.Y.Z` is a release. One product version for the whole repo.
- Brain schema N ↔ release v0.N: a schema change is a new minor with a migrate file and an updated
  fresh schema (the `schema-baseline` test keeps both paths identical).
- A brain schema change is one that needs a SQL migration, a new MIGRATION hygiene check
  (with `since_schema`) for existing engrams — a recurring review check (no `since_schema`) does not
  bump the schema — or changes what a logged op does when it is replayed: a command's validation,
  enums, limits, scope patterns, defaults, the learning topic gate, change-entry texts, slugs,
  wikilinks; a new field or value counts too. Every replica and every rebuild must derive the same
  state from the same log, so within one schema that behaviour is fixed;
  `packages/core/tests/frozen-log.test.ts` replays the schema's frozen log
  (`tests/fixtures/log-v<N>.json`) and fails when it moves. A schema bump freezes a new log
  (`EML_FREEZE_LOG=1`, see the test's header). A rebuild starts from the checkpoint of the
  migration: a private brain's migrate step writes it, a shared brain's first live device does.
  What changes only how a brain is read or shown ships in a patch.
- A migrate file gives the same rows on every device: no clock, no random value, no order that
  depends on rowids of one copy. In a shared brain each member migrates their own replica, and the
  second one stops if its state differs from the first one's checkpoint.
- A new requirement for existing engrams: what the migrate SQL can rewrite on its own, it rewrites
  there; what needs judgement becomes a check in `packages/core/src/hygiene.ts` with `since_schema`.
- English everywhere in the repo (code, comments, docs, commits).
- No personal data, user-specific paths or private infrastructure in code, tests or docs — this repo is public-facing.
- Develop against the dev cockpit (`pnpm run cockpit:dev`, home `~/.eml-cockpit-dev`, port 4318), never the production home.
  For shared-space checks between two members, `cockpit/scripts/dev-home.sh` adds a second fixed dev
  cockpit (4319) and serves either from any worktree, with snapshot / reset (see its header).
- Agent-facing texts (MCP tool descriptions, system rules, hook output) are product surface — review changes deliberately.
- Changes reach `main` through a pull request: one branch per topic, as many commits as it takes. Its author
  merges it with a merge commit once CI is green; an outside PR may be squashed. Read an outside PR's diff
  before approving its CI run: CI runs that code.
- Branch work happens in its own git worktree, never by switching the main checkout: other sessions
  work there too. In a shared checkout, stage and commit in one command with explicit paths (never
  `git add -A` / `commit -a`); check `git branch --show-current`, `git status --short` and `git log -1`
  first, and `git fetch` before, others push to main too. After the merge, GitHub
  deletes the remote branch; remove the worktree (`git worktree remove <path>`) and the local branch
  (`git branch -d <branch>`) once `git status` is clean and everything is pushed. No `--force` deletes.
- Check UI and host changes in the running dev cockpit in a browser before committing; `tsc` and the
  build alone miss them. One browser tab per cockpit: a second tab takes over every pane's PTY.

## Releases (maintainers)

1. Branch `vX.Y.Z` from `main`; `bash scripts/bump-version.sh X.Y.Z`.
2. Test the release on the dev cockpit; `cockpit/scripts/dev-refresh-brain.sh` loads a copy of the
   production brain into it first. A release whose migration updates data is audited before that:
   `node scripts/audit-brain-migration.mjs <copy of the production brain>` migrates its own copy
   and must pass. A release that changes how the brain behaves for an agent is also measured:
   `node packages/bench/dist/cli.js release --eml .` writes `packages/bench/results/X.Y.Z.json`
   (commit it) and prints the change from the previous release for the release notes.
3. Write `docs/release-notes/vX.Y.Z.md`: a `### What's new` section of short user-facing bullets (the cockpit
   shows them after an update; CI checks it), the detailed notes below. PR `vX.Y.Z` → `main` with those
   notes as description; CI green; merge with a merge commit.
4. Tag the merge commit on `main`: `git tag vX.Y.Z && git push origin refs/tags/vX.Y.Z` (the branch
   has the same name, so push the tag by its full ref).
5. `bash scripts/pack-release.sh`, then `gh release create vX.Y.Z release/X.Y.Z/* --notes-file docs/release-notes/vX.Y.Z.md`.
   The cockpit updater and the installers download the tarballs and SHA256SUMS by name from the latest release.
6. Production cockpits update through the in-app banner; check `/api/about` afterwards.
7. Remove the release worktree and the local `vX.Y.Z` branch.
