#!/usr/bin/env bash
# Cut a release: bump version, regenerate CHANGELOG section, commit, tag.
# Pushing the tag triggers .github/workflows/release.yml, which builds the
# extension zip and publishes it as a GitHub Release.
#
# Usage: scripts/release.sh <patch|minor|major>
set -euo pipefail

LEVEL="${1:?usage: release.sh <patch|minor|major>}"
case "$LEVEL" in patch|minor|major) ;; *) echo "unknown level: $LEVEL" >&2; exit 1 ;; esac

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "Releases are cut from main (currently on '$branch')." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean — commit or stash first." >&2
  exit 1
fi

git fetch origin main --tags
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Local main is not in sync with origin/main — pull/push first." >&2
  exit 1
fi

make typecheck test

make "bump-$LEVEL"
VERSION=$(node -p "require('./package.json').version")

if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "Tag v$VERSION already exists." >&2
  exit 1
fi

node scripts/release-notes.mjs changelog "$VERSION"

git add package.json package-lock.json manifest.json CHANGELOG.md
git commit -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

echo
echo "Release commit and tag v$VERSION created locally."
echo "Review CHANGELOG.md, then publish with:"
echo
echo "  git push origin main --follow-tags"
