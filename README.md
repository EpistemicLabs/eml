# EML — Engram Protocol

**A typed memory for AI agents, on your own machine.** EML (Epistemic Memory Layer) stores what an
agent learns while working with you as typed *engrams*: decisions, rules, tasks, status, notes,
references, events, logs and profiles. They are linked in a graph, carry their provenance and have a
lifecycle (active, superseded, resolved). An agent loads its identity, rules and open work at the
start of a session, recalls what it needs, and writes back what it decided or learned.

This repository is the local product: the **EML Cockpit**, a web app that runs isolated Claude Code
sessions next to your brain, with everything it is built from.

## Quick start

**New to the Terminal or GitHub?** Follow [INSTALL.md](INSTALL.md): install Node.js, paste one line,
done. No GitHub account needed.

For developers: you need macOS or Linux, Node ≥ 22 and pnpm 10 (`corepack enable`).

```bash
git clone https://github.com/EpistemicLabs/eml.git && cd eml
pnpm install
pnpm run cockpit
```

This builds everything, starts the cockpit on `127.0.0.1` and opens it in your browser. A fresh brain
is created under `~/.eml-cockpit/`.

To run a release as an app that updates itself (login service, update banner), use the one-line
installer from [INSTALL.md](INSTALL.md) instead. Details, updates and the development setup are in
[`cockpit/README.md`](cockpit/README.md).

## What's in here

| Path | What it is |
|---|---|
| `cockpit/host` | The `eml-cockpit` package: the local host. It runs Claude Code sessions in PTYs, launches the brain server and serves the UI. |
| `cockpit/frontend` | The cockpit UI (Vite + React): desks with terminal and brain panes, sidebar, brain dashboard, graph and search. |
| `packages/core` | The engram store: SQLite schema and migrations, the op log (every write, hash-chained, rebuildable), typed validation, the graph, recall, boot. |
| `packages/server` | The HTTP API over core, one SQLite file per brain, with token routing. |
| `packages/mcp-server` | `@engramprotocol/mcp-server`: the brain as MCP tools for Claude Code, plus the session hooks and skills. |

## Development

```bash
pnpm build          # TypeScript project build (core, server, mcp-server)
pnpm test           # all test suites
pnpm run cockpit:dev  # dev cockpit on port 4318 with its own home (~/.eml-cockpit-dev)
```

The dev cockpit never touches the production home, and its header shows a **DEV** badge.

## License

AGPL-3.0-only (see [`LICENSE`](LICENSE)), except `packages/mcp-server`, which is MIT.
Third-party notices are in [`NOTICE`](NOTICE).

Copyright © 2026 Dominik Tilman and Lasse Lung.
