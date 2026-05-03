---
agent: quality-planner
generated: 2026-05-03T00:00:00Z
task_id: feature-17
perspective: quality
---

# Quality Plan: Simplify session lifecycle — Pause-first, contextual exits

## Architecture reference

### Cited sections of `docs/ARCHITECTURE.md`

- **Side Panel section (lines 42–48)** — establishes the three-region layout (`#toolbar`, `#events-list`, `#controls`), and the **hide-not-disable contract**: "children of `#toolbar` and `#controls` are structurally appended/removed from `buildControlsModel()` — nothing is toggled via `display: none`, so the DoD phrase 'absent from the DOM' is pinned by `querySelector === null` tests." Feature 17 must extend this pattern, not break it.
- **Side Panel section, discard dialog (line 47)** — the discard dialog reads counts from a fresh `chrome.storage.local.get` at dialog-open time and Cancel performs **zero storage writes**, spy-pinned. Clear inherits this contract verbatim.
- **Shared Libraries: `session-status.ts` (line 51)** — "Pure state machine for the session lifecycle… Exports `nextStatus(current, action)` with a full transition table, plus `isCaptureActive` / `isLifecycleControlVisible` / `isResetEligible` predicates… The 4-state × 7-action transition table is pinned by a table-driven unit test (`session-status.test.ts`) — this IS the formal model for the lifecycle."
- **Shared Libraries: `sidepanel-controls.ts` (line 52)** — "Pure view-model: `buildControlsModel({status, hasResidualState})` returns a declarative `ControlVisibility` shape describing which nodes should be mounted in `#controls`."
- **Changelog: schema 1.2.0 / feature #11** — Reset's "non-destructive clear that runs only from `stopped`/`idle` with residual state — no confirmation"; Discard's "destructive mid-session action gated by a confirmation dialog… Cancel is a pure UI close with ZERO storage writes (spy-pinned). Confirmed discard calls a single atomic `remove([SESSION, EVENTS, SCREENSHOTS])`".
- **Changelog: feature #16** — `ControlVisibility.piiIndicator` and `piiMode` are mutually exclusive; "exactly one is true at any status." We must preserve this invariant.
- **CLI handoff (phase 2) section (lines 127–164)** — `PENDING_HANDOFF_CHANGED` broadcasts and the active vs pending handoff store are the live signal sources for End visibility.

### How the new surface maps onto the existing `SessionStatus` machine

The four-state machine `idle | running | paused | stopped` stays exactly as is. **No state is added or removed.** What changes is purely the **action surface** exposed to the user and how view-model flags map onto verbs:

| New verb on UI | Existing action in `session-status.ts` | From state | To state |
|----------------|------------------------------------------|-----------|----------|
| Start | `start` | `idle` / `stopped` | `running` |
| Pause | `pause` | `running` | `paused` |
| Resume | `resume` | `paused` | `running` |
| Download | `stop` then `export_complete` | `paused` | `stopped` → `idle` |
| Clear | `discard` | `paused` | `idle` |
| End | `stop` then `export_complete` (with handoff transport) | `paused` | `stopped` → `idle` |

**Critical insight**: Download, Clear, and End all dispatch from the **paused** state only — never from running. This is the simplification: the only mid-recording action is Pause. The state machine already permits all of these transitions from `paused` (rows 71–74 of `session-status.ts`); we are removing options from the UI, not from the model.

### Should `SessionAction` shrink?

**Recommendation: Keep `SessionAction` exactly as is.** Specifically:

- `discard` stays as an action — it is the underlying transition that Clear invokes.
- `stop` stays — both Download and End invoke it.
- `reset` stays — it remains legal from `stopped`/`idle` but is no longer triggered by any UI button. The service worker still services `RESET_SESSION` messages defensively (e.g. for tests, future internal cleanup, or service-worker resync after a crash where residual state is observed). The handler stays; the message is simply no longer sent from the panel under feature 17.
- The `running → discard → idle` transition row stays in the table even though the UI never invokes it from running. Removing it would (a) require a schema change to the formal model that has no functional benefit, and (b) make future refactors (e.g. a "panic stop" hotkey) require re-introducing the row. The transition table documents what is **legal**, not what is **reachable from the current UI**. Keeping the row preserves the "code is read more often than written" property — a future maintainer reading the table sees the full set of safe transitions, not just the ones today's UI happens to use.

**Alternative considered and rejected**: deleting `discard` from `running`. Tempting because the new UI cannot reach it, but it would force `tests/session-status.test.ts` row deletions and create a correctness gap if any production code path (e.g. a future global "abort" shortcut) wanted to invoke it. The cost (extra row in a 4×7 table) is trivial; the benefit of preserving the formal invariant `paused ↔ running` symmetry is real. Document this decision inline in `session-status.ts`.

### Invariants that MUST survive

1. **Capture gate**: `isCaptureActive(status) === (status === "running")`. Unchanged.
2. **Hide-not-disable**: every conditionally-visible control is **structurally absent** from the DOM, not toggled via CSS. Verified by `querySelector(...) === null`.
3. **piiMode XOR piiIndicator**: exactly one is true at any status. Feature 16 contract — must not regress.
4. **Discard cancel = zero storage writes**: spy-pinned in existing `tests/sidepanel-controls.test.ts`. Clear must inherit this verbatim.
5. **Marker-before-flag write order**: `session_paused` event is awaited before `session.status` flips (existing — `service-worker.ts` PAUSE_SESSION at lines 419–432). Unchanged.
6. **Atomic discard storage write**: `remove([SESSION, EVENTS, SCREENSHOTS])` as one batched onChanged. Inherited by Clear.
7. **End produces byte-identical zip** (feature #14 invariant): no new code path; the handoff POST is the same `performHandoff` invocation EXPORT_SESSION already uses. Pinned by `tests/service-worker-handoff.test.ts` and the `exporter.golden.test.ts` D10 row.
8. **No `schema_version` bump**. Pause/Resume markers stay. End is a transport choice for an existing zip, not a new event.

### Files that MUST change

**Sidepanel layer** (the obvious ones):
- `src/sidepanel/sidepanel.ts` — DOM wiring, button ids, click handlers, applyControlsModel branching, listener-attached subscription.
- `src/lib/sidepanel-controls.ts` — `ControlVisibility` shape gains `download`, `clear`, `end`; loses `stop`, `discard`, `reset`. `ControlsModelInputs` gains `hasEvents` and `listenerAttached` to drive paused-state visibility reactively.

**Beyond the obvious**:
- `src/sidepanel/sidepanel-handoff-badge.ts` — reused as the listener-attached signal source (already returns `{visible, tone}` for armed vs connected). The panel will subscribe to `PENDING_HANDOFF_CHANGED` broadcasts (already plumbed in `service-worker.ts:297–301, 542–547, 579`) and use `active != null` as the source-of-truth for the End button. **No changes to this file** — we just consume it.
- `tests/sidepanel-controls.test.ts` (existing) — every assertion that touches `stop`, `discard`, `reset`, `stop-btn`, `discard-btn`, `reset-btn` must migrate to `download`, `clear`, `end`, `download-btn`, `clear-btn`, `end-btn`. Inventoried in Risk Assessment.
- `tests/session-status.test.ts` (existing) — **no transition-table changes** (per the recommendation above) but a new assertion block confirms the rationale for keeping legacy rows.
- `tests/sidepanel-pause-resume.test.ts` (existing) — assertions about post-pause control visibility migrate.
- `tests/service-worker-pending-handoff.test.ts` — extend (not replace) the existing Stop-with-listener-attached test to drive End from the new button id and assert the handoff POST round-trip.
- `e2e/*.spec.ts` — any spec that clicks `#stop-btn`, `#discard-btn`, `#reset-btn` is migrated. New e2e spec for the empty-paused-state-shows-only-Resume DoD-9.
- `docs/ARCHITECTURE.md` — Side Panel section + new changelog entry. Specified in §6.
- `manifest.json` / `package.json` — **no version bump** (unreleased changelog row).

**Files that MUST NOT change** (verified by reading):
- `src/lib/session-status.ts` — keep the table as-is per recommendation.
- `src/background/service-worker.ts` STOP/DISCARD/RESET handlers — Clear maps to DISCARD_SESSION; Download and End both map to STOP_SESSION + EXPORT_SESSION. No new message types. The transport branch in EXPORT_SESSION (lines 818–833) already routes to performHandoff when a handoff is configured — that IS the End path.
- `src/lib/exporter.ts`, `src/background/handoff-post.ts` — End reuses everything.

## Architectural Approach

Treat the action set as a **model concern**, not a render concern. Feature 17 widens `ControlsModelInputs` from `{status, hasResidualState}` to `{status, hasResidualState, hasEvents, listenerAttached}`, returns a `ControlVisibility` whose paused-state flags (`download`, `clear`, `end`) are pure boolean functions of those inputs, and re-runs `applyControlsModel()` whenever any input changes. The state machine, the storage layer, and the export path are **untouched** — we are simplifying a UI surface that sits on top of an unchanged engine.

The reactive listener-attached update (DoD-5) reuses the existing `PENDING_HANDOFF_CHANGED` broadcast and the existing `runtimeListener` in `sidepanel.ts`. We add one branch to that listener that flips a local `listenerAttached` boolean and calls `applyControlsModel()` — no panel re-mount, same DOM nodes preserved across the transition (verified by reference equality of the events list children).

## Files to Create/Modify

| File | Purpose | Quality Considerations |
|------|---------|----------------------|
| `src/lib/sidepanel-controls.ts` | Widen `ControlsModelInputs` and `ControlVisibility`; map paused state to {resume, download?, clear?, end?} | Pure module, table-driven test friendly. Document the new flags inline. Preserve XOR `piiMode`/`piiIndicator`. Add JSDoc on each new flag explaining the visibility predicate. |
| `src/sidepanel/sidepanel.ts` | Replace stopBtn/discardBtn/resetBtn with downloadBtn/clearBtn/endBtn; rewire click handlers; subscribe to `PENDING_HANDOFF_CHANGED` for End reactivity | Reuse `iconBtn` helper, `withLoadingState`, the discard dialog (rename to clear-confirm-dialog), the existing pre-export reminder for Download. Listener-attach logic added to existing `runtimeListener`, not a new subscription. |
| `tests/sidepanel-controls.test.ts` | Migrate id assertions; add per-state DOM-presence/absence matrix tests | Table-driven. One row per (status, hasEvents, listenerAttached) cell. Document each migrated test with its old name in a comment so future archaeology is easy. |
| `tests/sidepanel-pause-resume.test.ts` | Migrate ids; extend with empty-paused = Resume-only assertion | Reuse existing harness. |
| `tests/sidepanel-clear-confirm.test.ts` (new) | Clear destructive-confirm: counts fetched fresh, Cancel = zero storage writes, Confirm = single atomic remove | Mirror the existing discard test verbatim — same storage spies, same assertion shape. New file rather than additions to keep the diff readable. |
| `tests/sidepanel-listener-reactive.test.ts` (new) | Listener attach/detach during pause updates End visibility live, no re-mount | Capture `eventsList.children[0]` reference before broadcast, assert it === the same node after. New file. |
| `tests/sidepanel-end-handoff.test.ts` (new, replaces or extends a section of `tests/service-worker-pending-handoff.test.ts`) | End → STOP_SESSION + EXPORT_SESSION → performHandoff round-trip with byte-identical zip | Use existing fake-session-store + fake fetch. Assert request body bytes match a control-zip from `exportSessionStreaming`. |
| `tests/session-status.test.ts` | Add a comment-only assertion documenting why the running-discard row stays | Architectural note as a test, so a future deletion attempt has a comment to read first. |
| `e2e/sidepanel-lifecycle-feature17.spec.ts` (new) | Two e2e flows from DoD-7 and DoD-8 | Group the assertions tightly — each spec runs Start → … in a single browser context to amortise auth+unlock cost. |
| `docs/ARCHITECTURE.md` | Updated Side Panel section, new changelog entry | See §6. |

**Total files**: 10 (4 modified, 4 new tests, 1 new e2e spec, 1 docs).

## Implementation Steps

1. **Lock the contract first.** Update `src/lib/sidepanel-controls.ts`: add `hasEvents: boolean` and `listenerAttached: boolean` to `ControlsModelInputs`; in `ControlVisibility` rename `stop → download`, `discard → clear`, drop `reset` (now always false from this view-model — see step 7), add `end`. Encode the predicates:
   - `download = status === "paused" && hasEvents`
   - `clear = status === "paused" && hasEvents`
   - `end = status === "paused" && listenerAttached`
   - `pause = status === "running"` (paused state shows Resume-via-pauseBtn-label-swap, but the visibility flag becomes `running`-only; the Resume case is governed by a new `resume = status === "paused"` flag for clarity, even though it currently shares the pauseBtn DOM node)
   *Quality rationale*: separating `pause` from `resume` flags makes the table-driven test easier to read and reduces the cognitive load of "the pause button is also the resume button" hidden inside a label swap. The DOM-level reuse (one button, swapped icon/label) stays inside `sidepanel.ts`.
2. **Write the table-driven test before the renderer.** Add to `tests/sidepanel-controls.test.ts` a 4×2×2 = 16-row table (status × hasEvents × listenerAttached) listing the expected `ControlVisibility`. Several rows should be impossible (e.g. `idle && hasEvents` is contradictory under feature 17 — pre-session is post-Clear, no events) — assert them as such. The test fails red because `buildControlsModel` does not yet read the new inputs. *Quality rationale*: TDD on the pure module — the model becomes the spec.
3. **Implement `buildControlsModel`** to satisfy the table. *Quality rationale*: pure-function-first means zero DOM coupling in the riskiest piece of logic.
4. **Migrate `sidepanel.ts` button ids**: `stopBtn → downloadBtn (id "download-btn")`, `discardBtn → clearBtn (id "clear-btn")`, add `endBtn (id "end-btn")`. **Remove** the existing pre-export reminder ID collision: today's confirm-download button inside the reminder panel is also `id="download-btn"` — rename it to `id="confirm-export-btn"` to free up `download-btn` for the toolbar entry point. *Quality rationale*: id collision today is a latent bug (two `#download-btn` in the same DOM under stopped state would break querySelector); fixing it as part of the migration prevents a regression.
5. **Rewire click handlers.** Download click opens the existing pre-export reminder; the reminder's confirm-export-btn dispatches STOP_SESSION + EXPORT_SESSION (unchanged from today's stopBtn flow). Clear click opens the renamed clear-confirm-dialog (was discard-confirm-dialog) with copy "Delete N events and M screenshots? This cannot be undone." — copy stays, ids change. End click dispatches STOP_SESSION + EXPORT_SESSION (the existing handoff branch in `service-worker.ts` will route to `performHandoff` because a listener is attached). *Quality rationale*: maximum reuse — the only thing changing is which button opens which existing dialog and which message is sent.
6. **Wire listener reactivity.** In `sidepanel.ts`, track `let listenerAttached = false` next to the existing `handoffAttachedUrl`. Initialise from the same `getHandoffConfig()` read that already runs at mount. In the existing `runtimeListener`, add a `case "PENDING_HANDOFF_CHANGED": listenerAttached = msg.active != null; applyControlsModel(); return;` branch. *Quality rationale*: zero new subscriptions, zero new abstractions — it rides on plumbing the SW already broadcasts and the panel already listens to.
7. **Remove resetBtn from the toolbar.** The `resetBtn` HTML node and click handler can be deleted from `sidepanel.ts`. The `RESET_SESSION` SW handler stays. The `isResetEligible` predicate stays in `session-status.ts` (still used internally by future code paths). *Quality rationale*: removing dead UI is cheap and unambiguous; keeping the underlying primitive available for tests / future hotkeys is cheap insurance.
8. **Handle the empty-paused edge case**. If the user pauses immediately after Start with no events captured, only Resume should appear (DoD-4, DoD-9). The `hasEvents` input must reflect timeline events including or excluding the auto-injected `session_paused` marker. **Decision: exclude pause/resume markers from the count.** Pause markers are user-action artefacts, not user-captured signal — counting them would mean "paused for 0.2s with no input" still shows Download. Implement a helper `countMaterialEvents(events)` in `sidepanel-controls.ts` that filters `session_paused` and `session_resumed`. *Quality rationale*: aligns the visibility predicate with user mental model ("did I capture anything worth keeping?").
9. **Migrate existing tests.** Run the test suite, fix every red test by replacing old ids with new ones. Cross-check against the inventory in §Risks.
10. **Add the new tests** (`sidepanel-clear-confirm.test.ts`, `sidepanel-listener-reactive.test.ts`, `sidepanel-end-handoff.test.ts`).
11. **Add the e2e spec.** Two `test()` blocks in one file to amortise the per-spec auth+unlock cost.
12. **Update `docs/ARCHITECTURE.md`** Side Panel section and changelog. *Quality rationale*: documentation drift is the most common source of "why is this code this way?" archaeology.

## Definition of Done

| # | DoD item (from roadmap) | Verification |
|---|--------------------------|--------------|
| DoD-1 | Pre-session shows exactly: Start, PII picker, status pill | `tests/sidepanel-controls.test.ts` table row `status=idle, hasEvents=false, listenerAttached=*` asserts `start: true, piiMode: true, piiIndicator: false, pause/resume/download/clear/end: false`. Plus DOM-level assertion that `#stop-btn`, `#discard-btn`, `#reset-btn`, `#clear-btn`, `#download-btn`, `#end-btn` all === null in idle state. |
| DoD-2 | Active session shows exactly: Pause + annotation/picker + capture-mode indicator | Table row `status=running` asserts `pause: true, resume: false, download/clear/end: false, annotation: true, elementPicker: true, piiIndicator: true, piiMode: false`. DOM assertion mirrors. |
| DoD-3 | Paused session shows Resume + Download/Clear when non-empty + End when listener attached | Table rows `status=paused, hasEvents=true, listenerAttached=true` ⇒ `{resume, download, clear, end} all true`; `paused, true, false` ⇒ `{resume, download, clear} true, end false`. |
| DoD-4 | Empty paused shows ONLY Resume — Download/Clear absent from DOM | Table row `status=paused, hasEvents=false, listenerAttached=false` ⇒ only `resume: true`. New jsdom test in `sidepanel-controls.test.ts` that mounts the panel and asserts `document.querySelector('#download-btn') === null && #clear-btn === null && #resume-btn !== null`. |
| DoD-5 | Listener attach/detach updates End visibility live, no re-mount | New `tests/sidepanel-listener-reactive.test.ts`: capture `const beforeNode = root.querySelector('#events-list')`; broadcast `PENDING_HANDOFF_CHANGED { active: {...} }`; assert `root.querySelector('#end-btn') !== null && root.querySelector('#events-list') === beforeNode`. Then broadcast detach, assert `#end-btn === null` and same node identity preserved. |
| DoD-6 | Clear shows destructive dialog matching Discard copy + cancel path | New `tests/sidepanel-clear-confirm.test.ts`: open Clear, snapshot dialog text === "Delete N events and M screenshots? This cannot be undone."; storage spy: `localSetSpy.mock.calls.length === 0` after Cancel; spy call count === 1 atomic remove after Confirm. |
| DoD-7 | End triggers same handoff POST as Stop-with-listener; byte-identical zip; exits to pre-session | `tests/sidepanel-end-handoff.test.ts`: build the same zip via `exportSessionStreaming` outside the test; click End; intercept fetch; assert request URL is loopback `/upload`, header `X-DeskCheck-Session-Id` matches; request body bytes deep-equal the control zip. After response 200, panel transitions to idle (`getStatus() === "idle"`). |
| DoD-8 | Old ids removed; tests migrated to new ids | grep test (`tests/sidepanel-no-legacy-ids.test.ts`, new): scan `src/sidepanel/sidepanel.ts` for the literals `"stop-btn"`, `"discard-btn"`, `"reset-btn"` and assert zero matches. Mirror grep for tests/ — assert no production code, only the legacy-id grep test itself, mentions them. |
| DoD-9 | Unit tests cover the four paused combinations + listener live update + Clear cancel + End round-trip | Covered by DoD-3, DoD-4, DoD-5, DoD-6, DoD-7 above. |
| DoD-roadmap-bullet-1 | E2E: Start (full mode) → type → Pause → Download visible → Download → exported zip contains input event | `e2e/sidepanel-lifecycle-feature17.spec.ts`: test 1. |
| DoD-roadmap-bullet-2 | E2E: Start → Pause (no events) → only Resume → Resume → type → Pause → Download/Clear appear | `e2e/sidepanel-lifecycle-feature17.spec.ts`: test 2. |

Plus generic:
- [ ] No linting / typecheck warnings (`make typecheck`)
- [ ] All existing tests still pass (`make test`)
- [ ] `docs/ARCHITECTURE.md` Side Panel section + changelog updated
- [ ] No `schema_version` change (`grep '"schema_version"' src/lib/agents-doc.ts` still says 1.2.0)
- [ ] `manifest.json` and `package.json` versions unchanged

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|---------------|----------------|-----------|
| 1 | DoD-1 (pre-session controls) | Unit | Pure table-driven assertion on `buildControlsModel` output; no Chrome APIs needed |
| 2 | DoD-2 (active controls) | Unit | Same — pure model |
| 3 | DoD-3 (paused 2x2 matrix) | Unit | Pure 4-row table |
| 4 | DoD-4 (empty paused) | Unit (jsdom) | Asserts DOM-level absence; jsdom is sufficient — no Chrome APIs |
| 5 | DoD-5 (listener live update) | Integration (jsdom) | Tests the boundary between the runtime broadcast and the view-model recompute; mocks the broadcast via the `onRuntimeMessage` shim already used in tests |
| 6 | DoD-6 (Clear cancel = zero writes) | Integration (jsdom + storage spy) | Tests the boundary between the dialog UI and the storage layer; mirrors the existing discard test which is the benchmark bar |
| 7 | DoD-7 (End → handoff round-trip) | Integration (fake-session-store + fake fetch) | Tests three boundaries (panel ↔ SW ↔ fetch). E2E would over-assert on Chrome plumbing already covered by the existing handoff e2e test |
| 8 | DoD-8 (legacy ids removed) | Unit (grep test, like `tests/sidepanel-no-direct-capture.test.ts`) | Static check on source files; no runtime needed |
| 9 | DoD-9 (paused combinations) | Unit | Covered by tests 1–4 |
| 10 | E2E roadmap bullet 1 (full lifecycle, exported zip contains input) | E2E | Tests the export-payload contract end-to-end — only level that exercises the real `chrome.downloads.download` and the real PII recording path |
| 11 | E2E roadmap bullet 2 (empty pause → resume → pause → controls appear) | E2E | Critical user journey for the "Pause is safe to use any time" behaviour pillar |

**Quality planner bias**: Prefer unit for logic, integration for boundaries, e2e sparingly. Each criterion maps to exactly ONE level.

**Determinism rule**: All tests are deterministic. The fetch boundary in DoD-7 is mocked. No live LLM calls are made anywhere; the export schema does not invoke an LLM.

## Testing Strategy

- **Unit**:
  - `tests/sidepanel-controls.test.ts` — 16-row matrix on `buildControlsModel(status × hasEvents × listenerAttached)`. Plus `countMaterialEvents` helper test (filters session_paused/resumed, counts everything else).
  - `tests/session-status.test.ts` — preserved table; add comment-only `it("documents that running→discard remains legal even though feature 17 UI never invokes it from running", ...)` so the kept row has a self-explanatory test name.
  - `tests/sidepanel-no-legacy-ids.test.ts` (new) — grep that `src/sidepanel/sidepanel.ts` does not contain `stop-btn`, `discard-btn`, `reset-btn`, `Stop`, `Discard`, `Reset` (as a substring of the iconBtn label). Bounded to the single source file by design — does NOT scan tests, since some old test files may legitimately reference the old ids in comments documenting the migration.

- **Integration** (jsdom):
  - `tests/sidepanel-clear-confirm.test.ts` (new) — counts fetched fresh from `deps.readStorage` spy, Cancel = zero writes, Confirm = single atomic `chrome.storage.local.remove([SESSION, EVENTS, SCREENSHOTS])` call; mirrors the existing `tests/sidepanel-discard-cancel.test.ts` (or its pinned section in `tests/sidepanel-controls.test.ts`).
  - `tests/sidepanel-listener-reactive.test.ts` (new) — mount panel in paused state with non-empty timeline; assert `#end-btn === null`; broadcast `PENDING_HANDOFF_CHANGED { active: {...} }` via `onRuntimeMessage`; assert `#end-btn !== null` and `#events-list` reference unchanged.
  - `tests/sidepanel-pause-resume.test.ts` (existing, migrated) — id renames only.
  - `tests/sidepanel-end-handoff.test.ts` (new) — end-to-end through the SW message router using fake fetch; verify byte-identical zip body (precomputed via `exportSessionStreaming`).

- **E2E** (Playwright, `e2e/sidepanel-lifecycle-feature17.spec.ts`):
  - **Test 1 — Roadmap bullet 1**: `test("Start (full mode) → type → Pause → Download visible → Download exports zip with input event")` — load extension, open side panel, click Start (full mode), navigate to fixture page with input, type, switch back to side panel, click Pause, assert `#download-btn` visible and `#stop-btn` absent, click Download, intercept the download, unzip, assert `session.json` timeline contains the input interaction event.
  - **Test 2 — Roadmap bullet 2**: `test("empty pause → only Resume → resume → type → pause → Download/Clear appear")` — Start, immediately Pause (no events), assert `#resume-btn` visible and `#download-btn === null && #clear-btn === null`, click Resume, type into fixture, Pause, assert `#download-btn` and `#clear-btn` now visible.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**:
  - Any spec under `e2e/` that selects `#stop-btn`, `#discard-btn`, or `#reset-btn`. Likely candidates from the project tree: `e2e/sidepanel-debug.spec.ts`, `e2e/input-capture.spec.ts`, `e2e/sidepanel-pause-resume.*.spec.ts` if present, plus any handoff-related e2e (the existing CLI handoff spec selects the Stop button to trigger export). Concrete inventory must be done at implementation time; predicted touch count: **3–6 specs**.
- **New e2e tests needed**: 1 file, 2 `test()` blocks (described above).
- **Cost note**: Each Playwright test does full extension load + bind-on-open. Group both feature-17 specs in one file with a shared `test.beforeEach` to amortise the auth+unlock cost. Don't add a third spec for End — the End handoff round-trip is covered at integration level (DoD-7), which is deterministic and fast.

**Test files to create/modify**:
- New: `tests/sidepanel-clear-confirm.test.ts`, `tests/sidepanel-listener-reactive.test.ts`, `tests/sidepanel-end-handoff.test.ts`, `tests/sidepanel-no-legacy-ids.test.ts`, `e2e/sidepanel-lifecycle-feature17.spec.ts`.
- Modified: `tests/sidepanel-controls.test.ts`, `tests/sidepanel-pause-resume.test.ts`, `tests/session-status.test.ts`, `tests/service-worker-pending-handoff.test.ts`, every existing e2e spec touching old ids.

**Coverage target**: ≥ 90 % on `src/lib/sidepanel-controls.ts` (it is pure and small), ≥ 80 % on the new branches in `src/sidepanel/sidepanel.ts`. Existing coverage on session-status.ts must not drop.

## Code Quality Checklist

- [ ] Follows SOLID — `buildControlsModel` remains pure (Single Responsibility); new flags are additive (Open/Closed); the panel depends on the abstract `ControlVisibility` shape, not on action implementation details (Dependency Inversion).
- [ ] No code duplication — Clear reuses the discard-confirm-dialog DOM (renamed); Download reuses the pre-export-reminder; End reuses the handoff POST path.
- [ ] Clear naming — `download-btn`, `clear-btn`, `end-btn` mirror the user-facing verbs. Internal renames: `discardDialog → clearDialog`, `discardBtn → clearBtn`. Comment-document the rename in one spot in `sidepanel.ts` so a `git blame` reader sees the intent.
- [ ] Appropriate abstraction level — no new abstractions introduced. We extend two existing pure modules' input shape; everything else is renames and rewires.
- [ ] Error handling — the existing `withLoadingState` envelope around STOP_SESSION + EXPORT_SESSION is reused for both Download and End. No new error branches.
- [ ] Types properly defined — `ControlsModelInputs` and `ControlVisibility` updates are typed; no `any`.
- [ ] Edge cases — empty-paused (DoD-4); listener attaches mid-pause (DoD-5); user clicks Pause then Clear immediately (no events at all, `countMaterialEvents === 0` so Clear is hidden — Clear cannot be invoked, only Resume can; the user can resume and then re-pause if they want to clear later — but if they already have nothing, "leave the session and it auto-cleans on Stop's empty-export branch" is acceptable).
- [ ] Logging/monitoring — none added. Existing `console.warn` calls in service-worker preserved.

## Patterns to Apply

| Pattern | Where | Why |
|---------|-------|-----|
| Pure view-model + structural mount | `sidepanel-controls.ts` + `applyControlsModel` | Already the codebase's idiom (feature #11, feature #16); zero deviation |
| Table-driven test for state-machine-shaped logic | `tests/sidepanel-controls.test.ts` | Mirrors `tests/session-status.test.ts`; one new dimension (`listenerAttached`) added cleanly |
| Reuse-by-rename over duplicate-and-edit | `discardDialog → clearDialog` | Minimises the diff; preserves the spy-pinned cancel-path test by trivial id substitution |
| Subscribe-once-broadcast-many | listener-attached reactivity uses existing `PENDING_HANDOFF_CHANGED` | No new subscription channel; piggy-backs on plumbing the SW already maintains |

## Impact Assessment

**Positive Impacts**:
- Reduces UI verb surface from 6 → 3-5 (pre-session: 1, active: 1, paused: 2-4 contextual). User mental model becomes "Pause first, then choose how to leave."
- Eliminates the latent `id="download-btn"` collision (today the same id appears on the toolbar Stop button and the reminder's confirm button — querySelector returns whichever Vite mounted first, an undocumented coupling).
- Tightens the formal model: `running` state's only legal user verb becomes `pause`, which matches the "no destructive action mid-recording" UX intent.
- Increased test granularity — 16-row paused matrix replaces the looser "discard exists when running or paused" assertion.

**Neutral** (what stays the same):
- `SessionStatus` machine: same 4 states, same 7 actions, same transition table.
- Storage layer: SESSION/EVENTS/SCREENSHOTS keys, OPFS layout, atomic remove on discard.
- Export schema: 1.2.0, no new fields, no new event types.
- Handoff POST path: same `performHandoff(config, zipBytes, sessionId, fetch)` signature, same loopback validator, same byte-identical zip.

**Risks**:
- **R1 — id-collision regression in the reminder panel**. Existing code uses `id="download-btn"` inside the pre-export reminder (line 476 of `sidepanel.ts`) — this is the "confirm download" button, not the toolbar entry. Step 4 of Implementation renames it to `confirm-export-btn`. Mitigation: test 4 in the new `sidepanel-no-legacy-ids.test.ts` greps that there is exactly one `id="download-btn"` in the rendered DOM under stopped state.
- **R2 — `EXPORT_WARNING` semantics for End vs Download**. Today the SW falls through to chrome.downloads on handoff failure and broadcasts `EXPORT_WARNING { message: "Listener unreachable, saved to Downloads instead." }`. For End we want the same fallback (don't lose the session) but the user clicked End specifically because they have a listener — silently downloading might be confusing. Decision: keep the existing fallback; the warning message is sufficiently explicit. *Optional follow-up*: in a future iteration, gate End behind a "really fall through?" prompt when handoff fails. Not needed for feature 17.
- **R3 — Reset removed from UI but still callable.** A future contributor might wonder if `RESET_SESSION` is dead. Mitigation: leave a comment in `service-worker.ts` at the RESET_SESSION case head: `// Kept for symmetry with isResetEligible() and to support future internal cleanup paths. Feature 17 removed the UI surface.`
- **R4 — Old test ids referenced in tests-as-documentation.** Some tests' descriptive `it(...)` names mention "Stop" or "Discard". These do not break the build but read confusingly. Mitigation: pass through every migrated test and rename `it()` text to match the new verb (Download/Clear/End).

## Estimated Effort

| Phase | Time | Justification |
|-------|------|---------------|
| Planning | 0 min | Already done. |
| Implementation | 90 min | View-model widening (10 min) + button rename + click rewires (30 min) + listener reactive branch (10 min) + remove resetBtn (5 min) + countMaterialEvents helper (5 min) + apply-controls-model branching (15 min) + style adjustments (10 min) + commit/manual smoke (5 min). |
| Testing | 120 min | Migrate ~3-6 e2e specs (30 min), migrate `tests/sidepanel-controls.test.ts` matrix (30 min), write `sidepanel-clear-confirm.test.ts` (15 min — heavy reuse from existing discard test), `sidepanel-listener-reactive.test.ts` (15 min), `sidepanel-end-handoff.test.ts` (20 min), `sidepanel-no-legacy-ids.test.ts` (5 min), `e2e/sidepanel-lifecycle-feature17.spec.ts` (15 min). |
| Review prep | 30 min | Update `docs/ARCHITECTURE.md` + new changelog row + walkthrough comment block in `sidepanel-controls.ts`. |
| **Total** | **≈ 240 min** | Medium effort. Heavy on testing because the surface is a contract layer; thin on net-new code because we're simplifying. |

⚠️ **Quality investment**: This thorough approach takes about 1.5x longer than a "rename and ship" minimal pass would (which would skip the listener-reactive integration test, the no-legacy-ids grep test, and the e2e bullet-2 test). Worth it because (a) the side panel is a frequently-modified area where every previous feature added a control, (b) the DoD includes a hide-not-disable invariant that is silently easy to break with `display: none` shortcuts, and (c) the matrix of paused-state visibility cells is exactly the kind of regression no manual-QA pass will catch.

## Technical Debt Addressed

- **Latent id collision** (`#download-btn` on two different buttons in the stopped DOM) gets fixed as a side-effect of the toolbar entry-point rename.
- **Verb sprawl** in `ControlVisibility` (today: pause/stop/discard/reset → 4 lifecycle flags for a 4-state machine, which is duplicative). Feature 17's flags (pause/resume/download/clear/end) align 1:1 with user-facing verbs and are partitioned by state.
- **Missing reactive listener subscription in the panel.** Today the panel reads `getHandoffConfig` once at mount and re-renders only on session-status changes; an attach mid-session does not update the toolbar status badge until the next status broadcast. Feature 17's `PENDING_HANDOFF_CHANGED` subscription fixes this for End and incidentally for the existing toolbar status badge.

**Debt avoided**:
- Resisted the urge to introduce a `LifecycleAction` enum on the view-model side. The existing `SessionAction` is the model-side enum; mirroring it on the view side would create a second source of truth for the same concept. The `ControlVisibility` boolean shape is already the right abstraction.

## Formal Verification Assessment

- **Concurrency concerns**: Yes. Listener attach/detach broadcasts can race with pause/resume broadcasts. The current code is single-threaded JS; the only ordering risk is whether `applyControlsModel` runs before the user can click a stale button. Mitigation: every state mutation calls `applyControlsModel` synchronously before returning; click handlers re-check status (`if (status !== "paused") return;`).
- **State machine complexity**: Yes — but **already formally pinned** by `tests/session-status.test.ts`'s 4×7 transition table. Feature 17 changes nothing in the table.
- **Conservation laws**: One — "no data loss across Pause" (roadmap constraint). Already enforced by the marker-before-flag write order in `service-worker.ts:419–432`.
- **Authorization model**: N/A at the panel layer; the handoff token check happens server-side at `performHandoff`.
- **Recommendation**: **Formal verification not needed.** The state machine is small (4×7), already exhaustively tested, and feature 17 does not perturb it. The new flags on `ControlVisibility` are pure boolean predicates over a 4-element enum — table-driven unit tests provide identical coverage to a Lean/TLA proof at a fraction of the cost.
- **Key invariants** (business-language) tracked by tests rather than proofs:
  - "Pause never loses events." — `tests/sidepanel-pause-resume.test.ts`.
  - "Capture stops while paused." — `isCaptureActive` predicate, table-pinned.
  - "Clear is the only path to drop a session from the UI." — DoD-8 grep test.
  - "End and Download produce byte-identical zips." — `exporter.golden.test.ts` + `service-worker-handoff.test.ts` D10 row.

## Future Extensibility

- **Adding a new paused-state action** (e.g. "Save draft" — keep the session but exit the panel) would need: one new flag on `ControlVisibility`, one new row pattern in the matrix test, one new button + click handler in `sidepanel.ts`. No state-machine change. The model is already shaped for this.
- **Adding a fifth state** (e.g. `archived`) would require: a new row in the transition table, a new column in the controls matrix, and a careful audit of `applyControlsModel`. Pure-module-first design means this is mechanical, not exploratory.
- **Hotkey support** (e.g. press "P" to pause): the click handlers are already pure functions of the current status — wiring a `keydown` listener to call them is additive.
- **A second listener channel** (e.g. WebSocket alongside HTTP POST): the `listenerAttached` boolean is already abstract over the transport. The model would not change; only the SW broadcast source would.

## docs/ARCHITECTURE.md additions/changes (post-implementation)

1. **Side Panel section** (lines 42–48) update:
   - Replace "Lifecycle controls (Start, Pause/Resume, Stop, Discard, Reset) live in the toolbar" with "Lifecycle controls follow a contextual model (feature #17): pre-session shows Start; running shows Pause; paused shows Resume + (Download, Clear when timeline non-empty) + (End when a CLI listener is attached). Stop, Discard, and Reset are removed from the surface."
   - Add a sentence: "End reuses the EXPORT_SESSION handoff path; Download reuses the chrome.downloads fallback; Clear reuses the atomic SESSION/EVENTS/SCREENSHOTS remove."
   - Add a line under the discard-dialog paragraph: "The same dialog (renamed to clear-confirm-dialog) backs the Clear action under feature #17 — copy and zero-writes-on-cancel contract are preserved."

2. **Shared Libraries: `sidepanel-controls.ts`** (line 52) update:
   - "Pure view-model: `buildControlsModel({status, hasResidualState, hasEvents, listenerAttached})` returns a declarative `ControlVisibility` shape… Feature #17 widened the input shape with `hasEvents` (drives Download/Clear visibility) and `listenerAttached` (drives End visibility). The matrix of paused-state combinations (4 cells: hasEvents × listenerAttached) is pinned by a table-driven unit test."

3. **New changelog row** (under "(unreleased)"):
   ```
   | (unreleased) | Simplify session lifecycle (feature #17): the side panel verb surface collapses from {Start, Pause, Resume, Stop, Discard, Reset} to a contextual set. Pre-session: Start only. Active: Pause only. Paused: Resume + (Download, Clear when timeline has events) + (End when a CLI listener is attached). The underlying SessionStatus machine is unchanged — the simplification is pure UI surface, with `ControlsModelInputs` widened by `hasEvents` and `listenerAttached`. Stop/Discard/Reset buttons are removed; Clear maps to DISCARD_SESSION (atomic remove + destructive-confirm dialog inherited verbatim, renamed to clear-confirm-dialog), Download maps to STOP_SESSION + EXPORT_SESSION via the existing pre-export reminder, End maps to STOP_SESSION + EXPORT_SESSION through the handoff transport branch — both produce byte-identical zips (no schema change, schema_version stays 1.2.0). End visibility is reactive: the panel subscribes to PENDING_HANDOFF_CHANGED broadcasts and recomputes the controls model without re-mounting (DOM node identity preserved across attach/detach). The latent id="download-btn" collision (toolbar Stop button + reminder confirm button shared the id) is fixed by renaming the reminder confirm to confirm-export-btn. RESET_SESSION SW handler retained for symmetry with isResetEligible(); UI no longer invokes it. |
   ```
