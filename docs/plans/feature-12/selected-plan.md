---
agent: plan-judge
generated: 2026-04-09T12:00:00Z
task_id: feature-12
selected: safety
---

# Plan Evaluation: Side Panel Control Layout Refinement

## Executive Summary

The Safety plan is selected because it identifies two critical correctness bugs that the other plans either miss or underestimate: (1) `withLoadingState` will destroy icon nodes by saving/restoring `textContent`, and (2) `newEventsChip` is currently appended to `#controls` and must relocate. The phased implementation sequence with test gates between phases is the right discipline for a change that touches the highest-risk function in the side panel (`applyControlsModel`). Key quality-plan insights (label span pattern, centralised icon constants) are incorporated.

## Plans Evaluated

### Speed Plan Summary
- **Core approach**: Unicode icons prepended to button text, minimal DOM restructure, annotation wrapper with absolute-positioned picker
- **Estimated effort**: 65 minutes
- **Key tradeoff**: Ignores the `withLoadingState` bug -- adding icons to `textContent` then having `withLoadingState` save/restore that text will produce subtle icon-stripping on every async action. Also does not address `newEventsChip` relocation or dialog placement.

### Quality Plan Summary
- **Core approach**: Separate `sidepanel-icons.ts` module, `<span class="btn-label">` pattern to protect from `withLoadingState` corruption, split `applyControlsModel` into `applyToolbar` + `applyAnnotationArea`
- **Estimated effort**: 165 minutes
- **Key tradeoff**: Identifies the `withLoadingState` bug and proposes the label-span fix, but does not sequence the fix BEFORE icon addition. Suggests reminder/discard dialogs move to `#toolbar` (incorrect -- they should stay in `#controls` as intentional friction). Over-engineers with a separate icons module for simple Unicode constants.

### Safety Plan Summary
- **Core approach**: 6-phase incremental sequence with test gates. Fixes `withLoadingState` BEFORE adding icons. Identifies `newEventsChip` must move into `#events-list`. Keeps dialogs in `#controls`. Each phase is a revertible commit.
- **Estimated effort**: 135 minutes
- **Key tradeoff**: Slightly more overhead from phased verification, but catches the most bugs pre-merge.

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|-----------|--------|-------|---------|--------|-------|
| Time to deliver | 20% | 4.5 | 2.5 | 3.5 | Speed is fastest but ships bugs; safety is faster than quality |
| Code quality | 25% | 3.0 | 4.5 | 4.0 | Quality's label-span pattern is excellent; safety adopts it |
| Risk mitigation | 25% | 2.0 | 3.5 | 5.0 | Safety is the only plan that sequences withLoadingState fix correctly |
| Maintainability | 15% | 3.0 | 4.5 | 4.0 | Quality's icon module adds a clean swap point; safety is pragmatic |
| Test coverage | 15% | 3.0 | 4.0 | 4.5 | Safety tests each phase; quality tests at end |
| **Weighted Total** | 100% | **3.00** | **3.75** | **4.20** | |

## Context Analysis

| Factor | Assessment | Impact |
|--------|------------|--------|
| Urgency | Low | Planned feature work, no deadline pressure |
| Blast radius | Medium | Touches `applyControlsModel` which controls the entire side panel UX |
| Code area | Core UI | The side panel is the primary (and only) DeskCheck user surface |
| Technical debt | Low | Feature #11 left clean patterns; this builds on them |

## Recommendation

### Selected Plan: Safety (with elements from Quality)

### Rationale

The safety plan wins because it is the only plan that correctly identifies and sequences the `withLoadingState` refactor. The current implementation (line 696: `const idleLabel = btn.textContent ?? ""`) will serialize icon nodes into flat text when saving, then destroy the icon DOM structure on restore. This is a high-likelihood, high-severity bug that would silently break icons after any Save/Capture/Download action. The safety plan mandates fixing this in Phase 2 before icons are added in Phase 3 -- a strict dependency the other plans do not enforce.

The safety plan also correctly identifies that `newEventsChip` (currently appended to `#controls` at line 847) must move into `#events-list` where its sticky positioning is semantically correct, and that reminder/discard dialogs should stay in `#controls` (not move to `#toolbar` as the quality plan suggests) because they represent deliberate friction for privacy-critical actions.

### Incorporated Elements from Other Plans
- From **Quality**: The `<span class="btn-icon">` + `<span class="btn-label">` pattern for buttons, which makes `withLoadingState` target only the label span. This is cleaner than the safety plan's generic "save/restore innerHTML" suggestion.
- From **Quality**: Update `docs/ARCHITECTURE.md` to reflect the new three-region layout. The safety plan omits this.
- From **Speed**: Skip the separate `sidepanel-icons.ts` module. Unicode constants inlined at button creation are sufficient for 7 buttons. The quality plan's icon module is over-engineering for simple string literals.

## The Selected Plan

### Approach

Six-phase incremental implementation. Each phase is a revertible commit with test gates. The key insight is strict ordering: fix `withLoadingState` before adding icons, add icons before restructuring DOM, restructure DOM before embedding the picker.

### Files to Create/Modify

| File | Change Type | Rationale |
|------|-------------|-----------|
| `src/lib/sidepanel-controls.ts` | Modify | Remove `screenshot` field from `ControlVisibility` interface and `buildControlsModel()` |
| `src/lib/sidepanel-controls.test.ts` | Modify | Remove `screenshot` assertions, add negative assertion |
| `src/sidepanel/sidepanel.ts` | Modify (major) | Remove screenshotBtn, refactor withLoadingState for label spans, add icons, create toolbar section, split applyControlsModel for dual-region mount, embed picker in annotation wrapper |
| `src/sidepanel/sidepanel.css` | Modify | Add `#toolbar` styles, `.annotation-wrapper` styles, `.btn-icon` spacing |
| `src/sidepanel/sidepanel.test.ts` | Modify (major) | Remove screenshot-btn references, update layout assertions for three-region DOM, add toolbar/icon/picker tests |
| `docs/ARCHITECTURE.md` | Modify | Update side panel description for toolbar + annotation-area layout |

**Total files**: 6 (0 new, 6 modified)

### Implementation Phases

**Phase 0: Baseline verification**
- Run `make test && make typecheck && make build`
- Confirm all green -- establishes known-good state
- Safety gate: all tests pass

**Phase 1: Remove screenshot button**
- Delete `screenshot` field from `ControlVisibility` interface in `sidepanel-controls.ts`
- Delete `screenshot` computation from `buildControlsModel()` return object
- Delete `screenshotBtn` declaration, its click handler, and its `withLoadingState` wiring from `sidepanel.ts`
- Remove `if (model.screenshot) noteRow.appendChild(screenshotBtn)` from `applyControlsModel()`
- Update `sidepanel-controls.test.ts`: remove all `screenshot` assertions, add `expect(model).not.toHaveProperty('screenshot')` for every state
- Update `sidepanel.test.ts`: remove `screenshot-btn` from all presence/absence ID lists, remove the "Capture screenshot shows a loading state" test
- Safety gate: `make typecheck` passes (compiler catches any missed references), `make test` passes

**Phase 2: Refactor `withLoadingState` for icon safety**
- Change button structure to use `<span class="btn-icon"></span><span class="btn-label">Text</span>` children. Initially the icon span is empty -- this phase only establishes the structure.
- Refactor `withLoadingState` to target only the `.btn-label` span:
  ```
  const labelSpan = btn.querySelector('.btn-label');
  const idleLabel = labelSpan?.textContent ?? btn.textContent ?? "";
  // ... busy state sets labelSpan.textContent = busyLabel
  // ... restore sets labelSpan.textContent = idleLabel
  ```
- Update existing loading-state tests to account for the span structure (assertions on `.btn-label` textContent)
- Safety gate: all existing loading-state tests still pass with text-only buttons (icon spans are empty)

**Phase 3: Add icons to all buttons**
- Populate the `.btn-icon` spans with Unicode glyphs:
  - Start: `\u25B6` (play triangle)
  - Pause: `\u23F8` (pause)
  - Resume: `\u25B6` (play triangle)
  - Stop: `\u23F9` (stop)
  - Discard: `\u{1F5D1}` (wastebasket)
  - Reset: `\u21BA` (counterclockwise arrow)
  - Add note: `\u{1F4DD}` (memo)
  - Pick element: `\u{1F3AF}` (target)
- Update pause/resume label swap in `applyControlsModel()` to also swap the icon span
- Update button text assertions in tests to account for icon + label spans
- Safety gate: `make test` passes, `withLoadingState` preserves icons (verified by updated loading-state tests)

**Phase 4: Create `#toolbar` section and split `applyControlsModel()`**
- Create `const toolbar = el("section", { id: "toolbar" })` in the DOM skeleton
- Insert in root: `noticeContainer -> toolbar -> eventsList -> controls`
- Split `applyControlsModel()` body into two regions:
  - **Toolbar** (`clearChildren(toolbar)`): metricsRow, pausedBadge logic, emptyStateHint (pre-session), lifecycle row (pause/stop/discard), start/reset row
  - **Controls** (`clearChildren(controls)`): piiFieldset, annotation area (elementChip, annotationText, noteRow with addNote + embedded picker), reminder panel, discard dialog, asyncErrorLine
- Move `newEventsChip` from `controls.appendChild(newEventsChip)` to `eventsList.appendChild(newEventsChip)` -- it uses sticky positioning relative to its scroll container, and semantically belongs with the events list
- Keep reminderPanel and discardDialog in `#controls` -- clicking Stop/Discard in the toolbar shows the dialog at the bottom near the annotation area, which is intentional friction for privacy-critical actions
- Add CSS for `#toolbar`: `flex: 0 0 auto`, `background: var(--bg-elev)`, `border-bottom: 1px solid var(--border)`, `padding: 8px 12px`, `display: flex`, `flex-direction: column`, `gap: 8px`
- Update layout tests: assert DOM order is `[first-run-notice-container, toolbar, events-list, controls]`
- Update controls-region tests: lifecycle buttons in `#toolbar`, annotation elements in `#controls`
- Safety gate: `make test` passes, `make typecheck` passes

**Phase 5: Embed element picker inside annotation textarea wrapper**
- Create `annotationWrapper = el("div", { class: "annotation-wrapper" })` that wraps the textarea
- Position `pickElementBtn` inside the wrapper (absolutely positioned at bottom-right of textarea)
- Remove picker from the standalone noteRow position
- Add CSS: `.annotation-wrapper { position: relative }`, picker button `position: absolute; right: 8px; bottom: 8px`, textarea `padding-right` adjusted to avoid text overlap
- Update tests: assert `#pick-element-btn` is inside `.annotation-wrapper`, chip lifecycle still works
- Safety gate: `make test` passes, picker click still sends `START_ELEMENT_PICKER`

**Phase 6: CSS polish and documentation**
- Final CSS refinements for toolbar/controls visual consistency
- Update `docs/ARCHITECTURE.md`: change "Two-region flex layout" to "Three-region flex layout" description, mention toolbar contains lifecycle controls + metrics, controls contains PII + annotation area, screenshot button removed
- Safety gate: `make build` succeeds, manual load in Chrome verifies layout

---

### Definition of Done (Final)
- [ ] `screenshot` field removed from `ControlVisibility` interface and `buildControlsModel()`
- [ ] `screenshotBtn` element, click handler, and `withLoadingState` wiring removed from `sidepanel.ts`
- [ ] `#screenshot-btn` absent from DOM in all session states
- [ ] `withLoadingState` preserves icons during busy/restore cycle (uses `.btn-label` span targeting)
- [ ] All buttons have leading icons via `<span class="btn-icon">` + `<span class="btn-label">` structure
- [ ] `#toolbar` section exists in DOM, positioned above `#events-list` and below notice container
- [ ] Lifecycle controls (Start, Pause, Stop, Discard, Reset) and metrics render in `#toolbar`
- [ ] `#controls` section contains only PII fieldset + annotation area (textarea with embedded picker, add-note button) + dialogs + error line
- [ ] Element picker icon embedded inside annotation textarea wrapper
- [ ] `newEventsChip` relocated to `#events-list`
- [ ] Reminder and discard dialogs remain in `#controls`
- [ ] Hide-not-disable invariant preserved (controls absent from DOM, not display:none)
- [ ] All existing tests pass (with necessary updates)
- [ ] No type errors (`make typecheck`)
- [ ] `make build` succeeds
- [ ] `docs/ARCHITECTURE.md` updated

### Test Level Matrix (Final)

| # | Acceptance Criterion | Test Level | Rationale |
|---|---------------------|-----------|-----------|
| 1 | `screenshot` field removed from ControlVisibility | Unit | Pure model function, isolated assertion on return shape |
| 2 | `#screenshot-btn` absent from all states | Integration | DOM querySelector against mounted side panel in jsdom |
| 3 | `withLoadingState` preserves icons | Integration | Exercises async button interaction + DOM mutation in jsdom; existing loading-state test pattern |
| 4 | All buttons have leading icons | Integration | DOM content assertion -- check `.btn-icon` span exists and has expected text for each button |
| 5 | `#toolbar` positioned above `#events-list` | Integration | DOM order assertion against mounted root children |
| 6 | Lifecycle controls in `#toolbar` | Integration | querySelector scoped to `#toolbar` for pause/stop/discard/start/reset buttons |
| 7 | `#controls` is annotation-only + PII | Integration | querySelector scoped to `#controls` -- lifecycle buttons NOT present |
| 8 | Picker embedded in annotation wrapper | Integration | DOM structure -- `#pick-element-btn` is descendant of `.annotation-wrapper` |
| 9 | `newEventsChip` in `#events-list` | Integration | querySelector scoped to `#events-list` for `#new-events-chip` |
| 10 | Dialogs remain in `#controls` | Integration | querySelector scoped to `#controls` for `#pre-export-reminder` and `#discard-confirm-dialog` |
| 11 | Hide-not-disable preserved | Integration | Existing gated-controls tests -- querySelector returns null for hidden controls |
| 12 | All tests pass | Integration | `make test` |
| 13 | No type errors | Static analysis | `make typecheck` |
| 14 | Documentation updated | Manual | Review `docs/ARCHITECTURE.md` diff |

**Rules applied:**
- Default to **unit tests** -- they are fast and isolated
- Use **integration** only at component boundaries (DOM mounting is a component boundary)
- Use **e2e** only for critical user journeys -- none needed here (layout refactor, no new user flows)
- Each criterion maps to exactly ONE level -- no duplication across levels
- **All tests are deterministic** -- no LLM calls, no network, no timers beyond controlled microtask flushes

### Testing Strategy (Final)
- **Unit** (`src/lib/sidepanel-controls.test.ts`):
  - Remove all `screenshot` assertions from existing tests
  - Add negative assertion: `expect(model).not.toHaveProperty('screenshot')` for every (status x residual) combination
  - Verify all other fields unchanged (regression guard)

- **Integration** (`src/sidepanel/sidepanel.test.ts`):
  - Remove all `screenshot-btn` from presence/absence ID lists (~15 test cases)
  - Remove the "Capture screenshot shows a loading state" test entirely
  - Update layout test: DOM order is `[first-run-notice-container, toolbar, events-list, controls]`
  - Add: `#toolbar` contains lifecycle buttons during active session, `#start-btn` during idle
  - Add: `#controls` contains PII, annotation wrapper, addNote during active session
  - Add: `#pick-element-btn` is inside `.annotation-wrapper`
  - Add: `#new-events-chip` is inside `#events-list`
  - Add: `#pre-export-reminder` and `#discard-confirm-dialog` are inside `#controls`
  - Update: all button text assertions to account for `.btn-icon` + `.btn-label` span structure
  - Update: loading-state tests to verify icon preservation (`.btn-icon` span survives busy cycle)
  - Update: pause/resume label swap test to check both icon and label spans

- **E2E**: None needed. This is a pure UI layout refactor within the side panel; no new cross-component flows.

### Risk Mitigations (Final)
1. **`withLoadingState` icon destruction** (High severity, High likelihood): Fix `withLoadingState` to target `.btn-label` span BEFORE adding icons. Phase 2 before Phase 3 enforces this.
2. **`applyControlsModel` dual-mount correctness** (High severity, Medium likelihood): Phase 4 is the largest change. The split is mechanical -- `clearChildren(toolbar)` + `clearChildren(controls)` mirror the existing single-container pattern. Test assertions verify buttons appear in the correct container.
3. **Flex layout breaks scroll** (Medium severity, Medium likelihood): `#toolbar` must be `flex: 0 0 auto` so it does not compete with `#events-list` for space. Existing scroll tests will catch regressions.
4. **`newEventsChip` orphaned** (Medium severity, Low likelihood): Explicitly relocate to `#events-list` in Phase 4. Its sticky positioning already targets the scroll container.
5. **Dialog placement confusion** (Medium severity, Low likelihood): Keep dialogs in `#controls` -- they are contextual to privacy-critical actions, not to the toolbar trigger. Integration tests verify their DOM parent.
6. **Test churn** (Low severity, High likelihood): ~15 test cases reference `screenshot-btn`. Changes are mechanical (remove from lists) and done in Phase 1.

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | N | N | N | N |
| State machine | N | N | N | N |
| Conservation | N | N | N | N |
| Authorization | N | N | N | N |

**Recommendation**: SKIP
**Verification focus**: N/A -- the SessionStatus state machine is unchanged. All changes are in the DOM projection layer.
**Key invariants**: None requiring formal verification. The hide-not-disable invariant is already pinned by querySelector integration tests.

---

## Orchestrator Handoff

This evaluation is the **final decision** -- no human checkpoint follows. The orchestrator will:
1. Commit all plans to `docs/plans/feature-12/` for audit trail
2. Use the Test Level Matrix to generate acceptance tests at the correct levels
3. Proceed directly to implementation

**Summary for git commit**:
- Selected plan: Safety (with Quality elements)
- Key rationale: Only plan that correctly sequences `withLoadingState` refactor before icon addition, preventing high-likelihood icon-stripping bug
- Estimated effort: 135 minutes
- Key risks: `withLoadingState` icon destruction (mitigated by phase ordering), dual-mount correctness (mitigated by parallel test assertions), flex layout scroll (mitigated by existing scroll tests)
- Test levels: 1 unit, 12 integration, 0 e2e
