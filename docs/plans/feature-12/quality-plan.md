---
agent: quality-planner
generated: 2026-04-09T12:00:00Z
task_id: feature-12
perspective: quality
---

# Quality Plan: Side Panel Control Layout Refinement

## Architecture Impact

**Components affected:**
- `src/lib/sidepanel-controls.ts`: Remove `screenshot` field from `ControlVisibility`; add a new `ToolbarVisibility` interface (or extend `ControlVisibility` to logically group toolbar fields vs annotation fields) so the model cleanly describes TWO DOM regions, not one.
- `src/sidepanel/sidepanel.ts`: Split `applyControlsModel()` into two DOM-mounting functions -- one for `#toolbar` (lifecycle buttons, metrics, start/reset, empty-state hint) and one for `#controls` (annotation only: PII, textarea with embedded picker, add-note). Remove `screenshotBtn`, its click handler, and its `withLoadingState` wiring. Create `#toolbar` section. Restructure annotation area with embedded picker icon.
- `src/sidepanel/sidepanel.css`: Add `#toolbar` styles, annotation-wrapper styles for embedded picker, button icon styles. Remove screenshot-button-specific CSS if any.
- `src/lib/sidepanel-controls.test.ts`: Remove screenshot assertions, add tests for new model shape.
- `src/sidepanel/sidepanel.test.ts`: Update all integration tests that reference `screenshot-btn`. Update layout tests for three-region DOM. Add tests for toolbar presence and annotation-wrapper structure.
- `docs/ARCHITECTURE.md`: Update side panel description.

**New patterns or abstractions introduced:**
- `src/lib/sidepanel-icons.ts` -- a pure module of icon factory functions (Unicode characters or inline SVG string builders) that return `HTMLElement` nodes via the existing `el()` helper pattern. Centralising icon definitions avoids scattering glyph/SVG literals across `sidepanel.ts`. Justified because 7 buttons need icons and the project has zero icon precedent -- a dedicated icon module prevents the glue layer from growing even larger.
- Annotation wrapper composite -- a `<div>` wrapping the textarea with a positioned picker icon inside it. This is a natural extension of the existing element-chip pattern (a container with internal interactive elements).

**Dependencies added or modified:**
- None -- pure vanilla TS, no icon library.

**Breaking changes to existing interfaces:**
- `ControlVisibility.screenshot` is removed. This is an internal-only interface consumed solely by `sidepanel.ts`, so no external migration is needed.
- The DOM structure changes from two-region (`#events-list` + `#controls`) to three-region (`#toolbar` + `#events-list` + `#controls`). Integration tests that assert DOM order will need updates.

## Architectural Approach

The key design decision is how to keep the `ControlVisibility` model clean when controls are split across two DOM regions (toolbar above event feed, annotation area below). Rather than introducing two separate model interfaces, the existing `ControlVisibility` remains a single flat shape -- it already contains logically distinct groups (lifecycle: start/pause/stop/discard/reset; interaction: annotation/elementPicker; always-on: piiMode/metrics). The `applyControlsModel()` function in the glue layer is split into `applyToolbar(model)` and `applyAnnotationArea(model)`, each consuming the same `ControlVisibility` and mounting their respective fields into the correct DOM section. This preserves the single-source-of-truth invariant: `buildControlsModel()` is still the only function that decides what is visible. The DOM skeleton changes from `[notice, events-list, controls]` to `[notice, toolbar, events-list, controls]`, where `#toolbar` is a sticky top section and `#controls` is the sticky bottom section (now annotation-only + PII).

For icons, Unicode characters are the simplest approach that matches the project's "no framework, no external deps" philosophy. Each button gets a leading text node with a Unicode glyph (e.g., `\u25B6` Play, `\u23F8` Pause, `\u23F9` Stop, `\u{1F5D1}` Discard, `\u21BA` Reset, `\u{1F4CE}` Pick, `\u{1F4DD}` Note). This avoids SVG complexity and additional build pipeline concerns. If higher-fidelity icons are desired later, the `sidepanel-icons.ts` module provides a single swap point.

## Files to Create/Modify

| File | Purpose | Quality Considerations |
|------|---------|----------------------|
| `src/lib/sidepanel-icons.ts` (new) | Pure icon factory module -- exports named constants or factory functions for each button icon | Zero DOM dependency for constants; if factory functions are used, they should take the existing `el()` pattern. Keep it trivially testable. |
| `src/lib/sidepanel-controls.ts` | Remove `screenshot` field from `ControlVisibility` interface and from `buildControlsModel()` return value | Ensure the interface change is a clean removal, not a deprecation. TypeScript compiler will catch any remaining references. |
| `src/sidepanel/sidepanel.ts` | (1) Add `#toolbar` section to DOM skeleton. (2) Remove `screenshotBtn` and its wiring. (3) Split `applyControlsModel()` into `applyToolbar()` + `applyAnnotationArea()`. (4) Add icons to all buttons. (5) Create annotation wrapper with embedded picker. | Largest change. Keep the two apply functions parallel in structure. Button creation stays at the same scope level. Follow existing `el()` pattern. |
| `src/sidepanel/sidepanel.css` | (1) Add `#toolbar` styles (sticky top, flex, gap). (2) Add `.annotation-wrapper` styles (position: relative wrapper, picker icon positioned inside). (3) Add `.btn-icon` styles for inline icon spacing. (4) Remove `--screenshot` CSS variable if no longer referenced. | Keep CSS variable naming consistent with existing palette. |
| `src/lib/sidepanel-controls.test.ts` | Remove all `screenshot` assertions. Verify the field no longer exists on the returned object. | Negative assertion: `expect(model).not.toHaveProperty('screenshot')`. |
| `src/sidepanel/sidepanel.test.ts` | (1) Remove all `screenshot-btn` references. (2) Update layout test to assert three-region DOM order: `[toolbar, events-list, controls]`. (3) Add test for toolbar containing lifecycle buttons during active session. (4) Add test for annotation wrapper containing picker icon. (5) Update "active session contains all required elements" list. | Most test changes are subtractive (removing screenshot-btn from presence/absence lists) plus additive (toolbar layout assertions). |
| `docs/ARCHITECTURE.md` | Update side panel description to reflect toolbar + annotation-area layout, removal of standalone screenshot button, embedded picker. | Keep description concise, matching existing doc style. |

**Total files**: 7 (1 new, 6 modified)

## Implementation Steps

1. **Create `src/lib/sidepanel-icons.ts`** -- Define Unicode icon constants for all 7 buttons (Start, Pause, Resume, Stop, Discard, Reset, Add note, Pick element). Export as a plain object map. No DOM, no side effects. Quality rationale: centralising icons prevents literal scattering and makes future icon-system upgrades a single-file change.

2. **Remove `screenshot` from `ControlVisibility`** -- Delete the `screenshot` boolean from the interface in `sidepanel-controls.ts` and from the return object in `buildControlsModel()`. Run `make typecheck` to surface all compile errors. Quality rationale: the TypeScript compiler is the primary safety net here; removing the field eagerly surfaces every downstream reference.

3. **Update `sidepanel-controls.test.ts`** -- Remove screenshot assertions from all test cases. Add a negative assertion confirming the field is absent. Quality rationale: tests should be updated before the glue layer so the model contract is locked first.

4. **Restructure the DOM skeleton in `sidepanel.ts`** -- Insert `#toolbar` section between `noticeContainer` and `eventsList`. Move Start, Pause, Stop, Discard, Reset, metricsRow, emptyStateHint into `applyToolbar()`. Keep PII fieldset, annotation textarea, element chip, picker button (embedded), add-note button in `applyAnnotationArea()`. Remove `screenshotBtn`, its `addEventListener('click', ...)`, and the `withLoadingState(screenshotBtn, ...)` call. Quality rationale: do the structural DOM change and the screenshot removal in a single step to avoid an intermediate state where screenshot exists but has no home.

5. **Add icons to buttons** -- Import icon constants from `sidepanel-icons.ts`. Prepend icon text nodes to each button's children. Adjust the `withLoadingState` helper to preserve icon nodes when swapping labels (store and restore icon + label separately, or use a `<span>` for the label text). Quality rationale: the `withLoadingState` helper currently sets `btn.textContent` which would blow away icon nodes. Wrapping the label in a `<span class="btn-label">` makes icon preservation clean.

6. **Create annotation wrapper with embedded picker** -- Build a `<div class="annotation-wrapper">` that wraps the textarea. Position the picker icon button inside the wrapper (absolutely positioned at bottom-right or on the border). The picker button loses its flex-row placement and becomes part of the annotation composite. Quality rationale: this groups related UI elements (text input + element picker) into a semantic unit, matching the "annotation is a composite" mental model.

7. **Update CSS** -- Add `#toolbar` styles: `flex: 0 0 auto`, `border-bottom: 1px solid var(--border)`, `padding: 12px`, `display: flex`, `flex-direction: column`, `gap: 8px`, `background: var(--bg-elev)`. Add `.annotation-wrapper` styles for the embedded picker. Add `.btn-icon` margin-right spacing. Quality rationale: mirror existing `#controls` style patterns so the two sticky regions look consistent.

8. **Update integration tests** -- Systematically update `sidepanel.test.ts`: (a) remove all `screenshot-btn` from presence/absence ID lists, (b) update layout test from two-region to three-region, (c) add toolbar-specific assertions, (d) add annotation-wrapper assertions. Quality rationale: test updates are the final step because they validate the entire implementation against the DoD.

9. **Update ARCHITECTURE.md** -- Revise the side panel description to reflect the new three-region layout, toolbar contents, annotation wrapper, and screenshot button removal. Quality rationale: docs stay in sync with code.

## Definition of Done

- [ ] `screenshot` field removed from `ControlVisibility` interface and `buildControlsModel()`
- [ ] `#screenshot-btn` element no longer exists in any session state
- [ ] `#toolbar` section renders above `#events-list` with lifecycle controls (Start/Pause/Stop/Discard/Reset) and metrics
- [ ] `#controls` section contains only PII selector, annotation textarea with embedded picker, and Add note button
- [ ] All buttons have leading icons (visible in DOM as icon text/elements)
- [ ] Element picker is embedded inside annotation textarea wrapper
- [ ] Existing gating logic preserved: hide-not-disable, controls absent from DOM when not applicable
- [ ] `withLoadingState` preserves icons during busy state
- [ ] All existing tests pass (after updates)
- [ ] New tests cover toolbar layout, embedded picker, icon presence
- [ ] No linting warnings
- [ ] No type errors (`make typecheck` passes)
- [ ] `make build` succeeds
- [ ] Documentation updated

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `screenshot` removed from ControlVisibility | Unit | Pure model function, isolated test |
| 2 | `#screenshot-btn` absent from all states | Integration | DOM query against mounted side panel in jsdom |
| 3 | `#toolbar` renders above `#events-list` | Integration | DOM structure test, needs mount |
| 4 | `#controls` is annotation-only | Integration | DOM structure test, needs mount |
| 5 | All buttons have leading icons | Integration | DOM content test, needs mount |
| 6 | Picker embedded in annotation wrapper | Integration | DOM structure test, needs mount |
| 7 | Hide-not-disable gating preserved | Unit + Integration | Unit: model returns correct booleans. Integration: DOM querySelector === null. |
| 8 | `withLoadingState` preserves icons | Integration | Needs async button interaction in jsdom |
| 9 | All existing tests pass | Integration | Existing test suite run |
| 10 | New tests cover toolbar layout | Integration | DOM structure tests |
| 11 | No type errors | Unit (build) | `make typecheck` in CI |
| 12 | Documentation updated | Manual | Review |

## Testing Strategy

- **Unit** (`src/lib/sidepanel-controls.test.ts`):
  - Remove all `screenshot` assertions from existing tests
  - Add negative assertion: `expect(model).not.toHaveProperty('screenshot')` for every state
  - Verify all other fields unchanged (regression guard)
  - Total: ~5 modified test cases, 1 new assertion per state combination

- **Unit** (`src/lib/sidepanel-icons.test.ts` -- optional, low priority):
  - Verify each icon constant is a non-empty string
  - Skip if icons are just Unicode constants -- the integration tests cover their presence implicitly

- **Integration** (`src/sidepanel/sidepanel.test.ts`):
  - **Layout test update**: assert DOM order is `[first-run-notice-container, toolbar, events-list, controls]`
  - **Pre-session toolbar**: `#toolbar` contains `#start-btn`, `#metrics-row`, `#empty-state-hint`, `#pii-mode-fieldset`; does NOT contain `#pause-btn`, `#stop-btn`, `#discard-btn`
  - **Active session toolbar**: `#toolbar` contains `#pause-btn`, `#stop-btn`, `#discard-btn`, `#metrics-row`; does NOT contain `#start-btn`
  - **Active session annotation area**: `#controls` contains `#annotation-text`, `#add-note-btn`, `#pick-element-btn` (embedded); does NOT contain lifecycle buttons
  - **Screenshot button absent**: `querySelector('#screenshot-btn')` returns null in ALL states (idle, running, paused, stopped)
  - **Icons present on buttons**: for each button ID, assert `querySelector('#<id> .btn-icon')` or that `textContent` starts with the expected icon character
  - **Annotation wrapper**: `#annotation-text` is inside `.annotation-wrapper`; `.annotation-wrapper` contains `#pick-element-btn`
  - **Loading state preserves icons**: trigger `withLoadingState` on a button, assert icon node still present during busy state
  - **Reminder panel in toolbar**: pre-export reminder renders inside `#toolbar` (not `#controls`) since Stop is in toolbar
  - **Discard dialog in toolbar**: same -- discard confirm dialog renders in `#toolbar`
  - Total: ~8-10 new test cases, ~15 modified test cases (removing screenshot-btn from ID lists)

- **E2E**: None needed. This is a pure UI layout refactor within the side panel; no new user journeys or cross-component flows are introduced.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: None. There are no e2e test files in the project (`**/*.e2e.*` glob returned empty).
- **New e2e tests needed**: None. This feature changes internal layout only; no new cross-component flows.
- **Cost note**: N/A.

**Test files to create/modify**:
- `src/lib/sidepanel-controls.test.ts` (modify)
- `src/sidepanel/sidepanel.test.ts` (modify)

**Coverage target**: 95% for new/modified code (matching existing coverage level of the controls module).

## Code Quality Checklist

- [x] Follows SOLID principles where applicable -- Single Responsibility: icon module, controls model, glue layer each have one job
- [x] No code duplication (DRY) -- icons centralised, apply functions share the same model
- [x] Clear naming (variables, functions, files) -- `applyToolbar`, `applyAnnotationArea`, `BUTTON_ICONS`
- [x] Appropriate abstraction level (not over/under-engineered) -- flat icon constants, not an icon component system
- [x] Error handling is comprehensive -- no new error paths; existing handlers preserved
- [x] Types are properly defined (no `any` in TypeScript) -- `ControlVisibility` interface updated cleanly
- [x] Edge cases are handled -- `withLoadingState` icon preservation, picker in annotation wrapper when annotation is hidden
- [x] Logging/monitoring where appropriate -- no logging needed for UI layout changes

## Patterns to Apply

| Pattern | Where | Why |
|---------|-------|-----|
| Single source of truth (view model) | `buildControlsModel()` remains the sole authority | Two DOM regions consume one model, preventing visibility logic from scattering |
| Hide-not-disable (structural mount/unmount) | `applyToolbar()` + `applyAnnotationArea()` | Preserves the existing DoD contract -- controls absent from DOM, not display:none |
| Centralised constants module | `sidepanel-icons.ts` | 7 icons need a home; scattering literals in glue code would degrade readability |
| Composite component (wrapper pattern) | Annotation wrapper with embedded picker | Groups related UI into a semantic unit, matching how users think about "add a note with an element reference" |
| Label span pattern for `withLoadingState` | `<span class="btn-icon">` + `<span class="btn-label">` inside each button | Separating icon from label text lets the loading helper swap just the label span without destroying the icon |

## Impact Assessment

**Positive Impacts**:
- Lifecycle controls move to a persistent toolbar, always visible without scrolling past the event feed
- Screenshot button removal simplifies the control surface (annotations with auto-screenshot already capture what is needed)
- Embedded picker in annotation area creates a tighter workflow for element-targeted annotations
- Icons improve scannability and reduce cognitive load for button identification
- `ControlVisibility` interface becomes smaller (one fewer field)

**Neutral** (what stays the same):
- Service worker is completely untouched -- no message protocol changes
- Content script is completely untouched
- Export schema is unchanged
- `TAKE_SCREENSHOT` message type is retained (used internally by annotation submit for element cropping)
- `buildControlsModel()` logic is unchanged except for removing one field

**Risks**:
- **`withLoadingState` icon preservation**: The current helper uses `btn.textContent` which would destroy child nodes including icons. Mitigation: wrap button labels in a `<span class="btn-label">` and have the helper target that span instead of the full `textContent`. This is a controlled refactor within one function.
- **Reminder/discard dialog placement**: These panels were appended to `#controls`. Since Stop and Discard move to `#toolbar`, the reminder and discard dialogs must also move to `#toolbar`. If they remain in `#controls` they would be orphaned when the triggering button is in a different section. Mitigation: append them to `#toolbar` in `applyToolbar()`.
- **Test churn**: ~15 test cases reference `screenshot-btn`. Mitigation: the changes are mechanical (remove from lists) and can be done with find-and-replace.
- **CSS specificity conflicts**: new `#toolbar` might collide with existing `#controls` styles. Mitigation: `#toolbar` gets its own rule set, modeled after `#controls` but as a top sticky section.

## Estimated Effort

- Planning: Already done
- Implementation: 90 minutes (icons module: 10, model change: 10, DOM restructure: 40, CSS: 15, annotation wrapper: 15)
- Testing: 60 minutes (model test updates: 10, integration test updates: 40, manual verification: 10)
- Review prep: 15 minutes
- **Total**: 165 minutes

## Technical Debt Addressed

- **Screenshot button was redundant**: Annotations already auto-capture screenshots when submitted. The standalone screenshot button created confusion about when screenshots are taken and cluttered the control surface. Removing it eliminates a feature that overlapped with annotation-attached screenshots.
- **Single monolithic controls region**: Having all controls in one bottom section forced users to scroll the event feed to see lifecycle state during long sessions. Splitting into toolbar + annotation area is the natural evolution.
- **No icons on buttons**: Text-only buttons in a dense control layout required reading each label. Icons provide faster visual scanning and are standard UX practice.

## Formal Verification Assessment

- Concurrency concerns: No -- all DOM mutations are synchronous within the single-threaded side panel JS context.
- State machine complexity: No change -- `SessionStatus` state machine and `buildControlsModel()` are unchanged in logic. Only the `screenshot` field is removed.
- Conservation laws: No -- no quantities that must be conserved.
- Authorization model: No -- no access control changes.
- Recommendation: Formal verification not needed. The change is a UI layout refactor. The existing state machine and control visibility model remain the formal specification; only their DOM consumption changes.

## Future Extensibility

- **Icon system upgrade**: The `sidepanel-icons.ts` module is the single swap point if the project later adopts SVG icons or an icon sprite sheet. The current Unicode approach is the simplest viable solution; the module boundary means upgrading is a one-file change.
- **Additional toolbar actions**: The toolbar structure naturally accommodates future buttons (e.g., "Settings", "Help") by adding fields to `ControlVisibility` and mounting them in `applyToolbar()`.
- **Annotation enhancements**: The annotation wrapper pattern can accommodate future embedded controls (e.g., a formatting toolbar, markdown preview toggle) without restructuring the layout.
- **Responsive layout**: The three-region flex layout degrades gracefully in narrow side panels since flex-column with `gap` handles variable content heights.
