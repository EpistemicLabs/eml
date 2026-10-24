#!/usr/bin/env bash
# Install the EML Cockpit on a Mac or a Linux machine — the one-line installer
# for people without a developer setup. It is attached to every GitHub release, so
#
#   curl -fsSL https://github.com/EpistemicLabs/eml/releases/latest/download/install.sh | bash
#
# always runs the installer of the newest release. It needs only Node ≥ 22: no
# git, no gh, no GitHub account. It downloads the release tarballs, checks them
# against SHA256SUMS, installs them into <home>/app/versions/<v>/ (the layout the
# in-app updater uses) and registers the login service (launchd on macOS, a
# systemd user unit on Linux). Later updates come through the cockpit's update
# banner. scripts/install-app.sh stays the developer path (local assets via --from).
#
# Env overrides: EML_COCKPIT_HOME (default ~/.eml-cockpit), COCKPIT_PORT (4317),
# EML_VERSION (default: newest release), EML_NO_OPEN=1 (don't open the browser),
# EML_FROM (a folder with the release assets instead of downloading them).

# Everything runs inside main, so a download cut off halfway through runs nothing.
main() {
  set -euo pipefail

  local repo="EpistemicLabs/eml"
  local home_dir="${EML_COCKPIT_HOME:-$HOME/.eml-cockpit}"
  local port="${COCKPIT_PORT:-4317}"
  local url="http://127.0.0.1:$port"
  local app="$home_dir/app"
  local os
  os="$(uname -s)"

  say() { printf '\033[1m%s\033[0m\n' "$*"; }
  fail() { printf '\n\033[31mInstallation stopped:\033[0m %s\n' "$*" >&2; exit 1; }

  [[ "$os" == "Darwin" || "$os" == "Linux" ]] || fail "this installer is for macOS and Linux. On Windows, see https://github.com/$repo/blob/main/INSTALL.md#installing-on-windows-beta"
  (( EUID != 0 )) || fail "run the command without sudo. The cockpit installs into your own user account."

  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js is not installed. Get version 22 or newer from https://nodejs.org (on Linux also from your package manager or nvm), then open a new terminal and run the command again."
  fi
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  (( node_major >= 22 )) || fail "Node.js $(node -v) is too old, the cockpit needs version 22 or newer. Get it from https://nodejs.org."
  command -v npm >/dev/null 2>&1 || fail "npm is missing (it comes with Node.js). Reinstall Node.js from https://nodejs.org."

  # The service each OS registers, and how to ask for it.
  is_registered() {
    if [[ "$os" == "Darwin" ]]; then launchctl list "io.engramprotocol.cockpit.$port" >/dev/null 2>&1
    else systemctl --user is-enabled --quiet "eml-cockpit-$port.service" 2>/dev/null; fi
  }
  port_in_use() {
    if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    elif command -v ss >/dev/null 2>&1; then [[ -n "$(ss -Hltn "sport = :$port" 2>/dev/null)" ]]
    else return 1; fi
  }
  sha256_check() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet SHA256SUMS >/dev/null
    else shasum -a 256 -c SHA256SUMS >/dev/null; fi
  }

  # Installed and registered: nothing to do. Installed but not registered (an
  # earlier run failed at the service, or it was uninstalled and the brain
  # kept): register it again below instead of reinstalling.
  local registered=""
  is_registered && registered=1
  if [[ -e "$app/current" && -n "$registered" ]]; then
    say "The EML Cockpit is already installed in $home_dir."
    echo "Updates come through the cockpit itself (update banner, or Settings › About › Updates)."
    echo "Open it: $url"
    exit 0
  fi
  if [[ -z "$registered" ]] && port_in_use; then
    fail "port $port is already in use by another program (perhaps a cockpit started from a checkout). Stop it, then run the command again."
  fi

  if [[ -e "$app/current" ]]; then
    say "Found an installed EML Cockpit in $home_dir, registering it again …"
  else
    local from="${EML_FROM:-}" tag="${EML_VERSION:-}"
    if [[ -n "$from" ]]; then
      local tarball
      tarball="$(cd "$from" && ls eml-cockpit-*.tgz 2>/dev/null | head -1)" || true
      [[ -n "$tarball" ]] || fail "no eml-cockpit-<version>.tgz in $from"
      tag="v${tarball#eml-cockpit-}"; tag="${tag%.tgz}"
    elif [[ -z "$tag" ]]; then
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
      if [[ -n "$from" ]]; then
        cp "$from/$name" "$staging/tarballs/$name" || fail "$name is missing in $from"
        continue
      fi
      echo "  downloading $name"
      curl -fsSL --retry 2 -o "$staging/tarballs/$name" "$base/$name" || fail "download of $name failed. Check your internet connection and try again."
    done
    (cd "$staging/tarballs" && sha256_check) || fail "the downloaded files do not match their checksums. Nothing was installed."
    echo "  checksums ok"

    echo "  installing (this takes a minute)"
    echo '{ "name": "eml-cockpit-app", "private": true }' > "$staging/package.json"
    (cd "$staging" && npm install --no-fund --no-audit --no-update-notifier --omit=dev --loglevel=error \
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
  if [[ "$os" == "Linux" && "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" == "no" ]]; then
    echo "To start it at boot and keep it running after you log out (e.g. on a server): sudo loginctl enable-linger $USER"
  fi
  [[ -z "${EML_NO_OPEN:-}" ]] || return 0
  if [[ "$os" == "Darwin" ]]; then open "$url"
  elif [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

main "$@"
