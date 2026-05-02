# Phase 5 evidence: feature-16 validation gate

Generated: 2026-05-02T22:55:00Z
Branch: feature/feature-16
Head: 43df0b3 feat(feature-16): freeze PII capture mode at session start

## Typecheck

```
$ make typecheck
npx tsc --noEmit
(exit 0)
```

## Unit + integration tests (vitest)

```
$ make test
Test Files  45 passed (45)
     Tests  626 passed (626)
  Start at  22:51:18
  Duration  2.40s
```

## E2E tests (Playwright, full suite)

```
$ npx playwright test
Running 15 tests using 1 worker

  ✓ input-capture.spec.ts › full mode captures the typed value (2.9s)
  ✓ input-capture.spec.ts › metadata mode captures structural metadata but never the raw value (2.6s)
  ✓ input-capture.spec.ts › feature-16: adversarial DOM mutation cannot defeat metadata mode mid-session (3.9s)
  ✓ input-capture.spec.ts › none mode emits no input events at all (2.8s)
  ✓ session.spec.ts × 8 (existing — unaffected)
  ✓ sidepanel-debug.spec.ts × 3 (existing — unaffected)

  15 passed (33.5s)
```

## Build

```
$ make build
✓ 6 modules transformed.
✓ built in 18ms (content)
✓ built in 968ms (sidepanel + service worker)
```

## Test Level Matrix coverage

| # | DoD checkbox | Level | File | Status |
|---|---|---|---|---|
| 1 | Fieldset hidden during running/paused | Unit (jsdom) | `src/sidepanel/sidepanel.test.ts` | ✓ |
| 2 | Toolbar capture pill visible during active session | Unit (jsdom) | `src/sidepanel/sidepanel.test.ts` | ✓ |
| 3 | `session.json pii_mode` reflects start-time mode | Unit | `src/lib/exporter.test.ts` (existing) | ✓ |
| 4 | Recorder gates on session-scoped frozen value | Unit | `src/content/recorder.test.ts` (new freeze tests) | ✓ |
| 5 | Pre-session selector unchanged | Unit (jsdom) | `src/sidepanel/sidepanel.test.ts` (existing rows + new) | ✓ |
| 6 | Indicator visibility per status | Unit | `src/lib/sidepanel-controls.test.ts` (matrix) | ✓ |
| 7 | E2E metadata-mode input has `value_metadata`, no raw `value` (incl. adversarial DOM mutation) | E2E | `e2e/input-capture.spec.ts` | ✓ |

## Acceptance criteria verdict

- [x] `make typecheck` exit 0
- [x] `make test` exit 0 (626/626)
- [x] `npx playwright test e2e/input-capture.spec.ts` exit 0 (4/4)
- [x] Adversarial DOM-mutation E2E asserts `pii_mode === "metadata"` AND `value_metadata` populated AND no `value` key
- [x] PII fieldset construction is gated by `model.piiMode` (sidepanel.ts:1083) — hide-not-disable contract honoured
- [x] No `schema_version` change — exporter.test.ts golden round-trip green
- [x] `src/lib/exporter.golden.test.ts` green (no snapshot regen)

**Verdict: PASS** — every DoD checkbox covered, every test green.
