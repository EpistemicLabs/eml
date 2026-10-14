# Contributing

Thanks for your interest in EML.

## Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm run cockpit:dev   # dev cockpit on port 4318, home ~/.eml-cockpit-dev, DEV badge in the header
```

Never develop against your real cockpit home (`~/.eml-cockpit`): `cockpit:dev` uses its own.

## Pull requests

- One topic per PR, with tests for behaviour changes. `pnpm build && pnpm test` must pass (CI runs both
  plus the frontend build).
- Code, comments, docs and commit messages in English.
- A change to the brain schema needs a new `packages/core/migrations/brain/v0.<N>_migrate.sql`, the
  matching update of `v0.<N>.sql` (the fresh-brain schema) and a minor version bump; the
  `schema-baseline` test checks that both paths end in the same schema.
- Texts that agents read (MCP tool descriptions, system rules, hook output) are product surface: keep
  them short, precise and stable.

## License

By contributing you agree that your contribution is licensed under the repository's license
(AGPL-3.0-only; `packages/mcp-server`: MIT).
