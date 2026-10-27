#!/usr/bin/env bash
# Build the release assets for the current version: the eml-cockpit,
# @engramprotocol/mcp-server and @engramprotocol/protocol tarballs plus
# SHA256SUMS, in ./release/<version>/,
# and the one-line installers install.sh (macOS) and install.ps1 (Windows) with
# its double-click starter install-eml-cockpit.cmd,
# linked via releases/latest/download/<installer>.
# Attach them to the GitHub release of tag v<version>:
#   gh release create v<version> release/<version>/* --notes-file <notes>
# The cockpit's updater and the installers download the cockpit and mcp-server
# tarballs and SHA256SUMS by name; the relay installs the protocol tarball,
# pinned by version and its SHA256SUMS line.
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
(cd packages/protocol && pnpm pack --pack-destination "$REPO_DIR/$OUT" >/dev/null)
for f in "eml-cockpit-$VERSION.tgz" "engramprotocol-mcp-server-$VERSION.tgz" "engramprotocol-protocol-$VERSION.tgz"; do
  [[ -f "$OUT/$f" ]] || { echo "[pack] missing $f" >&2; exit 1; }
done
cp scripts/install.sh "$OUT/install.sh"
cp scripts/install.ps1 "$OUT/install.ps1"
cp scripts/install-eml-cockpit.cmd "$OUT/install-eml-cockpit.cmd"
(cd "$OUT" && shasum -a 256 "eml-cockpit-$VERSION.tgz" "engramprotocol-mcp-server-$VERSION.tgz" "engramprotocol-protocol-$VERSION.tgz" > SHA256SUMS)
echo "[pack] done:"; ls -la "$OUT"
