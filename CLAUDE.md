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
- A brain schema change is one that needs a SQL migration, or a new hygiene check for existing
  engrams. A change to validation or a type's format that leaves existing engrams readable ships in a patch.
- A new requirement for existing engrams: what the migrate SQL can rewrite on its own, it rewrites
  there; what needs judgement becomes a check in `packages/core/src/hygiene.ts` with `since_schema`.
- English everywhere in the repo (code, comments, docs, commits).
- No personal data, user-specific paths or private infrastructure in code, tests or docs — this repo is public-facing.
- Develop against the dev cockpit (`pnpm run cockpit:dev`, home `~/.eml-cockpit-dev`, port 4318), never the production home.
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
3. PR `vX.Y.Z` → `main` with the release notes as description; CI green; merge with a merge commit.
4. Tag the merge commit on `main`: `git tag vX.Y.Z && git push origin refs/tags/vX.Y.Z` (the branch
   has the same name, so push the tag by its full ref).
5. `bash scripts/pack-release.sh`, then `gh release create vX.Y.Z release/X.Y.Z/* --notes-file <notes>`.
   The cockpit updater and the installers download the tarballs and SHA256SUMS by name from the latest release.
6. Production cockpits update through the in-app banner; check `/api/about` afterwards.
7. Remove the release worktree and the local `vX.Y.Z` branch.
