#!/usr/bin/env bash
# Publish the current package.json version to npm unless it's already there.
# Replaces `changeset publish`, which forwards the pnpm-only --git-checks flag
# into npm publish — modern npm hard-errors on unknown flags (EUNKNOWNCONFIG).
# The already-published guard keeps the workflow idempotent on pushes that
# carry no version bump, which `changeset publish` used to provide.
set -euo pipefail
VERSION=$(node -p "require('./package.json').version")
if npm view "durable-db@${VERSION}" version >/dev/null 2>&1; then
  echo "durable-db@${VERSION} already on npm — nothing to publish."
else
  npm publish --access public
fi
