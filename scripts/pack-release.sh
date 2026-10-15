#!/usr/bin/env bash
# Build the release assets for the current version: the eml-cockpit and
# @engramprotocol/mcp-server tarballs plus SHA256SUMS, in ./release/<version>/,
# and the one-line installer install.sh (INSTALL.md links it via
# releases/latest/download/install.sh).
# Attach them to the GitHub release of tag v<version>:
#   gh release create v<version> release/<version>/* --notes-file <notes>
# The cockpit's updater downloads the two tarballs and SHA256SUMS by name.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
VERSION="$(node -p "require('./package.json').version")"
OUT="release/$VERSION"

echo "[pack] v$VERSION"
pnpm install --frozen-lockfile
pnpm build
pnpm -F @engramprotocol/cockpit-frontend build
pnpm -F eml-cockpit build
rm -rf "$OUT" && mkdir -p "$OUT"
(cd packages/mcp-server && pnpm pack --pack-destination "$REPO_DIR/$OUT" >/dev/null)
(cd cockpit/host && pnpm pack --pack-destination "$REPO_DIR/$OUT" >/dev/null)
for f in "eml-cockpit-$VERSION.tgz" "engramprotocol-mcp-server-$VERSION.tgz"; do
  [[ -f "$OUT/$f" ]] || { echo "[pack] missing $f" >&2; exit 1; }
done
cp scripts/install.sh "$OUT/install.sh"
(cd "$OUT" && shasum -a 256 "eml-cockpit-$VERSION.tgz" "engramprotocol-mcp-server-$VERSION.tgz" > SHA256SUMS)
echo "[pack] done:"; ls -la "$OUT"
