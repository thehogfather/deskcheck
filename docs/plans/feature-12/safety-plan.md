---
agent: safety-planner
generated: 2026-04-09T12:00:00Z
task_id: feature-12
perspective: safety
---

# Safety Plan: Side panel control layout refinement

## Architecture Impact

**Components affected:**
- `src/lib/sidepanel-controls.ts`: Remove `screenshot` field from `ControlVisibility` interface. This is the pure view-model that every test and the glue layer depends on.
- `src/sidepanel/sidepanel.ts`: Major DOM restructuring -- new `#toolbar` section, removed `screenshotBtn`, embedded element picker inside annotation wrapper, icon additions to all buttons. The `applyControlsModel()` function is the highest-risk change point.
- `src/sidepanel/sidepanel.css`: New styles for `#toolbar`, annotation wrapper with embedded picker icon, button icon alignment.
- `src/lib/sidepanel-controls.test.ts`: Remove screenshot assertions, add any new visibility fields if the toolbar/annotation split introduces them.
- `src/sidepanel/sidepanel.test.ts`: Extensive updates -- tests assert specific DOM structure (`#controls` children, `#screenshot-btn` presence), DOM order assertions.

**New patterns or abstractions introduced:**
- `#toolbar` section: A new top-level flex child between `#first-run-notice-container` and `#events-list`. Contains lifecycle controls (Start, Pause, Stop, Discard, Reset) and the metrics row. This is a structural pattern change -- controls are now split across TWO mount regions (`#toolbar` + `#controls`) instead of one.
- Annotation wrapper: A composite element wrapping textarea + inline picker icon. Replaces the current flat layout where picker is a standalone button in a `.sp-row`.

**Dependencies added or modified:**
- None -- no new npm packages. SVG icons or Unicode glyphs are inline.

**Breaking changes to existing interfaces:**
- `ControlVisibility.screenshot` field removed. Any consumer referencing `model.screenshot` will get a compile error. This is intentional and detectable at typecheck time.
- The `#controls` section no longer contains lifecycle buttons (pause/stop/discard/start/reset). Tests that assert these exist as children of `#controls` will break and must be updated.
- `#screenshot-btn` is removed from the DOM entirely. Tests asserting its presence will break.

**Risk points in architecture this task touches:**
- `applyControlsModel()` is the single function that orchestrates ALL DOM mounting/unmounting for both `#toolbar` and `#controls`. A bug here breaks the entire side panel UX and the feature #11 DoD invariant (hide-not-disable).
- The flex layout (`noticeContainer` -> `eventsList` -> `controls`) is the foundation of the two-region scroll behavior. Inserting `#toolbar` between notice and events-list changes the flex children, which could break the scroll anchor and auto-scroll behavior.
- The `withLoadingState()` helper saves/restores `btn.textContent`. Adding icons means textContent now includes icon text. If `withLoadingState` saves "Pause" but the button now reads "\u23f8 Pause", the restore will strip the icon.

## Risk Assessment

### Identified Risks
| Risk | Severity | Likelihood | Impact | Mitigation |
|------|----------|------------|--------|------------|
| R1: `applyControlsModel()` dual-mount bug | High | Medium | All controls disappear or appear in wrong region | Phase the implementation: toolbar mount logic separate from controls mount logic, test each independently |
| R2: `withLoadingState` strips icons on restore | High | High | Button icons vanish after any async action (save, export) | Refactor `withLoadingState` to save/restore innerHTML or use a label span separate from the icon |
| R3: Flex layout breaks scroll anchor | Medium | Medium | Events list no longer scrolls or auto-scroll fails | Test scroll geometry explicitly after toolbar insertion; toolbar must be `flex: 0 0 auto` |
| R4: `#screenshot-btn` removal breaks tests | Low | High | Tests fail but no runtime bug | Update all test assertions in the same commit as the removal |
| R5: Element picker embed breaks chip display | Medium | Medium | Selected element chip no longer visible or clear button unreachable | Test the chip lifecycle (show/clear) with the new wrapper structure |
| R6: `newEventsChip` orphaned after controls split | Medium | Low | New-events chip stops appearing | Currently appended to `#controls`; must move to `#events-list` or `#toolbar` |
| R7: Reminder/discard dialog displaced by toolbar split | Medium | Medium | Pre-export reminder or discard dialog not visible | Dialogs are currently appended to `#controls`; they must stay accessible in the annotation region or be repositioned |
| R8: `ControlVisibility` interface change breaks downstream | Low | Low | Type errors in service worker or other consumers | The interface is only consumed by `sidepanel.ts` and tests -- grep confirms no other imports |

### Failure Modes Analysis
1. **FM1: Toolbar renders but events list loses scroll**
   - Cause: Inserting `#toolbar` as a flex child without `flex: 0 0 auto` causes it to compete for space with `#events-list`
   - Detection: Integration test asserting `events-list` has `overflow-y: auto` and `flex: 1 1 auto`; manual visual verification
   - Recovery: Revert the toolbar insertion commit; controls revert to single `#controls` section

2. **FM2: Button icons break loading state feedback**
   - Cause: `withLoadingState()` uses `btn.textContent` to save/restore label. With icons, textContent includes the icon character, and the busy label ("Saving...") replaces the entire content including icon.
   - Detection: Existing test "Save annotation shows a loading state" will fail because it asserts `textContent === "Saving..."` but button would still have an icon prefix, OR the restore would lose the icon.
   - Recovery: Fix `withLoadingState` to use a `<span class="btn-label">` for the text portion; icon lives in a sibling `<span class="btn-icon">`.

3. **FM3: Annotation wrapper breaks textarea sizing**
   - Cause: Wrapping the textarea in a container div changes its width calculation (it currently has `width: 100%` on `#annotation-text`)
   - Detection: CSS test or visual regression -- textarea should still fill the available width
   - Recovery: Set `position: relative` on wrapper, keep `width: 100%` on textarea, position picker icon absolutely

4. **FM4: Discard/reminder dialogs inaccessible after layout change**
   - Cause: Dialogs are currently children of `#controls` and positioned inline. If lifecycle controls move to toolbar but dialogs stay in `#controls`, clicking Stop (in toolbar) would show a reminder in the bottom annotation area -- confusing UX. If dialogs move to toolbar, they might get clipped.
   - Detection: Integration test clicking Stop and asserting the reminder is visible and interactable
   - Recovery: Keep dialogs in `#controls` (bottom section) -- they are contextual to the export/discard action which is a deliberate decision, so appearing at the bottom near the annotation is acceptable. Alternatively move them to a full-width overlay.

5. **FM5: `asyncErrorLine` and `newEventsChip` lost in the split**
   - Cause: Currently appended to `#controls` at the end of `applyControlsModel()`. After the split, they need a clear home.
   - Detection: Tests for new-events chip and async error line will fail if they cannot be found in the DOM
   - Recovery: Move `asyncErrorLine` to `#controls` (annotation section), move `newEventsChip` to remain inside `#events-list` (it already uses sticky positioning relative to the events list)

### Blast Radius
- **Affected users**: All users of the side panel -- this is the primary UI surface
- **Affected systems**: Side panel only. Service worker, content script, and export logic are unaffected. The `ControlVisibility` interface change is contained to the side panel module boundary.
- **Data at risk**: None. This is a pure UI change. No data storage, no session state, no export format changes.

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 0 | Baseline: run `make test` and `make typecheck` | All green | N/A -- establishes known-good state |
| 1 | Remove `screenshot` from `ControlVisibility` + update model tests + remove screenshotBtn from sidepanel.ts + update integration tests | `make typecheck` passes, `make test` passes, no references to `screenshot-btn` remain | `git revert` this single commit |
| 2 | Refactor `withLoadingState` to use label spans (icon-safe) | Existing loading-state tests still pass with current text-only buttons | `git revert` -- buttons still work without icons |
| 3 | Add icons to all buttons using `<span class="btn-icon">` + `<span class="btn-label">` structure | `make typecheck`, visual manual check, existing button-text assertions updated | `git revert` -- buttons revert to text-only |
| 4 | Create `#toolbar` section, move lifecycle controls (Start, Pause, Stop, Discard, Reset, metrics) to toolbar; `#controls` becomes annotation-only + PII | `make test` (updated assertions), two-region layout test still passes, scroll tests pass | `git revert` -- controls revert to single section |
| 5 | Embed element picker inside annotation textarea wrapper | Chip lifecycle tests pass, picker click sends `START_ELEMENT_PICKER`, textarea still full-width | `git revert` -- picker reverts to standalone button |
| 6 | CSS polish: toolbar styling, annotation wrapper styling, responsive checks | `make build`, manual load in Chrome | `git revert` CSS changes only |

## Files to Create/Modify
| File | Purpose | Risk Notes |
|------|---------|------------|
| `src/lib/sidepanel-controls.ts` | Remove `screenshot` field from `ControlVisibility` | Interface change propagates to all consumers -- typecheck catches missed references |
| `src/lib/sidepanel-controls.test.ts` | Remove `screenshot` assertions | Low risk -- test-only change |
| `src/sidepanel/sidepanel.ts` | Major restructure: remove screenshotBtn, add toolbar, refactor applyControlsModel for dual-region mount, embed picker in annotation wrapper, add icons, refactor withLoadingState | **Highest risk file** -- 1072 lines of tightly coupled DOM logic |
| `src/sidepanel/sidepanel.css` | Add `#toolbar` styles, `.annotation-wrapper` styles, `.btn-icon` styles | Medium risk -- flex layout changes can cascade |
| `src/sidepanel/sidepanel.test.ts` | Update all DOM structure assertions, remove screenshot-btn tests, update `#controls` children expectations to account for toolbar split | High volume of changes but low runtime risk |
| `src/types.ts` | No change needed -- `TAKE_SCREENSHOT` message type stays (used by annotation handler) | Confirmed: annotation's screenshot capture is independent of the screenshot button |

## Definition of Done
- [ ] `screenshot` field removed from `ControlVisibility` and all references
- [ ] `screenshotBtn` element and click handler removed from `sidepanel.ts`
- [ ] All buttons have leading icons (SVG or Unicode)
- [ ] `withLoadingState` preserves icons during loading/restore cycle
- [ ] `#toolbar` section exists above `#events-list` containing lifecycle controls + metrics
- [ ] `#controls` section contains only PII fieldset + annotation area
- [ ] Element picker icon embedded inside annotation textarea wrapper
- [ ] Hide-not-disable invariant preserved (controls absent from DOM, not display:none)
- [ ] Scroll anchor and auto-scroll behavior unbroken
- [ ] All existing tests updated and passing
- [ ] No type errors (`make typecheck`)
- [ ] `make build` succeeds

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `screenshot` field removed from ControlVisibility | Unit | Pure model function, existing unit tests cover all states |
| 2 | screenshotBtn removed | Integration | DOM structure assertion in sidepanel.test.ts |
| 3 | All buttons have icons | Integration | DOM assertion that button children include icon span |
| 4 | withLoadingState preserves icons | Integration | Exercises async handler + DOM mutation; existing loading-state tests cover this boundary |
| 5 | Toolbar contains lifecycle controls | Integration | DOM structure + parent-child assertions |
| 6 | Controls section is annotation-only | Integration | DOM structure assertion |
| 7 | Element picker embedded in annotation wrapper | Integration | DOM structure + click handler wiring |
| 8 | Hide-not-disable invariant | Integration | querySelector returns null for hidden controls -- existing test pattern |
| 9 | Scroll anchor unbroken | Integration | Existing scroll tests with geometry mocking |
| 10 | All tests pass | Unit + Integration | `make test` |
| 11 | No type errors | Static analysis | `make typecheck` |

**Safety planner bias**: Integration tests are the right level for nearly all criteria because the risk is in DOM structure and element wiring, not in pure logic. The only unit-level criterion is the ControlVisibility model change.

**Determinism rule**: All tests are deterministic. No LLM calls, no network, no timers beyond controlled `setTimeout(r, 0)` microtask flushes already established in the test harness.

## Testing Strategy (Comprehensive)

### Unit Tests
- `buildControlsModel` no longer returns `screenshot` field (all 8 status x residual combinations)
- `buildControlsModel` returns unchanged values for all other fields (regression)
- **Edge cases**:
  - Exhaustive (status x residualState) matrix still covers all expected boolean combinations
  - Verify TypeScript compilation fails if any code references `model.screenshot`

### Integration Tests
- **Screenshot button removal**: Pre-session and active-session DOM assertions exclude `#screenshot-btn`
- **Icon presence**: Every button (`#start-btn`, `#pause-btn`, `#stop-btn`, `#discard-btn`, `#reset-btn`, `#add-note-btn`, `#pick-element-btn`) contains a `.btn-icon` child
- **withLoadingState icon preservation**: After clicking Add note with slow response, button still contains `.btn-icon` when restored to idle state
- **Toolbar structure**: `#toolbar` is a direct child of root, positioned between `#first-run-notice-container` and `#events-list` in DOM order
- **Toolbar contents**: In active session, `#toolbar` contains `#pause-btn`, `#stop-btn`, `#discard-btn`, `#metrics-row`; in idle, contains `#start-btn`, `#metrics-row`
- **Controls (bottom) contents**: In active session, contains `#pii-mode-fieldset`, annotation wrapper with `#annotation-text`, `#add-note-btn`, picker icon; in idle, contains `#pii-mode-fieldset`, `#empty-state-hint`
- **Element picker embed**: Picker icon inside `.annotation-wrapper` triggers `START_ELEMENT_PICKER` on click
- **Chip lifecycle with embedded picker**: PICK_ELEMENT_RESULT shows chip, clear button works, chip clears on session end
- **Scroll behavior**: Inserting toolbar does not break auto-scroll or new-events chip
- **Reminder/discard dialogs**: Still accessible after toolbar split (clicking Stop shows reminder, clicking Discard shows dialog)
- **Hide-not-disable regression**: All existing gated-controls tests pass with updated DOM structure expectations

### E2E Tests
- None needed. This is a UI layout change within the side panel. The existing manual smoke test (load extension, start session, verify controls) covers the user journey.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: None -- the project has no automated e2e tests
- **New e2e tests needed**: None -- layout changes are fully testable at integration level with jsdom
- **Cost note**: N/A

### Regression Tests
- Annotation submit still sends `ADD_ANNOTATION` with correct text (existing test)
- Annotation with element screenshot still captures via `TAKE_SCREENSHOT` trigger "annotation" (existing test -- unaffected by screenshot button removal)
- Pause/resume label swap still works (existing test)
- Pre-export reminder flow still works (existing test)
- Discard confirmation flow still works (existing test)
- Reset flow still works (existing test)
- Live event append preserves existing rows (existing test)
- Cross-window focus refetch still works (existing test)
- First-run notice still works (existing test)

### Load/Stress Tests (if applicable)
- Not applicable for a UI layout change.

**Test files to create/modify**:
- `src/lib/sidepanel-controls.test.ts` (modify: remove screenshot assertions)
- `src/sidepanel/sidepanel.test.ts` (modify: update DOM structure assertions throughout, remove screenshot-btn tests, add toolbar structure tests, add icon tests, add embedded picker tests)

## Rollback Strategy

### Trigger Conditions
When to rollback:
- Any existing test fails after changes AND the fix is not obvious within 15 minutes
- `make typecheck` reports errors outside the files being changed (indicates interface leak)
- Manual smoke test in Chrome shows broken layout (controls not visible, scroll broken, buttons non-functional)

### Rollback Steps
1. `git stash` or `git revert HEAD~N` to return to the last known-good commit
2. Run `make test && make typecheck && make build` to confirm clean state
3. Identify which phase introduced the regression from the commit history
4. Re-approach that phase with a smaller increment

### Verification After Rollback
- [ ] `make test` passes (all existing tests green)
- [ ] `make typecheck` passes
- [ ] `make build` produces a loadable extension
- [ ] Manual load in Chrome: side panel opens, Start button works, controls appear

### Rollback Tested?
- [ ] No, but rollback is trivial: each phase is a separate git commit, and `git revert` is the standard mechanism

## Monitoring & Alerting

### Metrics to Watch
| Metric | Normal Range | Alert Threshold |
|--------|--------------|-----------------|
| Test pass rate | 100% | Any failure |
| TypeScript errors | 0 | Any error |
| Build size (dist/) | ~current | >20% increase (would indicate accidentally bundled assets) |

### Alerts to Configure
- CI pipeline failure notification (existing GitHub Actions setup if present)
- No runtime alerting needed -- this is a local extension

## Deployment Recommendations

- [ ] **Feature flag**: Not needed -- this is a UI layout change with no backend impact
- [ ] **Gradual rollout**: Not needed -- Chrome extension updates atomically
- [ ] **Staging verification**: Manual load-unpacked verification in Chrome before tagging release
- [ ] **Off-hours deployment**: Not needed -- local extension

## Estimated Effort
- Planning: Already done
- Implementation: 90 minutes
  - Phase 1 (screenshot removal): 15 min
  - Phase 2 (withLoadingState refactor): 15 min
  - Phase 3 (icons): 20 min
  - Phase 4 (toolbar split): 25 min
  - Phase 5 (picker embed): 15 min
- Safety verification: 15 minutes (make test + typecheck + manual smoke between phases)
- Testing: 30 minutes (updating existing tests + writing new assertions)
- **Total**: 135 minutes

## Formal Verification Assessment
- Concurrency concerns: No -- single-threaded DOM manipulation, no shared state across workers for this change
- State machine complexity: The SessionStatus state machine (idle/running/paused/stopped) is not changing. The `applyControlsModel()` function is a pure projection of this state. No new states or transitions.
- Conservation laws: No -- no quantities to conserve
- Authorization model: No -- no access control changes
- Recommendation: Formal verification NOT needed. The state machine is unchanged; the risk is in DOM structure, which is best verified by integration tests.

## Security Considerations
- [x] No secrets in code -- UI-only change
- [x] Input validation complete -- textarea input handling unchanged
- [x] Output encoding where needed -- no new output channels
- [x] Authentication/authorization verified -- N/A for extension UI
- [x] OWASP top 10 considered -- no new attack surface (no innerHTML, all DOM built via `el()` helper)

## Key Implementation Details for Implementer

### Critical: `withLoadingState` must be refactored BEFORE adding icons

The current implementation (line 692-711) does:
```
const idleLabel = btn.textContent ?? "";
btn.textContent = busyLabel;
// ... later ...
btn.textContent = idleLabel;
```

If icons are added first, `textContent` will serialize the icon + label as flat text, and the restore will inject that flat text (destroying the icon DOM node). The fix is to:
1. Structure buttons as `<span class="btn-icon">ICON</span><span class="btn-label">Text</span>`
2. Change `withLoadingState` to target only the `.btn-label` span

### Critical: `applyControlsModel()` must mount to TWO containers

The current function (line 767-848) does `clearChildren(controls)` then appends children to `controls`. After the split, it must also `clearChildren(toolbar)` and mount lifecycle controls there. The function signature stays the same, but the body becomes:

```
clearChildren(toolbar);
clearChildren(controls);
// Toolbar: metrics, lifecycle (or start+reset)
// Controls: piiMode, annotation wrapper, dialogs
```

### Critical: DOM order in root must be maintained

Current: `noticeContainer -> eventsList -> controls`
New: `noticeContainer -> toolbar -> eventsList -> controls`

The two-region layout test (matrix #5) asserts DOM order. The toolbar must be inserted BEFORE eventsList.

### Non-obvious: `newEventsChip` current home is inside `#controls`

Line 847: `controls.appendChild(newEventsChip)`. This chip uses sticky positioning and is semantically related to the events list. After the split, it should move inside `#events-list` (where it already uses `position: sticky; bottom: 8px`). The CSS already targets `.new-events-chip` with sticky positioning relative to its scroll container -- moving it inside `#events-list` is actually MORE correct.

### Non-obvious: `asyncErrorLine` stays in `#controls` (annotation section)

The error line shows annotation/export errors. It belongs with the annotation area, which stays in `#controls`.

### Non-obvious: Reminder and discard dialogs stay in `#controls`

Even though Stop/Discard buttons move to toolbar, the dialogs should remain in `#controls` (bottom). The user clicks Stop in the toolbar, the reminder appears at the bottom near the annotation -- this is intentional friction for a privacy-critical action.
