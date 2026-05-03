# Feature-17 Validation Gate

## Status: PASS

| Check | Result | Notes |
|-------|--------|-------|
| `make typecheck` | PASS | tsc --noEmit clean |
| `make test` | PASS | 50/50 files, 648/648 tests |
| `make build` | PASS | Vite + manifest copy clean |
| Legacy id grep | PASS | `tests/sidepanel-no-legacy-ids.test.ts` green |

## DoD verification

- [x] **DoD-1** Pre-session shows Start + PII picker + connection-status pill — pinned by `tests/sidepanel-paused-controls.test.ts` and `src/lib/sidepanel-controls.test.ts`
- [x] **DoD-2** Active running shows ONLY Pause as lifecycle — pinned by both files
- [x] **DoD-3** Paused contextual matrix (Resume + Download/Clear when events + End when listener) — pinned by 4-cell matrix test
- [x] **DoD-4** Empty paused shows ONLY Resume — `querySelector === null` for Download/Clear/End
- [x] **DoD-5** Live listener attach surfaces End without remount — `tests/sidepanel-listener-reactive.test.ts` (events-list node identity preserved)
- [x] **DoD-6** Clear destructive confirmation; cancel = zero writes — `tests/sidepanel-clear-confirm.test.ts` (4 tests covering open, cancel, confirm, fresh-storage counts, default focus)
- [x] **DoD-7** End reuses STOP_SESSION + EXPORT_SESSION — `tests/sidepanel-end-handoff.test.ts` (no END_SESSION message; reminder absent)
- [x] **DoD-8** Legacy stop-btn/discard-btn/reset-btn ids removed from src/, tests/, e2e/, cli/ (modulo allow-list of "assert absence" tests) — `tests/sidepanel-no-legacy-ids.test.ts`
- [x] **DoD-9** Combinatoric coverage subsumed by DoD-1..7 above
- [x] **DoD-10** E2E Download flow — `e2e/sidepanel-lifecycle-feature17.spec.ts` (run by Playwright)
- [x] **DoD-11** E2E empty-paused flow — same e2e file
- [x] **DoD-12 (SAFE)** Byte-identical zip determinism (Download ≡ End ≡ ...) — `src/lib/exporter.golden.test.ts` (two-call deep-equal)
- [x] **DoD-13 (SAFE)** SCHEMA_VERSION === "1.2.0" regression pin — same file
- [x] **DoD-14 (SAFE)** End absent without handoff config — `tests/sidepanel-paused-controls.test.ts` (paused with events but no listener: #end-btn === null)
- [x] **DoD-15 (SAFE)** Live attach mutation scoped — `tests/sidepanel-listener-reactive.test.ts` (toolbar children delta is exactly +1 / −1; activeElement preserved)

## Risk mitigations applied

1. Test-id rename safety net — grep test in `tests/sidepanel-no-legacy-ids.test.ts`
2. Schema regression — exporter golden test extended with byte-equality + version pin
3. Focus disruption on live attach — `applyControlsModel` saves+restores `document.activeElement.id` across the rebuild
4. Accidental End firing — End is structurally absent without `getHandoffConfig() !== null`; pinned by DoD-14
5. End / Download zip drift — both call the same SW message (`STOP_SESSION` + `EXPORT_SESSION`); the SW handles the transport choice via the existing handoff branch

## What did NOT change (out-of-scope clarifications)

- `SessionStatus` machine (`src/lib/session-status.ts`) — untouched, transition table unchanged
- `RESET_SESSION` and `DISCARD_SESSION` SW handlers — kept (UI no longer invokes RESET_SESSION; DISCARD_SESSION still drives Clear)
- `schema_version` constant — still `1.2.0`
- Manifest / package version — unchanged (this is unreleased work)
- Exporter / handoff internals — untouched
