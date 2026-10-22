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
- A change to the engram model (fields, validation, a type's format) is a new brain schema, even
  without a SQL change.
- A new requirement for existing engrams: what the migrate SQL can rewrite on its own, it rewrites
  there; what needs judgement becomes a check in `packages/core/src/hygiene.ts` with `since_schema`.
- English everywhere in the repo (code, comments, docs, commits).
- No personal data, user-specific paths or private infrastructure in code, tests or docs — this repo is public-facing.
- Develop against the dev cockpit (`pnpm run cockpit:dev`, home `~/.eml-cockpit-dev`, port 4318), never the production home.
- Agent-facing texts (MCP tool descriptions, system rules, hook output) are product surface — review changes deliberately.
- Branch work happens in its own git worktree, never by switching the main checkout. After the merge, GitHub
  deletes the remote branch; remove the worktree (`git worktree remove <path>`) and the local branch
  (`git branch -d <branch>`) once `git status` is clean and everything is pushed. No `--force` deletes.

## Releases (maintainers)

1. Branch `vX.Y.Z` from `main`; `bash scripts/bump-version.sh X.Y.Z`.
2. Test the release on the dev cockpit; `cockpit/scripts/dev-refresh-brain.sh` loads a copy of the
   production brain into it first. A release with a brain schema change is also measured:
   `node packages/bench/dist/cli.js release --eml .` writes `packages/bench/results/X.Y.Z.json`
   (commit it) and prints the change from the previous release for the release notes.
3. PR `vX.Y.Z` → `main` with the release notes as description; CI green; merge with a merge commit.
4. Tag the merge commit on `main`: `git tag vX.Y.Z && git push origin refs/tags/vX.Y.Z` (the branch
   has the same name, so push the tag by its full ref).
5. `bash scripts/pack-release.sh`, then `gh release create vX.Y.Z release/X.Y.Z/* --notes-file <notes>`.
   The cockpit updater installs exactly these three assets from the latest release.
6. Remove the release worktree and the local `vX.Y.Z` branch.
