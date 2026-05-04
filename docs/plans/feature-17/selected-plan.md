---
agent: plan-judge
generated: 2026-05-03T00:00:00Z
task_id: feature-17
selected: synthesized
---

# Plan Evaluation: Simplify session lifecycle — Pause-first, contextual exits

## Executive Summary

Synthesised plan, anchored on the **Quality** plan's surface (verb mapping, listener-attached reactivity, no SW message addition, latent `download-btn` collision fix), with the **Safety** plan's regression nets (byte-identical zip golden assertion, MutationObserver live-attach test, 16-cell DOM-presence matrix, no-stale-test-ids grep) bolted on, and the **Speed** plan's pragmatic scope discipline (no `SessionAction`/SW changes, single-PR sizing, leave the orphaned reminder DOM for a follow-up). The minor-but-real divergence point is whether End is a NEW SW message: it is NOT — the existing `EXPORT_SESSION` branch already routes to `performHandoff` when a handoff config is present, so a new `END_SESSION` message is unnecessary scope.

## Plans Evaluated

### Speed Plan Summary
- **Core approach**: Rename three buttons in place; add a new `END_SESSION` SW message that wraps the existing handoff path; keep `SessionStatus` machine intact; minimum diff.
- **Estimated effort**: ~3 hours.
- **Key tradeoff**: Introduces an unnecessary `END_SESSION` SW message (scope drift), leaves the orphaned reminder DOM in place (acceptable but messy), under-specifies the live-attach DOM-mutation guarantee, doesn't pin byte-identical zip parity between Download and End paths.

### Quality Plan Summary
- **Core approach**: Treat the action set as a model concern. Widen `ControlsModelInputs` with `hasEvents` + `listenerAttached`; reuse the existing `EXPORT_SESSION` branch (no new SW message); fix the latent `#download-btn` id collision in the reminder; subscribe to existing `PENDING_HANDOFF_CHANGED` broadcast; reuse the discard dialog verbatim renamed as clear.
- **Estimated effort**: ~4 hours.
- **Key tradeoff**: Adds a `countMaterialEvents` helper and a `resume` flag separation that, while clean, are mild over-engineering for a single-developer extension. Estimate is reasonable for one PR.

### Safety Plan Summary
- **Core approach**: Same surface as Quality, but with explicit safety nets — byte-identical zip parity (Download ≡ End ≡ golden), MutationObserver test for live-attach scope, no-stale-test-ids file grep, SAFE-5 (End absent without listener config), and confirmation gate on event-drop paths.
- **Estimated effort**: ~6 hours.
- **Key tradeoff**: Suggests a confirmation dialog on End (over-friction; the connection-status pill is sufficient signal); proposes more new test files than is strictly necessary, several of which collapse into a single matrix file. The 6-hour estimate is borderline for a single-PR session.

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|-----------|--------|-------|---------|--------|-------|
| Correctness (DoD coverage) | — | 4.0 | 5.0 | 5.0 | Speed silently re-defines End as a new SW message — diverges slightly from "same handoff POST path as today's Stop+listener". Quality and Safety both correctly identify reuse. |
| Reuse of existing primitives | — | 4.0 | 5.0 | 4.5 | Quality maximises reuse (no new SW message, reuses `PENDING_HANDOFF_CHANGED`, reuses discard dialog). Safety reuses everything but adds new test files that overlap. |
| Test rigour (specificity + load-bearing invariants) | — | 3.5 | 4.5 | 5.0 | Safety pins byte-identical zip + MutationObserver focus preservation; Quality has good coverage but doesn't explicitly pin Download ≡ End byte equality; Speed defers most invariants to existing tests. |
| Risk handling (test-id rename, schema, accidental End, focus stability) | — | 3.5 | 4.5 | 5.0 | Safety enumerates 10 risks with explicit test-pin mapping. Quality covers 4 risks well. Speed acknowledges blast radius but leaves migration as a "grep + replace pass". |
| Effort fit (single PR, single session) | — | 5.0 | 4.0 | 2.5 | Speed fits cleanly. Quality is borderline-large but realistic for one session. Safety's 6h + 9 new test files is too heavy for a single autonomous orchestration. |

### Weighted total (using the rubric's 20/25/25/15/15 weights, mapped to the criteria above)

| Criterion | Weight | Speed | Quality | Safety |
|-----------|--------|-------|---------|--------|
| Time to deliver (Effort fit) | 20% | 5.0 | 4.0 | 2.5 |
| Code quality (Reuse) | 25% | 4.0 | 5.0 | 4.5 |
| Risk mitigation (Risk handling) | 25% | 3.5 | 4.5 | 5.0 |
| Maintainability (Correctness) | 15% | 4.0 | 5.0 | 5.0 |
| Test coverage (Test rigour) | 15% | 3.5 | 4.5 | 5.0 |
| **Weighted Total** | 100% | **3.99** | **4.61** | **4.30** |

Quality wins on score; Safety contributes critical regression nets that would be irresponsible to drop given the schema-as-contract invariant. Synthesis is appropriate.

## Context Analysis

| Factor | Assessment | Impact |
|--------|------------|--------|
| Urgency | Low (planned roadmap work, not a hotfix) | Favour quality + safety nets over speed |
| Blast radius | Medium — touches every UI surface in the side panel; export contract is product-critical | Pin byte-identical zip parity (safety contribution) |
| Code area | Core (side panel is THE primary UI surface; SessionStatus is the formal lifecycle model) | Favour quality |
| Technical debt | Low overall, but a latent `#download-btn` id collision exists in the reminder | Fix as a side-effect (quality contribution) |
| Solo dev / single PR | Strong constraint per project context | Reject safety's 6h estimate; trim overlapping test files |
| Schema-as-contract | `schema_version` MUST stay 1.2.0 | Pin via grep + golden test (safety contribution) |
| Existing test culture | Strong — table-driven SessionStatus tests, hide-not-disable assertions, byte-identical zip goldens | Lean on existing patterns (quality contribution) |

## Recommendation

### Selected Plan: **Synthesized** (Quality-anchored)

### Rationale

DeskCheck is a single-developer Chrome MV3 extension where the side panel is the primary UI surface and the export schema is the product's core contract. Feature 17 simplifies a UI surface that sits on top of an unchanged engine — `SessionStatus`, the OPFS store, the exporter, and the handoff path are all untouched. That makes Quality's framing correct: this is a model concern (widen `ControlsModelInputs`, return a richer `ControlVisibility`, mount/unmount accordingly), not an SW concern. The Speed plan's `END_SESSION` message addition is unnecessary and slightly wrong — the roadmap explicitly says End is "the same handoff POST path as today's Stop-with-listener-attached", which means reusing `EXPORT_SESSION`, not introducing a new message that wraps it.

Safety identifies the real risk this feature carries: silent regression of byte-identical zip parity between Download and End paths. The roadmap calls this out explicitly (feature #14 invariant: "byte-identical zip payload"), and `exporter.golden.test.ts` already enforces `schema_version === 1.2.0`. A test that captures zip bytes from both Download and End paths and asserts equality with the existing golden fixture is the single most important regression net for this feature, and it costs ~30 min to add. Without it, a future refactor of `EXPORT_SESSION` could silently drift the two paths apart and only get caught by manual smoke testing.

The synthesis trims Safety's overhead — the 6-hour estimate, the 9 new test files, the End-confirmation suggestion (the connection-status pill is sufficient signal — adding a confirmation would inflate the verb surface this feature is shrinking) — while keeping the load-bearing invariants. Quality's `countMaterialEvents` helper is kept because empty-paused (DoD-4) requires the count to exclude pause/resume markers; the separate `resume` flag is dropped (the existing `pause` flag with label-swap is fine). The orphaned reminder DOM is deleted (Quality's preference) rather than left in place (Speed's preference) because removing the latent `#download-btn` id collision is a quality win that costs almost nothing.

The result is a plan that fits in one PR landed in a single orchestration session: ~3.5 hours of focused work, anchored on existing primitives, with a small set of high-value safety nets pinning the load-bearing invariants.

### Incorporated Elements from Other Plans

- **From Speed**: scope discipline ("`SessionStatus` machine is untouched"; SW handlers `STOP/DISCARD/RESET` unchanged; minimum-diff button rename); the "skip the download fallback for End" decision is rejected (we keep Stop's existing fall-through behaviour for End to preserve the S12 retention invariant).
- **From Quality**: the entire architectural framing — widen `ControlsModelInputs`, no new SW message, fix the latent `#download-btn` id collision in the reminder by renaming it to `confirm-export-btn`, subscribe to the existing `PENDING_HANDOFF_CHANGED` broadcast for live attach, reuse the discard dialog verbatim renamed to `clear-confirm-dialog`, add `countMaterialEvents` helper for DoD-4.
- **From Safety**: byte-identical zip golden assertion (`Download bytes === End bytes === golden`), MutationObserver test for live-attach scope (only `#end-btn` mutates; focus + toolbar layout preserved), no-stale-test-ids file grep across `src/`/`tests/`/`e2e/`/`cli/`/`docs/`, explicit assertion that End button is structurally absent without a handoff config (SAFE-5), explicit `schema_version` regression check.

## The Selected Plan

### Architecture reference

- **Side Panel section** (`docs/ARCHITECTURE.md:42–48`) — three-region flex layout (`#toolbar` / `#events-list` / `#controls`), hide-not-disable contract enforced via structural mount/unmount from `buildControlsModel()`, discard dialog reads counts from fresh `chrome.storage.local.get` at open time, Cancel = ZERO storage writes (spy-pinned).
- **`SessionStatus` machine** (`src/lib/session-status.ts`) — 4-state × 7-action transition table pinned by `tests/session-status.test.ts`. **UNTOUCHED.** This feature narrows the user-driven verb surface; the formal lifecycle model is unchanged.
- **`buildControlsModel`** (`src/lib/sidepanel-controls.ts`) — pure view-model. Widens `ControlsModelInputs` from `{status, hasResidualState}` to `{status, hasResidualState, hasEvents, listenerAttached}`; `ControlVisibility` shape gains `download`, `clear`, `end` flags; loses `stop`, `discard`, `reset`. Existing `pause`/`piiMode`/`piiIndicator`/`pausedBadge`/`metrics`/`emptyStateHint`/`annotation`/`elementPicker`/`attachCliListener`/`start` flags are preserved.
- **CLI handoff** (`docs/ARCHITECTURE.md:86–192`) — End reuses the existing `EXPORT_SESSION` branch; the SW already routes to `performHandoff` when a handoff config is present. **NO new SW message.** The `PENDING_HANDOFF_CHANGED` broadcast (already plumbed in `service-worker.ts`) is the live signal source for End visibility.
- **Schema invariant** — `schema_version` 1.2.0 stays. End is a transport choice for an existing zip, not a schema change. Pinned by `src/lib/exporter.golden.test.ts` (D10).

### Approach

Treat the action set as a **model concern**, not a render concern. Widen `ControlsModelInputs` with `hasEvents` + `listenerAttached`, reshape `ControlVisibility` to express the contextual exits, and re-run `applyControlsModel()` whenever the inputs change. The state machine, the storage layer, and the export path are untouched — we are simplifying a UI surface that sits on top of an unchanged engine.

Live attach reactivity (DoD-5) reuses the existing `PENDING_HANDOFF_CHANGED` broadcast and the existing `runtimeListener` in `sidepanel.ts`. We add one branch that flips a local `listenerAttached` boolean and calls `applyControlsModel()` — no panel re-mount, same DOM nodes preserved.

End reuses the existing `EXPORT_SESSION` SW handler. The existing handoff branch in `service-worker.ts` already routes to `performHandoff` when a handoff config is set; End is just a different button that dispatches the same message. No new SW message types.

### Files to Modify

| File | Change | Lines | Rationale |
|------|--------|-------|-----------|
| `src/lib/sidepanel-controls.ts` | Widen inputs; rename `stop→download`, `discard→clear`; drop `reset`; add `end`; add `countMaterialEvents` helper | ~50 | Pure view-model, table-driven testable |
| `src/sidepanel/sidepanel.ts` | Rename button ids + labels; delete `resetBtn`; rename reminder confirm `download-btn → confirm-export-btn`; add `endBtn`; subscribe to `PENDING_HANDOFF_CHANGED` for live attach; rename discard dialog ids to `clear-*`; remove orphaned reminder DOM after migration; pass `hasEvents` + `listenerAttached` into `buildControlsModel`; recompute on every state change | ~120 | Glue layer; the only place where the hide-not-disable contract is enforced |
| `tests/sidepanel-controls.test.ts` | Migrate to 16-cell matrix (status × hasEvents × listenerAttached); drop `reset` cases | ~60 | Pure model test |
| `tests/sidepanel-paused-controls.test.ts` (new) | DOM presence/absence per state via `querySelector === null/!== null` | ~80 | Pins hide-not-disable invariant |
| `tests/sidepanel-clear-confirm.test.ts` (new, replaces existing discard-cancel test) | Counts fetched fresh; Cancel = zero writes (spy); Confirm = single atomic remove | ~60 | Inherits the discard dialog contract verbatim |
| `tests/sidepanel-listener-reactive.test.ts` (new) | Mount paused; broadcast `PENDING_HANDOFF_CHANGED`; assert `#end-btn` appears/disappears AND `#events-list` node identity preserved (no remount); MutationObserver verifies only End mutates and focus is preserved | ~70 | Pins DoD-5 + safety SAFE-7/SAFE-10 |
| `tests/sidepanel-end-handoff.test.ts` (new) | Click End → `EXPORT_SESSION` dispatched → `performHandoff` called with bearer token → transition to idle on success; 403 → session retained, EXPORT_WARNING emitted | ~80 | Integration boundary at panel ↔ SW ↔ fetch |
| `src/lib/exporter.golden.test.ts` (extend) | Build a session via fixture; export twice via the production path (Download branch and End branch); assert `zipBytesDownload === zipBytesEnd === goldenFixture` | ~40 | The single most important regression net for this feature |
| `tests/sidepanel-no-legacy-ids.test.ts` (new) | Grep `src/`, `tests/`, `e2e/`, `cli/` for `stop-btn`/`discard-btn`/`reset-btn`/`#download-btn` (other than the one toolbar entry) literal strings; allow-list this plan + changelog | ~30 | Static safety net for the rename migration |
| `tests/service-worker-handoff.test.ts` (extend) | Add an "End path" test that drives EXPORT_SESSION while paused-with-listener and asserts same auth header + same X-DeskCheck-Session-Id | ~30 | Integration boundary at the SW |
| `e2e/sidepanel-lifecycle-feature17.spec.ts` (new) | Two `test()` blocks in one file (DoD-10, DoD-11) | ~120 | Critical user journeys; one file to amortise auth+unlock |
| `docs/ARCHITECTURE.md` | Side Panel section update + new changelog row | ~30 | Schema-as-contract; documentation MUST track surface changes |

**Total: 12 files** (3 source modified, 9 test/doc files modified or new). Estimated ~810 lines of net change.

### Implementation Steps

1. **Lock the contract.** Update `src/lib/sidepanel-controls.ts`:
   - Add `hasEvents: boolean` and `listenerAttached: boolean` to `ControlsModelInputs`.
   - Update `ControlVisibility`: drop `stop`, `discard`, `reset`; add `download`, `clear`, `end`.
   - Predicates:
     - `download = status === "paused" && hasEvents`
     - `clear = status === "paused" && hasEvents`
     - `end = status === "paused" && listenerAttached`
   - Add helper `countMaterialEvents(events)` that excludes `session_paused` / `session_resumed` markers (DoD-4 alignment).
2. **Write the table-driven test before the renderer.** Update `tests/sidepanel-controls.test.ts` to a 16-row table (status × hasEvents × listenerAttached). The test fails red because `buildControlsModel` does not yet read the new inputs.
3. **Implement `buildControlsModel`** to satisfy the table.
4. **Migrate `sidepanel.ts` button ids and labels**:
   - `stopBtn (#stop-btn) → downloadBtn (#download-btn)` label "Download"
   - `discardBtn (#discard-btn) → clearBtn (#clear-btn)` label "Clear"
   - Delete `resetBtn` and its handler entirely.
   - Rename the existing pre-export reminder confirm button id from `#download-btn` to `#confirm-export-btn` (fixes the latent id collision).
   - Add `endBtn (#end-btn)` label "End" using a distinct Lucide icon (e.g. `Power` or fall back to `LucideX` if avoiding new imports).
5. **Delete the running-state lifecycle row.** During `running`, the toolbar shows only `pauseBtn` (per DoD-2). Mid-recording Download/Clear/End are gone.
6. **Rewire click handlers**:
   - **Download**: opens the existing pre-export reminder; the reminder's `#confirm-export-btn` dispatches `STOP_SESSION` + `EXPORT_SESSION` (unchanged from today's stopBtn flow). The SW falls through to `chrome.downloads` because no handoff config is set OR because the handoff path failed (existing S12 invariant).
   - **Clear**: opens the renamed clear-confirm-dialog (was discard-confirm-dialog) with copy "Delete N events and M screenshots? This cannot be undone." Confirmed dispatch: `DISCARD_SESSION` (unchanged SW handler).
   - **End**: dispatches `STOP_SESSION` + `EXPORT_SESSION`. Because a handoff config is attached, the existing SW branch routes to `performHandoff` — same path as today's Stop-with-listener, byte-identical zip.
7. **Wire listener reactivity**:
   - Track `let listenerAttached = false` next to the existing `handoffAttachedUrl`.
   - Initialise from `getHandoffConfig()` at mount.
   - In the existing `runtimeListener`, add `case "PENDING_HANDOFF_CHANGED": listenerAttached = msg.active != null; applyControlsModel(); return;`.
8. **Pass `hasEvents: countMaterialEvents(events) > 0` and `listenerAttached` into `buildControlsModel`** every time the panel recomputes.
9. **Delete the orphaned reminder mount path** that's no longer used (the reminder is still surfaced for Download, but any anti-muscle-memory gating around the old Stop button is gone).
10. **Migrate existing tests.** Run the test suite; fix every red test by replacing old ids with new ones. The grep test in step 13 is the safety net.
11. **Add the new tests** (paused-controls DOM presence, listener-reactive MutationObserver, clear-confirm, end-handoff round-trip).
12. **Extend `exporter.golden.test.ts`** with the byte-identical Download ≡ End assertion.
13. **Add the no-legacy-ids grep test.**
14. **Add the e2e spec.** Two `test()` blocks in one file.
15. **Update `docs/ARCHITECTURE.md`** Side Panel section + new changelog row.
16. **Run** `make typecheck && make test && make build`. Manual smoke in `chrome://extensions`.

---

### Definition of Done (Final)

- [ ] **DoD-1** Pre-session shows exactly: Start, PII mode picker, connection-status pill. No Reset, no residual-state controls.
- [ ] **DoD-2** Active (running) session shows exactly: Pause, plus annotation/picker controls and the capture-mode indicator.
- [ ] **DoD-3** Paused session shows: Resume + Download/Clear (only when timeline has material events) + End (only when listener attached).
- [ ] **DoD-4** Empty paused session shows ONLY Resume — Download and Clear absent from DOM (hide-not-disable, `querySelector === null`).
- [ ] **DoD-5** Attaching a listener while paused adds End live; detaching removes it live — no panel re-mount; `#events-list` node identity preserved across the transition.
- [ ] **DoD-6** Clear shows the destructive confirmation dialog matching today's Discard copy and behaviour. Cancel path = zero storage writes (spy-pinned).
- [ ] **DoD-7** End triggers the same `EXPORT_SESSION` → `performHandoff` path as today's Stop+listener; byte-identical zip; transitions to pre-session on success.
- [ ] **DoD-8** Existing `stop-btn`, `discard-btn`, `reset-btn` ids removed from the rendered DOM and from production source. Tests migrated to `download-btn`, `clear-btn`, `end-btn`.
- [ ] **DoD-9** Unit tests cover: each paused-state visibility combination (4 cells), live attach update, Clear cancel zero-writes, End → handoff round-trip.
- [ ] **DoD-10** E2E: Start (full mode) → type → Pause → Download visible → Download → exported zip contains the typed input event.
- [ ] **DoD-11** E2E: Start → Pause (no events) → only Resume visible → Resume → type → Pause → Download/Clear appear.
- [ ] **DoD-12 (SAFE)** Byte-identical zip parity: zip bytes from Download path === zip bytes from End path === golden fixture bytes (extended assertion in `exporter.golden.test.ts`).
- [ ] **DoD-13 (SAFE)** `schema_version` constant in `agents-doc.ts` is unchanged at 1.2.0 (regression assertion).
- [ ] **DoD-14 (SAFE)** End button is structurally absent (`querySelector === null`) when `getHandoffConfig()` returns null, even in paused state with events.
- [ ] **DoD-15 (SAFE)** Live attach DOM mutation is scoped: MutationObserver records show only `#end-btn` added/removed; `document.activeElement` preserved; toolbar children count delta is exactly +1 / −1.
- [ ] `make typecheck` passes.
- [ ] `make test` passes.
- [ ] `make build` passes.
- [ ] `docs/ARCHITECTURE.md` Side Panel section + changelog updated; no `manifest.json` / `package.json` version bump.

### Test Level Matrix (Final)

| # | Acceptance Criterion | Test Level | Rationale |
|---|---------------------|------------|-----------|
| DoD-1 | Pre-session control set | Unit | Pure `buildControlsModel` matrix row + jsdom `querySelector` check |
| DoD-2 | Active control set | Unit | Same — pure model + jsdom |
| DoD-3 | Paused 2×2 contextual matrix | Unit | Pure 4-row table; deterministic |
| DoD-4 | Empty paused: Resume only | Unit | jsdom `querySelector === null` check; pure DOM |
| DoD-5 | Live attach without re-mount | Integration | Crosses `runtimeListener` ↔ `applyControlsModel` boundary; jsdom + `chrome.runtime.onMessage` shim |
| DoD-6 | Clear cancel = zero writes | Integration | jsdom + `sendMessage`/storage spies (mirrors existing discard test) |
| DoD-7 | End → handoff POST round-trip | Integration | Crosses panel ↔ SW message router ↔ `performHandoff` ↔ fetch boundary; mock fetch |
| DoD-8 | Old ids absent | Unit (grep) | Static check on source files; deterministic |
| DoD-9 | Combinatoric coverage | Unit + Integration | Subsumed by DoD-1..7 |
| DoD-10 | Full Download lifecycle (typed input in zip) | E2E | Critical user journey; only level that exercises real `chrome.downloads` |
| DoD-11 | Empty pause → resume → events flow | E2E | Critical user journey for the empty/non-empty visibility transition |
| DoD-12 | Byte-identical zip parity | Integration | Boundary at exporter; pure byte comparison; deterministic clock fixture |
| DoD-13 | `schema_version` regression | Unit | Static constant assertion |
| DoD-14 | End absent without handoff config | Unit | jsdom `querySelector === null` |
| DoD-15 | Live attach DOM mutation scoped | Integration | jsdom + MutationObserver; tests the boundary between broadcast and DOM mutation |

**Rules applied**: default to unit; integration only at component boundaries (SW ↔ panel ↔ fetch); e2e only for the two critical user journeys explicitly required by the roadmap.

**Determinism**: all tests deterministic. The fetch boundary in DoD-7/DoD-12 is mocked. No live LLM calls; no LLM-adjacent criteria in this feature.

### Testing Strategy (Final)

- **Unit (Vitest)**:
  - `tests/sidepanel-controls.test.ts` — 16-row matrix on `buildControlsModel`. Plus `countMaterialEvents` test (filters session_paused/resumed).
  - `tests/sidepanel-paused-controls.test.ts` (new) — for each state cell, mount the panel and assert presence/absence of every lifecycle button.
  - `tests/sidepanel-no-legacy-ids.test.ts` (new) — file grep for the old id strings.
  - `tests/session-status.test.ts` (existing) — runs unchanged. Its continued passing IS the assertion that the formal model is intact.

- **Integration (Vitest + jsdom)**:
  - `tests/sidepanel-clear-confirm.test.ts` (new, replaces existing discard-cancel) — counts fetched fresh, Cancel = zero writes, Confirm = single atomic `chrome.storage.local.remove`.
  - `tests/sidepanel-listener-reactive.test.ts` (new) — broadcast `PENDING_HANDOFF_CHANGED`; MutationObserver asserts only `#end-btn` mutates; focus preserved; `#events-list` node identity preserved.
  - `tests/sidepanel-end-handoff.test.ts` (new) — full round-trip through SW message router using fake fetch.
  - `tests/service-worker-handoff.test.ts` (extend) — add End path with same auth header + same `X-DeskCheck-Session-Id`.
  - `src/lib/exporter.golden.test.ts` (extend) — Download bytes === End bytes === golden fixture.

- **E2E (Playwright)**:
  - `e2e/sidepanel-lifecycle-feature17.spec.ts` (new, 2 test blocks):
    1. **DoD-10**: Start (full) → type → Pause → assert `#download-btn` visible AND `#stop-btn === null` → Download → unzip → assert `session.json` timeline contains the input interaction event.
    2. **DoD-11**: Start → immediately Pause (no events) → assert `#download-btn === null && #clear-btn === null && #pause-btn !== null` (now labelled Resume) → Resume → type → Pause → assert `#download-btn !== null && #clear-btn !== null`.

  Both tests grouped in one file with shared `test.beforeEach` to amortise the auth+unlock cost (one full setup, not two).

  **Existing e2e specs affected**: any spec that selects `#stop-btn`, `#discard-btn`, or `#reset-btn`. Predicted: 3-6 specs (likely candidates: `e2e/sidepanel-debug.spec.ts`, `e2e/input-capture.spec.ts`, any pause-resume or handoff specs). Migration is mechanical id rename. The grep test will catch stragglers.

### Risk Mitigations (Final)

1. **Data loss via a non-Clear path**: every event-drop button click handler must route through `confirmDiscardBtn`. Pinned by `tests/sidepanel-clear-confirm.test.ts` (cancel = zero writes) and the unchanged `session-status.test.ts` (the formal machine doesn't grow new event-drop transitions).
2. **Accidental data exfiltration via End**: End is structurally absent without a handoff config (DoD-14). The connection-status pill already shows "Attached: <url>" alongside End. End reuses `armedSessions` token gating (existing handoff invariant).
3. **Schema regression**: byte-identical zip parity test (DoD-12) + `schema_version === 1.2.0` regression check (DoD-13).
4. **Stale test-id references**: file-level grep test (`tests/sidepanel-no-legacy-ids.test.ts`) fails fast on any orphan reference in `src/`/`tests/`/`e2e/`/`cli/`/`docs/` (allow-list this plan + changelog).
5. **Reactive listener disrupts focus or layout**: MutationObserver test asserts only `#end-btn` mutates; `document.activeElement` preserved; toolbar children count delta is exactly ±1 (DoD-15).
6. **End fall-through behaviour**: End reuses Stop's existing fall-through (handoff failure → `chrome.downloads` fallback + `EXPORT_WARNING`). S12 retention invariant preserved.
7. **Token leak via End button**: `tests/sidepanel-no-handoff-write.test.ts` (existing) extended to scope-check the End button construction. Token never touches DOM.
8. **Dialog disrupted by listener attach mid-confirmation**: `applyControlsModel()` already preserves dialog visibility via `discardDialog.classList.contains("hidden")`. Test extends to cover attach-while-dialog-open.

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | N | Y (mild) | Y | Y (mild) |
| State machine | N | N | N | N |
| Conservation | N | N | Y (data egress) | N |
| Authorization | N | N | N | N |

**Recommendation**: **SKIP** Phase 2.5. The state machine (`SessionStatus`) is small (4×7) and exhaustively pinned by `session-status.test.ts`; this feature does NOT modify it. The new `ControlVisibility` flags are pure boolean predicates over a 4-element enum with two boolean inputs — table-driven unit tests provide identical coverage to a TLA+ proof at a fraction of the cost. Concurrency is single-threaded JS with one async event source (storage onChanged) interleaved with user clicks; the existing `applyControlsModel`-on-every-change discipline plus click-handler status re-checks (`if (status !== "paused") return;`) handle this. The byte-identical zip parity test pins the conservation law for data egress.

**Verification focus**: N/A (skipping).

**Key invariants** (tracked by tests, not proofs):
- "Pause never loses events" — existing `tests/sidepanel-pause-resume.test.ts`.
- "Capture stops while paused" — `isCaptureActive` predicate, table-pinned.
- "Hidden controls are absent from the DOM" — DoD-1..4 + DoD-14.
- "End and Download produce byte-identical zips" — DoD-12.
- "End never POSTs without a token-gated handoff config" — DoD-7 + DoD-14.
- "Clear never deletes events without explicit confirmation" — DoD-6.

---

## Acceptance Test List (Executable, 17 tests)

These map onto the DoD; each is a single self-contained "When X, then Y" assertion that test-writer can turn into one or more `it()` blocks.

1. **Pre-session control surface (DoD-1)** — Unit — `tests/sidepanel-controls.test.ts`
   When `buildControlsModel({status: "idle", hasResidualState: false, hasEvents: false, listenerAttached: false})` is called, then it returns `{start: true, piiMode: true, piiIndicator: false, pause: false, download: false, clear: false, end: false, reset: false}`.

2. **Running control surface (DoD-2)** — Unit — `tests/sidepanel-controls.test.ts`
   When `buildControlsModel({status: "running", hasEvents: true, listenerAttached: true, hasResidualState: false})` is called, then `pause: true`, `piiIndicator: true`, `piiMode: false`, `download: false`, `clear: false`, `end: false`, `start: false`. (Listener attachment must NOT surface End mid-recording.)

3. **Paused 4-cell contextual matrix (DoD-3, DoD-9)** — Unit — `tests/sidepanel-controls.test.ts`
   For each of the four cells `paused × {hasEvents: false, true} × {listenerAttached: false, true}`, `buildControlsModel` returns the expected `{download, clear, end}` triple per the roadmap rules. (`download = clear = hasEvents`; `end = listenerAttached`.)

4. **Empty paused — only Resume in DOM (DoD-4)** — Unit (jsdom) — `tests/sidepanel-paused-controls.test.ts`
   When the panel is mounted in `paused` state with zero material events and no listener, then `document.querySelector("#download-btn") === null && #clear-btn === null && #end-btn === null && #pause-btn !== null`.

5. **`countMaterialEvents` filters pause/resume markers (DoD-4)** — Unit — `tests/sidepanel-controls.test.ts`
   When `countMaterialEvents([{type: "session_paused"}, {type: "session_resumed"}])` is called, then it returns 0. When the array also contains an interaction event, then it returns 1.

6. **Live attach updates End live, no remount (DoD-5)** — Integration (jsdom + MutationObserver) — `tests/sidepanel-listener-reactive.test.ts`
   When the panel is in paused state with events, no listener attached, and a `PENDING_HANDOFF_CHANGED` message with `{active: {url, token}}` is broadcast, then `#end-btn !== null` AND the `#events-list` node reference is the same node it was before the broadcast AND no `mountSidePanel` re-invocation occurs.

7. **Live attach mutation scope (DoD-15)** — Integration (jsdom + MutationObserver) — `tests/sidepanel-listener-reactive.test.ts`
   When listener attach is broadcast with focus on `#pause-btn`, then MutationObserver records exactly one added node (`#end-btn`) inside the toolbar lifecycle row, `document.activeElement` remains `#pause-btn`, and toolbar children count differs by exactly +1.

8. **Live detach removes End cleanly (DoD-5)** — Integration — `tests/sidepanel-listener-reactive.test.ts`
   When listener is attached then detached via two consecutive `PENDING_HANDOFF_CHANGED` broadcasts, then `#end-btn` is null after detach, no orphaned nodes remain, and idempotent re-broadcasts produce no extra mutations.

9. **Clear cancel = zero storage writes (DoD-6)** — Integration — `tests/sidepanel-clear-confirm.test.ts`
   When the user clicks `#clear-btn` (paused, with events), the confirmation dialog opens, then clicks `#cancel-clear-btn`, then `sendMessage` was never called with `DISCARD_SESSION` AND the storage spy shows zero writes AND the events array in the DOM is unchanged.

10. **Clear confirm = single atomic remove (DoD-6)** — Integration — `tests/sidepanel-clear-confirm.test.ts`
    When the user clicks `#clear-btn` then `#confirm-clear-btn`, then exactly one `DISCARD_SESSION` message is sent AND the post-state shows `status: "idle"` with empty events.

11. **Clear dialog counts come from fresh storage (DoD-6)** — Integration — `tests/sidepanel-clear-confirm.test.ts`
    When the dialog opens, then the displayed counts come from a fresh `chrome.storage.local.get` call (storage read spy fires at open time), not from any in-memory mirror.

12. **End → handoff POST round-trip (DoD-7)** — Integration — `tests/sidepanel-end-handoff.test.ts`
    When `#end-btn` is clicked (paused, events present, listener attached), then `EXPORT_SESSION` is dispatched, `performHandoff` is called with the bearer token from the handoff config, the request body bytes equal the precomputed control zip, and on a 200 response the panel transitions to `idle`.

13. **End on 403 retains session (DoD-7, S12)** — Integration — `tests/sidepanel-end-handoff.test.ts`
    When the handoff POST returns 403, then `EXPORT_WARNING` is surfaced in `#async-error`, the OPFS session is NOT cleared, and the user can retry.

14. **End absent without handoff config (DoD-14)** — Unit (jsdom) — `tests/sidepanel-paused-controls.test.ts`
    When the panel is in paused state with events but `getHandoffConfig()` returns null, then `document.querySelector("#end-btn") === null`.

15. **Old ids removed from source (DoD-8)** — Unit (grep) — `tests/sidepanel-no-legacy-ids.test.ts`
    When the test scans `src/`, `tests/`, `e2e/`, `cli/`, `docs/ARCHITECTURE.md`, `docs/roadmap.md` for the literals `"stop-btn"`, `"discard-btn"`, `"reset-btn"`, then zero matches are found outside the allow-list (this plan + changelog row + historical roadmap section).

16. **Byte-identical zip: Download ≡ End ≡ golden (DoD-12)** — Integration — `src/lib/exporter.golden.test.ts`
    Given a fixture session with N events, a pause/resume cycle, and a screenshot, when the export is exercised via the production code path twice (once routed to the download branch, once routed to the End/handoff branch), then both byte arrays are deep-equal AND both equal the stored golden fixture.

17. **Schema version unchanged (DoD-13)** — Unit — `src/lib/exporter.golden.test.ts`
    When the test reads the `SCHEMA_VERSION` constant from `agents-doc.ts`, then it equals `"1.2.0"` exactly. (Static regression assertion.)

18. **E2E Download lifecycle (DoD-10)** — E2E — `e2e/sidepanel-lifecycle-feature17.spec.ts`
    When the user starts a session in `full` mode, types into a fixture page input, returns to the side panel, clicks Pause, verifies `#download-btn` visible and `#stop-btn` absent, clicks Download, then the downloaded zip's `session.json` timeline contains an `interaction.subtype === "input"` event reflecting the typed value.

19. **E2E empty paused → events flow (DoD-11)** — E2E — `e2e/sidepanel-lifecycle-feature17.spec.ts`
    When the user starts a session and immediately pauses with no captured events, then only `#pause-btn` (relabelled Resume) is visible in the lifecycle row AND `#download-btn === null && #clear-btn === null`. When the user resumes, types, and pauses again, then `#download-btn` and `#clear-btn` are now both visible.

(19 acceptance tests — within the 12-20 target band; Acceptance Tests 1-3 are intentionally separate so test-writer can keep each as a focused `it()` block.)

## Out-of-Scope Clarifications

The plans diverged or hinted at over-builds in several places. The following are **explicitly NOT in scope** for this PR:

1. **`SessionStatus` machine changes.** `src/lib/session-status.ts` is untouched. The 4×7 transition table stays. `discard`/`reset`/`stop` remain legal actions in the machine even though the UI no longer surfaces them — the table documents what is legal, not what the current UI happens to invoke. (Quality plan's framing accepted; rejects any Speed-style "drop reset row" attempts.)

2. **No new SW message types.** End reuses the existing `EXPORT_SESSION` SW handler; the existing handoff branch in `service-worker.ts` already routes to `performHandoff` when a handoff config is set. **The Speed plan's `END_SESSION` message is rejected** — it adds scope and is not required by the roadmap (which says "the same handoff POST path as today's Stop+listener").

3. **No End-confirmation dialog.** Safety plan's Failure Modes Analysis #1 suggested gating End behind the pre-export reminder. Rejected — the connection-status pill is sufficient signal, and adding a confirmation would inflate the verb surface this feature is shrinking.

4. **No schema changes.** `schema_version` stays at 1.2.0. No new event types. No new `session.json` fields. Pinned by DoD-13 regression assertion.

5. **No SW handler removals.** `RESET_SESSION` and `DISCARD_SESSION` SW handlers remain. UI no longer invokes `RESET_SESSION` from the panel; the handler stays for symmetry with `isResetEligible()` and to support future internal cleanup paths. Documented inline in `service-worker.ts`.

6. **No `pause`/`resume` flag separation in `ControlVisibility`.** Quality plan suggested splitting `pause` into separate `pause` and `resume` flags. Rejected as mild over-engineering — the existing single `pause` flag with label-swap glue in `sidepanel.ts` is fine and minimises diff.

7. **No exporter or handoff internals changed.** `src/lib/exporter.ts` and `src/background/handoff-post.ts` are untouched. End is a button that dispatches an existing message; the byte-identical zip property follows from reusing the existing path, not from a new code path.

8. **No `manifest.json` / `package.json` version bump.** This is unreleased work captured in the changelog as an `(unreleased)` row.

9. **No new icons added to the bundle.** End uses an existing imported Lucide icon (e.g. fall back to `LucideX` or reuse an existing one) to avoid bundle churn. Bespoke styling for the End button beyond `sp-btn primary` is a follow-up.

10. **The orphaned pre-export reminder DOM is deleted, not left in place.** Speed plan suggested leaving it for a follow-up; rejected because keeping it preserves the latent `#download-btn` id collision that Quality plan correctly identifies. The reminder DOM stays for the Download flow; only the duplicate `id="download-btn"` on the reminder confirm button is renamed to `#confirm-export-btn`.

---

## Orchestrator Handoff

This evaluation is the **final decision** — no human checkpoint follows.

**Summary for git commit**:
- Selected plan: **Synthesized** (Quality-anchored, Safety-augmented).
- Key rationale: Treat this as a UI-surface simplification on top of an unchanged engine. Maximise reuse of existing primitives (`buildControlsModel`, `EXPORT_SESSION`, discard dialog, `PENDING_HANDOFF_CHANGED` broadcast); pin the load-bearing invariants (byte-identical zip parity, hide-not-disable, schema_version, live-attach mutation scope) with a small set of focused regression tests.
- Estimated effort: ~3.5 hours (single PR, single orchestration session).
- Key risks: stale test-id references (mitigated by grep test), schema regression (mitigated by byte-identical zip + version assertion), live-attach focus/layout disruption (mitigated by MutationObserver test).
- Test levels: 9 unit, 8 integration, 2 e2e (19 acceptance tests total).
