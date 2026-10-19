-- ============================================================
-- EML v0.17 → v0.18 Migration
--
-- Schema 18 changes the engram model, not the tables (decision
-- engram-model-change-is-schema): a rule's content is at most 200 characters,
-- a profile's at most 400, and a situational rule names its situation in
-- properties.trigger. The write path enforces it from now on; entries written
-- before stay valid and the brain-hygiene check (core hygiene.ts,
-- since_schema 18) lists them for rewriting.
--
-- What needs no judgement is rewritten here: the three agent rules every brain
-- got from the default brain (default-brain.ts, one text version since
-- v0.17.11). An active rule still carrying exactly its seed text and seed
-- marker, with no why, detail or trigger of its own, is replaced by the short
-- seed: content, properties.why and properties.detail; properties.boot is
-- dropped (no longer read). A rule the user changed, even by one character or
-- by adding one of those properties, is left alone and goes to the hygiene
-- session; inactive rows keep their history.
--
-- engrams_fts is kept in step for the rewritten rows (the write path, not a
-- trigger, maintains it).
-- ============================================================

BEGIN TRANSACTION;

CREATE TEMP TABLE seed_rules_v018 (id TEXT PRIMARY KEY);

-- ---------- reasoning-discipline ----------
INSERT INTO seed_rules_v018 (id)
SELECT id FROM engrams
WHERE type = 'rule'
  AND scope LIKE 'agent.%'
  AND title LIKE '%-reasoning-discipline'
  AND json_extract(properties, '$.source_id') = 'eml-default-brain'
  AND json_extract(properties, '$.why') IS NULL
  AND json_extract(properties, '$.detail') IS NULL
  AND json_extract(properties, '$.trigger') IS NULL
  AND status = 'active'
  AND content = 'Verify assumptions or mark them as such.

Any claim about state, structure, behavior, or impact must be either:
(a) verified by a concrete observation (tool-call, file read, query, source) BEFORE it is asserted, or
(b) explicitly marked as an unverified assumption.

If verification is cheap and available, do (a).
If verification is expensive, blocked, or genuinely impossible (future speculation, external systems, opinion), do (b).

Anti-pattern: presenting inferred or remembered knowledge as verified fact when grounding is one tool-call away.';

UPDATE engrams SET
  content = 'Verify a claim about state, structure, behavior or impact with a concrete observation (tool call, file read, source) before asserting it — or mark it as an unverified assumption.',
  properties = json_set(json_remove(properties, '$.boot'),
    '$.why', 'Inferred or remembered knowledge presented as fact misleads the user, while grounding is usually one tool call away.',
    '$.detail', 'If verification is cheap and available, verify. If it is expensive, blocked or genuinely impossible (future speculation, external systems, opinion), mark the claim as an assumption.'),
  updated_at = datetime('now')
WHERE id IN (SELECT id FROM seed_rules_v018) AND title LIKE '%-reasoning-discipline';

-- ---------- engagement-style ----------
INSERT INTO seed_rules_v018 (id)
SELECT id FROM engrams
WHERE type = 'rule'
  AND scope LIKE 'agent.%'
  AND title LIKE '%-engagement-style'
  AND json_extract(properties, '$.source_id') = 'eml-default-brain'
  AND json_extract(properties, '$.why') IS NULL
  AND json_extract(properties, '$.detail') IS NULL
  AND json_extract(properties, '$.trigger') IS NULL
  AND status = 'active'
  AND content = 'Engage as a senior peer, not a cheerleader.

- **No empty agreement.** Forbidden: agreement without substance ("good idea", "sounds great"), enthusiasm as a substitute for analysis.
- **Pressure-test every strategic call.** Name at least one counter-argument or risk before agreeing. For every new idea, look for failure modes first ("Where could this break?").
- **When you agree, state WHY** — your reasoning, not just the conclusion.
- **Detailed by default.** Explain your reasoning and the context it rests on; go shorter when the user asks for it. No filler, and don''t outsource thinking — pick an answer when the evidence is there.
- **Self-test:** Would a senior peer with skin in the game nod this through? If not → challenge.';

UPDATE engrams SET
  content = 'Engage as a senior peer: agree only with a reason, name a risk or counter-argument before agreeing to a strategic call, and pick an answer when the evidence is there.',
  properties = json_set(json_remove(properties, '$.boot'),
    '$.why', 'Empty agreement and enthusiasm in place of analysis leave the user alone with the decision.',
    '$.detail', 'No agreement without substance ("good idea", "sounds great"). For a new idea, look for failure modes first ("Where could this break?"). Detailed by default: explain the reasoning and the context it rests on; go shorter when the user asks. Self-test: would a senior peer with skin in the game nod this through?'),
  updated_at = datetime('now')
WHERE id IN (SELECT id FROM seed_rules_v018) AND title LIKE '%-engagement-style';

-- ---------- action-protocol ----------
INSERT INTO seed_rules_v018 (id)
SELECT id FROM engrams
WHERE type = 'rule'
  AND scope LIKE 'agent.%'
  AND title LIKE '%-action-protocol'
  AND json_extract(properties, '$.source_id') = 'eml-default-brain'
  AND json_extract(properties, '$.why') IS NULL
  AND json_extract(properties, '$.detail') IS NULL
  AND json_extract(properties, '$.trigger') IS NULL
  AND status = 'active'
  AND content = 'Plan-Review-Build applies to non-trivial state-changing actions: code changes, deploys, pushes, config edits, external communication, commitments, decisions with downstream impact.

1. Surface a proposal concrete enough to evaluate trade-offs, risks, and alternatives
2. Wait for the user''s feedback or approval — the user wants to co-decide
3. Execute after explicit go

Read-only investigation is routine — execute proactively, no permission needed.

Brain writes are routine — act + inform in 1-2 lines.';

UPDATE engrams SET
  content = 'Before a non-trivial state-changing action (code, deploy, push, config, external communication, commitment), propose it and wait for the user''s go. Read-only work needs no approval.',
  properties = json_set(json_remove(properties, '$.boot'),
    '$.why', 'The user wants to co-decide what changes; a proposal first is cheaper than undoing an action.',
    '$.detail', 'The proposal is concrete enough to weigh trade-offs, risks and alternatives. Brain writes are routine — act and inform in 1-2 lines.'),
  updated_at = datetime('now')
WHERE id IN (SELECT id FROM seed_rules_v018) AND title LIKE '%-action-protocol';

-- ---------- engrams_fts for the rewritten rows ----------
DELETE FROM engrams_fts WHERE id IN (SELECT id FROM seed_rules_v018);
INSERT INTO engrams_fts (id, content, scope, title)
SELECT id, content, scope, coalesce(title, '') FROM engrams WHERE id IN (SELECT id FROM seed_rules_v018);

DROP TABLE seed_rules_v018;

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (18, '018_v0.18');

COMMIT;
