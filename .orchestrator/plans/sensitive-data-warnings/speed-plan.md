---
agent: speed-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-2
perspective: speed
---

# Speed Plan: Sensitive Data Warnings

## Architecture Impact

**Components affected:**
- Content script widget (`src/content/widget.ts`): adds two new in-shadow DOM panels (first-run banner and pre-export confirm) reusing existing `el()` helper and `dc-*` button styles.
- Library exporter (`src/lib/exporter.ts`): adds one extra entry (`PRIVACY.md`) to the `zipData` map alongside `session.json`.
- Constants (`src/constants.ts`): adds one new storage key (`STORAGE_PRIVACY_NOTICE_DISMISSED`).
- Widget CSS (`src/content/widget.css`): adds ~3 small classes for the notice/confirm panels (yellow background, padding, dismiss button).

**New patterns or abstractions introduced:**
- None. Reuses the existing `chrome.storage.local` direct access pattern (same as `STORAGE_SESSION`), the existing `el()` builder, and the existing fflate `zipData` record. No new modules, no new message types.

**Dependencies added or modified:**
- None.

**Breaking changes to existing interfaces:**
- None — additive only. `schema_version` is untouched. `PRIVACY.md` is a sibling file in the zip, not part of `session.json`. Stop & Download flow gains an in-widget confirmation step but the underlying messages (`STOP_SESSION`, `EXPORT_SESSION`) are unchanged.

## Approach
Inline everything into the existing widget. The first-run notice is a yellow panel rendered above the metrics bar when a stored flag is absent, with a single "Got it" button that sets the flag in `chrome.storage.local`. The pre-export reminder is a two-state button on the existing Stop & Download control: first click swaps the button label and reveals a brief inline reminder; second click proceeds to the existing stop+export flow. `PRIVACY.md` is a hard-coded string constant baked into `exporter.ts` and added to the zip map. No new message types, no new modules, no service-worker changes.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `src/content/widget.ts` | Modify | ~70 | Render first-run notice (read flag, show panel, write flag on dismiss). Add two-state confirm logic to existing `stopBtn` handler. |
| `src/content/widget.css` | Modify | ~25 | Three classes: `.dc-notice` (yellow panel), `.dc-notice-text`, `.dc-notice-dismiss`. Plus a `.dc-confirm-pending` modifier for the stop button. |
| `src/lib/exporter.ts` | Modify | ~6 | Add `PRIVACY_MD` constant and one extra `strToU8(PRIVACY_MD)` entry into `zipData`. |
| `src/constants.ts` | Modify | ~2 | Export `STORAGE_PRIVACY_NOTICE_DISMISSED = "deskcheck_privacy_notice_dismissed"`. |
| `src/lib/exporter.test.ts` | Modify | ~10 | Add one test asserting `PRIVACY.md` is present in the zip and contains the required substrings. |

**Total files**: 5 (all modified, zero new files)
**Total estimated lines**: ~115

## Implementation Steps

1. **Add storage key constant** in `src/constants.ts`: `export const STORAGE_PRIVACY_NOTICE_DISMISSED = "deskcheck_privacy_notice_dismissed";`.

2. **Bake `PRIVACY.md` into the exporter.** In `src/lib/exporter.ts` add a top-level `const PRIVACY_MD` containing a short markdown blurb that explicitly mentions: visible screen content, form inputs, and network headers, plus "intended for local use only". In `exportSession`, after `zipData["session.json"] = ...`, add `zipData["PRIVACY.md"] = strToU8(PRIVACY_MD);`. Done.

3. **Render the first-run notice in `widget.ts`.** Inside `showWidget()`, after the metrics bar is created and before the body is appended, query `chrome.storage.local.get(STORAGE_PRIVACY_NOTICE_DISMISSED)`. If the value is falsy, build a `dc-notice` div with: a paragraph explaining DeskCheck captures visible screen content, form inputs, and network headers; and a "Got it" button. On click, call `chrome.storage.local.set({ [STORAGE_PRIVACY_NOTICE_DISMISSED]: true })` and remove the panel from the DOM. Insert the panel between `metricsBar` and `body` in the widget root. Because the storage call is async, render the panel optimistically inside an IIFE and inject it into the live shadow root once the read resolves — the widget is already mounted, so this is safe.

4. **Add the pre-export reminder to the existing Stop & Download button.** In the current `stopBtn.addEventListener("click", ...)` handler, gate the existing logic behind a `confirmed` flag stored in a closure variable. First click: set the button label to "Click again to confirm export" (or similar inline reminder), add the `dc-confirm-pending` class, start a 4-second timer that resets state if the user does not confirm. Second click (within window): proceed with the existing `STOP_SESSION` + `EXPORT_SESSION` flow exactly as today. Inline a one-line reminder under the button using a sibling `<small>` element so the warning text "Zip may contain sensitive data — local use only" is visible during the pending state.

5. **Style the new elements** in `src/content/widget.css`. Yellow background `#fef3c7`, border `#fde68a`, small padding, 12px font, single dismiss button styled like an existing `.dc-btn`. The `.dc-confirm-pending` modifier flips the stop button to a more prominent warning color.

6. **Add an exporter test** in `src/lib/exporter.test.ts`: unzip the result of `exportSession(...)`, assert `unzipped["PRIVACY.md"]` exists, and assert the decoded text contains all three substrings: "screen", "form input", "network header".

7. **Manual smoke test**: load unpacked, install fresh (clear `chrome.storage.local`), start a session — confirm notice appears once. Reload extension, start another — confirm notice does NOT appear. Click Stop & Download, confirm reminder text appears, click again, confirm export proceeds and zip contains `PRIVACY.md` at the root.

## Definition of Done

- [ ] On first session start after install, the widget shows a dismissible yellow notice that explicitly names "visible screen content", "form inputs", and "network headers".
- [ ] After dismissing once, the notice never reappears across browser restarts (verified by `chrome.storage.local` flag persisting).
- [ ] Clicking "Stop & Download" surfaces a one-click reminder before the export actually runs; a second click within the confirmation window proceeds with the existing stop + download flow.
- [ ] The reminder is dismissible/bypassable in a single click — it does not gate the user.
- [ ] The exported zip contains a `PRIVACY.md` file at the root, alongside `session.json` and the `screenshots/` directory.
- [ ] `PRIVACY.md` content explicitly mentions screenshots may contain sensitive data and that the export is intended for local use.
- [ ] `schema_version` in `session.json` is unchanged at `1.0.0`.
- [ ] `make typecheck` passes; `make test` passes.

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | First-run notice appears once and mentions the three required topics | Manual | UI rendering inside closed Shadow DOM during a live session — existing project convention is to verify widget UI manually (see `CLAUDE.md` Testing section). |
| 2 | Dismissed flag persists in `chrome.storage.local` across restarts | Manual | Requires Chrome runtime; the pure logic is a single read/write call with no branching worth unit-testing. |
| 3 | Stop & Download surfaces a reminder before export | Manual | Two-state click handler in widget DOM; existing widget interactions are not unit-tested either. |
| 4 | Reminder is single-click bypassable | Manual | Same widget interaction. |
| 5 | Zip contains `PRIVACY.md` | Unit | Pure exporter function — fits the existing `exporter.test.ts` pattern (unzip with fflate, assert keys). |
| 6 | `PRIVACY.md` mentions required topics | Unit | String contents of a constant — trivially asserted in the same exporter test. |
| 7 | `schema_version` unchanged | Unit | Already covered by existing exporter tests; no extra work. |
| 8 | typecheck + test pass | CI | Standard `make` targets. |

**Speed planner bias**: Defaulting to manual verification for everything that lives inside the closed Shadow DOM widget — the project already does this for `widget.ts` (zero existing widget tests). Only the exporter change gets a unit test because exporter tests already exist and the assertion is one line.

**Determinism rule**: No LLM calls anywhere in this feature. All tests are pure synchronous string + zip assertions.

## Testing Strategy

- **Unit**: One additional case in `src/lib/exporter.test.ts` — unzip the export, assert `PRIVACY.md` is present and contains the required substrings ("screen", "form input", "network header"). This piggybacks on the existing test setup with zero new fixtures.
- **Integration**: Skip. There is no integration test harness in this project today and the speed approach does not introduce one.
- **E2E**: Skip. Playwright is installed but no e2e tests reference the widget today, and the feature is a UI affordance plus a static file in the zip.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: None — there are no e2e tests in `tests/` and the existing Playwright config does not exercise this flow.
- **New e2e tests needed**: None for the speed plan. The widget notice and confirm step are verified manually, the zip content is verified by the unit test.
- **Cost note**: N/A — no new e2e tests added.

**Test files to create/modify**: `src/lib/exporter.test.ts` (modify only, ~10 lines added).

## Risk Assessment

**Risk Level**: Low

**Why this is safe**:
- No service worker changes — message routing, session lifecycle, and CDP attachment are untouched.
- No schema changes — `session.json` and `schema_version` are byte-for-byte identical for an empty session except for the new sibling file.
- The two-click stop button is a strict superset of the old behaviour — second click triggers the original code path unchanged.
- The first-run notice failure mode is "notice does not appear" (e.g. storage read fails), which is graceful — the user simply does not see the warning. No data loss.
- `PRIVACY.md` is a static string; nothing dynamic can fail.
- All changes live in the content script and a pure library file. The popup, recorder, picker, debugger client, and screenshot capture are all untouched.

**Tradeoffs accepted**:
- The privacy notice content is hard-coded English — no i18n scaffolding.
- The pre-export "confirm" is a button label change rather than a styled modal. Less visually prominent than a dialog, but matches the constraint that it must not be a long modal flow.
- No unit tests for the widget DOM rendering or the storage flag flow — relying on manual verification consistent with the project's established convention for `widget.ts`.
- The 4-second confirm window is arbitrary — if the user waits longer, they tap once more to re-arm. Acceptable.
- `PRIVACY.md` lives inline as a string constant in `exporter.ts` rather than as a separate `.md` source file imported via Vite. Saves a Vite raw-import config tweak and one new file.

## Estimated Effort

- Planning: Already done.
- Implementation: 5 files, ~115 lines of straightforward edits, no new abstractions.
- Testing: One unit test addition, the rest is manual smoke against the unpacked extension.
- **Total complexity**: Very low. Single pass implementation with no cross-component coordination.

## Formal Verification Assessment

- Concurrency concerns: No — no shared state across actors beyond a single boolean flag with last-write-wins semantics.
- State machine complexity: No — the confirm button has two states (idle, pending) with a timeout reset; trivial.
- Conservation laws: No.
- Authorization model: No — local extension, single user.
- Recommendation: Not needed.
- If recommended, key invariants: N/A.

## What This Plan Does NOT Include

- Does NOT add a dedicated `PRIVACY.md` source file or a Vite `?raw` import — the markdown lives inline in `exporter.ts` as a const.
- Does NOT introduce any new message types between content script and service worker — the privacy flag is read/written directly via `chrome.storage.local` from the widget.
- Does NOT add unit tests for `widget.ts` — consistent with the rest of the codebase, widget UI is verified manually.
- Does NOT add a styled modal/dialog — the pre-export reminder is an inline two-state button, the cheapest UI that satisfies "must be acknowledged in one click and must not block".
- Does NOT add an i18n layer — strings are hard-coded English.
- Does NOT add a "reset notice" debug toggle or settings page.
- Does NOT touch `manifest.json`, the popup, the recorder, the element picker, the screenshot module, the debugger client, or the service worker.
- Does NOT bump `schema_version` — `PRIVACY.md` is a sibling artifact, not part of the session schema.
- Does NOT add e2e tests with Playwright — the existing infrastructure is not used for this feature.
- Does NOT change the dismissed flag from a single boolean to a per-session or per-version variant — feature explicitly says "once per install".
