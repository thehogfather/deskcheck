---
name: roadmap-utilities
description: |
  Standardized utilities for roadmap operations. Use these utilities instead of ad-hoc grep, awk, or sed commands when parsing or updating roadmap markdown files.
---

# Roadmap Utilities

Consistent, reusable operations for working with roadmap markdown files.

## Why Use These Utilities

**Never use ad-hoc commands like:**
- `grep -E "^### Feature"`
- `sed 's/- \[ \]/- [x]/'`
- `awk '/Definition of done/{...}'`

**Always use these utilities instead:**
```bash
python3 ~/.claude/plugins/local/shared-utilities/scripts/roadmap_ops.py <command>
```

## Commands

### find-feature

Get detailed information about a specific feature:

```bash
python3 ~/.../roadmap_ops.py find-feature ./roadmap.md 25
# or
python3 ~/.../roadmap_ops.py find-feature ./roadmap.md feature-25
```

Returns JSON with:
- Feature ID and title
- Priority level
- Persona, goal, impact, effort metadata
- All DoD tasks with completion status
- Progress percentage

### update-checkbox

Update a task's completion status:

```bash
python3 ~/.../roadmap_ops.py update-checkbox ./roadmap.md "Implement auth flow" done
python3 ~/.../roadmap_ops.py update-checkbox ./roadmap.md "Add unit tests" undone
```

**Important**: Task text must match exactly (case-insensitive).

### calculate-progress

Get progress for a feature or entire roadmap:

```bash
# Single feature
python3 ~/.../roadmap_ops.py calculate-progress ./roadmap.md feature-25

# Entire roadmap
python3 ~/.../roadmap_ops.py calculate-progress ./roadmap.md
```

Returns:
- Total and completed task counts
- Progress percentage
- Breakdown by priority level

### list-features

List all features, optionally filtered by priority:

```bash
# All features
python3 ~/.../roadmap_ops.py list-features ./roadmap.md

# Only "now" priority
python3 ~/.../roadmap_ops.py list-features ./roadmap.md --priority=now
```

### extract-dod

Get just the Definition of Done tasks for a feature:

```bash
python3 ~/.../roadmap_ops.py extract-dod ./roadmap.md feature-25
```

## Integration with Orchestrator

The roadmap-orchestrator should use these utilities in its workflow:

1. **Before starting work**: `calculate-progress` to establish baseline
2. **After completing each task**: `update-checkbox` immediately
3. **Before checkpoint**: `calculate-progress` to verify completion
4. **For status checks**: `list-features --priority=now` to find next work

## Example Workflow

```bash
# Before starting
python3 ~/.../roadmap_ops.py calculate-progress ./roadmap.md feature-25
# Output: {"progress_percent": 50.0, "done_tasks": 3, "total_tasks": 6}

# After completing a task
python3 ~/.../roadmap_ops.py update-checkbox ./roadmap.md "Create circuit breaker" done
# Output: {"success": true, "task": "Create circuit breaker", "done": true}

# Verify update
python3 ~/.../roadmap_ops.py calculate-progress ./roadmap.md feature-25
# Output: {"progress_percent": 66.7, "done_tasks": 4, "total_tasks": 6}
```
