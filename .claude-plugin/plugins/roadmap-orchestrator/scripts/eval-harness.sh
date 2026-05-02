#!/bin/bash
# eval-harness.sh — Compare vanilla vs orchestrated Claude Code implementations
#
# Usage:
#   eval-harness.sh --feature <feature-id> --roadmap <roadmap.md> [options]
#
# Options:
#   --feature ID       Feature ID (e.g., feature-5)
#   --roadmap PATH     Path to roadmap markdown file
#   --runs N           Number of runs per approach (default: 1)
#   --dry-run          Show what would run without launching sessions
#   --skip-vanilla     Skip vanilla session (re-use existing worktree)
#   --skip-orchestrated Skip orchestrated session
#   --skip-eval        Skip evaluator session
#   --vanilla-budget N  Max USD for vanilla session (default: 5)
#   --orch-budget N     Max USD for orchestrated session (default: 10)
#   --eval-budget N     Max USD for evaluator session (default: 3)

set -euo pipefail

# --- Resolve paths portably ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARED_UTILS="$PLUGIN_DIR/shared-utilities/scripts"

# Fallback: check installed plugin location
if [ ! -f "$SHARED_UTILS/roadmap_ops.py" ]; then
  INSTALLED="$(ls -d ~/.claude/plugins/cache/*/roadmap-orchestrator/*/shared-utilities/scripts 2>/dev/null | tail -1)"
  if [ -n "$INSTALLED" ]; then
    SHARED_UTILS="$INSTALLED"
  fi
fi

ROADMAP_OPS="python3 $SHARED_UTILS/roadmap_ops.py"
COLLECT_METRICS="$SCRIPT_DIR/collect-metrics.sh"

# --- Defaults ---
FEATURE_ID=""
ROADMAP_PATH=""
RUNS=1
DRY_RUN=false
SKIP_VANILLA=false
SKIP_ORCHESTRATED=false
SKIP_EVAL=false
VANILLA_BUDGET=5
ORCH_BUDGET=10
EVAL_BUDGET=3
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# --- Parse args ---
while [ $# -gt 0 ]; do
  case "$1" in
    --feature) FEATURE_ID="$2"; shift 2 ;;
    --roadmap) ROADMAP_PATH="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --skip-vanilla) SKIP_VANILLA=true; shift ;;
    --skip-orchestrated) SKIP_ORCHESTRATED=true; shift ;;
    --skip-eval) SKIP_EVAL=true; shift ;;
    --vanilla-budget) VANILLA_BUDGET="$2"; shift 2 ;;
    --orch-budget) ORCH_BUDGET="$2"; shift 2 ;;
    --eval-budget) EVAL_BUDGET="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Validate ---
if [ -z "$FEATURE_ID" ]; then
  echo "Error: --feature is required" >&2
  exit 1
fi

if [ -z "$ROADMAP_PATH" ]; then
  echo "Error: --roadmap is required" >&2
  exit 1
fi

if [ ! -f "$ROADMAP_PATH" ]; then
  echo "Error: Roadmap file not found: $ROADMAP_PATH" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude CLI not found in PATH" >&2
  exit 1
fi

# --- Extract feature from roadmap ---
echo "=== Parsing feature $FEATURE_ID from $ROADMAP_PATH ==="

FEATURE_JSON="$($ROADMAP_OPS find-feature "$ROADMAP_PATH" "$FEATURE_ID" 2>/dev/null || echo "")"

if [ -z "$FEATURE_JSON" ] || [ "$FEATURE_JSON" = "null" ]; then
  echo "Error: Could not find $FEATURE_ID in $ROADMAP_PATH" >&2
  exit 1
fi

TITLE="$(echo "$FEATURE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title',''))")"
PRIORITY="$(echo "$FEATURE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('priority',''))")"
PERSONA="$(echo "$FEATURE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('persona',''))")"

# Extract DoD items
DOD_JSON="$($ROADMAP_OPS extract-dod "$ROADMAP_PATH" "$FEATURE_ID" 2>/dev/null || echo "[]")"
DOD_ITEMS="$(echo "$DOD_JSON" | python3 -c "
import sys, json
items = json.load(sys.stdin)
for item in items:
    text = item.get('text', item) if isinstance(item, dict) else item
    print(f'- [ ] {text}')
" 2>/dev/null || echo "- [ ] (Could not extract DoD)")"

# Build description from feature JSON
DESCRIPTION="$(echo "$FEATURE_JSON" | python3 -c "
import sys, json
f = json.load(sys.stdin)
parts = []
if f.get('goal'): parts.append(f'Goal: {f[\"goal\"]}')
if f.get('impact'): parts.append(f'Impact: {f[\"impact\"]}')
if f.get('effort'): parts.append(f'Effort: {f[\"effort\"]}')
print('\n'.join(parts) if parts else 'See Definition of Done below.')
")"

echo "  Feature: $TITLE"
echo "  Priority: $PRIORITY"
echo "  Persona: $PERSONA"
echo "  DoD items: $(echo "$DOD_ITEMS" | wc -l | tr -d ' ')"
echo ""

# --- Snapshot baseline ---
BASELINE_SHA="$(git rev-parse HEAD)"
BASELINE_BRANCH="$(git branch --show-current)"
echo "=== Baseline: $BASELINE_SHA on $BASELINE_BRANCH ==="
echo ""

# --- Extract enabled plugin marketplace names for settings override ---
# Reads the project's settings.json to find plugin names to disable
SETTINGS_FILE="$(find . -path '*/claude-config/settings.json' -print -quit 2>/dev/null || true)"
DISABLED_PLUGINS='{}'
if [ -n "$SETTINGS_FILE" ]; then
  DISABLED_PLUGINS="$(python3 -c "
import json, sys
with open('$SETTINGS_FILE') as f:
    s = json.load(f)
plugins = s.get('enabledPlugins', {})
# Disable orchestrator and workflow-improver, keep everything else
overrides = {}
for k, v in plugins.items():
    if 'roadmap-orchestrator' in k or 'workflow-improver' in k:
        overrides[k] = False
    else:
        overrides[k] = v
print(json.dumps(overrides))
" 2>/dev/null || echo '{}')"
fi

# Build vanilla settings override JSON
VANILLA_SETTINGS="$(python3 -c "
import json
settings = {
    'enabledPlugins': json.loads('''$DISABLED_PLUGINS'''),
    'hooks': {}
}
print(json.dumps(settings))
" 2>/dev/null || echo '{"hooks":{}}')"

# --- Build vanilla prompt ---
VANILLA_PROMPT="$(cat <<PROMPT_EOF
You are implementing a feature for this project.

## Feature: $TITLE
$DESCRIPTION

## Definition of Done
$DOD_ITEMS

## Persona
$PERSONA

## Instructions
1. Explore the codebase to understand the existing architecture
2. Plan your implementation approach
3. Write tests that encode the Definition of Done
4. Implement the feature
5. Ensure all tests pass, types check, and lint passes
6. Create atomic commits with clear messages

Do NOT use any slash commands or orchestration workflows.
PROMPT_EOF
)"

# --- Build orchestrated prompt ---
ORCH_PROMPT="/roadmap work — implement $FEATURE_ID: $TITLE"

# --- Report directory ---
REPORT_DIR=".orchestrator/eval-reports"
mkdir -p "$REPORT_DIR"

# --- Dry run ---
if [ "$DRY_RUN" = true ]; then
  echo "=== DRY RUN — would execute the following ==="
  echo ""
  echo "--- Vanilla Session ---"
  echo "  Worktree: eval-vanilla-${FEATURE_ID}"
  echo "  Budget: \$${VANILLA_BUDGET}"
  echo "  Model: opus"
  echo "  Settings override: plugins disabled, hooks cleared"
  echo "  Prompt:"
  echo "$VANILLA_PROMPT" | sed 's/^/    /'
  echo ""
  echo "--- Orchestrated Session ---"
  echo "  Worktree: eval-orchestrated-${FEATURE_ID}"
  echo "  Budget: \$${ORCH_BUDGET}"
  echo "  Model: opus"
  echo "  Settings: default (orchestrator enabled)"
  echo "  Prompt: $ORCH_PROMPT"
  echo ""
  echo "--- Evaluator Session ---"
  echo "  Budget: \$${EVAL_BUDGET}"
  echo "  Model: opus"
  echo "  Input: diffs + metrics from both sessions"
  echo ""
  echo "--- Reports ---"
  echo "  $REPORT_DIR/${FEATURE_ID}-${TIMESTAMP}.md"
  echo "  $REPORT_DIR/${FEATURE_ID}-${TIMESTAMP}.json"
  echo ""
  echo "Estimated total cost: ~\$$(( VANILLA_BUDGET + ORCH_BUDGET + EVAL_BUDGET )) (budget caps)"
  exit 0
fi

# --- Run sessions ---
run_session() {
  local LABEL="$1"
  local WORKTREE_NAME="$2"
  local BUDGET="$3"
  local PROMPT="$4"
  local SETTINGS_OVERRIDE="${5:-}"
  local RUN_NUM="${6:-1}"

  local WORKTREE_SUFFIX=""
  if [ "$RUNS" -gt 1 ]; then
    WORKTREE_SUFFIX="-run-${RUN_NUM}"
  fi
  local WT_NAME="${WORKTREE_NAME}${WORKTREE_SUFFIX}"

  echo "=== Running $LABEL session (run $RUN_NUM/$RUNS) ==="
  echo "  Worktree: $WT_NAME"
  echo "  Budget: \$${BUDGET}"
  echo ""

  local CMD=(
    claude --print
    --worktree "$WT_NAME"
    --model opus
    --permission-mode auto
    --max-budget-usd "$BUDGET"
    --output-format json
  )

  if [ -n "$SETTINGS_OVERRIDE" ]; then
    CMD+=(--settings "$SETTINGS_OVERRIDE")
  fi

  CMD+=(-p "$PROMPT")

  local SESSION_OUTPUT
  local SESSION_START
  SESSION_START="$(date +%s)"

  SESSION_OUTPUT="$("${CMD[@]}" 2>&1)" || true

  local SESSION_END
  SESSION_END="$(date +%s)"
  local ELAPSED=$(( SESSION_END - SESSION_START ))

  # Save session output
  local OUTPUT_FILE="$REPORT_DIR/${FEATURE_ID}-${LABEL}${WORKTREE_SUFFIX}-session.json"
  echo "$SESSION_OUTPUT" > "$OUTPUT_FILE"

  echo "  Completed in ${ELAPSED}s"
  echo "  Output saved to $OUTPUT_FILE"
  echo ""

  # Find the worktree path
  local WT_PATH
  WT_PATH="$(git worktree list --porcelain | grep -A1 "worktree.*$WT_NAME" | grep 'worktree ' | head -1 | sed 's/worktree //' || true)"

  if [ -z "$WT_PATH" ]; then
    echo "  Warning: Could not find worktree $WT_NAME" >&2
    return 1
  fi

  # Collect metrics
  echo "  Collecting metrics..."
  local METRICS_FILE="$REPORT_DIR/${FEATURE_ID}-${LABEL}${WORKTREE_SUFFIX}-metrics.json"
  bash "$COLLECT_METRICS" "$WT_PATH" "$METRICS_FILE" "$ELAPSED"
  echo "  Metrics saved to $METRICS_FILE"
  echo ""
}

# Run for each run count
for RUN in $(seq 1 "$RUNS"); do
  # Vanilla session
  if [ "$SKIP_VANILLA" = false ]; then
    run_session "vanilla" "eval-vanilla-${FEATURE_ID}" "$VANILLA_BUDGET" "$VANILLA_PROMPT" "$VANILLA_SETTINGS" "$RUN"
  else
    echo "=== Skipping vanilla session ==="
    echo ""
  fi

  # Orchestrated session
  if [ "$SKIP_ORCHESTRATED" = false ]; then
    run_session "orchestrated" "eval-orchestrated-${FEATURE_ID}" "$ORCH_BUDGET" "$ORCH_PROMPT" "" "$RUN"
  else
    echo "=== Skipping orchestrated session ==="
    echo ""
  fi
done

# --- Create PRs ---
echo "=== Creating PRs ==="

create_pr_if_worktree() {
  local LABEL="$1"
  local WT_PATTERN="$2"

  local WT_PATH
  WT_PATH="$(git worktree list --porcelain | grep -A1 "worktree.*$WT_PATTERN" | grep 'worktree ' | head -1 | sed 's/worktree //' || true)"

  if [ -z "$WT_PATH" ]; then
    echo "  No worktree found for $WT_PATTERN, skipping PR"
    return
  fi

  local BRANCH
  BRANCH="$(cd "$WT_PATH" && git branch --show-current)"

  if [ -z "$BRANCH" ]; then
    echo "  No branch in worktree $WT_PATH, skipping PR"
    return
  fi

  # Check if there are any commits beyond baseline
  local COMMIT_COUNT
  COMMIT_COUNT="$(cd "$WT_PATH" && git rev-list "$BASELINE_SHA..HEAD" --count 2>/dev/null || echo "0")"

  if [ "$COMMIT_COUNT" = "0" ]; then
    echo "  No commits in $LABEL, skipping PR"
    return
  fi

  echo "  Creating PR for $LABEL ($BRANCH, $COMMIT_COUNT commits)..."
  (cd "$WT_PATH" && git push -u origin "$BRANCH" 2>/dev/null) || true

  local PR_URL
  PR_URL="$(cd "$WT_PATH" && gh pr create \
    --base "$BASELINE_BRANCH" \
    --head "$BRANCH" \
    --title "EVAL: $TITLE ($LABEL)" \
    --body "$(cat <<PR_EOF
## Evaluation: $LABEL implementation of $FEATURE_ID

**Feature**: $TITLE
**Approach**: $LABEL
**Baseline**: $BASELINE_SHA
**Commits**: $COMMIT_COUNT

This PR was created by the evaluation harness for comparison purposes.
Do NOT merge — close after review.
PR_EOF
)" 2>&1)" || true

  echo "  $LABEL PR: $PR_URL"
}

if [ "$SKIP_VANILLA" = false ]; then
  create_pr_if_worktree "vanilla" "eval-vanilla-${FEATURE_ID}"
fi
if [ "$SKIP_ORCHESTRATED" = false ]; then
  create_pr_if_worktree "orchestrated" "eval-orchestrated-${FEATURE_ID}"
fi
echo ""

# --- Run evaluator ---
if [ "$SKIP_EVAL" = false ]; then
  echo "=== Running evaluator session ==="

  # Collect diffs and metrics for the evaluator
  VANILLA_DIFF=""
  VANILLA_METRICS=""
  ORCH_DIFF=""
  ORCH_METRICS=""

  for LABEL in vanilla orchestrated; do
    WT_PATTERN="eval-${LABEL}-${FEATURE_ID}"
    WT_PATH="$(git worktree list --porcelain | grep -A1 "worktree.*$WT_PATTERN" | grep 'worktree ' | head -1 | sed 's/worktree //' || true)"

    if [ -n "$WT_PATH" ]; then
      DIFF="$(cd "$WT_PATH" && git diff "$BASELINE_SHA"..HEAD 2>/dev/null || echo "(no diff)")"
      METRICS_FILE="$REPORT_DIR/${FEATURE_ID}-${LABEL}-metrics.json"
      METRICS="$(cat "$METRICS_FILE" 2>/dev/null || echo "{}")"

      if [ "$LABEL" = "vanilla" ]; then
        VANILLA_DIFF="$DIFF"
        VANILLA_METRICS="$METRICS"
      else
        ORCH_DIFF="$DIFF"
        ORCH_METRICS="$METRICS"
      fi
    fi
  done

  # Build evaluator prompt from template
  EVALUATOR_TEMPLATE="$SCRIPT_DIR/evaluator-prompt.md"

  if [ ! -f "$EVALUATOR_TEMPLATE" ]; then
    echo "Error: Evaluator prompt template not found: $EVALUATOR_TEMPLATE" >&2
    exit 1
  fi

  # Use python3 for safe template substitution
  EVALUATOR_PROMPT="$(python3 -c "
import sys

template = open('$EVALUATOR_TEMPLATE').read()

replacements = {
    '\${TITLE}': '''$TITLE''',
    '\${FEATURE_ID}': '''$FEATURE_ID''',
    '\${DESCRIPTION}': '''$DESCRIPTION''',
    '\${DOD_ITEMS}': '''$DOD_ITEMS''',
    '\${PERSONA}': '''$PERSONA''',
    '\${VANILLA_DIFF}': '''$(echo "$VANILLA_DIFF" | head -500)''',
    '\${VANILLA_METRICS}': '''$VANILLA_METRICS''',
    '\${ORCH_DIFF}': '''$(echo "$ORCH_DIFF" | head -500)''',
    '\${ORCH_METRICS}': '''$ORCH_METRICS''',
}

result = template
for k, v in replacements.items():
    result = result.replace(k, v)

print(result)
" 2>/dev/null || cat "$EVALUATOR_TEMPLATE")"

  EVAL_OUTPUT="$(claude --print \
    --model opus \
    --permission-mode auto \
    --max-budget-usd "$EVAL_BUDGET" \
    --output-format json \
    -p "$EVALUATOR_PROMPT" 2>&1)" || true

  echo "$EVAL_OUTPUT" > "$REPORT_DIR/${FEATURE_ID}-${TIMESTAMP}-eval-session.json"

  # Extract the evaluator's text response for the report
  EVAL_TEXT="$(echo "$EVAL_OUTPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    # Handle various output formats
    if isinstance(data, dict):
        print(data.get('result', data.get('text', data.get('content', json.dumps(data, indent=2)))))
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and item.get('type') == 'text':
                print(item.get('text', ''))
    else:
        print(str(data))
except:
    print(sys.stdin.read())
" 2>/dev/null || echo "$EVAL_OUTPUT")"

  # Write markdown report
  cat > "$REPORT_DIR/${FEATURE_ID}-${TIMESTAMP}.md" <<REPORT_EOF
# Evaluation Report: $TITLE ($FEATURE_ID)

**Date**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Baseline**: $BASELINE_SHA on $BASELINE_BRANCH
**Runs**: $RUNS

## Feature
$DESCRIPTION

## Definition of Done
$DOD_ITEMS

## Vanilla Metrics
\`\`\`json
$VANILLA_METRICS
\`\`\`

## Orchestrated Metrics
\`\`\`json
$ORCH_METRICS
\`\`\`

## Evaluator Analysis

$EVAL_TEXT
REPORT_EOF

  echo "  Report: $REPORT_DIR/${FEATURE_ID}-${TIMESTAMP}.md"
  echo ""
else
  echo "=== Skipping evaluator session ==="
  echo ""
fi

# --- Emit OTEL if available ---
OTEL_SCRIPT="$SCRIPT_DIR/emit_otel.py"
if [ -f "$OTEL_SCRIPT" ]; then
  python3 "$OTEL_SCRIPT" \
    --event "eval.comparison.complete" \
    --attributes "{\"feature_id\":\"$FEATURE_ID\",\"runs\":$RUNS,\"timestamp\":\"$TIMESTAMP\"}" \
    2>/dev/null || true
fi

echo "=== Evaluation complete ==="
echo "  Reports: $REPORT_DIR/${FEATURE_ID}-${TIMESTAMP}.*"
echo "  Total estimated cost: \$$(( VANILLA_BUDGET + ORCH_BUDGET + EVAL_BUDGET )) (budget caps)"
