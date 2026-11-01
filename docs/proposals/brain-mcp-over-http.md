# Proposal: one brain MCP endpoint per cockpit instead of one process per session

Status: proposed.

## The problem

Every cockpit session starts its own `eml_brain` MCP server: `packages/mcp-server` over stdio,
spawned by Claude Code from the space's `mcp.json`. The process is a thin adapter. It takes the
agent's tool calls and forwards them as HTTP requests to the EML API, which the cockpit host already
runs once per cockpit.

Each adapter costs about 70 MB of resident memory. With six or seven sessions in parallel that is
close to half a gigabyte for processes that hold no state of their own. On a small server (8 GB)
running a cockpit, this is noticeable next to the agent CLIs themselves.

## Why it is one process per session today

stdio MCP servers belong to the client process that started them; that is how the transport works.
The adapter also relies on it: `provenance.ts` takes the session id from its environment
(`COCKPIT_SESSION_ID`, inherited from the session), and the model from the cockpit host by that id.
One process per session is what makes "who wrote this engram" correct.

## What the agent CLIs allow

Checked with Claude Code 2.1.308:

- An HTTP MCP server in an `--mcp-config` file (`"type": "http"`, `"url"`, `"headers"`) is
  supported, the same as for remote MCPs.
- `${VAR}` in a header value is expanded from the session's environment. A test server behind
  `"headers": { "X-Test-Session": "${TEST_SESSION_ID}" }` received the value of the variable.

So one `mcp.json` per space can carry a per-session header, although the file is shared by every
session of the space.

Codex: not checked yet. Codex keeps the stdio adapter until it is (see open questions).

## Proposal

### 1. A factory for the MCP server (`packages/mcp-server`)

`startMcpServer` builds the server and connects it to stdio in one step. Split it:

- `createEmlMcpServer({ httpClient, provenance })` registers the tools and returns the `McpServer`.
- `startMcpServer` (stdio, unchanged for self-hosting and other clients) uses the factory.
- `Provenance` can be built from explicit values (session id, a model lookup) instead of only
  `process.env`.

The tools, their descriptions and their behaviour do not change. This is not agent-facing.

### 2. The endpoint in the cockpit host

The host serves `/mcp/<space id>` with the SDK's Streamable HTTP transport, one MCP session per
agent session (`mcp-session-id`), created on `initialize`:

- **Session:** from the `X-EML-Session` header, which the session's `mcp.json` fills with
  `${COCKPIT_SESSION_ID}`.
- **Harness:** from the client name in the `initialize` handshake, per MCP session as today.
- **Model:** from the host's own session ledger (what `/api/session-model` answers today), without
  an HTTP round trip.
- **Brain:** the host forwards to the EML API with the space's token. The token never leaves the
  host; the session gets a per-boot MCP token instead.

The host and not the EML API is the right place: the host already knows sessions, spaces and
models. Serving MCP from the EML API would make the API call back into the cockpit for the model,
and the API serves self-hosted setups without a cockpit too.

### 3. Access

- Loopback only. The endpoint is refused through remote access (`tailscale serve`), whatever
  `remote.json` allows: no request with proxy headers or a non-loopback `Host` reaches it.
- Every request carries a per-boot token header, like the session hooks (`/api/hook`). Without it:
  403.
- It is a token endpoint in the CSRF guard's sense (no `Origin`), like `/api/hook`.

### 4. The session config

`brainMcpServer` (`cockpit/host/src/infrastructure/providers/shared.ts`) writes, for Claude Code:

```json
{
  "eml_brain": {
    "type": "http",
    "url": "http://127.0.0.1:<host port>/mcp/<space id>",
    "headers": {
      "X-Cockpit-Mcp-Token": "<per-boot token>",
      "X-EML-Session": "${COCKPIT_SESSION_ID}"
    }
  }
}
```

The host port and the token change per boot, as the hook config already does; `mcp.json` is
rewritten on every boot.

### 5. Tests

- A write through the endpoint carries the session id from the header and the model from the
  ledger.
- Two sessions writing at the same time each get their own provenance.
- No token: 403. A request through remote access: refused.
- The stdio adapter still works unchanged (existing tests).
- By hand on the dev cockpit: write an engram from two sessions and compare their `session_id`.

## What it saves

About 70 MB per session: roughly 0.5 GB with seven sessions. The host gains a few MCP sessions in
memory, which hold no more than a provenance object and a transport.

## Risks

- **One point of failure.** If the host's MCP endpoint fails, every session loses the brain at
  once; today a crashed adapter only affects its own session. The host is already a single point
  of failure for every session (PTYs, hooks), so this adds little.
- **Provenance mistakes are silent.** A missing or wrong `X-EML-Session` would stamp writes with
  the wrong session. Mitigation: the endpoint refuses `initialize` without the header, and a session
  id the ledger does not know is rejected rather than accepted.
- **A Claude Code change in header expansion** would break the session id. The test in step 5
  catches it on the next Claude Code update in CI.

## Rejected

- **A generic stdio→HTTP bridge** (supergateway, mcp-proxy) in front of the adapter: it would not
  know which session calls, so provenance would break, and it adds a process instead of removing
  one.
- **MCP served by the EML API:** see section 2.
- **Leaving it as it is:** acceptable on a laptop, but on a small server it is one of the larger
  fixed costs per session.

## Open questions

- Codex: does it support HTTP MCP servers with headers and environment expansion in
  `config.toml`? Until checked, Codex sessions keep the stdio adapter.
- Should third-party stdio MCPs the user adds get the same treatment later (a shared-MCP feature in
  the host)? Only for MCPs without per-session or per-project state; not part of this proposal.
