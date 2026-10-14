# EML — Repo instructions

EML (Epistemic Memory Layer, brand: Engram Protocol) is a typed memory store for AI agents: typed
engrams, graph relations, provenance, lifecycle. This repo is the local product — the **EML Cockpit**
(`cockpit/host` = the `eml-cockpit` package, `cockpit/frontend`) and its building blocks
(`packages/core`, `packages/server`, `packages/mcp-server`).

## Where to find what

- `README.md` — overview and quick start; `cockpit/README.md` — cockpit architecture, dev setup, what it touches.
- `packages/core/migrations/brain/` — `v0.<N>.sql` (fresh-brain schema) + `v0.<N>_migrate.sql` (one step each, from v0.13).
- `packages/mcp-server/README.md` — MCP tool inventory and hooks.
- `scripts/bump-version.sh` — the one version bump; `scripts/pack-release.sh` — release assets (tarballs + SHA256SUMS) for the GitHub release the updater reads; `scripts/install-app.sh` — install a release as the app.

## Conventions

- `main` is development; a tag `vX.Y.Z` is a release. One product version for the whole repo.
- Brain schema N ↔ release v0.N: a schema change is a new minor with a migrate file and an updated
  fresh schema (the `schema-baseline` test keeps both paths identical).
- English everywhere in the repo (code, comments, docs, commits).
- No personal data, user-specific paths or private infrastructure in code, tests or docs — this repo is public-facing.
- Develop against the dev cockpit (`pnpm run cockpit:dev`, home `~/.eml-cockpit-dev`, port 4318), never the production home.
- Agent-facing texts (MCP tool descriptions, system rules, hook output) are product surface — review changes deliberately.
