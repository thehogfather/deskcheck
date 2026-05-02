---
name: evidence-utilities
description: |
  Standardized utilities for evidence collection and validation. Ensures consistent evidence structure across all feature implementations.
---

# Evidence Utilities

Consistent evidence collection and validation for feature implementations.

## Required Evidence Structure

Every feature must have:
```
.orchestrator/evidence/{feature-id}/
├── test-results.md    # Required: Test execution output
├── validation.md      # Required: DoD verification matrix
└── screenshots/       # Optional: Playwright captures for UI work
```

## Commands

### init

Initialize evidence directory for a feature:

```bash
python3 ~/.../evidence_ops.py init feature-25
```

Creates:
- `evidence/feature-25/` directory
- `test-results.md` template
- `validation.md` template
- `screenshots/` directory

### validate

Check that required evidence exists and is complete:

```bash
python3 ~/.../evidence_ops.py validate feature-25
```

Returns:
- `validation_passed`: true/false
- `missing_required`: list of missing or incomplete files
- `items`: details about each evidence item

**Important**: Templates with placeholder text are flagged as incomplete.

### collect-tests

Run tests and capture output to evidence:

```bash
python3 ~/.../evidence_ops.py collect-tests feature-25
python3 ~/.../evidence_ops.py collect-tests feature-25 --test-command="npm run test:run"
```

- Runs the test command
- Captures stdout/stderr
- Parses test metrics (passed, failed, duration)
- Writes formatted results to `test-results.md`

### summary

Generate a summary of evidence status:

```bash
python3 ~/.../evidence_ops.py summary feature-25
```

## Integration with Orchestrator

1. **At feature start**: `init` to create evidence structure
2. **After implementation**: `collect-tests` to capture test results
3. **Before checkpoint**: `validate` to ensure evidence is complete
4. **At approval**: Evidence must pass validation

## Workflow Example

```bash
# Start of feature work
python3 ~/.../evidence_ops.py init feature-25

# After completing implementation
python3 ~/.../evidence_ops.py collect-tests feature-25

# Before evidence approval checkpoint
python3 ~/.../evidence_ops.py validate feature-25
# Must return: {"validation_passed": true, ...}

# Summary for checkpoint presentation
python3 ~/.../evidence_ops.py summary feature-25
```

## What Makes Evidence "Complete"

- **test-results.md**: Must have actual test output (not template placeholder)
- **validation.md**: Must have DoD items filled in (not "(to be filled)")
- **screenshots/**: Required for UI work, checked if files present
