---
agent: safety-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-2-sensitive-data-warnings
perspective: safety
---

# Safety Plan: Sensitive Data Warnings (feature #2)

## Summary

This feature is itself a privacy/safety control: it tells users what DeskCheck
captures and ships a `PRIVACY.md` inside every export zip. The implementation
risk is therefore meta — a buggy warning system is *worse than no warning at
all* because it gives users a false sense of having been informed. The plan
prioritises three invariants: (1) the first-run notice MUST be shown at least
once before any session can produce data, (2) the pre-export reminder MUST be
shown at least once per stop-and-download click, and (3) `PRIVACY.md` MUST be
present in every successfully-downloaded zip — failure to include it should
abort the export with a loud error rather than ship a silently-incomplete zip.
None of these invariants may introduce a blocking modal that prevents the user
from completing the core stop/download flow.

## Failure Mode Catalog

| # | Scenario | Default behaviour without this plan | Proposed behaviour | Rationale |
|---|----------|-------------------------------------|---------------------|-----------|
| F1 | `chrome.storage.local.set({deskcheck_first_run_seen: true})` rejects (quota, IO, transient SW shutdown) | User dismisses notice; flag never persists; notice reappears next session — annoying but safe | **Catch the rejection, log a warning, and leave the in-memory flag unset.** Notice will reappear next session. Never swallow silently — emit a `console.warn` so it shows up in extension logs | Safer to over-show than under-show. Re-showing is annoying; failing-to-show is a privacy regression |
| F2 | `chrome.storage.local.get(deskcheck_first_run_seen)` rejects when starting a session (the read used to decide whether to show the notice) | Unknown — could either show or skip the notice depending on how it's coded | **Treat read failure as "not seen" and show the notice.** Fail-loud-toward-privacy | Default to the privacy-protecting branch on any I/O error |
| F3 | User starts a session, the read of the first-run flag is still in-flight when the recorder begins capturing events | Race: data capture begins before the user has been informed | **Service worker awaits the flag read before sending `SESSION_STARTED` to the content script. Recording does not begin until the content script has received `SESSION_STARTED`.** The current `START_SESSION` handler already builds a `warnings` array; extend it with a `firstRunNoticeRequired: boolean` field that the widget reads on mount | Honour the "shown before capture" invariant. The current code path already serialises start-session through the SW message handler, so this is a small localised change |
| F4 | User accidentally dismisses the first-run notice by clicking outside it / hitting Escape, having read nothing | Notice is gone, flag is set, user has effectively been informed of nothing | **Dismissal requires an explicit click on a labelled button ("Got it"). Clicking outside the notice does NOT dismiss. Escape does NOT dismiss.** Notice text remains accessible afterwards via a small `(?)` info icon in the widget header that re-opens the same panel | Reduces the chance of an "I never saw that" complaint without blocking |
| F5 | User clicks "Stop & Download", the pre-export reminder shows, user accidentally clicks the only action button before reading | Reminder shown for 0ms of cognitive time, export proceeds, user surprised | **Reminder requires explicit confirmation (one click) but does NOT auto-acknowledge on outside click. The confirm button is not the visually-default focused element on first render** — a tiny anti-muscle-memory measure. The reminder text remains visible until the export download completes, so a user who blinks past it can still re-read it on the way out | Avoid the "I clicked through it" failure mode without becoming a multi-step modal flow |
| F6 | `PRIVACY.md` write into the zip throws (string encoding bug, fflate edge case) | Export proceeds, zip is missing `PRIVACY.md`, contract violated | **Treat `PRIVACY.md` as a required artifact in `exportSession`. If `strToU8` or the assignment fails for any reason, throw and let the caller surface "Export failed — privacy notice could not be attached".** Do NOT catch and continue. The user can retry; a silently-incomplete export is worse than a failed one | Loud failure protects the contract. Unlike screenshots (which are allowed to be skipped if corrupted because the underlying data already exists), the privacy notice has no per-record fallback |
| F7 | Page CSS uses `* { all: unset !important }` or similar and pierces the widget's containment, mangling the notice UI | Notice is rendered but invisible / illegible, user sees nothing meaningful | The widget already uses **closed Shadow DOM** (`widget.ts:42`). Reuse the same shadow root for the notice — do NOT inject the notice as a sibling DOM node. Add explicit `all: initial` reset on the notice container inside the shadow root as belt-and-braces | Shadow DOM with closed mode is the existing pattern; the constraint is to make sure the new notice does not bypass it |
| F8 | User starts a session in tab A, immediately switches to tab B which has the widget injected from a previous session, and the storage flag changes mid-flight | Stale UI in tab B might re-show or fail to show the notice | **The notice is rendered by the widget when it mounts, driven by `firstRunNoticeRequired` returned in the `START_SESSION` response and surfaced via `SESSION_STARTED` payload.** It is NOT driven by `chrome.storage.onChanged`. This makes the notice strictly a function of "did *this* session-start need it?", not a reactive watch | Eliminates cross-tab race entirely — only the active session-target tab renders the notice |
| F9 | Service worker writes the first-run flag, then immediately crashes/wakes; the content script never receives confirmation that the flag was set | Notice may re-show next session — annoying but safe | **Write the flag in the SW *after* the content script has confirmed (via a new `FIRST_RUN_NOTICE_DISMISSED` message) that the user clicked "Got it".** Do not write the flag pre-emptively on session start | The flag means "user has acknowledged", not "we tried to show". Anchoring it on the user click guarantees the meaning |
| F10 | Pre-export reminder shows, user clicks "Cancel" / dismisses without confirming | Ambiguous — does the export proceed or not? | **The pre-export reminder presents two buttons: "Download" (proceed) and "Keep recording" (cancel stop). If the user picks "Keep recording", the SW does NOT call `endSession`, the badge stays REC, the recorder keeps capturing.** This gives the user a graceful out without losing data | Privacy-respecting *and* data-respecting. Avoids the "I cancelled but my session is now half-stopped" trap |
| F11 | User dismisses the pre-export reminder, but later wants to re-read what it said | Text is gone | The pre-export reminder reuses the same content as the first-run notice's "what is captured" section. The widget's `(?)` info icon (added in F4) keeps it permanently retrievable | Single source of truth for the notice text, retrievable on demand |
| F12 | Localisation / i18n drift: notice text in the widget says one thing, `PRIVACY.md` says another | Two sources of truth diverge | **Define notice text strings in one module, `src/lib/privacy-notice.ts`, exporting both the in-widget strings and the `PRIVACY.md` body. Both `widget.ts` and `exporter.ts` import from this module.** | Single source of truth |

## Architecture Sketch

```
src/lib/privacy-notice.ts          <- NEW. Pure module. Exports:
  - PRIVACY_NOTICE_TITLE
  - PRIVACY_NOTICE_BULLETS  (visible screen, form inputs, network headers)
  - PRIVACY_MD_BODY         (string, used by exporter)
  - FIRST_RUN_FLAG_KEY      (= "deskcheck_first_run_seen")

src/lib/first-run.ts              <- NEW. Pure-ish. Exports:
  - hasSeenFirstRunNotice(): Promise<boolean>     // catches read errors -> false
  - markFirstRunNoticeSeen(): Promise<boolean>    // returns false on write fail, never throws
  These wrap chrome.storage.local but return safe defaults on rejection.

src/background/service-worker.ts  <- MODIFY:
  - In START_SESSION: await hasSeenFirstRunNotice(), include
    `firstRunNoticeRequired: boolean` in the response
  - Send the same flag via SESSION_STARTED message payload (extend Message type)
  - Add new message FIRST_RUN_NOTICE_DISMISSED -> calls markFirstRunNoticeSeen()

src/content/widget.ts             <- MODIFY:
  - Accept optional `firstRunNoticeRequired` arg in showWidget()
  - If true, render a notice panel inside the existing shadow root,
    above the body, with explicit "Got it" button.
  - Add a small "(?)" info icon in the header that re-opens the notice panel
  - Modify Stop & Download click handler:
      1. If reminder not yet shown for this click, render reminder panel
         (Download / Keep recording buttons), do NOT yet call STOP_SESSION
      2. On Download click -> proceed with existing flow
      3. On Keep recording click -> close panel, restore stop button label,
         do nothing else

src/content/index.ts              <- MODIFY:
  - The SESSION_STARTED message now carries firstRunNoticeRequired,
    pass it to showWidget()

src/lib/exporter.ts               <- MODIFY:
  - Import PRIVACY_MD_BODY
  - Add "PRIVACY.md" to zipData. If strToU8 throws, propagate.
  - Do NOT bump schema_version (PRIVACY.md is a sibling, not part of session.json)

src/types.ts                      <- MODIFY:
  - Extend Message union with FIRST_RUN_NOTICE_DISMISSED
  - Extend SESSION_STARTED with `firstRunNoticeRequired: boolean`
  - Extend START_SESSION response with `firstRunNoticeRequired: boolean`
```

No new third-party dependencies. No schema version change.

## Files Touched

| File | Change | Risk surface |
|------|--------|--------------|
| `src/lib/privacy-notice.ts` | NEW — single source of truth for notice text | Pure strings; trivial |
| `src/lib/first-run.ts` | NEW — wraps `chrome.storage.local` first-run flag with safe defaults | Touches storage I/O; must catch all rejections |
| `src/lib/exporter.ts` | Add `PRIVACY.md` to zip; throw on failure | Touches the export contract — main risk surface |
| `src/background/service-worker.ts` | Read first-run flag on START_SESSION; handle FIRST_RUN_NOTICE_DISMISSED message | Cross-cutting message handler change |
| `src/content/widget.ts` | Render first-run notice + pre-export reminder inside existing closed Shadow DOM | UI surface; depends on shadow containment holding |
| `src/content/index.ts` | Forward `firstRunNoticeRequired` from SESSION_STARTED into `showWidget()` | Small message-routing change |
| `src/types.ts` | Extend Message and START_SESSION response types | Type-only; compile-time enforced |
| `src/lib/exporter.test.ts` | New test cases asserting `PRIVACY.md` is present and matches `PRIVACY_MD_BODY` | Test only |
| `src/lib/first-run.test.ts` | NEW — failure-mode coverage of first-run flag wrapper | Test only |
| `src/lib/privacy-notice.test.ts` | NEW — assert constants are non-empty and mention the three required topics | Test only |
| `src/content/widget.test.ts` | NEW (jsdom) — widget mounts in shadow root, renders notice, dismissal triggers FIRST_RUN_NOTICE_DISMISSED message, pre-export reminder gates STOP_SESSION | Test only — integration-level |

## Implementation Steps

1. **Create `src/lib/privacy-notice.ts`** with the three exported strings/constants. Notice bullets MUST mention: visible screen content, form inputs, network headers (DoD #4). Write the test first asserting these substrings appear.
2. **Create `src/lib/first-run.ts`** wrapping `chrome.storage.local` get/set with try/catch. Read failure → return `false` (i.e. "not seen", which biases toward showing). Write failure → return `false`, log via `console.warn`. Test with a mocked `chrome.storage.local` that throws.
3. **Extend `src/types.ts`**: add `FIRST_RUN_NOTICE_DISMISSED` to the Message union; add `firstRunNoticeRequired: boolean` to the START_SESSION response shape and to the SESSION_STARTED message payload. Run `make typecheck` after this step — it will surface every call site that needs updating.
4. **Modify `src/background/service-worker.ts`**:
   - In `START_SESSION`: call `await hasSeenFirstRunNotice()`, set `firstRunNoticeRequired = !seen`, include it in the response, and include it in the `SESSION_STARTED` `chrome.tabs.sendMessage` payload.
   - Add a `FIRST_RUN_NOTICE_DISMISSED` case → `await markFirstRunNoticeSeen()`. Return whether the write succeeded so the widget can warn in console if it didn't.
5. **Modify `src/content/widget.ts`**:
   - Accept `firstRunNoticeRequired` parameter in `showWidget`.
   - Add a `notice panel` element inside the existing shadow root (above the body). Hidden by default. Inside it: title, three bullets (from `privacy-notice.ts`), and a single "Got it" button.
   - When `firstRunNoticeRequired === true`, show the panel on mount.
   - On "Got it" click: hide the panel, send `FIRST_RUN_NOTICE_DISMISSED` via `chrome.runtime.sendMessage`. Do not block on the response.
   - Add a small `(?)` info button in the header that re-opens the same panel. The header reopen path does NOT re-send `FIRST_RUN_NOTICE_DISMISSED`.
   - Add a `pre-export reminder panel` element inside the same shadow root. Hidden by default. Reuses the bullets from `privacy-notice.ts`. Two buttons: "Download" and "Keep recording". The "Download" button is NOT autofocused.
   - Replace the current Stop & Download click handler with a two-phase flow:
     - Phase 1: show the reminder panel, change `stopBtn` label to "Awaiting confirmation…", do NOT send `STOP_SESSION`.
     - Phase 2a: On "Download" click → run the existing STOP_SESSION + EXPORT_SESSION flow.
     - Phase 2b: On "Keep recording" click → close the reminder, restore `stopBtn` label, return.
6. **Modify `src/content/index.ts`** to forward `firstRunNoticeRequired` from the SESSION_STARTED message into `startSession` → `showWidget`.
7. **Modify `src/lib/exporter.ts`**:
   - Import `PRIVACY_MD_BODY` from `privacy-notice.ts`.
   - Add `zipData["PRIVACY.md"] = strToU8(PRIVACY_MD_BODY);` BEFORE the screenshots loop, so a downstream throw aborts the export before any zip bytes are realised.
   - Do not catch — allow exceptions to propagate to the EXPORT_SESSION handler in `service-worker.ts`, which already returns `{ error: String(err) }` to the popup/widget.
8. **Update `src/lib/exporter.test.ts`** to assert `unzipped["PRIVACY.md"]` exists, decodes to a non-empty string, and that the string mentions "screenshots", "form", and "headers". Also add a test that injecting an exporter that throws when adding `PRIVACY.md` causes the whole export to fail (verify the loud-failure invariant).
9. **Write `src/content/widget.test.ts`** (jsdom) — see test strategy below.
10. **Run `make typecheck && make test`**. Manual smoke: load the unpacked extension, fresh install, start session, see notice, dismiss, click stop, see reminder, cancel, click stop again, confirm, verify zip contains `PRIVACY.md`.

## Test Strategy

### Unit tests

**`src/lib/privacy-notice.test.ts`** (new):
- `PRIVACY_NOTICE_BULLETS` mentions "screen" / "visible"
- `PRIVACY_NOTICE_BULLETS` mentions "form" / "input"
- `PRIVACY_NOTICE_BULLETS` mentions "header" / "network"
- `PRIVACY_MD_BODY` is non-empty and mentions all three topics
- `FIRST_RUN_FLAG_KEY` is the literal `"deskcheck_first_run_seen"` (regression
  guard against rename — see rollback plan)

**`src/lib/first-run.test.ts`** (new): mock `chrome.storage.local`:
- `hasSeenFirstRunNotice` returns `true` when storage returns `{ deskcheck_first_run_seen: true }`
- `hasSeenFirstRunNotice` returns `false` when storage returns `{}`
- `hasSeenFirstRunNotice` returns `false` when storage `.get()` rejects (failure mode F2)
- `markFirstRunNoticeSeen` returns `true` on success
- `markFirstRunNoticeSeen` returns `false` and logs a warning when `.set()` rejects (F1)
- `markFirstRunNoticeSeen` does NOT throw under any circumstance

**`src/lib/exporter.test.ts`** (extend):
- `exportSession` includes a `PRIVACY.md` entry in the unzipped output
- `PRIVACY.md` content matches `PRIVACY_MD_BODY` byte-for-byte
- `PRIVACY.md` is included even when there are no events and no screenshots
- `PRIVACY.md` is included even when there are screenshots
- (Loud-failure test) Stub `strToU8` via a wrapper or use `vi.spyOn` on the
  privacy-notice import to throw; assert `exportSession` throws and that NO
  partial zip is returned. (If stubbing is impractical, instead assert that
  `PRIVACY.md` is added before the screenshots loop by checking ordering of
  the zipData keys in a snapshot.)

### Integration tests (jsdom)

**`src/content/widget.test.ts`** (new, `// @vitest-environment jsdom`):

This is the failure-mode integration layer. Mock `chrome.runtime.sendMessage`
and `chrome.storage.local` at the top of the file.

- *Mount with `firstRunNoticeRequired: true`* → notice panel is present in the
  shadow root and visible
- *Mount with `firstRunNoticeRequired: false`* → notice panel is NOT visible
- *Click "Got it"* → notice panel hides, `chrome.runtime.sendMessage` called
  once with `{ type: "FIRST_RUN_NOTICE_DISMISSED" }`
- *Click outside the notice panel* → panel does NOT hide (F4)
- *Press Escape* → panel does NOT hide (F4)
- *Click `(?)` info icon* → notice panel reappears, NO new
  `FIRST_RUN_NOTICE_DISMISSED` message sent
- *Click Stop & Download (first time)* → reminder panel is rendered, NO
  `STOP_SESSION` message sent yet
- *Click Stop & Download → "Keep recording"* → reminder hides, no
  `STOP_SESSION`, no `EXPORT_SESSION`, stop button restored to "Stop & Download"
- *Click Stop & Download → "Download"* → `STOP_SESSION` then `EXPORT_SESSION`
  messages are sent in that order (F5/F10)
- *Reminder panel "Download" button is not the autofocused element* (F5)
- *Notice panel and reminder panel are inside the closed shadow root, not
  appended to `document.body` directly* (F7) — assert via querying
  `document.body` and confirming the panels are NOT findable there

**Why integration here**: each of these tests exercises the widget's DOM
together with its message-sending behaviour. Pure unit tests of the panel
strings would not catch the wiring bugs we are trying to prevent.

### Manual end-to-end (load unpacked)

A short manual checklist (DeskCheck has no e2e harness; per `CLAUDE.md`,
"Chrome API integration: tested manually via extension load"):

1. Fresh install (clear `chrome.storage.local` first). Start a session →
   notice appears.
2. Dismiss notice → start a *second* session → notice does NOT reappear.
3. Stop & Download → reminder appears → click "Keep recording" → session is
   still REC, badge still red.
4. Stop & Download → click "Download" → zip downloads, extract → confirm
   `PRIVACY.md` is at the zip root next to `session.json`.
5. Open `(?)` info icon mid-session → notice panel reopens, dismissal does
   not re-fire `FIRST_RUN_NOTICE_DISMISSED` (verify in SW console).

### Test count summary

- New unit test files: 2 (`privacy-notice.test.ts`, `first-run.test.ts`)
- Extended unit test file: 1 (`exporter.test.ts`)
- New integration test file: 1 (`widget.test.ts`, jsdom)
- Total ~22 test cases. Risk surface justifies this — each case maps to a
  specific failure mode in the catalog above.

## Rollback Plan

The feature is reversible at three levels:

**Level 1 — git revert.** Because all changes are in clearly-scoped new files
plus surgical edits to existing files, a `git revert` of the feature commit(s)
restores prior behaviour cleanly. No migrations to undo.

**Level 2 — stale storage cleanup.** A reverted feature would leave the
`deskcheck_first_run_seen` key in users' `chrome.storage.local`. This is
**harmless dead data** — the key is never read by post-revert code. We do
NOT need to clean it up. However, to keep the door open for re-introducing
the feature later without changed semantics, **the key name MUST be a stable
constant** (`deskcheck_first_run_seen`) and that constant lives in
`src/lib/privacy-notice.ts`. The unit test in `privacy-notice.test.ts` pins
this exact string so accidental rename in a future PR fails CI.

**Level 3 — partial rollback (kill switch).** If only the pre-export reminder
proves problematic (e.g. blocking complaints), the widget's two-phase stop
flow can be reverted to the single-phase flow by deleting the reminder panel
render and the phase-1 branch in the stop button handler — a localised change
of <30 lines. The first-run notice and `PRIVACY.md` injection remain
independently shippable.

**Verification after rollback:**
- `make test` passes (the new test files are deleted along with the revert)
- Manual: fresh install, start session, no notice appears, stop & download,
  zip contains no `PRIVACY.md`, behaviour is identical to pre-feature
- `chrome.storage.local` may contain a stale `deskcheck_first_run_seen` key —
  this is expected and benign

## Monitoring & Alerting

Not applicable. This is a local-only Chrome MV3 extension with no telemetry
(per task constraints: "no network requests"). The only available signal is
`console.warn` lines in the extension's service worker console, which the
plan uses for failure modes F1 and F9.

If a future telemetry feature is added, the metrics worth instrumenting would
be: notice-shown count, notice-dismissed count, reminder-shown count,
reminder-cancelled count, export-failed-due-to-privacy-notice count. The
last metric is the canary for failure mode F6.

## What This Plan Deliberately Omits

1. **Sync storage / cross-install persistence.** Out of scope per task brief.
   `chrome.storage.local` only.
2. **Configurable notice content / locales.** A single English string set.
   The single-source-of-truth module (`privacy-notice.ts`) makes future i18n
   a mechanical change.
3. **Redaction of captured data.** Covered by feature #4.
4. **Schema version bump.** Explicitly forbidden — `PRIVACY.md` is a sibling
   artifact.
5. **A blocking modal.** Both the first-run notice and the pre-export
   reminder are dismissible in one click. Neither is a multi-step flow.
6. **Telemetry.** No network calls, no analytics.
7. **A "don't show again" checkbox on the pre-export reminder.** The reminder
   is intentionally per-export, not per-install, because the privacy risk is
   per-export.
8. **Migration of users who already had sessions before the feature shipped.**
   They have no `deskcheck_first_run_seen` flag, which means they will see
   the notice on their next session — this is the correct behaviour.

## Formal Verification Assessment

- Concurrency concerns: Mild — failure mode F3 (read-vs-record race) and F8
  (cross-tab race). Both are addressed by serialising through the existing
  message-router pattern, not by introducing new concurrency primitives. No
  shared mutable state across workers.
- State machine complexity: Low. The widget gains two new visible states
  (notice-showing, reminder-showing) on top of the existing minimised /
  expanded states. State transitions are linear and user-driven.
- Conservation laws: None — no balances, no inventory.
- Authorization model: None — no roles, no per-user ACLs.
- **Recommendation: Formal verification (TLA+/TLC) NOT needed.** The feature's
  state space is small enough to be exhaustively covered by the integration
  test suite proposed above. Effort is better spent on the failure-mode
  integration tests than on a TLC model.

If a future feature introduces multi-actor coordination over the
`chrome.storage.local` first-run flag (e.g. sync storage with conflict
resolution), revisit this assessment.

## Security Considerations

- [x] No secrets in code. The new constants are user-facing notice strings.
- [x] Input validation: there is no user input to validate — the notice text
  is hard-coded constants and the only user "input" is button clicks.
- [x] Output encoding: the notice text is rendered via `textContent` (or
  equivalent safe DOM construction in `widget.ts`), never `innerHTML`. The
  `PRIVACY.md` body is written as bytes via `strToU8` — no string
  interpolation.
- [x] Authentication / authorization: not applicable, local extension.
- [x] OWASP top 10: the only relevant item is XSS, which is mitigated by
  Shadow DOM containment + `textContent`-only rendering.
- [x] No new permissions added to `manifest.json`. The feature uses
  `chrome.storage.local`, which is already requested.
- [x] No new network endpoints. Constraint upheld: extension remains
  local-only.

## Definition of Done

- [ ] First-run notice appears on first session start (DoD #1)
- [ ] First-run notice does NOT reappear after explicit dismissal, on the
  same install (DoD #1)
- [ ] First-run notice is dismissible in one click on a labelled button (DoD #1)
- [ ] Pre-export reminder appears in the widget on Stop & Download click
  (DoD #2)
- [ ] Pre-export reminder offers an explicit "Keep recording" cancel that
  does NOT end the session
- [ ] Pre-export reminder, when confirmed, proceeds with the existing
  STOP_SESSION + EXPORT_SESSION flow
- [ ] Export zip contains `PRIVACY.md` at the root, alongside `session.json`
  (DoD #3)
- [ ] `PRIVACY.md` content explains screenshots may contain sensitive data
  (DoD #3)
- [ ] Notice text mentions visible screen content, form inputs, and network
  headers (DoD #4) — verified by `privacy-notice.test.ts`
- [ ] All identified failure modes F1–F12 have a test or an explicit
  documented handling
- [ ] First-run flag read failure defaults to "show notice" (F2)
- [ ] First-run flag write failure logs a warning and the notice will
  re-appear next session (F1)
- [ ] Export aborts loudly if `PRIVACY.md` cannot be added to the zip (F6)
- [ ] Notice and reminder are rendered inside the existing closed Shadow DOM
  (F7), verified by widget integration test
- [ ] The notice text is retrievable post-dismissal via the `(?)` info icon
  (F4, F11)
- [ ] No new third-party dependencies
- [ ] No `schema_version` change in `session.json`
- [ ] `make typecheck` clean
- [ ] `make test` clean
- [ ] Manual smoke checklist (above) executed once

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|---------------|-----------------|-----------|
| 1 | First-run notice appears on first session start | Integration (jsdom) | Crosses widget DOM + message wiring boundary |
| 2 | First-run notice does NOT reappear after dismissal | Integration (jsdom) | Same boundary; need to verify message → flag-write path |
| 3 | First-run notice dismissible in one click on labelled button | Integration (jsdom) | DOM behaviour |
| 4 | Pre-export reminder appears on stop click | Integration (jsdom) | DOM + message wiring |
| 5 | Pre-export reminder "Keep recording" does not end session | Integration (jsdom) | Verifies the negative — that no STOP_SESSION fires |
| 6 | Pre-export reminder confirm proceeds with existing flow | Integration (jsdom) | Verifies message ordering |
| 7 | Export zip contains `PRIVACY.md` | Unit (exporter) | Pure function over zip bytes; deterministic |
| 8 | `PRIVACY.md` content explains screenshots may contain sensitive data | Unit (exporter + privacy-notice) | String content assertion |
| 9 | Notice text mentions screen / form / headers | Unit (privacy-notice) | String content assertion |
| 10 | First-run flag read failure → show notice | Unit (first-run) | Mocked storage rejection |
| 11 | First-run flag write failure → log + retry next session | Unit (first-run) | Mocked storage rejection |
| 12 | Export aborts loudly if `PRIVACY.md` cannot be attached | Unit (exporter) | Mocked / spied throw |
| 13 | Notice and reminder rendered inside closed Shadow DOM | Integration (jsdom) | Assert panels are not in `document.body` |
| 14 | Notice text retrievable via `(?)` info icon | Integration (jsdom) | DOM behaviour |
| 15 | No `schema_version` change | Unit (exporter) | Existing test already pins `"1.0.0"`; add a comment-doc test if needed |
| 16 | No new third-party dependencies | Manual / lint | Verified by reading `package.json` diff in code review |

**Determinism rule**: All tests use mocked Chrome APIs and fixed strings.
No live Chrome runtime, no real `chrome.storage.local`, no real downloads.
The `widget.test.ts` integration tests use jsdom, which is the same approach
already used in the codebase per `CLAUDE.md`. No LLM calls anywhere.

**Bias note**: I am leaning integration-heavy on widget behaviour because
the most important invariants of this feature (notice-shown-before-capture,
reminder-shown-before-export, panels-inside-shadow-DOM) are *wiring*
invariants, not pure-logic invariants. Unit tests of the strings alone
would give false confidence.
