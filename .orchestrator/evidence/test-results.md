---
feature_id: feature-2
generated: 2026-04-07
---

# Test Results — Feature #2

## `make test` output (final run)

```
npx vitest run

 RUN  v4.1.2 /Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-sensitive-data-warnings


 Test Files  5 passed (5)
      Tests  72 passed (72)
```

## `make typecheck` output (final run)

```
npx tsc --noEmit
```

(no diagnostics — exit 0)

## `make build` output (tail)

```
✓ All steps completed.

transforming...
✓ 1 modules transformed.
rendering chunks...
computing gzip size...
dist/manifest.json  1.04 kB │ gzip: 0.48 kB
✓ built in 548ms
```

## Acceptance test mapping

| Matrix # | Test name | File | Status |
|----------|-----------|------|--------|
| 1 | mentions visible screen content | `src/lib/privacy.test.ts` | PASS |
| 2 | mentions form inputs | `src/lib/privacy.test.ts` | PASS |
| 3 | mentions network headers | `src/lib/privacy.test.ts` | PASS |
| 4 | shouldShowFirstRunNotice(false) === true | `src/lib/privacy.test.ts` | PASS |
| 5 | shouldShowFirstRunNotice(true) === false | `src/lib/privacy.test.ts` | PASS |
| 6 | PRIVACY_MD_TEMPLATE non-empty + H1 | `src/lib/privacy.test.ts` | PASS |
| 7 | PRIVACY_MD_TEMPLATE mentions all three topics | `src/lib/privacy.test.ts` | PASS |
| 8 | PRIVACY_MD_TEMPLATE notes local-use-only | `src/lib/privacy.test.ts` | PASS |
| 9 | PRIVACY_MD_TEMPLATE mentions screenshots/sensitive | `src/lib/privacy.test.ts` | PASS |
| 10 | empty zip contains PRIVACY.md | `src/lib/exporter.test.ts` | PASS |
| 11 | screenshots-bearing zip contains PRIVACY.md | `src/lib/exporter.test.ts` | PASS |
| 12 | PRIVACY.md content references screenshots/sensitive | `src/lib/exporter.test.ts` | PASS |
| 13 | schema_version unchanged | `src/lib/exporter.test.ts` (existing) | PASS |
