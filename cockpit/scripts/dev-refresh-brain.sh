#!/usr/bin/env bash
# Refresh dev cockpit a (cockpit/scripts/dev-home.sh) with a fresh WAL-safe copy of
# the PRODUCTION brain, so a release can be exercised against real data + volume.
# Disposable-viewer model (rule cockpit-release-gating): the copy goes ONE way,
# prod → dev, and overwrites whatever was in dev. Real work stays on prod (4317);
# anything written in the dev cockpit is lost on the next refresh.
#
# It finds each home's main brain through the brain token of its cockpit config (no
# hard-coded UUIDs), so it keeps working across versions and machines. The dev token stays; the brain
# FILE content is swapped, and from schema 21 on the dev main brain takes the id the
# copy's log names (see step 2b). On the next dev-cockpit start the bundled server
# migrates the copy forward through the safety pipeline.
#
# Usage (worktree root):
#   bash cockpit/scripts/dev-refresh-brain.sh
# Env overrides:
#   PROD_HOME (default ~/.eml-cockpit)
#   NO_RESTART=1  → only swap the brain, don't (re)start the dev cockpit
# Afterwards `dev-home.sh snapshot a` keeps the migrated copy as the state a reset returns to.
set -euo pipefail

PROD_HOME=${PROD_HOME:-$HOME/.eml-cockpit}
DEV_HOME=$HOME/.eml-cockpit-dev   # profile a of dev-home.sh
DEV_HOME_SH="$(dirname "$0")/dev-home.sh"

brain_file() { # $1 = home dir → absolute path of its main space's brain file
  local home="$1" ctl="$1/data/control.db" prefix rel
  [ -f "$ctl" ] || { echo "no control.db at $ctl" >&2; exit 1; }
  # The cockpit config's token is the main space's (eml_<8-char prefix><secret>);
  # its prefix finds the token row and so the brain. Only the prefix leaves python.
  prefix=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"][4:12])' "$home/config")
  rel=$(sqlite3 "$ctl" "SELECT b.brain_file FROM tokens t JOIN brains b ON b.id = t.brain_id WHERE t.prefix = '$prefix' AND t.revoked_at IS NULL")
  [ -n "$rel" ] || { echo "no main brain for the config token in $ctl" >&2; exit 1; }
  echo "$home/data/$rel"
}

PROD_DB=$(brain_file "$PROD_HOME")
DEV_DB=$(brain_file "$DEV_HOME")
DEV_REL=${DEV_DB#"$DEV_HOME/data/"}   # as control.db names it
[ -f "$PROD_DB" ] || { echo "prod brain not found: $PROD_DB" >&2; exit 1; }
echo "prod brain: $PROD_DB ($(sqlite3 "$PROD_DB" 'SELECT count(*) FROM engrams') engrams, schema $(sqlite3 "$PROD_DB" 'SELECT MAX(version) FROM _eml_migrations'))"
echo "dev  brain: $DEV_DB"

# 1) Stop the dev cockpit so the brain file is free.
bash "$DEV_HOME_SH" stop a

# 2) Back up the current dev brain (disposable, but keep the latest one), then
#    WAL-safe copy. VACUUM INTO refuses an existing target, so the previous backup
#    is replaced explicitly — before, a leftover file made the backup fail silently.
if [ -f "$DEV_DB" ]; then
  rm -f "$DEV_DB.bak-pre-refresh"
  sqlite3 "$DEV_DB" "VACUUM INTO '$DEV_DB.bak-pre-refresh'"
  echo "old dev brain backed up → $DEV_DB.bak-pre-refresh"
fi
rm -f "$DEV_DB" "$DEV_DB-wal" "$DEV_DB-shm"
sqlite3 "$PROD_DB" "VACUUM INTO '$DEV_DB'"
# The dev control.db must report the copied brain's schema so the runner migrates it
# forward — only this brain's row: the other brains of the dev home keep their version,
# or the runner would re-run their migration and the preflight would take them offline.
SV=$(sqlite3 "$DEV_DB" "SELECT MAX(version) FROM _eml_migrations")
sqlite3 "$DEV_HOME/data/control.db" "UPDATE brains SET schema_version = $SV WHERE brain_file = '$DEV_REL'"

# 2b) v0.21: a brain carries its id in its log's genesis, and the server sets a
#     control row naming another id to needs_intervention. The copy names the
#     production brain, so the dev main brain takes that id: its control rows, its
#     file, and what the dev cockpit keys by it (config, project registry, per-space
#     folders). A brain without a log (schema < 21) keeps the dev id.
NEW_ID=$(sqlite3 "$DEV_DB" "SELECT json_extract(payload, '\$.args.brain') FROM op_log WHERE seq = 1" 2>/dev/null || true)
OLD_ID=$(sqlite3 "$DEV_HOME/data/control.db" "SELECT id FROM brains WHERE brain_file = '$DEV_REL'")
if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "$OLD_ID" ]; then
  if [ -n "$(sqlite3 "$DEV_HOME/data/control.db" "SELECT 1 FROM brains WHERE id = '$NEW_ID'")" ]; then
    echo "the dev control.db has another brain with id $NEW_ID already" >&2; exit 1
  fi
  NEW_REL="brains/$NEW_ID.db"
  mv "$DEV_DB" "$DEV_HOME/data/$NEW_REL"
  sqlite3 "$DEV_HOME/data/control.db" "PRAGMA foreign_keys = OFF; BEGIN;
    UPDATE brains SET id = '$NEW_ID', brain_file = '$NEW_REL', status = 'ok' WHERE id = '$OLD_ID';
    UPDATE tokens SET brain_id = '$NEW_ID' WHERE brain_id = '$OLD_ID';
    UPDATE brain_members SET brain_id = '$NEW_ID' WHERE brain_id = '$OLD_ID';
    UPDATE brain_migrations SET brain_id = '$NEW_ID' WHERE brain_id = '$OLD_ID';
    COMMIT;"
  for f in config projects.json; do
    [ -f "$DEV_HOME/$f" ] && perl -pi -e "s/\Q$OLD_ID\E/$NEW_ID/g" "$DEV_HOME/$f"
  done
  for d in brain-hygiene eml/spaces claude-config/spaces; do
    if [ -e "$DEV_HOME/$d/$OLD_ID" ] && [ ! -e "$DEV_HOME/$d/$NEW_ID" ]; then mv "$DEV_HOME/$d/$OLD_ID" "$DEV_HOME/$d/$NEW_ID"; fi
  done
  DEV_DB="$DEV_HOME/data/$NEW_REL"
  echo "dev main brain now has the id its copy names: $OLD_ID → $NEW_ID"
fi
echo "copied: $(sqlite3 "$DEV_DB" 'SELECT count(*) FROM engrams') engrams, schema $SV, integrity $(sqlite3 "$DEV_DB" 'PRAGMA integrity_check' | head -1)"

if [ "${NO_RESTART:-0}" = "1" ]; then
  echo "NO_RESTART=1 → brain swapped, dev cockpit not started."
  exit 0
fi

# 3) Restart the dev cockpit from this worktree → the bundled server migrates the copy forward.
bash "$DEV_HOME_SH" start a
echo "dev brain now: $(sqlite3 "$DEV_DB" 'SELECT count(*) FROM engrams') engrams, schema $(sqlite3 "$DEV_DB" 'SELECT MAX(version) FROM _eml_migrations')"
