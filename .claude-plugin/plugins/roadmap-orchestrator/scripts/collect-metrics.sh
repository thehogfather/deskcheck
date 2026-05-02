#!/bin/bash
# collect-metrics.sh — Gather quantitative metrics from a worktree
#
# Usage:
#   collect-metrics.sh <worktree-path> <output.json> [elapsed_seconds]

set -euo pipefail

WT_PATH="${1:?Usage: collect-metrics.sh <worktree-path> <output.json> [elapsed_seconds]}"
OUTPUT_FILE="${2:?Usage: collect-metrics.sh <worktree-path> <output.json> [elapsed_seconds]}"
ELAPSED="${3:-0}"

if [ ! -d "$WT_PATH" ]; then
  echo "Error: Worktree path not found: $WT_PATH" >&2
  exit 1
fi

cd "$WT_PATH"

# --- Git metrics ---
MAIN_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo 'main')"
MERGE_BASE="$(git merge-base "$MAIN_BRANCH" HEAD 2>/dev/null || echo "$MAIN_BRANCH")"

# Lines added/removed
LINES_ADDED=0
LINES_REMOVED=0
DIFF_STAT=""
if NUMSTAT="$(git diff "$MERGE_BASE"..HEAD --numstat 2>/dev/null)"; then
  if [ -n "$NUMSTAT" ]; then
    LINES_ADDED="$(echo "$NUMSTAT" | awk '{s+=$1} END {print s+0}')"
    LINES_REMOVED="$(echo "$NUMSTAT" | awk '{s+=$2} END {print s+0}')"
  fi
  DIFF_STAT="$(git diff "$MERGE_BASE"..HEAD --stat 2>/dev/null | tail -1 || echo "")"
fi

# Files changed/created
FILES_CHANGED="$(git diff "$MERGE_BASE"..HEAD --name-only 2>/dev/null | wc -l | tr -d ' ')"
FILES_CREATED="$(git diff "$MERGE_BASE"..HEAD --name-only --diff-filter=A 2>/dev/null | wc -l | tr -d ' ')"

# Commit count
COMMITS="$(git rev-list "$MERGE_BASE"..HEAD --count 2>/dev/null || echo "0")"

# --- Validation checks ---
# Resolve validation_ops.py portably
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VALIDATION_OPS="$PLUGIN_DIR/shared-utilities/scripts/validation_ops.py"

if [ ! -f "$VALIDATION_OPS" ]; then
  INSTALLED="$(ls -d ~/.claude/plugins/cache/*/roadmap-orchestrator/*/shared-utilities/scripts/validation_ops.py 2>/dev/null | tail -1)"
  if [ -n "$INSTALLED" ]; then
    VALIDATION_OPS="$INSTALLED"
  fi
fi

VALIDATION_JSON="{}"
ALL_PASSED=true

if [ -f "$VALIDATION_OPS" ]; then
  VALIDATION_JSON="$(python3 "$VALIDATION_OPS" full-check 2>/dev/null || echo "{}")"
  ALL_PASSED="$(echo "$VALIDATION_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    checks = d.get('checks', [])
    print('true' if all(c.get('passed', False) for c in checks) else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")"
else
  # Fallback: basic checks
  CHECKS="[]"
  TYPE_PASS=true
  TEST_PASS=true
  LINT_PASS=true

  # TypeScript check
  if [ -f "tsconfig.json" ]; then
    if npx tsc --noEmit >/dev/null 2>&1; then
      TYPE_PASS=true
    else
      TYPE_PASS=false
      ALL_PASSED=false
    fi
  fi

  # Test check
  if [ -f "package.json" ] && grep -q '"test"' package.json 2>/dev/null; then
    if npm test >/dev/null 2>&1; then
      TEST_PASS=true
    else
      TEST_PASS=false
      ALL_PASSED=false
    fi
  fi

  # Lint check
  if [ -f "package.json" ] && grep -q '"lint"' package.json 2>/dev/null; then
    if npm run lint >/dev/null 2>&1; then
      LINT_PASS=true
    else
      LINT_PASS=false
      ALL_PASSED=false
    fi
  fi

  VALIDATION_JSON="{\"all_passed\": $ALL_PASSED, \"checks\": [{\"name\":\"types\",\"passed\":$TYPE_PASS},{\"name\":\"tests\",\"passed\":$TEST_PASS},{\"name\":\"lint\",\"passed\":$LINT_PASS}]}"
fi

# --- Evidence artifacts ---
EVIDENCE_COUNT=0
if [ -d ".orchestrator/evidence" ]; then
  EVIDENCE_COUNT="$(find .orchestrator/evidence -type f 2>/dev/null | wc -l | tr -d ' ')"
fi

# --- Build output JSON ---
python3 -c "
import json

metrics = {
    'lines_added': $LINES_ADDED,
    'lines_removed': $LINES_REMOVED,
    'files_changed': $FILES_CHANGED,
    'files_created': $FILES_CREATED,
    'commits': $COMMITS,
    'elapsed_seconds': $ELAPSED,
    'validation': json.loads('''$VALIDATION_JSON'''),
    'evidence_artifacts': $EVIDENCE_COUNT,
    'diff_stat': '''$DIFF_STAT'''
}

print(json.dumps(metrics, indent=2))
" > "$OUTPUT_FILE"
