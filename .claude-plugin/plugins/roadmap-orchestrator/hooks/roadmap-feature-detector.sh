#!/bin/bash
# roadmap-feature-detector.sh — UserPromptSubmit hook
#
# Two-stage detection: fast regex rejection, then roadmap correlation.
# Receives JSON on stdin with "user_prompt" field.
# Outputs JSON: {} (allow) or {"decision":"warn","reason":"..."} (nudge).
#
# Stage 1: Fast regex rejects non-feature prompts (<10ms)
# Stage 1b: Positive signal detection (feature IDs, roadmap terms, impl verbs)
# Stage 2: Roadmap correlation (only on positive signal)

set -euo pipefail

# Read stdin JSON
INPUT="$(cat)"
PROMPT="$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_prompt',''))" 2>/dev/null || echo "")"

# Empty prompt — allow
if [ -z "$PROMPT" ]; then
  echo '{}'
  exit 0
fi

# --- Stage 1: Fast rejection ---

PROMPT_LOWER="$(echo "$PROMPT" | tr '[:upper:]' '[:lower:]')"
PROMPT_LEN="${#PROMPT}"

# Too short to be a feature request
if [ "$PROMPT_LEN" -lt 30 ]; then
  echo '{}'
  exit 0
fi

# Slash commands — already invoking a skill
if echo "$PROMPT" | grep -qE '^\s*/'; then
  echo '{}'
  exit 0
fi

# Explicit bypass prefix
if echo "$PROMPT_LOWER" | grep -qE '^\s*quick:'; then
  echo '{}'
  exit 0
fi

# Question words — exploratory, not implementation
if echo "$PROMPT_LOWER" | grep -qE '^\s*(what|how|why|where|when|explain|describe|show|tell|can you|does|is there|are there|do you|could you explain|help me understand)'; then
  echo '{}'
  exit 0
fi

# Bug/debug work
if echo "$PROMPT_LOWER" | grep -qE '^\s*(fix|debug|investigate|diagnose|troubleshoot)'; then
  echo '{}'
  exit 0
fi

# Pure refactoring (without "feature")
if echo "$PROMPT_LOWER" | grep -qE '^\s*(refactor|clean up|reorganize|simplify)' && ! echo "$PROMPT_LOWER" | grep -q 'feature'; then
  echo '{}'
  exit 0
fi

# Documentation tasks
if echo "$PROMPT_LOWER" | grep -qE '^\s*(update docs|add comments|write readme|document|add documentation)'; then
  echo '{}'
  exit 0
fi

# Housekeeping
if echo "$PROMPT_LOWER" | grep -qE '^\s*(rename|move|delete|remove|revert|undo|rollback)'; then
  echo '{}'
  exit 0
fi

# --- Stage 1b: Positive signal detection ---

HAS_POSITIVE=false
SIGNAL_TYPE=""

# Feature ID reference: feature-5, Feature 5, feature 12, etc.
if echo "$PROMPT" | grep -qEi 'feature[- ][0-9]+'; then
  HAS_POSITIVE=true
  SIGNAL_TYPE="feature_id"
fi

# Roadmap mention
if echo "$PROMPT_LOWER" | grep -qE '(roadmap|priority:|dod|definition of done)'; then
  HAS_POSITIVE=true
  SIGNAL_TYPE="roadmap_ref"
fi

# Implementation verb + substantial scope (>60 chars with substantial noun)
if [ "$PROMPT_LEN" -gt 60 ]; then
  if echo "$PROMPT_LOWER" | grep -qE '(implement|build|create|develop|add)\s+.{10,}(feature|capability|system|interface|workflow|service|module|component|endpoint|page)'; then
    HAS_POSITIVE=true
    SIGNAL_TYPE="impl_verb"
  fi
fi

# No positive signal — allow
if [ "$HAS_POSITIVE" = false ]; then
  echo '{}'
  exit 0
fi

# --- Stage 2: Roadmap correlation ---

# Locate roadmap file in project root
ROADMAP_FILE="$(find . -maxdepth 1 -iname '*roadmap*.md' -print -quit 2>/dev/null || true)"

# Resolve shared-utilities roadmap_ops.py portably
PLUGIN_SHARED="$(dirname "$(dirname "$0")")/shared-utilities/scripts/roadmap_ops.py"
ROADMAP_OPS=""
if [ -f "$PLUGIN_SHARED" ]; then
  ROADMAP_OPS="$PLUGIN_SHARED"
fi

MATCHED_FEATURE=""

if [ -n "$ROADMAP_FILE" ] && [ -n "$ROADMAP_OPS" ]; then
  # Try to match prompt against current priority features
  FEATURES_JSON="$(python3 "$ROADMAP_OPS" list-features "$ROADMAP_FILE" --priority=now 2>/dev/null || echo "[]")"

  if [ "$FEATURES_JSON" != "[]" ] && [ -n "$FEATURES_JSON" ]; then
    # Check word overlap between prompt and feature titles
    MATCHED_FEATURE="$(python3 -c "
import sys, json, re

prompt = '''$PROMPT'''.lower()
prompt_words = set(re.findall(r'[a-z]{3,}', prompt))

try:
    features = json.loads('''$FEATURES_JSON''')
except:
    sys.exit(0)

best_match = None
best_overlap = 0.0

for f in features:
    title = f.get('title', '').lower()
    title_words = set(re.findall(r'[a-z]{3,}', title))
    if not title_words:
        continue
    overlap = len(prompt_words & title_words) / len(title_words)
    if overlap > best_overlap and overlap > 0.5:
        best_overlap = overlap
        best_match = f

if best_match:
    fid = best_match.get('id', '')
    ftitle = best_match.get('title', '')
    print(f'{ftitle} ({fid})')
" 2>/dev/null || echo "")"
  fi
fi

# Build warning message
if [ -n "$MATCHED_FEATURE" ]; then
  REASON="Matches roadmap feature: ${MATCHED_FEATURE}. Consider /roadmap work for orchestrated planning, validation, and evidence collection. Prefix with quick: to skip."
elif [ "$SIGNAL_TYPE" = "feature_id" ]; then
  REASON="Feature ID detected in prompt. Consider /roadmap work for orchestrated planning, validation, and evidence collection. Prefix with quick: to skip."
elif [ "$SIGNAL_TYPE" = "roadmap_ref" ]; then
  REASON="Roadmap reference detected. Consider /roadmap work for orchestrated planning, validation, and evidence collection. Prefix with quick: to skip."
else
  REASON="This looks like a substantial implementation task. Consider /roadmap work for orchestrated planning, validation, and evidence collection. Prefix with quick: to skip."
fi

# Output warn decision
python3 -c "
import json
print(json.dumps({
    'decision': 'warn',
    'reason': $(python3 -c "import json; print(json.dumps('''$REASON'''))")
}))
" 2>/dev/null || echo "{\"decision\":\"warn\",\"reason\":\"Consider /roadmap work for orchestrated planning. Prefix with quick: to skip.\"}"
