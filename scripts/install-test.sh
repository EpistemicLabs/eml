#!/usr/bin/env bash
# CI (Linux): install the cockpit the way a user does, with install.sh, from
# release assets packed from this checkout. Then check the systemd user unit it
# registers and remove it again. Needs `pnpm build`, the frontend and the
# eml-cockpit build, and a reachable systemd user manager (the CI step turns on
# lingering for the runner user and sets XDG_RUNTIME_DIR).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
assets="$(mktemp -d)"
home_dir="$(mktemp -d)/eml-home"
port=4399
unit_name="eml-cockpit-$port.service"
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit_name"
entry="$home_dir/app/current/node_modules/eml-cockpit/dist/index.js"

# every release asset, as pack-release.sh makes them: SHA256SUMS lists more than install.sh installs
for pkg in packages/mcp-server cockpit/host packages/protocol; do
  (cd "$root/$pkg" && pnpm pack --pack-destination "$assets" >/dev/null)
done
(cd "$assets" && sha256sum ./*.tgz | sed 's#  \./#  #' > SHA256SUMS)

export EML_FROM="$assets" EML_COCKPIT_HOME="$home_dir" COCKPIT_PORT="$port" EML_NO_OPEN=1

on_exit() {
  local code=$?
  if (( code != 0 )); then
    # What a failed run needs to be understood: the unit, and what systemd saw.
    echo "--- $unit ---"; cat "$unit" 2>/dev/null || echo "(no unit)"
    echo "--- systemctl --user status ---"; systemctl --user status "$unit_name" --no-pager 2>&1 | tail -20 || true
    echo "--- journal ---"; journalctl --user -u "$unit_name" --no-pager -n 30 2>&1 || true
  fi
  if [[ -f "$home_dir/host.log" ]]; then echo "--- host.log (end) ---"; tail -30 "$home_dir/host.log"; fi
  # Never leave a unit behind on the runner.
  systemctl --user disable --now "$unit_name" >/dev/null 2>&1 || true
  rm -f "$unit"
}
trap on_exit EXIT

bash "$root/scripts/install.sh"

grep -q "Restart=always" "$unit" || { echo "the unit does not restart the host"; exit 1; }
status="$(node "$entry" service status)"
echo "$status"
grep -q "installed: yes" <<<"$status" || { echo "the unit is not installed"; exit 1; }
grep -Eq "running: +yes" <<<"$status" || { echo "the unit is not running"; exit 1; }
grep -q "port $port: responds" <<<"$status" || { echo "the host does not respond on $port"; exit 1; }
[[ -f "$home_dir/host.log" ]] || { echo "the host writes no log"; exit 1; }

# A crash: systemd starts the host again.
pid="$(systemctl --user show "$unit_name" --property=MainPID --value)"
kill -9 "$pid"
for _ in $(seq 1 30); do
  new_pid="$(systemctl --user show "$unit_name" --property=MainPID --value)"
  [[ "$new_pid" != "0" && "$new_pid" != "$pid" ]] && curl -fs -o /dev/null "http://127.0.0.1:$port/health" && break
  sleep 1
done
[[ "$new_pid" != "0" && "$new_pid" != "$pid" ]] || { echo "systemd did not start the host again after a crash"; exit 1; }
echo "restarted after a crash: pid $pid -> $new_pid"

# Again: an installed and registered cockpit is left as it is.
bash "$root/scripts/install.sh" | grep -q "already installed" || { echo "a second install.sh run did not see the installed cockpit"; exit 1; }

node "$entry" service uninstall
sleep 2
if curl -fs -o /dev/null "http://127.0.0.1:$port/health"; then echo "the host still runs after service uninstall"; exit 1; fi
[[ ! -e "$unit" ]] || { echo "the unit file is still there after service uninstall"; exit 1; }
echo "install test passed"
