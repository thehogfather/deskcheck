# Validation Gate — Feature #16 (Freeze PII capture mode at session start)

**Date**: 2026-05-02
**Branch**: feature/feature-16
**Session**: orch-20260502-213511-81971
**Final commit**: 43df0b3 feat(feature-16): freeze PII capture mode at session start

## Verdict: PASS

All acceptance criteria met on first validation run (no retry needed).

## Phase summary

| Phase | Status | Commit |
|---|---|---|
| 0 — initialize workspace + brief | ✓ | 4645cca |
| 1 — three competing plans | ✓ | d335ed9 |
| 2 — judge selects plan + test matrix | ✓ | 1088c18 |
| 3 — failing acceptance tests (13 tests) | ✓ | a5cf369 |
| 4 — implementation (4 source files) | ✓ | 43df0b3 |
| 5 — automated validation gate | ✓ | (this commit) |

## Acceptance criteria

- [x] `make typecheck` clean
- [x] `make test` 626/626 green
- [x] `npx playwright test` 15/15 green (4 input-capture, 8 session, 3 sidepanel-debug)
- [x] Adversarial DOM-mutation E2E green
- [x] No `schema_version` change (exporter golden test green)
- [x] PII fieldset construction is `model.piiMode`-gated
- [x] Indicator pill is `model.piiIndicator`-gated and mutually exclusive with fieldset
- [x] Recorder closure-frozen at start (`const piiMode = opts.piiMode`)

## DoD coverage map (roadmap.md lines 161-168)

- [x] PII mode fieldset is hidden from the DOM during running/paused states
- [x] Toolbar shows a non-interactive "Capture: full | metadata | none" indicator while a session is active
- [x] `session.json` `pii_mode` field reflects the mode at Start time and never changes
- [x] Recorder gates input events on a session-scoped frozen mode value
- [x] Existing pre-session selector behaviour (Full / Metadata / None) is unchanged
- [x] Unit tests cover: indicator visibility per status, frozen-mode persistence, recorder gate behaviour
- [x] E2E test: metadata-mode session captures `value_metadata` + no raw value (incl. adversarial mutation)

## Risks accepted (from selected plan)

1. No service-worker write-guard for hypothetical future `pii_mode` mutations.
2. No `console.warn` divergence canary in `recorder.ts`.
3. No extracted `sidepanel-pii-indicator.ts` module (followed `buildPiiFieldset` precedent inline).
4. No ARCHITECTURE.md prose section — tests are the live spec.
5. Default `parsePiiMode` fallback remains `full` (most permissive on storage corruption) — flagged as follow-up by safety planner, deferred.

## Latent bug found and fixed

The closure-freeze test (recorder.test.ts) revealed that `opts.piiMode` was being read live at event time inside `capturePayloadForMode(target, opts.piiMode)` (recorder.ts:61, pre-fix). Mutating the opts object after `startRecording` would have changed payload behaviour mid-session.

Today no code path mutates the opts object — service-worker constructs a fresh `{ piiMode: session.pii_mode }` per `SESSION_STARTED` message, and content/index.ts wraps it inline (`startRecording(sendEvent, { piiMode })`). But the freeze was soft, not hard.

The fix at recorder.ts:20-26 captures `const piiMode: PiiCaptureMode = opts.piiMode` once, and uses the const everywhere else. A future refactor that introduces a mutable opts source (e.g. live storage subscription) cannot leak raw values when the user picked metadata or none — the test pins the contract.
