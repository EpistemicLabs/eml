#!/usr/bin/env bash
# Install the EML Cockpit on a Mac — the one-line installer for people without
# a developer setup. It is attached to every GitHub release, so
#
#   curl -fsSL https://github.com/EpistemicLabs/eml/releases/latest/download/install.sh | bash
#
# always runs the installer of the newest release. It needs only Node ≥ 22: no
# git, no gh, no GitHub account. It downloads the release tarballs, checks them
# against SHA256SUMS, installs them into <home>/app/versions/<v>/ (the layout the
# in-app updater uses) and registers the login service. Later updates come
# through the cockpit's update banner. scripts/install-app.sh stays the
# developer path (local assets via --from).
#
# Env overrides: EML_COCKPIT_HOME (default ~/.eml-cockpit), COCKPIT_PORT (4317),
# EML_VERSION (default: newest release), EML_NO_OPEN=1 (don't open the browser).

# Everything runs inside main, so a download cut off halfway through runs nothing.
main() {
  set -euo pipefail

  local repo="EpistemicLabs/eml"
  local home_dir="${EML_COCKPIT_HOME:-$HOME/.eml-cockpit}"
  local port="${COCKPIT_PORT:-4317}"
  local url="http://127.0.0.1:$port"
  local app="$home_dir/app"
  local label="io.engramprotocol.cockpit.$port"

  say() { printf '\033[1m%s\033[0m\n' "$*"; }
  fail() { printf '\n\033[31mInstallation stopped:\033[0m %s\n' "$*" >&2; exit 1; }

  [[ "$(uname -s)" == "Darwin" ]] || fail "this installer is for macOS. On Linux, see https://github.com/$repo#quick-start"
  (( EUID != 0 )) || fail "run the command without sudo. The cockpit installs into your own user account."

  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js is not installed. Get the LTS installer from https://nodejs.org, run it, then open a new Terminal window and paste the command again."
  fi
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  (( node_major >= 22 )) || fail "Node.js $(node -v) is too old, the cockpit needs version 22 or newer. Get the LTS installer from https://nodejs.org."
  command -v npm >/dev/null 2>&1 || fail "npm is missing (it comes with Node.js). Reinstall Node.js from https://nodejs.org."

  # Installed and registered: nothing to do. Installed but not registered (an
  # earlier run failed at the service, or it was uninstalled and the brain
  # kept): register it again below instead of reinstalling.
  local registered=""
  launchctl list "$label" >/dev/null 2>&1 && registered=1
  if [[ -e "$app/current" && -n "$registered" ]]; then
    say "The EML Cockpit is already installed in $home_dir."
    echo "Updates come through the cockpit itself (update banner, or Settings › About › Updates)."
    echo "Open it: $url"
    exit 0
  fi
  if [[ -z "$registered" ]] && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $port is already in use by another program (perhaps a cockpit started from a checkout). Stop it, then run the command again."
  fi

  if [[ -e "$app/current" ]]; then
    say "Found an installed EML Cockpit in $home_dir, registering it again …"
  else
    local tag="${EML_VERSION:-}"
    if [[ -z "$tag" ]]; then
      # The releases/latest page redirects to .../releases/tag/v<version>; no API, no rate limit.
      tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")" \
        || fail "could not reach GitHub. Check your internet connection and try again."
      tag="${tag##*/}"
    fi
    [[ "$tag" == v* ]] || tag="v$tag"
    local v="${tag#v}"
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "could not find the newest release (got '$tag'). Check your internet connection."

    say "Installing EML Cockpit v$v into $home_dir …"
    mkdir -p "$app/versions"
    chmod 700 "$home_dir"
    local staging
    staging="$(mktemp -d "$app/.staging-XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    mkdir -p "$staging/tarballs"

    local base="https://github.com/$repo/releases/download/$tag" name
    for name in "eml-cockpit-$v.tgz" "engramprotocol-mcp-server-$v.tgz" SHA256SUMS; do
      echo "  downloading $name"
      curl -fsSL --retry 2 -o "$staging/tarballs/$name" "$base/$name" || fail "download of $name failed. Check your internet connection and try again."
    done
    (cd "$staging/tarballs" && shasum -a 256 -c SHA256SUMS >/dev/null) || fail "the downloaded files do not match their checksums. Nothing was installed."
    echo "  checksums ok"

    echo "  installing (this takes a minute)"
    echo '{ "name": "eml-cockpit-app", "private": true }' > "$staging/package.json"
    (cd "$staging" && npm install --no-fund --no-audit --omit=dev --loglevel=error \
      "./tarballs/engramprotocol-mcp-server-$v.tgz" "./tarballs/eml-cockpit-$v.tgz") || fail "npm install failed (see the messages above)."

    rm -rf "$app/versions/$v"
    mv "$staging" "$app/versions/$v"
    trap - EXIT
    ln -sfn "versions/$v" "$app/current"
  fi

  EML_COCKPIT_HOME="$home_dir" COCKPIT_PORT="$port" node "$app/current/node_modules/eml-cockpit/dist/index.js" service install >/dev/null \
    || fail "the cockpit is installed, but its login service could not be registered. Run the command again; if it stops here again, open an issue."

  echo "  starting"
  local i up=""
  for i in $(seq 1 60); do
    curl -fs -o /dev/null "$url/health" && { up=1; break; }
    sleep 1
  done
  [[ -n "$up" ]] || fail "the cockpit did not start within a minute. Its log is $home_dir/host.log, attach it when you open an issue."

  echo
  say "Done. The EML Cockpit runs at $url"
  echo "It starts on its own at every login. Updates appear as a banner inside the cockpit."
  [[ -n "${EML_NO_OPEN:-}" ]] || open "$url"
}

main "$@"
