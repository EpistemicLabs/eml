#!/usr/bin/env bash
# Release version bump — one product version for the whole repo.
#
# Sets <X.Y.Z> in the root package.json (the product version), cockpit/host
# (eml-cockpit), packages/server, packages/mcp-server, packages/protocol (its
# tarball is a release asset the relay installs) and the mcp-server README
# "## Tools (vX.Y.Z)" header, then verifies they all agree. core and the
# cockpit frontend are internal workspace packages and stay 0.0.0.
#
# Usage: bash scripts/bump-version.sh <X.Y.Z>
set -euo pipefail

VERSION="${1:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: usage: bump-version.sh <X.Y.Z> (got: '${VERSION}')" >&2
  exit 1
fi
cd "$REPO_DIR"
echo "[bump] target version: $VERSION"

for dir in . cockpit/host packages/server packages/mcp-server packages/protocol; do
  (cd "$dir" && npm pkg set version="$VERSION")
done
perl -pi -e "s/^## Tools \(v[0-9]+\.[0-9]+\.[0-9]+\)/## Tools (v${VERSION})/" packages/mcp-server/README.md

FAIL=0
check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then echo "  ok       $1 = $2"; else echo "  MISMATCH $1 = $2 (expected $3)" >&2; FAIL=1; fi
}
for dir in . cockpit/host packages/server packages/mcp-server packages/protocol; do
  check "$dir" "$(node -p "require('./$dir/package.json').version")" "$VERSION"
done
check "mcp-server README ## Tools" "$(grep -m1 -oE '^## Tools \(v[0-9]+\.[0-9]+\.[0-9]+\)' packages/mcp-server/README.md | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')" "$VERSION"
for dir in packages/core cockpit/frontend; do
  check "$dir (internal)" "$(node -p "require('./$dir/package.json').version")" "0.0.0"
done

if [[ "$FAIL" -ne 0 ]]; then echo "[bump] FAILED — versions out of lockstep." >&2; exit 1; fi
echo "[bump] done — all at $VERSION."
