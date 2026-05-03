---
agent: speed-planner
generated: 2026-05-02T00:00:00Z
task_id: feature-16
perspective: speed
---

# Speed Plan: Freeze PII capture mode at session start

## Architecture Impact

**Components affected:**
- `src/lib/sidepanel-controls.ts`: flip `piiMode` from unconditional `true` to status-conditional (`preSession` only).
- `src/sidepanel/sidepanel.ts`: render a non-interactive `Capture: <mode>` pill in the toolbar when `model.piiMode === false`.

**New patterns or abstractions introduced:**
- None. Reuses the existing `ControlsModel` lever and the `.handoff-status` pill CSS.

**Dependencies added or modified:**
- None.

**Breaking changes to existing interfaces:**
- None — `pii_mode` schema unchanged. Three existing jsdom tests need a one-line update to assert status-conditional fieldset presence.

## Approach
Flip one line in `buildControlsModel` to hide the fieldset during `running`/`paused`, then render a tiny pill that reuses the `.handoff-status` classes. The recorder closure-freeze is already correct (recorder.ts:57-61) — pin it with one unit test and lean on the existing `e2e/input-capture.spec.ts` "metadata mode" test to satisfy the e2e DoD.

## Files to Modify (Minimal)
| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `src/lib/sidepanel-controls.ts` | Modify | ~3 | Single-line lever: `piiMode: preSession`. |
| `src/sidepanel/sidepanel.ts` | Modify | ~25 | Build `capturePill` element once, append to toolbar when `!model.piiMode`; read `selectedPiiMode`. |
| `src/lib/sidepanel-controls.test.ts` | Modify | ~6 | Update `piiMode` expectation to status-conditional. |
| `src/sidepanel/sidepanel.test.ts` | Modify | ~15 | Update lines 239/273/1177 assertions; add 2 small assertions for pill visibility per status. |
| `src/content/recorder.test.ts` | Modify | ~25 | Add one test: simulate storage `pii_mode` change mid-session, assert recorder still uses start-time mode. |

**Total files**: 5
**Total estimated lines**: ~75

## Implementation Steps
1. Change `src/lib/sidepanel-controls.ts:72` from `piiMode: true` to `piiMode: preSession`.
2. In `sidepanel.ts`, after `buildPiiFieldset`, build `capturePill = el("div", { id: "capture-mode-pill", class: "handoff-status capture-mode-pill" }, [...])` with text `Capture: ${selectedPiiMode}`. Update its text whenever `selectedPiiMode` changes (already wired in pre-session change handler) and whenever the model re-renders.
3. In the toolbar render block (near `sidepanel.ts:1062`), append `capturePill` when `!model.piiMode` (i.e., active session).
4. In the controls block at line 1076, the existing `if (model.piiMode)` guard already handles fieldset removal — no further change.
5. Update `src/lib/sidepanel-controls.test.ts:106-107`: assert `piiMode === true` for `idle`/`stopped`; `piiMode === false` for `running`/`paused`.
6. Update `src/sidepanel/sidepanel.test.ts:239, 273, 1177`: keep the pre-session presence assertion at 239/273; at 1177 (active-session), assert fieldset is absent and `#capture-mode-pill` is present with text matching the chosen mode.
7. Add a recorder unit test: start a session with `full`, fire a `chrome.storage.onChanged` event flipping `pii_mode` to `none`, assert `capturePayloadForMode` still returns `value` (full-mode payload) for the next input.
8. Run `make test` and `make typecheck`.

## Definition of Done
- [ ] `buildControlsModel` returns `piiMode: false` for `running`/`paused`, `true` otherwise.
- [ ] Active-session DOM contains no `#pii-mode-fieldset` and does contain `#capture-mode-pill` with text `Capture: <mode>`.
- [ ] Pre-session DOM contains `#pii-mode-fieldset` and no `#capture-mode-pill`.
- [ ] Recorder unit test pins closure-frozen mode against mid-session storage change.
- [ ] `pii_mode` round-trip tests (`exporter.test.ts:140-153`, `exporter.golden.test.ts`) stay green.
- [ ] `e2e/input-capture.spec.ts` "metadata mode" test stays green (already asserts `value_metadata` populated, no raw value).
- [ ] `make test` and `make typecheck` pass.

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `buildControlsModel` status-conditional `piiMode` | Unit | Pure function, no deps. |
| 2 | Active-session fieldset absent, pill present | Unit (jsdom) | Deterministic via `transitionTo` helper already used by `sidepanel.test.ts`. |
| 3 | Pre-session fieldset present, pill absent | Unit (jsdom) | Same. |
| 4 | Recorder ignores mid-session storage `pii_mode` change | Unit | Closure semantics, no Chrome runtime needed — mock `chrome.storage.onChanged`. |
| 5 | `session.json pii_mode` reflects start-time value | Unit | Already pinned by existing `exporter.test.ts:140-153`. |
| 6 | Metadata-mode input event has `value_metadata`, no raw `value` | E2E | Already covered by `e2e/input-capture.spec.ts` "metadata mode" test. |

**Speed planner bias**: Default to unit. Only existing e2e is reused — zero new e2e tests.

**Determinism rule**: All tests fully deterministic — no LLM calls anywhere in this stack.

## Testing Strategy
- **Unit**: 1 new recorder test, 1 update to `sidepanel-controls.test.ts`, ~3 updates to `sidepanel.test.ts`.
- **Integration**: Skip — existing exporter round-trip already pins schema.
- **E2E**: Reuse existing `e2e/input-capture.spec.ts` — already covers metadata-mode `value_metadata` + no raw value. No new e2e file.

**E2E Test Impact**:
- **Existing e2e tests affected**: `e2e/input-capture.spec.ts` (no changes; already aligned with DoD), `e2e/session.spec.ts` (verify no fieldset assertions break — likely none).
- **New e2e tests needed**: None — DoD criterion (g) is already satisfied by existing coverage. The brief's "input-event coverage gap" was closed by an earlier fix; `input-capture.spec.ts` exists today.
- **Cost note**: Zero new e2e — saves full auth/load cycle.

**Test files to create/modify**: `sidepanel-controls.test.ts`, `sidepanel.test.ts`, `recorder.test.ts`.

## Risk Assessment
**Risk Level**: Low

**Why this is safe**:
- Recorder freeze semantics already work (recorder.ts:57-61 uses closure capture). No behavioural change to recording.
- `pii_mode` write path already only fires at session creation (service-worker.ts:334). Read-only verified by brief.
- Schema unchanged → exporter golden tests act as a tripwire.
- Pill is purely decorative DOM — no event handlers, no state.

**Tradeoffs accepted**:
- No defensive guard inside service-worker against hypothetical future `pii_mode` mutation paths (quality plan would add one).
- No formal "lock" semantics in storage — relies on UI affordance + closure freeze.
- Reuse `.handoff-status` classes verbatim; if those change later, pill picks up the change. Acceptable.

## Estimated Effort
- Planning: Already done
- Implementation: ~25 minutes
- Testing: ~20 minutes
- **Total**: ~45 minutes

## Formal Verification Assessment
- Concurrency concerns: No — single content-script closure per session, single service-worker write at creation.
- State machine complexity: No — adds zero new states; reuses existing `SessionStatus` lever.
- Conservation laws: No.
- Authorization model: No.
- Recommendation: Not needed.

## What This Plan Does NOT Include
- Does NOT add a service-worker-side guard rejecting `pii_mode` writes after creation — the existing code path already only writes once.
- Does NOT introduce a dedicated `FrozenPiiMode` type or session-scoped frozen-mode store — closure capture is already the freeze point.
- Does NOT add new e2e tests — `e2e/input-capture.spec.ts` already covers the DoD.
- Does NOT refactor the PII fieldset or change the radio UX pre-session.
- Does NOT add `(locked)` copy or aria-live announcements (brief explicitly forbids).
- Does NOT bump `schema_version`.
