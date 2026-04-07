---
agent: quality-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-2
perspective: quality
---

# Quality Plan: Sensitive Data Warnings (feature #2)

## Summary
Add three privacy reminders to DeskCheck without expanding the export schema or
blocking core flows. Pure logic (the "should the first-run notice be shown?"
gate, and the static `PRIVACY.md` template) lives in a new `src/lib/privacy.ts`
module that mirrors the `session-metrics.ts` shape — small, framework-free,
fully unit-testable without Chrome mocks. The widget gains two new presentation
surfaces (a first-run banner shown on `SESSION_STARTED` and a confirm panel
shown when `Stop & Download` is clicked) that delegate all decision logic to
the lib module. The exporter takes a single new line that injects
`PRIVACY.md` into the existing `zipData` map. No changes to `schema_version`
or `session.json`.

## Architecture sketch

| Layer        | Module                              | Responsibility                                                                                          |
|--------------|-------------------------------------|---------------------------------------------------------------------------------------------------------|
| Pure logic   | `src/lib/privacy.ts` (new)          | `PRIVACY_NOTICE_TEXT`, `PRIVACY_MD_TEMPLATE`, `shouldShowFirstRunNotice(flag)`, `markFirstRunSeen(flag)` (returns next state — no I/O) |
| Coordinator  | `src/lib/privacy-store.ts` (new)    | Thin `chrome.storage.local` wrapper: `getFirstRunSeen()`, `setFirstRunSeen()`. Single responsibility, easy to swap. |
| Coordinator  | `src/background/service-worker.ts`  | Handles `GET_PRIVACY_FIRST_RUN` and `MARK_PRIVACY_FIRST_RUN_SEEN` messages; thin pass-throughs to `privacy-store`. |
| Coordinator  | `src/lib/exporter.ts`               | Adds `PRIVACY.md` to `zipData` using `PRIVACY_MD_TEMPLATE` from `privacy.ts`.                            |
| Presentation | `src/content/widget.ts`             | Renders first-run banner (conditional) and pre-export confirm panel; manages focus, Esc-to-dismiss, ARIA roles. |
| Presentation | `src/content/widget.css`            | Styles for `.dc-notice`, `.dc-confirm`, focus rings, dismiss button.                                    |
| Types        | `src/types.ts`                      | Adds two new `Message` variants.                                                                        |
| Constants    | `src/constants.ts`                  | Adds `STORAGE_PRIVACY_FIRST_RUN_SEEN` storage key.                                                      |

The split deliberately mirrors `session-metrics.ts` (pure) + widget polling
pattern: presentation never owns persistence, and pure logic never touches
`chrome.*`.

## Files touched

| Path                              | Kind     | Purpose                                                                                       |
|-----------------------------------|----------|-----------------------------------------------------------------------------------------------|
| `src/lib/privacy.ts`              | new      | Pure module: constants for notice text + MD template, decision helpers. No Chrome imports.    |
| `src/lib/privacy.test.ts`         | new      | Unit tests for `shouldShowFirstRunNotice`, template structure, notice-text contents.          |
| `src/lib/privacy-store.ts`        | new      | Tiny `chrome.storage.local` wrapper for the first-run seen flag.                              |
| `src/constants.ts`                | modified | Add `STORAGE_PRIVACY_FIRST_RUN_SEEN = "deskcheck_privacy_first_run_seen"`.                    |
| `src/types.ts`                    | modified | Add `GET_PRIVACY_FIRST_RUN` and `MARK_PRIVACY_FIRST_RUN_SEEN` to `Message` union.             |
| `src/background/service-worker.ts`| modified | Add two message handlers wired to `privacy-store`.                                            |
| `src/content/widget.ts`           | modified | Render first-run banner on show; render pre-export confirm panel inside `stopBtn` handler.    |
| `src/content/widget.css`          | modified | Styles for `.dc-notice`, `.dc-notice-dismiss`, `.dc-confirm`, `.dc-confirm-actions`.          |
| `src/lib/exporter.ts`             | modified | Add `zipData["PRIVACY.md"] = strToU8(PRIVACY_MD_TEMPLATE)` before screenshot loop.            |
| `src/lib/exporter.test.ts`        | modified | New test: zip contains `PRIVACY.md`; new test: contents include the three required topics.   |

**Total**: 3 new files, 7 modified.

## Implementation steps

1. **Create `src/lib/privacy.ts`** with three exports:
   - `PRIVACY_NOTICE_TEXT`: the user-facing first-run/confirm copy. Must
     mention *visible screen content*, *form inputs*, and *network headers*
     verbatim (the DoD bullet 4 requires it; the test will assert each phrase).
   - `PRIVACY_MD_TEMPLATE`: a multi-line template-literal string. Single source
     of truth, referenced by both the exporter and (transitively) the widget so
     copy never drifts.
   - `shouldShowFirstRunNotice(seen: boolean): boolean` — pure, just `!seen`,
     but the named function makes intent explicit at call sites and gives us a
     hook if the rule grows (e.g. version-bumped re-prompts).
   Rationale: pure module = trivially testable, no Chrome mocks, and the same
   constants are reused by exporter and widget so the copy lives in exactly
   one place.

2. **Create `src/lib/privacy-store.ts`**:
   ```ts
   import { STORAGE_PRIVACY_FIRST_RUN_SEEN } from "../constants";
   export async function getFirstRunSeen(): Promise<boolean> { ... }
   export async function setFirstRunSeen(): Promise<void> { ... }
   ```
   Mirrors the shape of `session-store.ts` helpers. Isolated so pure logic
   stays untainted and so a future migration (e.g. to `chrome.storage.sync`)
   touches one file.

3. **Add storage key + message types**. In `src/constants.ts`, append
   `STORAGE_PRIVACY_FIRST_RUN_SEEN`. In `src/types.ts`, append:
   ```ts
   | { type: "GET_PRIVACY_FIRST_RUN" }
   | { type: "MARK_PRIVACY_FIRST_RUN_SEEN" }
   ```
   Keeping the message vocabulary explicit (rather than coupling it to
   `GET_SESSION_STATE`) keeps each handler single-purpose.

4. **Wire service-worker handlers**. Inside `handleMessage`, add two cases that
   delegate to `privacy-store`. Each is 2–3 lines. No state in the worker
   itself — the flag lives entirely in `chrome.storage.local`, so service
   worker wakes don't need a restore step.

5. **Exporter change**. In `exportSession`, after building `jsonStr`:
   ```ts
   const zipData: Record<string, Uint8Array> = {
     "session.json": strToU8(jsonStr),
     "PRIVACY.md": strToU8(PRIVACY_MD_TEMPLATE),
   };
   ```
   Single import, single line added to the literal. No change to
   `SessionExport` interface, no `schema_version` bump — `PRIVACY.md` is a
   sibling artifact, exactly as the constraint requires.

6. **Widget — first-run banner**. In `showWidget()`, after the body is
   constructed, fire-and-await:
   ```ts
   const seen = await chrome.runtime.sendMessage({ type: "GET_PRIVACY_FIRST_RUN" });
   if (shouldShowFirstRunNotice(seen)) renderFirstRunNotice(shadow, widget);
   ```
   `renderFirstRunNotice` creates a `<div role="alert" aria-live="polite"
   class="dc-notice">` containing `PRIVACY_NOTICE_TEXT`, a "Got it" dismiss
   button, and inserts it above `metricsBar`. Dismiss handler:
   - removes the node,
   - calls `MARK_PRIVACY_FIRST_RUN_SEEN`,
   - returns focus to the textarea (prevent focus being orphaned).
   Esc keydown on the notice triggers the same dismiss path.

7. **Widget — pre-export confirm panel**. Refactor the `stopBtn` click handler
   to a two-phase flow:
   - **Phase 1 (first click)**: render an inline `<div role="alertdialog"
     aria-modal="false" class="dc-confirm">` *inside* the widget body
     containing a one-paragraph reminder (the `PRIVACY_NOTICE_TEXT` snippet
     plus "This zip is for local use only"), a *Cancel* button, and a
     *Download anyway* button. The widget itself remains interactive — this
     satisfies the "must not block" constraint.
   - **Phase 2 (Download anyway)**: existing `STOP_SESSION` + `EXPORT_SESSION`
     flow runs unchanged.
   - **Cancel** removes the panel and re-enables the stop button.
   - Esc cancels. Initial focus moves to *Download anyway*.
   No persistence — the reminder shows every export by design (DoD bullet 2
   says "appears... when Stop & Download is clicked", not "once").

8. **CSS additions**. Add `.dc-notice` (amber accent, `padding`,
   `border-radius`, dismiss `aria-label="Dismiss"`), `.dc-confirm` (sits inside
   `.dc-body`, slightly inset background), `.dc-confirm-actions` row,
   `:focus-visible` outline for both. Reuse existing `.dc-btn` /
   `.dc-btn-primary` for the action buttons — no new visual vocabulary.

9. **Tests** (see Test strategy).

10. **Manual verification pass**. Reload the unpacked extension on a fresh
    profile, confirm: notice appears once → dismiss → start a new session →
    no notice; click Stop & Download → confirm panel → cancel → still
    recording; click again → confirm → download → unzip → `PRIVACY.md`
    present alongside `session.json`.

## Test strategy

### Unit tests — `src/lib/privacy.test.ts` (new)
- `shouldShowFirstRunNotice(false)` returns `true`.
- `shouldShowFirstRunNotice(true)` returns `false`.
- `PRIVACY_NOTICE_TEXT` includes the literal phrases `visible screen content`,
  `form inputs`, and `network headers` (one assertion each — these are DoD
  bullet 4 and must not silently drift).
- `PRIVACY_MD_TEMPLATE` starts with a markdown H1 (`# `), is non-empty, and
  contains the same three phrases.
- `PRIVACY_MD_TEMPLATE` mentions "local use only" / equivalent, satisfying
  the brief's "intended for local use only" requirement.

### Unit tests — `src/lib/exporter.test.ts` (extended)
- New test: "includes PRIVACY.md in zip" — `unzipSync(...)["PRIVACY.md"]` is
  defined and non-empty.
- New test: "PRIVACY.md mentions screenshots, form inputs, network headers" —
  `strFromU8` the entry, assert the three phrases. This is the
  defence-in-depth assertion that the export contract carries the warning even
  if the widget is bypassed.
- Regression: existing `produces a valid zip with session.json` and `strips
  tab_id` tests must still pass unchanged (`schema_version` untouched).

### No new tests for `privacy-store.ts`
It is a 4-line `chrome.storage.local` pass-through; testing it would require
mocking Chrome APIs, contradicting the "pure functions tested without Chrome
API mocks" convention in `CLAUDE.md`. The behaviour is exercised by manual
verification.

### Manual verification (recorded as DoD checklist for the implementer)
1. Fresh profile → start session → first-run notice visible above the metrics
   bar with the required phrases → Esc dismisses → start a second session →
   no notice.
2. Tab refresh / browser restart between sessions → still no notice
   (persistence works, `chrome.storage.local`).
3. Stop & Download → confirm panel inline in the widget → Cancel → recording
   continues, stop button restored.
4. Stop & Download → confirm → Download anyway → zip downloads → unzip →
   `PRIVACY.md` present at root, `session.json` unchanged, `screenshots/`
   present.
5. Screen reader (VoiceOver, macOS): notice is announced as alert; confirm
   panel is announced as alertdialog; both can be operated by keyboard alone.

## Risks & mitigations

| Risk                                                                                       | Mitigation                                                                                                                |
|--------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| Widget Shadow DOM breaks focus management (closed root)                                    | Track focus inside `widgetShadow` only; on dismiss, refocus the existing textarea via the same `widgetShadow.querySelector` pattern already used in `focusWidget()`. |
| `chrome.storage.local` write races with rapid start/stop                                   | `setFirstRunSeen()` is fire-and-forget after the user dismisses; the flag is monotonic (false→true), so a duplicate write is harmless. |
| Copy drift between widget banner, confirm panel, and PRIVACY.md                            | All three pull from the same `PRIVACY_NOTICE_TEXT` / `PRIVACY_MD_TEMPLATE` constants in `privacy.ts`. Tests assert phrases. |
| Confirm panel feels like a blocker                                                         | It is rendered inline in the existing widget body (not a modal overlay), uses one-click dismiss, and the cancel path leaves the session running. Explicitly required by the "must not block" constraint. |
| Future schema migration accidentally moves PRIVACY.md content into session.json            | Exporter test asserts `PRIVACY.md` is present as a separate zip entry; `session.json` continues to be the only place `schema_version` lives. |
| Adding two messages bloats the `Message` union                                             | Two members is acceptable; the alternative (overloading `GET_SESSION_STATE`) couples concerns. Cost is negligible. |
| First-run notice never shown if `chrome.runtime.sendMessage` fails on widget mount         | Failure path: log a warning and skip the notice (don't crash the widget). The next session retries — the flag stays `false`. |

## What this plan deliberately omits

- **No new test for `privacy-store.ts`**. It is a Chrome-API pass-through;
  the codebase convention is to verify those manually.
- **No automated UI test for the widget banner**. The widget already has zero
  jsdom tests; introducing one solely for this feature would expand the test
  surface inconsistently. Manual verification covers it.
- **No version bump of `schema_version`**. `PRIVACY.md` is a sibling artifact,
  per the task constraint.
- **No popup-level notice**. The popup auto-closes on session start; the
  widget is the right surface for both reminders.
- **No internationalisation**. DeskCheck is single-locale today; introducing
  i18n machinery for two strings would be over-engineering.
- **No "remind me again" toggle or settings page**. Out of scope per the
  brief — persistent prefs across installs are explicitly excluded.
- **No redaction or scrubbing**. Feature #4 owns that.
- **No telemetry on dismiss**. The extension makes no network calls by
  design.
- **No e2e Playwright test**. The existing e2e harness (per repo notes)
  exercises core record/export flows; adding a privacy-specific journey would
  require auth+unlock cost the brief doesn't justify. The exporter unit test
  guarantees `PRIVACY.md` ships in every zip.
