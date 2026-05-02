---
name: validation-utilities
description: |
  Pre-commit validation utilities. Run type checking, tests, and linting before commits to ensure code quality.
---

# Validation Utilities

Automated pre-commit validation for type checking, testing, and linting.

## Why Pre-Commit Validation Matters

**Commits should never happen with:**
- TypeScript errors
- Failing tests
- Lint violations

These utilities ensure all checks pass before committing.

## Commands

### type-check

Run TypeScript type checking:

```bash
python3 ~/.../validation_ops.py type-check
python3 ~/.../validation_ops.py type-check --project-dir=/path/to/project
```

Auto-detects TypeScript projects and runs `npx tsc --noEmit`.

### test-check

Run project tests:

```bash
python3 ~/.../validation_ops.py test-check
python3 ~/.../validation_ops.py test-check --test-command="npm run test:run"
```

Auto-detects test framework from package.json.

### lint-check

Run linter:

```bash
python3 ~/.../validation_ops.py lint-check
python3 ~/.../validation_ops.py lint-check --lint-command="npm run lint"
```

Auto-detects lint command from package.json.

### full-check

Run all validations at once:

```bash
python3 ~/.../validation_ops.py full-check
python3 ~/.../validation_ops.py full-check --project-dir=/path/to/project
```

Returns combined results:
```json
{
  "all_passed": true,
  "checks": [...],
  "summary": {
    "total_checks": 3,
    "passed_checks": 3,
    "failed_checks": 0,
    "total_errors": 0
  }
}
```

## Integration with Hooks

The enhanced hooks use `full-check` to block commits:

```json
{
  "event": "PreToolUse",
  "type": "command",
  "command": "python3 ~/.../validation_ops.py full-check",
  "triggers": [{"toolName": "Bash", "inputMatches": "git commit"}],
  "rules": [
    {"if": "outputContains", "value": "\"all_passed\": false", "then": "block"}
  ]
}
```

## Pre-Commit Workflow

**Before every commit:**

```bash
# Run full validation
python3 ~/.../validation_ops.py full-check

# Only proceed if all pass
if [ $? -eq 0 ]; then
    git add . && git commit -m "..."
fi
```

## Exit Codes

- `0`: All checks passed
- `1`: One or more checks failed

Hooks can use exit codes for blocking decisions.
