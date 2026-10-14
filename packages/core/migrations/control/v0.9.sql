-- Control-plane schema v0.9 (initial)
--
-- Lives in <data-dir>/control.db, separate from the brain files (<data-dir>/brains/<uuid>.db).
-- Holds the state needed for token → user → brain routing.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                          -- UUID
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE brains (
  id TEXT PRIMARY KEY,                          -- UUID
  name TEXT NOT NULL,                           -- display name ("work", "personal")
  owner_id TEXT NOT NULL REFERENCES users(id),
  brain_file TEXT NOT NULL UNIQUE,              -- relative path: brains/<id>.db
  schema_version INTEGER NOT NULL DEFAULT 0,    -- brain DB schema version (NOT the control plane)
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_intervention')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE brain_members (
  brain_id TEXT NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),  -- 'member' for shared brains
  added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (brain_id, user_id)
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,                          -- internal token id (UUID)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brain_id TEXT NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  name TEXT,                                    -- user label ("Mac MCP", "laptop")
  token_hash TEXT NOT NULL UNIQUE,              -- SHA-256 of the bearer secret (plaintext never stored)
  prefix TEXT NOT NULL,                         -- first 8 chars of the plaintext (lookup index)
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP
);
CREATE INDEX idx_tokens_prefix ON tokens(prefix) WHERE revoked_at IS NULL;

CREATE TABLE brain_migrations (
  brain_id TEXT NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (brain_id, schema_version)
);

CREATE TABLE meta_migrations (                  -- the control plane's own migrations
  schema_version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
