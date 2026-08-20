#!/usr/bin/env bash
#
# The full verification gate. Lives here rather than as a series of YAML steps
# so a contributor can reproduce exactly what CI does with one command, and so
# no step depends on state passed through $GITHUB_OUTPUT.
set -euo pipefail

cd "$(dirname "$0")/../.."

run() {
  echo ""
  echo "─── $1 ───"
  shift
  "$@"
}

run "formatting" npm run format:check
run "lint" npm run lint
run "types" npm run typecheck
run "unit tests" npm run test
# Builds first, then drives dist/index.js over a real stdio transport. This is
# the step that catches a stray write to stdout corrupting the JSON-RPC framing.
run "build + stdio smoke test" npm run test:smoke

echo ""
echo "All checks passed."
