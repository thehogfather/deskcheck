---
agent: speed-planner
generated: 2026-05-03T00:00:00Z
task_id: feature-17
perspective: speed
---

# Speed Plan: Simplify session lifecycle — Pause-first, contextual exits

## Architecture reference

Sections of `docs/ARCHITECTURE.md` consulted:
- "Side Panel (`src/sidepanel/`)" — three-region layout, hide-not-disable contract via `buildControlsModel()`, discard dialog behaviour, `withLoadingState` icon-safe envelope.
- "Shared Libraries / session-status.ts" — 4-state `SessionStatus` machine (`idle | running | paused | stopped`) is the formal lifecycle model; transition table is pinned by `tests/session-status.test.ts`.
- "Shared Libraries / sidepanel-controls.ts" — pure view-model `buildControlsModel({status, hasResidualState})` returns `ControlVisibility`.

Smallest set of files that change:
- `src/lib/sidepanel-controls.ts` — extend `ControlsModelInputs` with `hasEvents` + `listenerAttached`; flip the visibility shape (rename `stop`→`download`, `discard`→`clear`, drop `reset`, add `end`). Tighten paused-only gating.
- `src/sidepanel/sidepanel.ts` — rename three button ids/labels (`stop-btn`→`download-btn`, `discard-btn`→`clear-btn`; add new `end-btn`); collapse the running-state lifecycle row to Pause-only; wire End to a new `END_SESSION` flow that POSTs to the listener; track `listenerAttached` in local state and recompute model when handoff config changes; remove the pre-export reminder gating around Stop (Download from paused state replaces it). Reuse the existing discard confirmation dialog as the Clear dialog. Drop the `resetBtn` and its handler entirely.
- `src/background/service-worker.ts` — add an `END_SESSION` message that routes through the existing handoff POST path (same byte-identical zip as Stop+listener) without invoking the browser download fallback. If listener not attached, return error.
- `src/types.ts` — add `END_SESSION` to the `Message` discriminated union.
- Tests — see Testing strategy.

The existing `SessionStatus` machine (`session-status.ts`) is **untouched**. `discard` and `reset` actions and `stopped` state remain in the table; the side panel simply stops surfacing them. `Clear` reuses the existing `DISCARD_SESSION` action under a new label, and `Download` reuses the existing `STOP_SESSION` + `EXPORT_SESSION` flow. `End` is a new SW message that wraps stop+handoff-only export.

## Approach

Re-shape `buildControlsModel` to express the new contextual visibility with two new inputs (`hasEvents`, `listenerAttached`); rename the three buttons in place; add one new `end-btn`; reuse the existing discard dialog verbatim for Clear; reuse the existing `STOP_SESSION` + handoff path for End. No state-machine changes, no schema changes, minimum diff.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `src/lib/sidepanel-controls.ts` | Modify | ~30 | Add `hasEvents` + `listenerAttached` inputs, rewrite the visibility logic; rename `stop`→`download`, `discard`→`clear`; drop `reset`; add `end`. |
| `src/sidepanel/sidepanel.ts` | Modify | ~80 | Rename button ids/labels, add `endBtn`, drop `resetBtn` handler, drop the pre-export reminder gating around Download (Pause-first replaces that anti-muscle-memory), wire End handler, plumb listener-attached state into `applyControlsModel`. |
| `src/background/service-worker.ts` | Modify | ~25 | Add `END_SESSION` handler — same path as Stop+listener-attached but errors instead of falling through to download. |
| `src/types.ts` | Modify | ~3 | Add `END_SESSION` message variant. |
| `tests/sidepanel-controls.test.ts` | Modify | ~40 | Cover the new visibility matrix (idle/running/paused × hasEvents × listenerAttached). |
| `tests/sidepanel-lifecycle.test.ts` (new file) | Create | ~120 | Integration test (jsdom): button id presence/absence per state, listener-attach live update, Clear dialog cancel path, End → SW message. |
| `tests/service-worker-end-session.test.ts` (new file) | Create | ~50 | Unit-level SW handler test: END_SESSION routes through handoff path; errors when no listener attached. |
| `e2e/lifecycle-pause-first.spec.ts` (new file) | Create | ~60 | DoD-8 + DoD-9 e2e flows. |
| Existing tests referencing `stop-btn` / `discard-btn` / `reset-btn` | Modify | ~20 (across N files) | Migrate test ids — see Risk assessment for the grep list. |

**Total files**: 9 (4 modified, 3 new test files, 2 modified test/types files) plus N existing test files affected by the id rename.
**Total estimated lines**: ~430.

## Implementation Steps

1. Extend `ControlsModelInputs` to `{ status, hasResidualState, hasEvents, listenerAttached }`. Update `ControlVisibility` shape: rename `stop`→`download`, `discard`→`clear`, drop `reset`, add `end`. New rules:
   - `start`: pre-session
   - `pause`: `running || paused` AND (status==="running") — actually Pause is shown only running; Resume (which is Pause's label-swap) only paused → keep current `pause` flag and continue label-swapping in glue.
   - `download`/`clear`: `status==="paused" && hasEvents`
   - `end`: `status==="paused" && listenerAttached`
   - `pausedBadge`: unchanged
   - Remove `reset` field entirely.
2. Update `tests/sidepanel-controls.test.ts` to cover the new product (idle, running, paused × empty/non-empty × attached/detached). Drop the `reset` cases.
3. In `sidepanel.ts`:
   - Track `let listenerAttached = false;` next to `handoffAttachedUrl` (it's already implied — fold into the existing variable).
   - Rename `stopBtn` id `stop-btn` → `download-btn` and label "Download". Rename `discardBtn` id `discard-btn` → `clear-btn` and label "Clear".
   - Delete `resetBtn` and its click handler entirely.
   - Add `endBtn = iconBtn("end-btn", "sp-btn primary", lucideNode(LucideX), "End")` (icon: pick something distinct, e.g. `Power` from lucide; if not imported, reuse `LucideX` or `ChevronsLeftRightEllipsis` to avoid bundle churn).
   - Remove the running-state stopBtn/discardBtn from the lifecycle row — running shows only Pause now.
   - Remove the pre-export reminder gating from the Download button (paused-state Download replaces the anti-muscle-memory contract). Delete the `reminderPanel` mounting under `model.stop`. (Keep the reminder DOM in case other tests reference `pre-export-reminder`; lazy delete in a follow-up. **For minimum diff, leave reminderPanel + Escape handler in place but stop mounting it; controls.appendChild(reminderPanel) is dropped.**)
   - Wire End handler: call `withLoadingState(endBtn, "Sending…", async () => { await sendMessage({ type: "END_SESSION" }); transitionTo("idle"); })`. The SW finalises + POSTs to the listener.
   - Pass `hasEvents: events.length > 0` and `listenerAttached: handoffAttachedUrl !== null` into `buildControlsModel`.
   - Call `applyControlsModel()` from inside `renderHandoffState()` so attach/detach updates the End button live without a panel re-mount (DoD-5).
4. In `service-worker.ts`, add an `END_SESSION` case:
   - Read handoff config; if absent, return `{ ok: false, error: "no listener attached" }`.
   - Otherwise reuse the existing stop-and-export-via-handoff code path (same as `STOP_SESSION` + `EXPORT_SESSION` with `forceHandoff: true`). Skip the download fallback on handoff failure (the user explicitly asked to End — surface the error instead).
5. Add `END_SESSION` to `src/types.ts` `Message` union.
6. Update existing tests that reference the old ids — global grep + replace `stop-btn`/`discard-btn`/`reset-btn` → `download-btn`/`clear-btn`/(deleted). Migrate any reset-specific tests to verify the button is gone.
7. Add new tests (see Testing strategy).
8. `make typecheck && make test && make build`. Manual verify in Chrome.

## Definition of Done (1:1 with roadmap DoD-1..DoD-9)

- [ ] **DoD-1** Pre-session shows exactly Start, PII picker, status pill — verified by `tests/sidepanel-controls.test.ts` (idle row in matrix) and a jsdom integration assertion in `tests/sidepanel-lifecycle.test.ts` that no `pause-btn`/`download-btn`/`clear-btn`/`end-btn` exist in DOM at status=idle.
- [ ] **DoD-2** Active (running) shows exactly Pause + annotation/picker + capture-mode indicator — assertion that `pause-btn` exists and `download-btn`/`clear-btn`/`end-btn` are absent from DOM at status=running.
- [ ] **DoD-3** Paused: Resume + Download/Clear (only when events) + End (only when listener attached) — table-driven test covering the 4 combinations of (events × attached).
- [ ] **DoD-4** Empty paused shows only Resume — Download/Clear absent from DOM (hide-not-disable, `querySelector === null`).
- [ ] **DoD-5** Listener attach/detach mid-pause flips End live, no panel re-mount — integration test simulates `setHandoffConfig`/`clearHandoffConfig` while paused, asserts `#end-btn` appears/disappears without `mountSidePanel` being called again.
- [ ] **DoD-6** Clear shows the existing destructive confirmation dialog (cancel path verified) — reuse existing `tests/sidepanel-discard-dialog.test.ts` cases, just rename id references.
- [ ] **DoD-7** End triggers the same handoff POST as today's Stop+listener-attached, byte-identical zip, exits to pre-session on success — `tests/service-worker-end-session.test.ts` asserts the SW dispatches the same handoff body, idle on success.
- [ ] **DoD-8** Old `stop-btn`/`discard-btn`/`reset-btn` ids removed from DOM; tests migrated — grep test in `tests/sidepanel-no-old-ids.test.ts` (3-line addition) plus migration of existing references.
- [ ] **DoD-9** Unit + e2e coverage as specified in roadmap.
- [ ] `make typecheck` passes.
- [ ] `make test` passes.
- [ ] `make build` passes.

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | DoD-1 pre-session surface | Unit | Pure `buildControlsModel` table test. |
| 2 | DoD-2 running surface | Unit | Same. |
| 3 | DoD-3 paused contextual surface | Unit | Same — view-model is pure, deterministic. |
| 4 | DoD-4 empty paused | Unit | Same. |
| 5 | DoD-5 reactive listener attach mid-pause | Integration (jsdom) | Requires the glue layer to recompute on storage change — must exercise the panel render pipeline, not just the view-model. |
| 6 | DoD-6 Clear dialog cancel | Integration (jsdom) | Existing discard-dialog test pattern, rebadged. |
| 7 | DoD-7 End → handoff POST | Unit (SW) + Integration (panel→SW message) | Pure SW-handler unit test plus a panel test that mocks `sendMessage` and asserts the `END_SESSION` message shape. No live network. |
| 8 | DoD-8 old ids absent | Unit (grep test) | Static check; no runtime needed. |
| 9 | DoD-9 e2e flows | E2E | Full user journey for the two scripted scenarios in the roadmap. |

**Speed planner bias**: Default to unit tests. Integration only for DoD-5/DoD-6/DoD-7 where live DOM mutation through the glue layer is the contract. E2E only for DoD-9 (explicit roadmap requirement).

**Determinism rule**: All tests deterministic. SW handoff POST is mocked at the `fetch` boundary; no live HTTP calls.

## Testing Strategy

- **Unit (Vitest)**:
  - `tests/sidepanel-controls.test.ts` — extend the existing matrix to cover `(status × hasEvents × listenerAttached)`. Drop `reset` cases. Net delta: +20 / -10 lines.
  - `tests/service-worker-end-session.test.ts` (new) — END_SESSION dispatches handoff POST; errors on no-listener; finalises session on success.
  - `tests/sidepanel-no-old-ids.test.ts` (new, ~10 lines) — grep `src/sidepanel/sidepanel.ts` for the old id strings; assert absent.
- **Integration (Vitest + jsdom)**:
  - `tests/sidepanel-lifecycle.test.ts` (new) — mounts the side panel, drives it through idle→running→paused, asserts which `data-testid`/`#id` selectors are present at each phase. Simulates `chrome.storage.onChanged` for the handoff config to verify DoD-5. Verifies the Clear dialog cancel path leaves storage untouched (reusing the spy pattern from the existing discard-dialog test).
- **E2E (existing harness in `e2e/`)**:
  - `e2e/lifecycle-pause-first.spec.ts` (new) — two scripted flows mirroring DoD-9 bullets:
    1. Start (full) → type into input → Pause → confirm `#download-btn` visible → Download → assert exported zip contains the typed input event.
    2. Start → Pause (no events) → confirm only Resume visible (`#download-btn` and `#clear-btn` absent) → Resume → type → Pause → confirm Download/Clear appear.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: any spec that asserts `#stop-btn` or `#discard-btn` selectors. Likely candidates: `e2e/sidepanel-debug.spec.ts`, any feature-11/feature-14 spec. Migration is mechanical id rename. Tests asserting the pre-export reminder mounts on Stop will need to drop those assertions (the reminder is no longer surfaced).
- **New e2e tests needed**: 1 new spec (`lifecycle-pause-first.spec.ts`) covering DoD-9's two scenarios — both assertions packed into the single file to minimise auth+unlock cost.
- **Cost note**: Each e2e test does full auth+unlock — both DoD-9 scenarios live in one spec to keep cost at one full setup.

**Test files to create/modify**:
- New: `tests/sidepanel-lifecycle.test.ts`, `tests/service-worker-end-session.test.ts`, `tests/sidepanel-no-old-ids.test.ts`, `e2e/lifecycle-pause-first.spec.ts`.
- Modify: `tests/sidepanel-controls.test.ts`, plus any existing test referencing the renamed ids (mechanical rename).

## Risk Assessment

**Risk Level**: Medium-Low

**Why this is safe**:
- The `SessionStatus` state machine is untouched — the lifecycle invariants (capture-active, paused-preserves-events, etc.) survive unchanged.
- Schema unchanged; no `schema_version` bump; pause/resume timeline markers unaffected.
- Clear, Download, and (under the hood) End all reuse existing service-worker actions (`DISCARD_SESSION`, `STOP_SESSION`+`EXPORT_SESSION`, handoff POST). The diff is mostly a relabel/regroup.
- `buildControlsModel` is pure and exhaustively unit-tested — easy to lock the new matrix down.

**Specific risk: test-id rename (DoD-8) has cross-file blast radius.**

Likely callers of `stop-btn` / `discard-btn` / `reset-btn` (must grep + migrate before merge):
- `tests/sidepanel-*.test.ts` — discard-dialog, controls, integration flows.
- `e2e/*.spec.ts` — any spec that drives the existing Stop or Discard flows.
- CSS — `src/sidepanel/sidepanel.css` may have `#stop-btn` / `#discard-btn` / `#reset-btn` rules; rename or generalise to class-based.
- Documentation — `docs/ARCHITECTURE.md` mentions the Toolbar layout naming Stop/Discard/Reset; one-paragraph update needed.

Plan: a single grep-and-replace pass before the typecheck step, then run the full suite. The grep test in `tests/sidepanel-no-old-ids.test.ts` is the safety net.

**Tradeoffs accepted**:
- The pre-export reminder dialog DOM stays in the file (un-mounted) rather than being deleted, to keep the diff small. The reminder is no longer surfaced because Pause-first already serves as anti-muscle-memory friction. Cleanup is a follow-up task.
- We do NOT introduce a generalised "session exit" abstraction — Download / Clear / End remain three distinct handlers that share a small amount of code with the existing flow.
- We do NOT refactor the toolbar/controls split or the way `applyControlsModel` mounts/unmounts children. Same render pipeline, slightly different shape.
- We do NOT add new lifecycle actions to `session-status.ts`. End is implemented at the SW message layer (not the state machine layer), which is sufficient because the post-End status transition (`stopped → idle` after `export_complete`) already exists in the table.

## Estimated Effort

- Planning: Done.
- Implementation: ~90 minutes.
- Testing: ~75 minutes (unit + integration + 1 e2e + id-rename migration).
- **Total**: ~3 hours. Size: **Medium** (multi-file, but every change is mechanical or reuses existing scaffolding).

## Formal Verification Assessment

- Concurrency concerns: **No** — visibility is computed synchronously in a pure view-model; the only "live" update is a single re-render triggered by the existing storage-onChanged subscription.
- State machine complexity: **No** — `SessionStatus` is unchanged; this feature only relabels surface controls. The state machine tests in `session-status.test.ts` continue to pin the formal model.
- Conservation laws: **No** — no data movement; events, screenshots, and the export zip are byte-identical to today's Stop+listener path.
- Authorization model: **No** — no privilege boundaries crossed; the SW already gates capture and the panel never touches privileged APIs.
- Recommendation: **Not needed**. The existing unit + integration + e2e ladder is sufficient. The roadmap's DoD bullets ARE the spec.
- If recommended, key invariants: N/A.

## What This Plan Does NOT Include

- Does NOT delete the `pre-export-reminder` DOM — left orphaned in the file to keep the diff small. Cleanup is a follow-up.
- Does NOT refactor `applyControlsModel` to use a registry/dispatch pattern — straight-line if/else stays.
- Does NOT touch `src/lib/session-status.ts` — `discard`/`reset` actions and `stopped` state remain in the transition table even though they're no longer surfaced.
- Does NOT introduce new icons beyond what's already imported from `lucide` (reuses existing icons; End uses `LucideX` or similar to avoid bundle churn).
- Does NOT add a confirmation dialog to End — the roadmap doesn't require one (only Clear is destructive). If a follow-up wants End to confirm, that's a separate change.
- Does NOT add documentation beyond a one-paragraph update to the Side Panel section of `docs/ARCHITECTURE.md` describing the new toolbar shape.
- Does NOT change CSS classes/colour for the new `end-btn` beyond reusing `sp-btn primary` — bespoke styling is a follow-up.
