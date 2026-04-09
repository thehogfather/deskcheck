---
agent: speed-planner
generated: 2026-04-09T00:00:00Z
task_id: feature-12
perspective: speed
---

# Speed Plan: Side panel control layout refinement

## Architecture Impact

**Components affected:**
- `src/lib/sidepanel-controls.ts`: Remove `screenshot` field from `ControlVisibility`
- `src/sidepanel/sidepanel.ts`: Restructure DOM skeleton (add `#toolbar` section), remove screenshotBtn, add icons to buttons, wrap annotation textarea with picker icon
- `src/sidepanel/sidepanel.css`: Add toolbar styles, annotation-wrapper styles, button icon styles
- `src/lib/sidepanel-controls.test.ts`: Remove screenshot assertions
- `src/sidepanel/sidepanel.test.ts`: Remove screenshot-btn references, update layout assertions for toolbar

**New patterns or abstractions introduced:**
- None. The `#toolbar` section reuses the same `el()` helper and `applyControlsModel()` pattern. Icons are Unicode characters prepended to button text content -- no SVG sprite sheet needed.

**Dependencies added or modified:**
- None

**Breaking changes to existing interfaces:**
- `ControlVisibility.screenshot` field removed -- callers of `buildControlsModel()` lose the `screenshot` property. This is intentional (sub-task 2).

## Approach

Move lifecycle controls (Start, Pause, Stop, Discard, Reset) and metrics into a new `#toolbar` section between the notice container and events list. Remove the standalone screenshot button entirely. Add Unicode leading icons to all buttons. Wrap the annotation textarea with an inline picker icon. Bottom `#controls` becomes annotation-only (+ PII fieldset pre-session). Reuse existing `el()` helper and `applyControlsModel()` pattern -- just change WHERE elements get appended.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `src/lib/sidepanel-controls.ts` | Modify | ~5 | Remove `screenshot` field from `ControlVisibility` interface and `buildControlsModel()` |
| `src/sidepanel/sidepanel.ts` | Modify | ~80 | Add `#toolbar` DOM section, move lifecycle buttons there, remove screenshotBtn, add Unicode icons to button text, wrap annotation textarea with picker icon |
| `src/sidepanel/sidepanel.css` | Modify | ~40 | Add `#toolbar` styles, `.annotation-wrapper` styles for inline picker, button icon spacing |
| `src/lib/sidepanel-controls.test.ts` | Modify | ~10 | Remove `screenshot` assertions |
| `src/sidepanel/sidepanel.test.ts` | Modify | ~30 | Remove `screenshot-btn` references from DOM assertions, update layout tests for new toolbar, update expected child order |

**Total files**: 5
**Total estimated lines**: ~165

## Implementation Steps

1. **Remove screenshot from ControlVisibility** (`sidepanel-controls.ts`): Delete the `screenshot` boolean field from the `ControlVisibility` interface and its computation in `buildControlsModel()`. Update the test file to remove all `screenshot` assertions.

2. **Add `#toolbar` section and restructure DOM** (`sidepanel.ts`):
   - Create `const toolbar = el("section", { id: "toolbar" })` in the DOM skeleton
   - Insert it between `noticeContainer` and `eventsList`: `root.appendChild(noticeContainer); root.appendChild(toolbar); root.appendChild(eventsList); root.appendChild(controls);`
   - Delete `screenshotBtn` declaration and its click handler entirely
   - Add Unicode icons to button text: `startBtn` -> "▶ Start session", `pauseBtn` -> "⏸ Pause" / "▶ Resume", `stopBtn` -> "⏹ Stop & download", `discardBtn` -> "🗑 Discard", `resetBtn` -> "↺ Reset", `addNoteBtn` -> "📝 Add note", `pickElementBtn` -> "🎯 Pick element"

3. **Refactor `applyControlsModel()`** (`sidepanel.ts`):
   - Split: toolbar gets lifecycle controls (Start, Pause, Stop, Discard, Reset), metrics row, empty-state hint
   - Bottom `#controls` gets PII fieldset (pre-session), annotation wrapper (active session), reminder/discard dialogs, async error line
   - Both sections use `clearChildren()` + re-append pattern (same as current)

4. **Create annotation wrapper with inline picker** (`sidepanel.ts`):
   - Build `annotationWrapper = el("div", { class: "annotation-wrapper" })` containing the textarea and a picker icon button
   - The picker icon is positioned inside/on-border of the textarea via CSS
   - Replace standalone `pickElementBtn` in the note row with this embedded version

5. **Add CSS** (`sidepanel.css`):
   - `#toolbar`: `flex: 0 0 auto`, `background: var(--bg-elev)`, `border-bottom: 1px solid var(--border)`, `padding: 8px 12px`, flex column, gap
   - `.annotation-wrapper`: `position: relative` with the picker button `position: absolute; right: 8px; bottom: 8px`
   - Adjust textarea padding-right to avoid text overlap with picker icon

6. **Fix tests** (`sidepanel.test.ts`, `sidepanel-controls.test.ts`):
   - Remove all `screenshot-btn` from assertion arrays (lines ~247, ~271, ~753, ~781, ~849-857)
   - Remove the entire "Capture screenshot shows a loading state" test
   - Update layout order test -- `#toolbar` now appears between notice and events-list
   - Update "controls region contents" test to check lifecycle buttons are in `#toolbar` instead of `#controls`

## Definition of Done

- [ ] Standalone screenshot button is removed -- no `#screenshot-btn` in DOM in any state
- [ ] `ControlVisibility` interface has no `screenshot` field
- [ ] All buttons have leading icons (Unicode characters visible in button text)
- [ ] `#toolbar` section exists in DOM, positioned above `#events-list` and below notice
- [ ] Lifecycle controls (Start, Pause, Stop, Discard, Reset) and metrics render in `#toolbar`
- [ ] Bottom `#controls` contains only PII fieldset + annotation area
- [ ] Annotation textarea has picker icon embedded inside/on-border
- [ ] Existing gating logic works -- hide-not-disable based on SessionStatus
- [ ] All existing tests pass (with necessary updates)
- [ ] No type errors (`make typecheck`)

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Screenshot button removed | Unit | Check DOM query returns null -- already tested in existing sidepanel.test.ts pattern |
| 2 | ControlVisibility no screenshot | Unit | Pure function test -- already in sidepanel-controls.test.ts |
| 3 | Buttons have leading icons | Unit | Check `textContent` of buttons in jsdom |
| 4 | Toolbar exists above events-list | Unit | DOM order assertion -- same pattern as existing layout test |
| 5 | Lifecycle controls in toolbar | Unit | querySelector scope check in jsdom |
| 6 | Bottom controls is annotation-only | Unit | querySelector scope check in jsdom |
| 7 | Picker icon embedded in annotation | Unit | DOM structure assertion in jsdom |
| 8 | Gating logic preserved | Unit | Already covered by existing buildControlsModel tests |
| 9 | Tests pass | Unit | `make test` |
| 10 | No type errors | Unit | `make typecheck` |

## Testing Strategy

- **Unit**: Update `sidepanel-controls.test.ts` to remove screenshot references. Update `sidepanel.test.ts` to: (a) remove screenshot-btn from all assertion lists, (b) remove the screenshot loading-state test, (c) add assertions for toolbar DOM order, (d) add assertions for button icon text content.
- **Integration**: Skip -- the jsdom sidepanel.test.ts already serves as integration.
- **E2E**: Skip -- layout changes are visual; no new user-facing flows that require e2e.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: None -- no e2e tests exist for the side panel layout.
- **New e2e tests needed**: None -- no new user-facing flows. Layout refinement is cosmetic + structural.
- **Cost note**: N/A

**Test files to create/modify**:
- `src/lib/sidepanel-controls.test.ts` (modify)
- `src/sidepanel/sidepanel.test.ts` (modify)

## Risk Assessment

**Risk Level**: Low

**Why this is safe**:
- All changes are within the side panel UI layer -- no service worker, background, or storage logic touched
- The `applyControlsModel()` restructure uses the exact same pattern (clearChildren + re-append), just targeting two containers instead of one
- Removing screenshot is purely subtractive -- delete code, delete tests
- Unicode icons are zero-dependency -- no SVG build pipeline or asset management

**Tradeoffs accepted**:
- Unicode icons instead of custom SVG -- some icons may render differently across OS versions, but this is the fastest approach and matches the existing text-only button pattern
- Not adding aria-labels for icons -- buttons already have text labels, icons are decorative
- Not animating the toolbar show/hide -- defer to future iteration

## Estimated Effort

- Planning: Already done
- Implementation: 45 minutes
- Testing: 20 minutes
- **Total**: 65 minutes

## Formal Verification Assessment

- Concurrency concerns: No -- single-threaded DOM manipulation
- State machine complexity: No -- reuses existing SessionStatus machine unchanged
- Conservation laws: No
- Authorization model: No
- Recommendation: Not needed

## What This Plan Does NOT Include

- Does NOT add SVG icons -- uses Unicode for speed; SVG sprite sheet can be added later
- Does NOT add toolbar collapse/expand animation
- Does NOT add responsive breakpoints for narrow panels
- Does NOT refactor `applyControlsModel()` into smaller functions -- the split is mechanical
- Does NOT add new keyboard shortcuts for toolbar buttons
- Does NOT change the PII fieldset behavior -- it just moves between toolbar (never) and controls (same as today)
