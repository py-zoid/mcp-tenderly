#!/usr/bin/env bash
#
# Points git at the committed hooks directory. Run automatically by npm's
# `prepare` lifecycle after `npm install`, so a contributor gets the hooks
# without a documented extra step.
#
# Exits quietly when there is no git repository — that is the case when this
# package is installed as a dependency, where setting git config would be wrong.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d .git ] && ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

git config core.hooksPath .githooks
echo "git hooks enabled (core.hooksPath=.githooks)"
