#!/usr/bin/env bash
# Install an EML Cockpit release as this machine's app and run it as a login
# service (macOS launchd). Later updates come through the cockpit itself
# (update banner / Settings › About › Updates).
#
#   scripts/install-app.sh [--home <dir>] [--port <port>] <version | latest | --from <dir>>
#
#   <version>|latest  download the release assets from GitHub (needs a logged-in `gh`)
#   --from <dir>      use local assets (eml-cockpit-<v>.tgz, engramprotocol-mcp-server-<v>.tgz,
#                     SHA256SUMS), e.g. release/<v> from scripts/pack-release.sh
#   --home            cockpit home (default ~/.eml-cockpit) — an existing home is kept as is;
#                     its brain is migrated by the new version on start (with a backup)
#   --port            service port (default 4317)
#
# Layout: <home>/app/versions/<v>/ + <home>/app/current -> versions/<v>.
set -euo pipefail

REPO="${EML_COCKPIT_UPDATE_REPO:-EpistemicLabs/eml}"
HOME_DIR="${HOME}/.eml-cockpit"
PORT=4317
FROM=""
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --home) HOME_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) VERSION="$1"; shift ;;
  esac
done
[[ -n "$FROM" || -n "$VERSION" ]] || { echo "usage: install-app.sh [--home <dir>] [--port <port>] <version|latest|--from <dir>>" >&2; exit 1; }

APP="$HOME_DIR/app"
mkdir -p "$APP/versions"
chmod 700 "$HOME_DIR"
STAGING="$(mktemp -d "$APP/.staging-XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/tarballs"

if [[ -n "$FROM" ]]; then
  cp "$FROM"/*.tgz "$FROM"/SHA256SUMS "$STAGING/tarballs/"
else
  TAG="$VERSION"; [[ "$TAG" == "latest" ]] && TAG="$(gh release view -R "$REPO" --json tagName -q .tagName)"
  [[ "$TAG" == v* ]] || TAG="v$TAG"
  gh release download "$TAG" -R "$REPO" -p '*.tgz' -p 'SHA256SUMS' -D "$STAGING/tarballs"
fi

cd "$STAGING/tarballs"
shasum -a 256 -c SHA256SUMS
COCKPIT_TGZ="$(ls eml-cockpit-*.tgz)"
MCP_TGZ="$(ls engramprotocol-mcp-server-*.tgz)"
V="${COCKPIT_TGZ#eml-cockpit-}"; V="${V%.tgz}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected tarball name $COCKPIT_TGZ" >&2; exit 1; }

cd "$STAGING"
echo '{ "name": "eml-cockpit-app", "private": true }' > package.json
npm install --no-fund --no-audit --omit=dev "./tarballs/$MCP_TGZ" "./tarballs/$COCKPIT_TGZ"
[[ "$(node -p "require('./node_modules/eml-cockpit/package.json').version")" == "$V" ]]

rm -rf "$APP/versions/$V"
mv "$STAGING" "$APP/versions/$V"
trap - EXIT
# -n: replace the existing link itself, never write into the directory it points to
ln -sfn "versions/$V" "$APP/current"
echo "installed v$V → $APP/current"

EML_COCKPIT_HOME="$HOME_DIR" COCKPIT_PORT="$PORT" node "$APP/current/node_modules/eml-cockpit/dist/index.js" service install
