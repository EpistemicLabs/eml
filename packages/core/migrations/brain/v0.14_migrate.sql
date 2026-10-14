-- ============================================================
-- EML v0.13 → v0.14 Migration
--
-- Cluster A — add the `note` type (decision engram-type-check-in-db).
--   The engram type is guarded by a CHECK constraint; SQLite cannot alter a
--   CHECK, so `engrams` is rebuilt: new table → copy → drop → rename →
--   indexes. Columns are listed explicitly (not SELECT *), so the copy does
--   not depend on the physical column order of older brains.
--   engrams_fts is keyed by id values (no content table, no rowid link) and
--   relations has no FK, so neither needs to change. engram_tags and
--   engram_labels reference engrams(id); the ids are unchanged.
--
-- Cluster B — themes axis (the "heavy facet"): a `themes` registry with a
--   description + lifecycle status (active | closed — the "is it done?" axis
--   that separates a theme from a tag) and an `engram_themes` junction.
--   Membership stays out of `relations` (relations = directed semantics).
--
-- foreign_keys MUST be OFF while this runs (the forward-migration runner and
-- database.ts runMigrateWithFkOff handle it): with FKs on, DROP TABLE engrams
-- would cascade-delete every engram_tags / engram_labels row.
-- ============================================================

BEGIN TRANSACTION;

CREATE TABLE engrams_v014 (
  -- ============ Identity ============
  id                  TEXT PRIMARY KEY,

  -- ============ Categorization (Mode → Type → Scope/Subject) ============
  mode                TEXT NOT NULL
                      CHECK(mode IN ('epistemic','context')),
  type                TEXT NOT NULL
                      CHECK(type IN (
                        'observation','hypothesis','assessment','prediction','pattern',
                        'decision','rule','profile','status',
                        'task','event','log',
                        'reference',
                        'note'                -- v0.14
                      )),
  scope               TEXT NOT NULL,
  subject             TEXT,

  -- ============ Content ============
  content             TEXT NOT NULL,

  -- ============ Lifecycle ============
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('planned','active','superseded','invalidated','expired','resolved')),
  significance        TEXT NOT NULL DEFAULT 'normal'
                      CHECK(significance IN ('critical','high','normal','low','trivial')),

  -- ============ Type-specific Properties (validated by application layer) ============
  properties          TEXT,

  -- ============ Ingestion (technical audit trail) ============
  ingested_by         TEXT,
  ingestion_method    TEXT
                      CHECK(ingestion_method IS NULL OR ingestion_method IN ('hook','direct','bulk','other')),
  session_id          TEXT,

  -- ============ Timestamps ============
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO engrams_v014 (
  id, mode, type, scope, subject, content, status, significance, properties,
  ingested_by, ingestion_method, session_id, created_at, updated_at
)
SELECT
  id, mode, type, scope, subject, content, status, significance, properties,
  ingested_by, ingestion_method, session_id, created_at, updated_at
FROM engrams;

DROP TABLE engrams;
ALTER TABLE engrams_v014 RENAME TO engrams;

CREATE INDEX idx_engrams_scope            ON engrams(scope);
CREATE INDEX idx_engrams_subject          ON engrams(subject);
CREATE INDEX idx_engrams_type             ON engrams(type);
CREATE INDEX idx_engrams_mode             ON engrams(mode);
CREATE INDEX idx_engrams_status           ON engrams(status);
CREATE INDEX idx_engrams_significance     ON engrams(significance);
CREATE INDEX idx_engrams_created          ON engrams(created_at);
CREATE INDEX idx_engrams_ingested_by      ON engrams(ingested_by);

-- ---------- Cluster B: themes ----------
CREATE TABLE IF NOT EXISTS themes (
  id          TEXT PRIMARY KEY,               -- slug of name (same slugify as tags/labels)
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'closed'
                CHECK (status IN ('active','closed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engram_themes (
  engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  theme_id    TEXT NOT NULL REFERENCES themes(id)  ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (engram_id, theme_id)
);

CREATE INDEX IF NOT EXISTS idx_engram_themes_theme  ON engram_themes(theme_id);
CREATE INDEX IF NOT EXISTS idx_engram_themes_engram ON engram_themes(engram_id);

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (14, '014_v0.14');

COMMIT;
