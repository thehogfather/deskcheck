---
name: test-validation
description: |
  Integration with testing infrastructure for automated test validation. Use before evidence approval checkpoint to verify implementation meets Definition of Done.
---

# Test Validation Skill

## Overview

This skill provides patterns for:
- Running automated tests
- Collecting test evidence
- Validating against Definition of Done
- Preparing for evidence approval checkpoint

**Important**: All evidence should be stored in feature-scoped directories:
- `.orchestrator/evidence/[feature-id]/test-results.md`
- `.orchestrator/evidence/[feature-id]/validation.md`
- `.orchestrator/evidence/[feature-id]/screenshots/`

Extract the feature ID from the task context (e.g., "Feature 25" → `feature-25`).

## Using Standardized Utilities

**IMPORTANT**: Always use the utilities from the shared-utilities plugin for validation instead of ad-hoc commands.

```bash
VALIDATION_OPS="python3 ~/.claude/plugins/local/shared-utilities/scripts/validation_ops.py"
EVIDENCE_OPS="python3 ~/.claude/plugins/local/shared-utilities/scripts/evidence_ops.py"
```

## Test Execution Strategy

Different phases of the orchestrator use different test execution strategies:

### During Implementation (Phase 4): Targeted Execution

Run **ONLY the acceptance test files** for fast feedback. Do NOT run the full suite.

```bash
# Node/TypeScript — run just the acceptance tests
npm run test -- --testPathPattern="[acceptance-test-files]"

# Python — run just the acceptance test files
uv run pytest [acceptance-test-file-paths] --tb=short -q
```

The acceptance test file paths are recorded in the parent orchestration task description during Phase 3 (retrieve via `TaskGet`). Use those paths for targeted execution after each change.

**Why targeted?** Full validation includes type-check + ALL tests + lint. During active implementation, this is slow and most failures will be in unrelated code. Running only acceptance tests gives fast signal on whether the criteria are being met.

### At Validation Gate (Phase 5): Full Validation

Run the **complete validation suite** exactly ONCE:

```bash
$VALIDATION_OPS full-check  # type-check + ALL tests + lint
```

This catches any regressions or side effects that targeted testing missed.

### Pre-commit Hooks

Type-check and lint hooks are fast — keep them active. Full test suite in `block-commit-on-test-failure.json` is the bottleneck. During orchestrated workflows, the orchestrator manages test execution directly — acceptance test paths are stored in the parent orchestration task description.

## Pre-Completion Verification Flow

```
Implementation Complete (all acceptance tests pass)
        ↓
   Full Validation ($VALIDATION_OPS full-check)
        ↓
Collect Evidence ($EVIDENCE_OPS collect-tests)
        ↓
Validate DoD ($EVIDENCE_OPS validate)
        ↓
Automated Validation Gate (pass/fail)
```

## Test Determinism Requirements

**All tests must be deterministic.** A test that can pass on one run and fail on another with no code changes is a broken test.

### Prohibited: Live LLM API Calls in Tests

Tests must NEVER make live calls to LLM APIs (OpenAI, Anthropic, etc.). LLM responses are non-deterministic — even with temperature=0, outputs can vary across model versions, API changes, and rate limits. This makes tests flaky and validation gates unreliable.

### How to Test LLM-Adjacent Code

| What to test | How to test it |
|-------------|---------------|
| Prompt construction | Unit test — assert the built prompt string matches expected shape |
| Response parsing | Unit test — feed fixed JSON/text, assert parsed output |
| Error handling (timeout, 429, 500) | Unit test — mock error responses, assert retry/fallback behavior |
| Token counting / truncation | Unit test — fixed input strings, assert counts |
| End-to-end flow with LLM | Integration test — mock the LLM client, return canned response, assert downstream behavior |
| "AI produces good output" | **Not testable deterministically** — test the contract (schema validation, required fields) not the content |

### Red Flags in Test Files

When reviewing generated tests, reject any that:
- Import and instantiate a real LLM client without mocking
- Contain API keys or reference environment variables for LLM services
- Assert on natural language content that could vary (e.g., `expect(result).toContain("helpful")`)
- Use `retry` or `eventually` wrappers to handle non-deterministic results
- Have comments like "may flake" or "LLM-dependent"

---

## Running All Validations

### Recommended: Full Check

```bash
# Run type check + tests + lint in one command
$VALIDATION_OPS full-check

# Returns JSON:
# {
#   "all_passed": true,
#   "checks": [
#     {"name": "type_check", "passed": true, "output": "..."},
#     {"name": "test_check", "passed": true, "output": "..."},
#     {"name": "lint_check", "passed": true, "output": "..."}
#   ],
#   "summary": {"passed": 3, "failed": 0, "total": 3}
# }
```

### Individual Checks

```bash
# Type check only
$VALIDATION_OPS type-check

# Tests only
$VALIDATION_OPS test-check

# Lint only
$VALIDATION_OPS lint-check
```

### Collect Tests to Evidence

```bash
# Initialize evidence structure first
$EVIDENCE_OPS init feature-25

# Run tests and capture results to evidence
$EVIDENCE_OPS collect-tests feature-25

# This saves test output to:
# .orchestrator/evidence/feature-25/test-results.md
```

## Legacy Commands (for reference)

The validation utilities auto-detect project type. Manual commands below are for edge cases:

### Python Projects (pytest)

```bash
# Run all tests with coverage
uv run pytest --tb=short -q --cov=src --cov-report=term-missing

# Type check
uv run python -m mypy src/
```

### Node/TypeScript Projects (vitest/jest)

```bash
# Vitest
npm run test:run

# Type check
npx tsc --noEmit

# Lint
npx eslint src/
```

## Test Results Format

Write to `.orchestrator/evidence/[feature-id]/test-results.md`:

```markdown
# Test Results

## Generated: [ISO timestamp]

## Summary
| Category | Result |
|----------|--------|
| Unit Tests | PASS (45/45) |
| Integration Tests | PASS (12/12) |
| Type Check | PASS |
| Lint | PASS |

## Unit Test Details
```
[Raw pytest/vitest output here]
```

## Coverage Report
| File | Stmts | Miss | Cover |
|------|-------|------|-------|
| src/foo.py | 100 | 5 | 95% |

## Type Check Output
```
[mypy/tsc output here]
```

## Lint Output
```
[ruff/eslint output here]
```
```

## Collecting UI Evidence

### When to Collect Screenshots

Collect screenshots when:
- Task involves frontend/UI changes
- Task modifies user-visible behavior
- Definition of Done includes visual verification

### Playwright Screenshots

```python
# Using Playwright for evidence collection
from playwright.sync_api import sync_playwright

def collect_ui_evidence(feature_id: str):
    evidence_dir = f'.orchestrator/evidence/{feature_id}/screenshots'

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Navigate to the relevant page
        page.goto('http://localhost:3000/feature-page')
        page.wait_for_load_state('networkidle')

        # Capture evidence
        page.screenshot(
            path=f'{evidence_dir}/final-state.png',
            full_page=True
        )

        # Multiple viewport sizes for responsive check
        viewports = [
            {'width': 375, 'height': 667, 'name': 'mobile'},
            {'width': 768, 'height': 1024, 'name': 'tablet'},
            {'width': 1440, 'height': 900, 'name': 'desktop'},
        ]

        for vp in viewports:
            page.set_viewport_size({'width': vp['width'], 'height': vp['height']})
            page.screenshot(
                path=f'{evidence_dir}/{vp["name"]}.png'
            )

        browser.close()
```

### Video Recording for Interactions

```python
def record_interaction(feature_id: str):
    evidence_dir = f'.orchestrator/evidence/{feature_id}/screenshots'

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # Record video
        context = browser.new_context(
            record_video_dir=evidence_dir,
            record_video_size={'width': 1280, 'height': 720}
        )
        page = context.new_page()

        # Perform the interaction flow
        page.goto('http://localhost:3000')
        page.click('button#login')
        page.fill('input[name="email"]', 'test@example.com')
        page.fill('input[name="password"]', 'password123')
        page.click('button[type="submit"]')
        page.wait_for_url('**/dashboard')

        # Close to save video
        context.close()
        browser.close()
```

## Using testing Plugin

Invoke the `testing:test-writer` agent for:
- Generating missing tests
- Expanding test coverage
- Adding edge case tests

```markdown
Please generate tests for the following:
- New function: `src/utils/validate.ts:validateEmail`
- Edge cases: empty input, malformed email, unicode characters
- Integration: API endpoint POST /api/users with validation

Follow existing test patterns in `tests/` directory.
```

## Validating Against Definition of Done

### Manual Verification Process

For each DoD item, determine:
1. **Can it be automated?** → Run automated check
2. **Requires visual inspection?** → Collect screenshot
3. **Requires manual testing?** → Document steps taken

### DoD Verification Matrix

```markdown
| DoD Item | Verification Type | Result | Evidence |
|----------|------------------|--------|----------|
| Tests pass | Automated | PASS | test-results.md |
| No type errors | Automated | PASS | test-results.md |
| Button is visible | Screenshot | PASS | screenshots/desktop.png |
| Form validates email | Manual | PASS | Tested with invalid input |
| Performance < 100ms | Automated | PASS | Lighthouse report |
```

### Evidence Validation File

Write to `.orchestrator/evidence/[feature-id]/validation.md`:

```markdown
# DoD Validation Report

## Task: [Task description]
## Generated: [ISO timestamp]

## Automated Checks
| Check | Status | Details |
|-------|--------|---------|
| Unit Tests | PASS | 45/45 passing |
| Integration Tests | PASS | 12/12 passing |
| Type Check | PASS | No errors |
| Lint | PASS | No warnings |
| Coverage | PASS | 87% (target: 80%) |

## Manual Verifications
| Item | Verified By | Result | Notes |
|------|-------------|--------|-------|
| Feature works end-to-end | Visual inspection | PASS | See screenshots/ |
| Responsive design | Viewport tests | PASS | Mobile, tablet, desktop captured |

## Definition of Done Status
| Criterion | Status | Evidence |
|-----------|--------|----------|
| [Criterion 1] | PASS | [Evidence reference] |
| [Criterion 2] | PASS | [Evidence reference] |
| [Criterion 3] | PASS | [Evidence reference] |

## Overall Status: READY FOR VALIDATION GATE

## Evidence Files
- `test-results.md` - Complete test output
- `screenshots/desktop.png` - Desktop view
- `screenshots/mobile.png` - Mobile view
- `screenshots/interaction.mp4` - User flow video
```

## Handling Test Failures

### If Tests Fail

1. **Don't proceed to validation gate** with failing tests
2. Log failure details to evidence
3. Return to implementation to fix
4. Re-run validation after fix

### If Coverage Is Low

1. Identify uncovered code
2. Generate additional tests using `testing:test-writer`
3. Re-run coverage
4. Document coverage improvement

### If Type Errors Exist

1. Fix type errors before proceeding
2. Log the fixes made
3. Re-run type check
4. Confirm clean output

## Integration with Orchestrator

The orchestrator should:

1. **During implementation (Phase 4)**:
   - Run only acceptance tests for fast feedback
   - Use targeted test execution after each change
   - Continue until all acceptance tests pass

2. **At validation gate (Phase 5)**:
   - Run full validation (`$VALIDATION_OPS full-check`) once
   - Collect all evidence
   - Verify validation.md exists and shows PASS
   - Verify all required evidence files exist
   - Pass/fail decision is automated (see `automated-validation-gate` skill)

3. **If validation fails**:
   - Return to implementation phase
   - Address specific failures
   - Re-run validation (max 3 retries, then abort)

## Pre-Validation Gate Checklist

Before running the automated validation gate, verify ALL of the following:

### Mandatory Checks

```bash
# Run evidence validation utility
$EVIDENCE_OPS validate [feature-id]

# Expected output:
# {"valid": true, "missing": [], "incomplete": []}
```

### Validation Criteria

| Artifact | Requirement | Check |
|----------|-------------|-------|
| test-results.md | Exists, shows PASS | `$EVIDENCE_OPS validate` |
| validation.md | All DoD items checked | Manual review |
| screenshots/ | Non-empty if frontend work | `ls .orchestrator/evidence/[id]/screenshots/` |

### If Validation Fails

1. **DO NOT proceed to validation gate**
2. Identify specific missing/incomplete items
3. Return to implementation phase
4. Complete missing evidence collection
5. Re-validate before running the gate

### Frontend Work Detection

If any of these are true, screenshots/ MUST be non-empty:
- Task modifies UI components (*.tsx, *.jsx, *.vue)
- Definition of Done includes visual verification
- Files changed include *.css, *.scss, *.html
- Task description mentions "UI", "frontend", "component", "page"

### Pre-Gate Validation Command

Run this before the automated validation gate:

```bash
# Full validation check
$EVIDENCE_OPS validate [feature-id]

# If it returns {"valid": false, ...}, examine:
# - missing: files that should exist but don't
# - incomplete: files that exist but have issues

# Only proceed when:
# {"valid": true, "missing": [], "incomplete": []}
```

---

## Best Practices

1. **Run tests early and often** during implementation
2. **Keep evidence organized** in the standard structure
3. **Be explicit about failures** - don't hide them
4. **Document manual checks** - future automation opportunity
5. **Archive evidence** for audit trail
6. **Validate before checkpoint** - never skip pre-checkpoint validation
