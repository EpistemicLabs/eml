#!/usr/bin/env bash
# Release version bump — one product version for the whole repo.
#
# Sets <X.Y.Z> in the root package.json (the product version), cockpit/host
# (eml-cockpit), packages/server, packages/mcp-server, packages/protocol (its
# tarball is a release asset the relay installs) and the mcp-server README
# "## Tools (vX.Y.Z)" header, then verifies they all agree. core and the
# cockpit frontend are internal workspace packages and stay 0.0.0.
#
# A pre-release suffix is accepted: 0.22.0-alpha.1 (the alpha line).
#
# Usage: bash scripts/bump-version.sh <X.Y.Z[-pre]>
set -euo pipefail

VERSION="${1:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo "Error: usage: bump-version.sh <X.Y.Z[-pre]> (got: '${VERSION}')" >&2
  exit 1
fi
cd "$REPO_DIR"
echo "[bump] target version: $VERSION"

for dir in . cockpit/host packages/server packages/mcp-server packages/protocol; do
  (cd "$dir" && npm pkg set version="$VERSION")
done
perl -pi -e "s/^## Tools \(v[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.-]*\)/## Tools (v${VERSION})/" packages/mcp-server/README.md

FAIL=0
check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then echo "  ok       $1 = $2"; else echo "  MISMATCH $1 = $2 (expected $3)" >&2; FAIL=1; fi
}
for dir in . cockpit/host packages/server packages/mcp-server packages/protocol; do
  check "$dir" "$(node -p "require('./$dir/package.json').version")" "$VERSION"
done
check "mcp-server README ## Tools" "$(grep -m1 -oE '^## Tools \(v[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.-]*\)' packages/mcp-server/README.md | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.-]*')" "$VERSION"
for dir in packages/core packages/channel-bridge cockpit/frontend; do
  check "$dir (internal)" "$(node -p "require('./$dir/package.json').version")" "0.0.0"
done

if [[ "$FAIL" -ne 0 ]]; then echo "[bump] FAILED — versions out of lockstep." >&2; exit 1; fi
echo "[bump] done — all at $VERSION."
