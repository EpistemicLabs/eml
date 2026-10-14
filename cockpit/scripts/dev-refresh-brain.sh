#!/usr/bin/env bash
# Refresh the DEV cockpit with a fresh WAL-safe copy of the PRODUCTION brain, so
# the release worktree's dev cockpit can be exercised against real data + volume.
# Disposable-viewer model (rule cockpit-release-gating): the copy goes ONE way,
# prod → dev, and overwrites whatever was in dev. Real work stays on prod (4317);
# anything written in the dev cockpit is lost on the next refresh.
#
# It reads each home's brain file from its own control.db (no hard-coded UUIDs),
# so it keeps working across versions and machines. The dev control.db + token
# stay untouched — only the brain FILE content is swapped. On the next dev-cockpit
# start the bundled server migrates the copy forward through the safety pipeline.
#
# Usage (worktree root):
#   bash cockpit/scripts/dev-refresh-brain.sh
# Env overrides:
#   PROD_HOME (default ~/.eml-cockpit)  DEV_HOME (default ~/.eml-cockpit-dev)
#   DEV_PORT  (default 4318)            DEV_SESSION (tmux session, default eml-dev)    
#   NO_RESTART=1  → only swap the brain, don't (re)start the dev cockpit
set -euo pipefail

PROD_HOME=${PROD_HOME:-$HOME/.eml-cockpit}
DEV_HOME=${DEV_HOME:-$HOME/.eml-cockpit-dev}
DEV_PORT=${DEV_PORT:-4318}
DEV_SESSION=${DEV_SESSION:-eml-dev}
WORKTREE=$(cd "$(dirname "$0")/../.." && pwd)

brain_file() { # $1 = home dir → absolute path of its (single) brain file, per control.db
  local home="$1" ctl="$1/data/control.db" rel
  [ -f "$ctl" ] || { echo "no control.db at $ctl" >&2; exit 1; }
  rel=$(sqlite3 "$ctl" "SELECT brain_file FROM brains LIMIT 1")
  [ -n "$rel" ] || { echo "no brain row in $ctl" >&2; exit 1; }
  echo "$home/data/$rel"
}

PROD_DB=$(brain_file "$PROD_HOME")
DEV_DB=$(brain_file "$DEV_HOME")
[ -f "$PROD_DB" ] || { echo "prod brain not found: $PROD_DB" >&2; exit 1; }
echo "prod brain: $PROD_DB ($(sqlite3 "$PROD_DB" 'SELECT count(*) FROM engrams') engrams, schema $(sqlite3 "$PROD_DB" 'SELECT MAX(version) FROM _eml_migrations'))"
echo "dev  brain: $DEV_DB"

# 1) Stop the dev cockpit so the brain file is free (kill listeners on DEV_PORT +
#    the bundled brain server for this dev home; the tmux session, if any, closes).
echo "stopping dev cockpit on :$DEV_PORT …"
lsof -ti "tcp:$DEV_PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
pgrep -f "server.cjs.*$(basename "$DEV_HOME")/data" 2>/dev/null | xargs -r kill 2>/dev/null || true
tmux kill-session -t "$DEV_SESSION" 2>/dev/null || true
sleep 2

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
# The dev control.db must report the copied brain's schema so the runner migrates it forward.
SV=$(sqlite3 "$DEV_DB" "SELECT MAX(version) FROM _eml_migrations")
sqlite3 "$DEV_HOME/data/control.db" "UPDATE brains SET schema_version = $SV"
echo "copied: $(sqlite3 "$DEV_DB" 'SELECT count(*) FROM engrams') engrams, schema $SV, integrity $(sqlite3 "$DEV_DB" 'PRAGMA integrity_check' | head -1)"

if [ "${NO_RESTART:-0}" = "1" ]; then
  echo "NO_RESTART=1 → brain swapped, dev cockpit not started."
  exit 0
fi

# 3) Restart the dev cockpit → the bundled server migrates the copy forward.
echo "starting dev cockpit (tmux $DEV_SESSION) …"
tmux new-session -d -s "$DEV_SESSION" -c "$WORKTREE" \
  "zsh -lc 'pnpm cockpit:dev 2>&1 | tee -a $DEV_HOME/host-dev.log'"

for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DEV_PORT/" 2>/dev/null)" = "200" ] && break
  sleep 1
done
echo "dev cockpit http://127.0.0.1:$DEV_PORT → $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DEV_PORT/") after ${i}s"
echo "dev brain now: $(sqlite3 "$DEV_DB" 'SELECT count(*) FROM engrams') engrams, schema $(sqlite3 "$DEV_DB" 'SELECT MAX(version) FROM _eml_migrations')"
