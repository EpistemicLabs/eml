#!/usr/bin/env bash
# The two fixed dev cockpits, started from any worktree. Each profile is its own
# home on its own port — one person each, both members of the same shared space,
# so sync between two members can be checked locally:
#   a  ~/.eml-cockpit-dev    port 4318   (main: a copy of the production brain, dev-refresh-brain.sh)
#   b  ~/.eml-cockpit-dev-b  port 4319   (main: the sample brain, seed-sample-brain.sh)
# One home is served by one host at a time: two hosts on one home would run two
# brain servers on the same files and one device identity on the relay twice.
#
# Usage (from the root of any worktree):
#   bash cockpit/scripts/dev-home.sh start [a|b] [--build]   stop a running host of the profile, serve it from this worktree
#   bash cockpit/scripts/dev-home.sh stop [a|b]
#   bash cockpit/scripts/dev-home.sh status                  which worktree serves which profile
#   bash cockpit/scripts/dev-home.sh snapshot [a|b]          keep the local brains' state as the one to come back to
#   bash cockpit/scripts/dev-home.sh reset [a|b]             go back to it
#   bash cockpit/scripts/dev-home.sh log [a|b]               follow the host log
# The profile defaults to a. A snapshot holds the control db, the local brains, the
# cockpit config and the per-space state — never a shared brain: its replica follows
# the relay's log, and an older copy of it would fork from what the other member has.
# Logins (claude-config, codex, account) are not part of it and survive a reset.
set -euo pipefail

WORKTREE=$(cd "$(dirname "$0")/../.." && pwd)
CMD=${1:-status}
PROFILE=${2:-a}
case "$PROFILE" in
  a) DEV_HOME=$HOME/.eml-cockpit-dev;   DEV_PORT=4318 ;;
  b) DEV_HOME=$HOME/.eml-cockpit-dev-b; DEV_PORT=4319 ;;
  *) echo "profile is a or b, not '$PROFILE'" >&2; exit 2 ;;
esac
SESSION=eml-dev-$PROFILE
LOG=$DEV_HOME/host-dev.log
SERVED_BY=$DEV_HOME/served-by       # the worktree, branch and commit the running host was started from
SNAP=$DEV_HOME/dev-snapshot

up() { [ -n "$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null)" ]; }

stop_host() {
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
  [ "$PROFILE" = a ] && tmux kill-session -t =eml-dev 2>/dev/null || true   # the session dev-refresh-brain.sh used to start
  lsof -ti "tcp:$DEV_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  pgrep -f "server.cjs.*$(basename "$DEV_HOME")/data" 2>/dev/null | xargs kill 2>/dev/null || true
  for _ in $(seq 1 20); do up "$DEV_PORT" || break; sleep 0.5; done
  if up "$DEV_PORT"; then echo "port $DEV_PORT is still taken" >&2; exit 1; fi
  rm -f "$SERVED_BY"
}

# The host runs from source (tsx watch); the brain server it bundles and the
# frontend it serves come from this worktree's builds. Older than their sources →
# the cockpit would show code other than this worktree's.
check_build() {
  local stale=""
  newer() { [ -n "$(find "$@" -newer "$1" -type f -print -quit 2>/dev/null)" ]; }
  [ -f cockpit/host/dist/server.cjs ] && ! newer cockpit/host/dist/server.cjs packages/core/src packages/server/src || stale="$stale brain-server"
  [ -f cockpit/frontend/dist/index.html ] && ! newer cockpit/frontend/dist/index.html cockpit/frontend/src || stale="$stale frontend"
  [ -f packages/mcp-server/dist/cli.js ] && ! newer packages/mcp-server/dist/cli.js packages/mcp-server/src || stale="$stale mcp-server"
  [ -z "$stale" ] || { echo "build older than its sources in $WORKTREE:$stale — run: pnpm run cockpit:build (or start --build)" >&2; exit 1; }
}

start_host() {
  cd "$WORKTREE"
  if [ "${1:-}" = "--build" ]; then pnpm run cockpit:build; else check_build; fi
  stop_host
  mkdir -p "$DEV_HOME"
  tmux new-session -d -s "$SESSION" -c "$WORKTREE" \
    "zsh -lc 'EML_COCKPIT_HOME=$DEV_HOME COCKPIT_PORT=$DEV_PORT pnpm cockpit:dev 2>&1 | tee -a $LOG'"
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DEV_PORT/" 2>/dev/null)" = "200" ] && break
    sleep 1
  done
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DEV_PORT/")" = "200" ] || { echo "host did not come up — dev-home.sh log $PROFILE" >&2; exit 1; }
  printf '%s %s %s\n' "$WORKTREE" "$(git -C "$WORKTREE" branch --show-current)" "$(git -C "$WORKTREE" rev-parse --short HEAD)" > "$SERVED_BY"
  echo "dev $PROFILE: http://127.0.0.1:$DEV_PORT  home $DEV_HOME  from $(cat "$SERVED_BY")  (tmux $SESSION)"
}

# Brains whose replica follows a relay (a team file names them).
shared_ids() { for f in "$DEV_HOME"/data/team/*.json; do [ -e "$f" ] && basename "$f" .json; done; return 0; }

snapshot() {
  [ -f "$DEV_HOME/data/control.db" ] || { echo "no dev home at $DEV_HOME" >&2; exit 1; }
  local was_up=0; up "$DEV_PORT" && was_up=1
  local from; from=$(cut -d' ' -f1 "$SERVED_BY" 2>/dev/null || echo "$WORKTREE")
  stop_host
  rm -rf "$SNAP.new"; mkdir -p "$SNAP.new/brains"
  sqlite3 "$DEV_HOME/data/control.db" "VACUUM INTO '$SNAP.new/control.db'"
  local shared; shared=" $(shared_ids | tr '\n' ' ') "
  for f in "$DEV_HOME"/data/brains/*.db; do
    local id; id=$(basename "$f" .db)
    case "$shared" in *" $id "*) continue ;; esac
    sqlite3 "$f" "VACUUM INTO '$SNAP.new/brains/$id.db'"
  done
  shared_ids > "$SNAP.new/shared"
  for p in config projects.json agents.json spaces eml/spaces brain-hygiene; do
    [ -e "$DEV_HOME/$p" ] && { mkdir -p "$SNAP.new/home/$(dirname "$p")"; cp -R "$DEV_HOME/$p" "$SNAP.new/home/$p"; }
  done
  rm -rf "$SNAP"; mv "$SNAP.new" "$SNAP"
  echo "snapshot of dev $PROFILE: $(ls "$SNAP/brains" | wc -l | tr -d ' ') local brains, shared left out: $(tr '\n' ' ' < "$SNAP/shared")"
  [ "$was_up" = 1 ] && WORKTREE=$from start_host || true
}

reset() {
  [ -d "$SNAP" ] || { echo "no snapshot for dev $PROFILE — dev-home.sh snapshot $PROFILE first" >&2; exit 1; }
  # A shared space joined or left since the snapshot would leave the control db
  # and the replicas on disk disagreeing; that one is set up again by hand.
  [ "$(shared_ids)" = "$(cat "$SNAP/shared")" ] || { echo "the shared spaces changed since the snapshot ($(shared_ids | tr '\n' ' ')≠ $(tr '\n' ' ' < "$SNAP/shared")) — take a new snapshot" >&2; exit 1; }
  local was_up=0; up "$DEV_PORT" && was_up=1
  local from; from=$(cut -d' ' -f1 "$SERVED_BY" 2>/dev/null || echo "$WORKTREE")
  stop_host
  local shared; shared=" $(shared_ids | tr '\n' ' ') "
  for f in "$DEV_HOME"/data/brains/*.db; do
    local id; id=$(basename "$f" .db)
    case "$shared" in *" $id "*) continue ;; esac
    rm -f "$f" "$f-wal" "$f-shm"
  done
  cp "$SNAP"/brains/*.db "$DEV_HOME/data/brains/"
  rm -f "$DEV_HOME/data/control.db-wal" "$DEV_HOME/data/control.db-shm"
  cp "$SNAP/control.db" "$DEV_HOME/data/control.db"
  for p in config projects.json agents.json spaces eml/spaces brain-hygiene; do
    rm -rf "${DEV_HOME:?}/$p"
    [ -e "$SNAP/home/$p" ] && { mkdir -p "$DEV_HOME/$(dirname "$p")"; cp -R "$SNAP/home/$p" "$DEV_HOME/$p"; }
  done
  echo "dev $PROFILE reset to its snapshot of $(date -r "$SNAP/control.db" '+%Y-%m-%d %H:%M')"
  [ "$was_up" = 1 ] && WORKTREE=$from start_host || true
}

status() {
  for p in a b; do
    local home port; [ "$p" = a ] && { home=$HOME/.eml-cockpit-dev; port=4318; } || { home=$HOME/.eml-cockpit-dev-b; port=4319; }
    if up "$port"; then echo "dev $p  :$port  up    $(cat "$home/served-by" 2>/dev/null || echo '(started outside dev-home.sh)')"
    else echo "dev $p  :$port  down"; fi
    [ -d "$home/dev-snapshot" ] && echo "        snapshot $(date -r "$home/dev-snapshot/control.db" '+%Y-%m-%d %H:%M')"
  done
}

case "$CMD" in
  start) start_host "${3:-}" ;;
  stop) stop_host; echo "dev $PROFILE stopped" ;;
  status) status ;;
  snapshot) snapshot ;;
  reset) reset ;;
  log) tail -f "$LOG" ;;
  *) sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
