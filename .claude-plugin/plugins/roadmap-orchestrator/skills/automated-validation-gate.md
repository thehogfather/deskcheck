---
name: automated-validation-gate
description: |
  Automated pass/fail gate for orchestrated workflows. Replaces human checkpoints with deterministic validation. All acceptance tests must pass, full validation must succeed, and evidence must be complete.
---

# Automated Validation Gate

## Overview

This skill defines the automated pass/fail gate that replaces human approval checkpoints. The gate is deterministic: if all checks pass, the task proceeds. If any check fails, the orchestrator retries. After 3 failures, the task aborts.

**No human interaction.** No `AskUserQuestion`. No escalation. Pass or fail.

---

## Pass Criteria

**ALL of the following must be true:**

| # | Check | Command | Required Result |
|---|-------|---------|----------------|
| 1 | Full validation | `$VALIDATION_OPS full-check` | `{"all_passed": true}` |
| 2 | Acceptance tests | Run acceptance test files | All pass |
| 3 | Evidence complete | `$EVIDENCE_OPS validate [feature-id]` | `{"valid": true}` |
| 4 | Screenshots | Check evidence dir | Exist if frontend work detected |

```bash
VALIDATION_OPS="python3 ~/.claude/plugins/local/shared-utilities/scripts/validation_ops.py"
EVIDENCE_OPS="python3 ~/.claude/plugins/local/shared-utilities/scripts/evidence_ops.py"
```

---

## Validation Sequence

### Step 1: Run Full Validation

```bash
$VALIDATION_OPS full-check

# Returns JSON:
# {
#   "all_passed": true/false,
#   "checks": [
#     {"name": "type_check", "passed": true, "output": "..."},
#     {"name": "test_check", "passed": true, "output": "..."},
#     {"name": "lint_check", "passed": true, "output": "..."}
#   ],
#   "summary": {"passed": 3, "failed": 0, "total": 3}
# }
```

### Step 2: Run Acceptance Tests

```bash
# Run ONLY the acceptance test files (paths from parent task description via TaskGet)
npm run test -- --testPathPattern="[acceptance-test-files]"
# or:
uv run pytest [acceptance-test-file-paths] --tb=short -q
```

### Step 3: Validate Evidence

```bash
$EVIDENCE_OPS validate [feature-id]

# Returns JSON:
# {"valid": true/false, "missing": [], "incomplete": [], "files": [...]}
```

### Step 4: Check Screenshots (conditional)

Only required if frontend work was detected (via `frontend-detection` skill):

```bash
ls .orchestrator/evidence/[feature-id]/screenshots/
# Must be non-empty if frontend work detected
```

---

## Decision Logic

```
ALL checks pass?
  ├── YES → PASS: proceed to Phase 6 (Architecture Update + Completion)
  └── NO → FAIL: log failures, return to Phase 4
                  ├── retry_count < MAX_VALIDATION_RETRIES → fix and re-validate
                  └── retry_count >= MAX_VALIDATION_RETRIES → ABORT task
```

---

## On Failure

When any check fails:

1. **Append failure details to Phase 5 task description** (via `TaskUpdate`):
   ```
   Validation Gate - Attempt [N]: FAIL
   - [Check name]: [Specific failure details]
   - [Check name]: [Specific failure details]
   ```

2. **Return to implementation (Phase 4)**:
   - Fix the specific failures identified
   - Run targeted acceptance tests during implementation
   - Do NOT run full validation again until returning to Phase 5

3. **Track retry count** in Phase 5 task description (appended per attempt)

---

## On Abort (After MAX_VALIDATION_RETRIES Failures)

After `MAX_VALIDATION_RETRIES` failed validation attempts:

1. **Commit evidence of failures**:
   ```bash
   git add .orchestrator/evidence/[feature-id]/
   git commit -m "chore: add failure evidence for [feature-id]

   Validation gate failed after MAX_VALIDATION_RETRIES attempts.
   Failures: [summary]"
   ```

2. **Mark Phase 5 task as `completed`** with failure summary in description

3. **Emit failure event**:
   ```bash
   python3 emit_otel.py task.end \
     --attr task_id=[id] \
     --attr status=failed \
     --attr reason="validation_failed_after_max_retries" \
     --attr failures=[summary]
   ```

4. **Do NOT**:
   - Use `AskUserQuestion` to escalate
   - Attempt a 4th retry
   - Skip failing checks
   - Mark the task as complete

The task simply fails. The git history preserves the evidence.

---

## On Pass

When all checks pass:

1. **Commit evidence artifacts**:
   ```bash
   git add .orchestrator/evidence/[feature-id]/
   git commit -m "chore: add validation evidence for [feature-id]

   All acceptance tests pass.
   Full validation: all_passed=true
   Evidence validated: valid=true"
   ```

2. **Emit success events**:
   ```bash
   python3 emit_otel.py validation_gate.passed \
     --attr feature_id=[feature-id] \
     --attr retry_count=[0-MAX_VALIDATION_RETRIES]
   python3 emit_otel.py evidence.collected --attr type=test_results
   python3 emit_otel.py evidence.collected --attr type=validation
   ```

3. **Proceed to Phase 6** (Architecture Update + Completion)

---

## Integration with Orchestrator

The orchestrator calls this gate at Phase 5. The gate:
- Is fully automated — no user interaction
- Returns a clear pass/fail with details
- Handles its own retry logic (returning to Phase 4 on failure)
- Commits evidence regardless of outcome (pass or abort)

---

## Comparison with Previous Checkpoint Protocol

| Aspect | Old (checkpoint-protocol) | New (automated-validation-gate) |
|--------|--------------------------|-------------------------------|
| Decision maker | Human via AskUserQuestion | Automated checks |
| Blocking | Waits indefinitely for user | Immediate pass/fail |
| Retry | Unlimited with user guidance | Maximum `MAX_VALIDATION_RETRIES` attempts |
| On failure | User decides next step | Auto-retry, then abort |
| Audit trail | Status.md notes | Git commits + OTEL events |
| Evidence | Presented to user | Committed to git |
