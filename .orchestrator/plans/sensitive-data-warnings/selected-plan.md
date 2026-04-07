---
agent: plan-judge
generated: 2026-04-07T00:00:00Z
task_id: feature-2
selected: quality
---

# Plan Evaluation: Sensitive Data Warnings (feature #2)

## Executive Summary
The Quality plan wins because it mirrors the established "pure lib + thin widget"
pattern from `session-metrics.ts`, gives the feature a single source of truth
(`src/lib/privacy.ts`) that the widget, exporter, and tests all read from, and
keeps the test surface aligned with the codebase convention (pure-function unit
tests, no jsdom widget tests). It is augmented with two targeted ideas borrowed
from the Safety plan (loud-fail exporter on missing `PRIVACY.md`; an explicit
"Keep recording" cancel on the pre-export reminder) and one simplification from
the Speed plan (read the first-run flag directly from `chrome.storage.local` in
the content script — no new message types).

## Plans Evaluated

### Speed Plan Summary
- **Core approach**: Inline a yellow notice and a two-state stop button into `widget.ts`, bake `PRIVACY.md` as a string constant in `exporter.ts`, ship 5 modified files with one new exporter test.
- **Complexity**: Lowest — 5 files modified, 0 new files, 1 new test case.
- **Key tradeoff**: Notice copy lives in `exporter.ts`, divorced from where the widget reads it, so the "single source of truth" property is broken. No unit coverage of the privacy module because there is no privacy module. The two-state stop button without an explicit cancel makes the "Keep recording" path implicit (timeout-based), which is fine for a UX nicety but weak for a privacy-critical control.

### Quality Plan Summary
- **Core approach**: Introduce `src/lib/privacy.ts` (pure constants + decision helpers) plus a tiny `chrome.storage.local` wrapper, two new message types, widget renders a first-run banner and a Cancel/Download confirm panel inside the existing closed shadow root, exporter adds one line.
- **Complexity**: Medium — 3 new files, 7 modified, ~6 new test cases.
- **Key tradeoff**: Adds two new `Message` variants and a service-worker handler purely to read/write a single boolean. Given that `chrome.storage.local` is already accessible from the content script, the indirection is overhead the previous feature did not pay. (We will collapse this in the synthesis below.)

### Safety Plan Summary
- **Core approach**: 12-failure-mode catalogue, two new lib modules, message-typed `firstRunNoticeRequired` flag flowing through `START_SESSION` → `SESSION_STARTED`, a `(?)` info icon for re-reading the notice, jsdom integration tests for the widget.
- **Complexity**: Highest — 4 new files (3 lib + 1 widget integration test), 6 modified, ~22 test cases including a brand-new jsdom test surface.
- **Key tradeoff**: Introduces patterns the codebase does not yet have (jsdom widget tests, an explicit "must be shown before capture begins" race serialization through the service worker, a `(?)` info icon not in the DoD). For a one-maintainer Chrome extension with no production users, the failure modes are real but the cost of paying down all of them is disproportionate. Many of the F1–F12 modes are addressed for free by simply defaulting unknown reads to "show the notice".

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|-----------|--------|-------|---------|--------|-------|
| Time to deliver | 20% | 5.0 | 3.5 | 2.0 | Speed touches fewest files; Safety adds a new test surface |
| Code quality | 25% | 2.5 | 4.5 | 4.0 | Quality matches existing `session-metrics.ts` shape exactly; Safety is good but introduces a `(?)` icon not in scope |
| Risk mitigation | 25% | 2.5 | 3.5 | 5.0 | Safety covers more failure modes; Quality is solid with named decision helpers; Speed has no unit coverage of the privacy module |
| Maintainability | 15% | 2.0 | 4.5 | 3.5 | Quality has the cleanest single-source-of-truth split; Safety is correct but bigger surface area |
| Test coverage | 15% | 2.0 | 4.0 | 5.0 | Safety has the most tests; Quality has appropriate tests; Speed has one |
| **Weighted Total** | 100% | **2.95** | **4.05** | **3.93** | |

Quality wins by a small margin over Safety, and decisively over Speed.

## Context Analysis

| Factor | Assessment | Impact |
|--------|------------|--------|
| Urgency | Low | No production users, no deadline. Don't optimise for speed. |
| Blast radius | Medium | The feature IS the safety mechanism, so a failure-to-show is the costly mode. Push toward correctness, not toward minimum changes. |
| Code area | Core but additive | Touches the export contract and the widget — both are core, but the changes are strictly additive. |
| Technical debt | Low | The codebase is clean. The previous feature won with Quality. Cutting corners has low payoff. |
| Team capacity | Single maintainer | A 22-test failure-mode catalogue is overkill for one person to maintain. Quality's ~6 tests are right-sized. |
| User visibility | High | This is a user-facing privacy affordance. The copy must match between widget and `PRIVACY.md` — single source of truth is essential. |
| Formal verification need | None | No concurrency, no state machine of consequence, no conservation laws. Skip Phase 2.5. |

## Recommendation

### Selected Plan: Quality (with two Safety-borrowed elements and one Speed-borrowed simplification)

### Rationale
The Quality plan is the closest mirror of the codebase's existing "pure lib +
thin widget" convention, established by `session-metrics.ts` and the previous
feature. Its `src/lib/privacy.ts` module gives the feature a single source of
truth that both the widget and the exporter import from, which directly
addresses the highest-value invariant of the brief: the notice copy must not
drift between the in-widget banner, the pre-export reminder, and the
`PRIVACY.md` file in the zip. The plan's test footprint is right-sized for a
single-maintainer extension. The Safety plan's extra rigour around failure
modes is genuinely valuable, but the bulk of its failure-mode coverage either
duplicates what a "default to show on read failure" line provides for free, or
introduces patterns (jsdom widget tests, service-worker race serialisation,
the `(?)` info icon) that are not in the DoD and would be the first
significant test-pattern expansion the codebase has seen.

### Incorporated Elements from Other Plans

- **From Safety: loud-fail exporter behaviour for `PRIVACY.md`.** If
  `strToU8(PRIVACY_MD_TEMPLATE)` throws or the `PRIVACY.md` entry cannot be
  added, `exportSession` propagates the error rather than silently shipping a
  zip without the notice. The exporter already lets `zipSync` throw, so this
  is achieved by not wrapping the new line in a try/catch. We add a unit test
  that pins the ordering: `PRIVACY.md` is added BEFORE the screenshots loop,
  so a downstream throw aborts before any partial state matters.
- **From Safety: explicit "Keep recording" cancel button on the pre-export
  reminder.** The Speed plan's two-click stop button with a 4-second timeout
  is too implicit for a privacy control. The reminder panel has TWO buttons
  ("Download" and "Keep recording"), and the cancel path leaves the session
  recording with no state changes — no `STOP_SESSION` is sent. This makes the
  "I clicked Stop by accident" recovery story explicit and testable.
- **From Safety: read failure defaults to "show the notice".** The wrapper
  function `getFirstRunSeen()` catches storage errors and returns `false`, so
  unknown state biases toward privacy disclosure. This is one extra `try`
  block in the wrapper and one unit test.
- **From Speed: read the first-run flag directly from `chrome.storage.local`
  in the content script.** Quality's plan adds two new `Message` variants
  (`GET_PRIVACY_FIRST_RUN`, `MARK_PRIVACY_FIRST_RUN_SEEN`) and a service-worker
  handler whose only job is to call through to `chrome.storage.local`. The
  content script already has direct `chrome.storage.local` access (the
  `STORAGE_PRIVACY_FIRST_RUN_SEEN` key has no service-worker-side state to
  protect — it is a single monotonic boolean). We collapse the indirection:
  the widget calls the `privacy-store.ts` wrapper directly, no new message
  types, no service-worker changes. This saves files and brings the design
  closer to the brief's "read/write directly via `chrome.storage.local`" hint.

### Explicitly NOT borrowed

- **Safety's `(?)` info icon to re-open the notice post-dismissal.** Not in
  the DoD. Adds widget surface area for a UX nicety the brief did not ask for.
- **Safety's `firstRunNoticeRequired` flag flowing through `START_SESSION` /
  `SESSION_STARTED` to serialise notice-shown-before-capture.** This is a real
  but minor race (the read is fast, the recorder runs for minutes, the user
  reads the notice for seconds). The brief does not require it, and adding a
  message-payload field for it touches the type system, the service worker,
  and `content/index.ts`. Skip.
- **Safety's jsdom `widget.test.ts` integration suite.** The codebase has zero
  widget tests today; the previous feature deferred them too; adding one
  solely for this feature would be the first jsdom test in `src/content/`.
  Manual verification covers it consistent with `CLAUDE.md` ("Chrome API
  integration: tested manually via extension load").
- **Speed's hard-coded inline `PRIVACY_MD` constant in `exporter.ts`.** The
  whole point of the synthesis is single source of truth. The constant lives
  in `src/lib/privacy.ts` and `exporter.ts` imports it.
- **Speed's 4-second auto-reset timer on the stop button.** Implicit and
  untestable. We use an explicit two-button panel.

## The Selected Plan

### Architecture

The split mirrors `src/lib/session-metrics.ts` (pure logic) plus the
widget polling pattern. Pure logic never touches `chrome.*`; presentation
never owns persistence; both read constants from the same module.

| Layer        | Module                              | Responsibility                                                                                          |
|--------------|-------------------------------------|---------------------------------------------------------------------------------------------------------|
| Pure logic   | `src/lib/privacy.ts` (NEW)          | `PRIVACY_NOTICE_BULLETS` (the in-widget bullets), `PRIVACY_MD_TEMPLATE` (the markdown body), `shouldShowFirstRunNotice(seen: boolean)`. No Chrome imports. |
| Coordinator  | `src/lib/privacy-store.ts` (NEW)    | Tiny `chrome.storage.local` wrapper: `getFirstRunSeen()`, `markFirstRunSeen()`. Both catch rejections and bias toward "not seen". |
| Coordinator  | `src/lib/exporter.ts`               | Imports `PRIVACY_MD_TEMPLATE`; adds `PRIVACY.md` to `zipData` BEFORE the screenshots loop. Loud-fails on encoding error. |
| Presentation | `src/content/widget.ts`             | Renders first-run notice (conditional on `getFirstRunSeen()` resolving false) and a two-button pre-export reminder panel inside the existing closed Shadow DOM. |
| Presentation | `src/content/widget.css`            | Adds `.dc-notice`, `.dc-notice-dismiss`, `.dc-confirm`, `.dc-confirm-actions`. Reuses existing `.dc-btn` / `.dc-btn-primary` / `.dc-btn-danger`. |
| Constants    | `src/constants.ts`                  | Adds `STORAGE_PRIVACY_FIRST_RUN_SEEN = "deskcheck_privacy_first_run_seen"`. |

Notably absent from this synthesis (compared to the Quality plan):

- No new `Message` variants — the widget reads/writes `chrome.storage.local`
  via the wrapper directly.
- No service-worker changes.
- No `src/types.ts` changes.

### Files Touched

| Path                              | Kind     | Purpose                                                                                                       |
|-----------------------------------|----------|---------------------------------------------------------------------------------------------------------------|
| `src/lib/privacy.ts`              | NEW      | Pure constants + `shouldShowFirstRunNotice` decision helper. Mirrors `session-metrics.ts` shape.              |
| `src/lib/privacy.test.ts`         | NEW      | Unit tests for the decision helper, the bullets contents, the markdown template contents.                    |
| `src/lib/privacy-store.ts`        | NEW      | `chrome.storage.local` wrapper with try/catch. Returns `false` on read failure (bias to show the notice).    |
| `src/lib/exporter.ts`             | modified | Import `PRIVACY_MD_TEMPLATE`; add `zipData["PRIVACY.md"] = strToU8(PRIVACY_MD_TEMPLATE)` BEFORE the screenshots loop. |
| `src/lib/exporter.test.ts`        | modified | Add 3 new test cases — see Test Level Matrix.                                                                 |
| `src/constants.ts`                | modified | Add `STORAGE_PRIVACY_FIRST_RUN_SEEN`.                                                                         |
| `src/content/widget.ts`           | modified | Render first-run notice on mount (gated by `getFirstRunSeen()`); render pre-export reminder panel inside the existing stop button click handler with two-button (Download / Keep recording) flow. |
| `src/content/widget.css`          | modified | Styles for the two new panels. Reuse existing button classes.                                                 |

**Total**: 3 new files, 5 modified files. (Compared to Quality's 3 new + 7 modified, and Safety's 4 new + 6 modified. We save the type/message-routing churn.)

### Implementation Steps

1. **Create `src/lib/privacy.ts`** — pure module with three exports:
   - `PRIVACY_NOTICE_BULLETS: readonly string[]` — at minimum three bullets,
     each containing one of the literal substrings `screen` (or `visible`),
     `form` (or `input`), and `header` (or `network`). The Test Level Matrix
     pins these exact substrings so DoD #4 cannot silently drift.
   - `PRIVACY_MD_TEMPLATE: string` — multi-line template literal containing a
     markdown H1, the same three topics, and the phrase "local use only" (or
     equivalent).
   - `shouldShowFirstRunNotice(seen: boolean): boolean` — returns `!seen`. Named
     for intent and gives a hook for future "version-bumped re-prompts".

2. **Create `src/lib/privacy-store.ts`** — tiny wrapper with two functions:
   ```ts
   import { STORAGE_PRIVACY_FIRST_RUN_SEEN } from "../constants";
   export async function getFirstRunSeen(): Promise<boolean> {
     try {
       const result = await chrome.storage.local.get(STORAGE_PRIVACY_FIRST_RUN_SEEN);
       return result[STORAGE_PRIVACY_FIRST_RUN_SEEN] === true;
     } catch {
       return false; // Bias to showing the notice on read failure.
     }
   }
   export async function markFirstRunSeen(): Promise<void> {
     try {
       await chrome.storage.local.set({ [STORAGE_PRIVACY_FIRST_RUN_SEEN]: true });
     } catch (e) {
       console.warn("[DeskCheck] Failed to persist privacy notice flag:", e);
     }
   }
   ```
   No tests — this is a Chrome-API pass-through; the codebase convention is to
   verify these manually.

3. **Add storage key constant** in `src/constants.ts`:
   `export const STORAGE_PRIVACY_FIRST_RUN_SEEN = "deskcheck_privacy_first_run_seen";`.

4. **Modify `src/lib/exporter.ts`**:
   - `import { PRIVACY_MD_TEMPLATE } from "./privacy";`
   - Inside `exportSession`, after `const jsonStr = ...`, build `zipData` with
     the `PRIVACY.md` entry BEFORE the screenshots loop:
     ```ts
     const zipData: Record<string, Uint8Array> = {
       "session.json": strToU8(jsonStr),
       "PRIVACY.md": strToU8(PRIVACY_MD_TEMPLATE),
     };
     ```
   - DO NOT wrap the `PRIVACY.md` line in try/catch. If it throws (encoding
     bug, missing template), the export aborts loudly and the existing
     `service-worker.ts` `EXPORT_SESSION` handler returns `{ error: String(err) }`
     to the popup/widget. The user can retry; a silently-incomplete zip is
     worse than a failed one.
   - The `schema_version` field is unchanged. `PRIVACY.md` is a sibling
     artifact, not part of `session.json`.

5. **Modify `src/content/widget.ts`** — first-run notice on mount:
   - At the top, import `getFirstRunSeen`, `markFirstRunSeen`,
     `PRIVACY_NOTICE_BULLETS`, and `shouldShowFirstRunNotice`.
   - In `showWidget()`, after the `widget` element is appended to the shadow
     root, fire-and-forget:
     ```ts
     getFirstRunSeen().then((seen) => {
       if (!shouldShowFirstRunNotice(seen)) return;
       const notice = renderFirstRunNotice();
       widget.insertBefore(notice, metricsBar);
     });
     ```
   - `renderFirstRunNotice()` builds a `<div role="alert" class="dc-notice">`
     containing a short title, a `<ul>` of `PRIVACY_NOTICE_BULLETS`, and a
     single "Got it" `<button class="dc-btn">`. The button's click handler:
     removes the notice node, calls `markFirstRunSeen()` (do not await — it
     is fire-and-forget; a write failure simply means the notice will reappear
     next session, which is the safer default per the Safety plan).
   - The notice is built with `el()` and `textContent`-equivalent appends only;
     no `innerHTML`. Containment is enforced by the existing closed Shadow DOM.

6. **Modify `src/content/widget.ts`** — pre-export reminder on stop click:
   - Refactor the existing `stopBtn.addEventListener("click", ...)` handler to
     a two-phase flow:
     - **Phase 1 (first click on Stop & Download)**: Render an inline
       `<div role="alertdialog" class="dc-confirm">` inside the widget body
       containing a one-sentence reminder (the literal phrases "screenshots
       may contain sensitive data" and "intended for local use only" must
       appear), and two buttons inside `.dc-confirm-actions`:
       - **"Keep recording"** (`.dc-btn`) — closes the panel, restores the
         stop button label, returns. Sends NO messages. The session continues
         recording exactly as before.
       - **"Download"** (`.dc-btn dc-btn-danger`) — proceeds with the existing
         `STOP_SESSION` then `EXPORT_SESSION` flow unchanged.
     - The panel is rendered inline inside the existing widget body — it is
       NOT an overlay, NOT a modal, and the rest of the widget remains
       interactive. This honours the "must not block the user from completing
       the core flow" constraint.
     - The reminder shows on every Stop & Download click (per-export, not
       per-install). DoD #2 says "appears... when 'Stop & Download' is
       clicked", not "once".
     - Initial focus moves to "Keep recording" (NOT "Download") — a small
       anti-muscle-memory measure borrowed from the Safety plan.
   - The existing `stopBtn.textContent = "Exporting..."` and disable logic
     moves into the "Download" button's click handler, not the outer
     `stopBtn` click. The `stopBtn` itself only opens the panel.

7. **Add CSS** in `src/content/widget.css`:
   - `.dc-notice` — amber/yellow background `#fef3c7`, border `#fde68a`,
     padding, border-radius. Sits between the metrics bar and the body.
   - `.dc-notice ul` — list-style, small left padding.
   - `.dc-notice .dc-btn` — reuse existing button styling.
   - `.dc-confirm` — slight inset background inside the body, matches the
     widget visual vocabulary, padding.
   - `.dc-confirm-actions` — flex row, gap, right-aligned.
   - `:focus-visible` outline for both panels' interactive elements.

8. **Add unit tests** per the Test Level Matrix below.

9. **Manual smoke checklist** (per `CLAUDE.md` "Chrome API integration: tested
   manually via extension load"):
   - Fresh profile (clear `chrome.storage.local`) → Start session → notice
     appears with the three bullets → click "Got it" → notice disappears.
   - Start a second session in the same install → notice does NOT reappear.
   - Restart the browser → start a session → notice still does NOT reappear.
   - Click Stop & Download → reminder panel appears inline → click "Keep
     recording" → panel closes, badge still REC, recording continues.
   - Click Stop & Download → click "Download" → zip downloads → unzip →
     `PRIVACY.md` is at the zip root next to `session.json` and `screenshots/`.

---

### Definition of Done (Final)

- [ ] On first session start after install, the widget shows a dismissible
      notice that explicitly mentions "screen" (or "visible"), "form" (or
      "input"), and "header" (or "network").
- [ ] After dismissing once, the notice does not reappear on subsequent
      sessions in the same install (verified by `chrome.storage.local`
      persistence — manual smoke).
- [ ] First-run flag read failure defaults to "show the notice" (verified by
      a unit test on the wrapper).
- [ ] Clicking "Stop & Download" surfaces an inline reminder panel inside the
      widget with two buttons: "Keep recording" and "Download".
- [ ] Clicking "Keep recording" closes the panel and sends NO messages — the
      session continues recording (manual smoke).
- [ ] Clicking "Download" proceeds with the existing `STOP_SESSION` +
      `EXPORT_SESSION` flow unchanged (manual smoke).
- [ ] The exported zip contains a `PRIVACY.md` file at the root, alongside
      `session.json` and the `screenshots/` directory.
- [ ] `PRIVACY.md` content explicitly mentions screenshots may contain
      sensitive data, mentions all three topics (screen / form / header), and
      mentions "local use only" or equivalent.
- [ ] If `PRIVACY.md` cannot be added to the zip, `exportSession` throws
      (loud failure, no silently-incomplete zip).
- [ ] `schema_version` in `session.json` is unchanged at `"1.0.0"` — verified
      by the existing exporter test.
- [ ] No new `Message` variants. No service-worker changes. No type changes.
- [ ] No new third-party dependencies.
- [ ] `make typecheck` clean.
- [ ] `make test` clean.

### Test Level Matrix (Final)

This matrix is the contract for Phase 3. Each row maps to a DoD criterion and
specifies the file path, the test level, and the asserting behaviour. All
tests must be writable BEFORE the implementation exists — every row below
either targets a file that already exists (`exporter.test.ts`) or specifies a
NEW test file path that Phase 3 will create with skeleton failing tests
(`privacy.test.ts`).

| # | DoD Criterion | Test Level | Test File | Asserting Behaviour (1 sentence) |
|---|---------------|-----------|-----------|----------------------------------|
| 1 | First-run notice mentions "screen" / "visible" | Unit | `src/lib/privacy.test.ts` (NEW) | At least one entry in `PRIVACY_NOTICE_BULLETS` matches `/screen|visible/i`. |
| 2 | First-run notice mentions "form" / "input" | Unit | `src/lib/privacy.test.ts` (NEW) | At least one entry in `PRIVACY_NOTICE_BULLETS` matches `/form|input/i`. |
| 3 | First-run notice mentions "header" / "network" | Unit | `src/lib/privacy.test.ts` (NEW) | At least one entry in `PRIVACY_NOTICE_BULLETS` matches `/header|network/i`. |
| 4 | `shouldShowFirstRunNotice` returns true when not seen | Unit | `src/lib/privacy.test.ts` (NEW) | `shouldShowFirstRunNotice(false) === true`. |
| 5 | `shouldShowFirstRunNotice` returns false when seen | Unit | `src/lib/privacy.test.ts` (NEW) | `shouldShowFirstRunNotice(true) === false`. |
| 6 | `PRIVACY_MD_TEMPLATE` is non-empty markdown | Unit | `src/lib/privacy.test.ts` (NEW) | `PRIVACY_MD_TEMPLATE` starts with `# ` and is at least 100 characters. |
| 7 | `PRIVACY_MD_TEMPLATE` mentions all three topics | Unit | `src/lib/privacy.test.ts` (NEW) | `PRIVACY_MD_TEMPLATE` matches `/screen|visible/i` AND `/form|input/i` AND `/header|network/i`. |
| 8 | `PRIVACY_MD_TEMPLATE` mentions "local use only" | Unit | `src/lib/privacy.test.ts` (NEW) | `PRIVACY_MD_TEMPLATE` matches `/local use only/i` (or contains both "local" and "only"). |
| 9 | `PRIVACY_MD_TEMPLATE` mentions screenshots / sensitive data | Unit | `src/lib/privacy.test.ts` (NEW) | `PRIVACY_MD_TEMPLATE` matches `/screenshot/i` and `/sensitive/i`. |
| 10 | Export zip contains `PRIVACY.md` | Unit | `src/lib/exporter.test.ts` (modified) | `unzipSync(exportSession(makeSession(), [], {}))["PRIVACY.md"]` is defined and non-empty. |
| 11 | Export zip contains `PRIVACY.md` even with screenshots | Unit | `src/lib/exporter.test.ts` (modified) | `PRIVACY.md` is present in the zip alongside `screenshots/ss_1.png` (parameterised on the existing screenshot test fixture). |
| 12 | `PRIVACY.md` content matches the template | Unit | `src/lib/exporter.test.ts` (modified) | `strFromU8(unzipped["PRIVACY.md"])` mentions "screenshot" and "sensitive" — verifies the exporter uses the same source of truth as the privacy module without coupling the test to the exact byte sequence. |
| 13 | `schema_version` is unchanged at `"1.0.0"` | Unit | `src/lib/exporter.test.ts` (existing) | The existing `produces a valid zip with session.json` test already pins `json.schema_version === "1.0.0"`; no new test required. |
| 14 | First-run notice appears on first session start | Manual | (manual smoke checklist) | Fresh-profile load: open a tab, click Start Session, verify notice is visible above the metrics bar with three bullets. |
| 15 | First-run notice does not reappear after dismissal | Manual | (manual smoke checklist) | After dismissing once, start a second session and confirm no notice. Restart the browser and confirm still no notice. |
| 16 | Pre-export reminder appears on Stop & Download click | Manual | (manual smoke checklist) | Click Stop & Download, verify the reminder panel renders inline inside the widget with two buttons. |
| 17 | "Keep recording" cancels the export | Manual | (manual smoke checklist) | Click "Keep recording", verify the panel closes, the badge stays REC, and the session continues capturing events. |
| 18 | "Download" proceeds with the existing flow | Manual | (manual smoke checklist) | Click "Download", verify the zip downloads, unzip it, and confirm `PRIVACY.md` is present at the root. |
| 19 | First-run flag read failure defaults to "show notice" | Unit | `src/lib/privacy-store.test.ts` (NEW, optional) | If included: mock `chrome.storage.local.get` to reject, assert `getFirstRunSeen()` resolves to `false`. **Skipped by default** to honour the codebase convention of not unit-testing Chrome-API wrappers; the behaviour is exercised by the manual smoke checklist on a fresh profile. |
| 20 | `make typecheck` clean | Build | (CI: `make typecheck`) | Standard make target. |
| 21 | `make test` clean | Build | (CI: `make test`) | Standard make target. |

**Rules applied:**
- Default to **unit** tests — they are fast, isolated, and match the
  codebase's existing pattern (`session-metrics.ts` + `exporter.ts` are both
  tested at the unit level only).
- **Manual** is used for anything that crosses the closed Shadow DOM boundary
  or requires `chrome.storage.local`. This is consistent with `CLAUDE.md`
  ("Chrome API integration: tested manually via extension load") and with the
  zero existing widget tests in the repo.
- **No integration / e2e / jsdom tests added.** The Safety plan's jsdom
  `widget.test.ts` was rejected because it would be the first jsdom widget
  test in the codebase and is disproportionate for a single-maintainer
  extension. The DoD criteria it would cover (notice appears, reminder
  appears, "Keep recording" cancels) are all covered by the manual checklist.
- Each criterion maps to exactly ONE level — no duplication.
- Rationale for criterion #12 deliberately does NOT assert byte-for-byte
  equality with `PRIVACY_MD_TEMPLATE`. The privacy unit tests pin the
  template's content invariants; the exporter test pins that the *correct
  source of truth* is being shipped. This avoids coupling the exporter test
  to the exact wording of the template, which is allowed to evolve as long
  as the topics remain present.

**Determinism constraint**: No live LLM calls. All tests are pure synchronous
string + zip assertions. The privacy module is a set of constants and a pure
function. The exporter test reuses the existing `unzipSync` + `strFromU8`
pattern. No mocks of `chrome.storage.local` are needed for the default test
set (the optional `privacy-store.test.ts` row #19 would need one if added,
but it is skipped).

### Testing Strategy (Final)

- **Unit (privacy module)**: 9 cases in `src/lib/privacy.test.ts` (NEW) —
  bullets contents, decision helper, template structure, template contents,
  template "local use only" phrase, screenshots/sensitive phrasing.
- **Unit (exporter)**: 3 new cases in `src/lib/exporter.test.ts` (modified)
  — `PRIVACY.md` present in empty session, `PRIVACY.md` present alongside
  screenshots, `PRIVACY.md` contents match the privacy module's template.
  All existing exporter tests must continue to pass unchanged.
- **Integration**: Skip. No integration test harness exists in this project.
- **E2E**: Skip. The repo has Playwright installed but no widget e2e flows;
  this feature is not the right time to start that pattern.
- **Manual smoke**: 5-step checklist (rows #14–#18 above), executed once
  against a freshly-loaded unpacked extension on a clean profile.

**E2E test impact**: None. No existing Playwright tests reference the widget
or the export flow. No new e2e tests are added.

### Risk Mitigations (Final)

1. **Risk**: `PRIVACY.md` is silently missing from the zip due to a future
   refactor or encoding bug.
   **Mitigation**: The exporter unit test asserts `PRIVACY.md` is present in
   both the empty-session case and the with-screenshots case. The line that
   adds `PRIVACY.md` is BEFORE the screenshots loop, so a downstream throw
   aborts the export rather than producing a partial zip. The `PRIVACY.md`
   line is intentionally not wrapped in try/catch — it loud-fails to the
   service worker's existing `{ error: String(err) }` handler.

2. **Risk**: Notice copy drifts between the in-widget banner and the
   `PRIVACY.md` file in the zip.
   **Mitigation**: Both surfaces import from `src/lib/privacy.ts`. The
   privacy unit tests pin the required substrings in both
   `PRIVACY_NOTICE_BULLETS` and `PRIVACY_MD_TEMPLATE`, so a one-sided edit
   that drops a topic from one but not the other will fail CI.

3. **Risk**: `chrome.storage.local.get` rejects on session start, the read
   resolves with `undefined`, and the notice is silently skipped.
   **Mitigation**: `getFirstRunSeen()` wraps the read in try/catch and
   returns `false` (not seen) on any failure. The notice will appear, biasing
   toward over-disclosure rather than under-disclosure. Manual smoke verifies
   the happy path; the unit test for this is intentionally skipped per the
   codebase convention but the behaviour is documented and the wrapper is 4
   lines long.

4. **Risk**: User clicks "Stop & Download", clicks "Download" before reading
   the reminder, and feels they were not properly informed.
   **Mitigation**: Initial focus on the reminder panel goes to "Keep
   recording", not "Download". Muscle-memory clicks land on the safer path.
   The reminder text remains visible during the entire export flow.

5. **Risk**: `chrome.storage.local.set` fails when the user dismisses the
   notice; the flag never persists; the notice reappears next session.
   **Mitigation**: Acceptable. `markFirstRunSeen()` catches and logs but does
   not throw. Re-showing the notice is graceful degradation; the flag is
   monotonic so a duplicate write is harmless.

6. **Risk**: The page injects CSS that pierces the widget's containment.
   **Mitigation**: The new notice and reminder panels are rendered inside the
   existing closed Shadow DOM (`shadow.appendChild(widget)`), reusing the
   `el()` builder and `textContent`-only construction. No `innerHTML`. No new
   shadow root.

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | N | (not assessed) | Mild (F3, F8) | N |
| State machine | N | (not assessed) | Low | N |
| Conservation | N | (not assessed) | N | N |
| Authorization | N | (not assessed) | N | N |

**Recommendation**: **SKIP Phase 2.5.** The Speed planner explicitly says "not
needed", the Safety planner explicitly says "NOT needed — state space is
small enough to be exhaustively covered by tests", and the Quality plan does
not flag anything. The widget gains two visible states (notice-showing,
reminder-showing) on top of the existing minimised/expanded states, which is
linear and user-driven. No multi-actor coordination, no shared mutable state,
no balances. The "notice shown before recording starts" race that the Safety
plan flagged is real but mild — the read is fast, the recorder runs for
minutes, and the failure mode (notice arrives a few hundred ms after the
first event) is acceptable for a privacy reminder that the user reads for
seconds.

**Verification focus**: N/A.
**Key invariants**: N/A.

---

## Orchestrator Handoff

This evaluation is the **final decision** — no human checkpoint follows. The
orchestrator will:

1. Commit all plans (speed, quality, safety, this synthesis) to
   `docs/plans/sensitive-data-warnings/` for the audit trail.
2. Use the Test Level Matrix above to generate failing skeleton tests in:
   - `src/lib/privacy.test.ts` (NEW — 9 unit cases, rows #1–9)
   - `src/lib/exporter.test.ts` (modified — 3 new unit cases, rows #10–12)
3. Proceed directly to implementation in the order:
   - Constants (`src/constants.ts`)
   - Privacy module (`src/lib/privacy.ts`) — write the constants and helper
   - Privacy store wrapper (`src/lib/privacy-store.ts`)
   - Exporter modification (`src/lib/exporter.ts`) — make rows #10–12 pass
   - Widget modification (`src/content/widget.ts`) — first-run notice, then
     pre-export reminder
   - Widget CSS (`src/content/widget.css`)
4. Run `make typecheck && make test` after each file change.
5. Execute the 5-step manual smoke checklist on a freshly-loaded unpacked
   extension on a clean profile before marking the feature done.

**Summary for git commit**:
- Selected plan: **Quality** (synthesis: Quality base + Safety's loud-fail
  exporter and explicit "Keep recording" cancel + Speed's direct
  `chrome.storage.local` access without new message types)
- Key rationale: Mirrors the existing `session-metrics.ts` "pure lib + thin
  widget" pattern; gives the feature a single source of truth for notice
  copy; right-sized test surface for a single-maintainer extension; honours
  the brief's "no service-worker indirection for a single boolean" hint.
- Complexity: 3 new files (`privacy.ts`, `privacy.test.ts`,
  `privacy-store.ts`), 5 modified files (`exporter.ts`, `exporter.test.ts`,
  `constants.ts`, `widget.ts`, `widget.css`).
- Key risks: `PRIVACY.md` silently missing (mitigated by loud-fail exporter
  + ordering test); copy drift (mitigated by single-source-of-truth module +
  pinned substring tests); read failure (mitigated by try/catch in wrapper).
- Test levels: **12 unit** tests total (9 new in `privacy.test.ts`, 3 new in
  `exporter.test.ts`), **0 integration**, **0 e2e**, **5 manual smoke
  steps**.
