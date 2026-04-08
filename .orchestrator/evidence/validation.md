# Validation gate — feature-8 (Side panel UX with live event timeline)

Run: 2026-04-08
Result: **PASS** (first attempt, no retries needed)

| Check | Command | Result |
|-------|---------|--------|
| Typecheck | `make typecheck` | Pass (exit 0) |
| Tests | `make test` | 225/225 pass (19 files) |
| Build | `make build` | Pass (dist/ produced; sidepanel/index.js: 12.71 KB, service-worker.js: 30.19 KB) |

## Acceptance criteria from selected-plan.md (Test Level Matrix — 28 rows)

### Build-level (5 rows)
- [x] Row #1: `manifest.json` declares `side_panel.default_path = "src/sidepanel/index.html"` and `permissions` includes `"sidePanel"`
- [x] Row #3: `manifest.json` does not declare `action.default_popup`; `src/popup/` does not exist; no source file imports from `src/popup`
- [x] Row #16: `src/sidepanel/**/*.ts` contains no references to `chrome.tabs.captureVisibleTab`, `chrome.debugger`, or `chrome.scripting`
- [x] Row #24: `make typecheck` exits 0
- [x] Row #25: `make test` passes 225/225
- [x] Row #26: `make build` exits 0 and produces dist/

### Unit-level (9 rows)
- [x] Row #6a: `eventToRow` produces a row for every TimelineEvent discriminator (7 variants × subtypes = 11 unit tests)
- [x] Row #6b: `EXPECTED_DISCRIMINATORS` matches the TimelineEvent union; `assertExhaustiveSidePanelEvent` provides compile-time guard
- [x] Row #7: screenshot row carries `screenshotPlaceholderId` and `screenshotDataUrl`; missing screenshots yield null without throwing; row JSON never contains `<img>` substring
- [x] Row #11: subscription `change` handler never calls `session-store.getEvents` / `getSession` / `getScreenshots` (spy-asserted)
- [x] Row #12: `newValue.length < lastSeenLength` triggers `onReset`; `newValue undefined` triggers `onReset(empty)`; same-length update triggers `onReset` (defensive); unrelated keys ignored; non-local areas ignored
- [x] Row #13: `appendEvent` preserves the prefix; monotonic seq numbers
- [x] Row #17: `setScrollPosition`/`getScrollPosition` round-trip; per-window isolation; `WINDOW_ID_NONE` (-1) is a no-op; key prefix is exactly `deskcheck_sidepanel_scroll_`; negative values clamp to 0
- [x] Row #21: `buildFirstRunNoticeModel().bullets` deep-equals `PRIVACY_NOTICE_BULLETS` (single source of truth)

### Integration-level (12 rows)
- [x] Row #2: service worker calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` on module init; tolerates rejection without crashing
- [x] Row #4: clicking `#start-btn` with PII radio set to `metadata` sends `START_SESSION` with `piiMode: "metadata"`
- [x] Row #5: `#events-list` and `#controls` are direct sibling children of root; events region precedes controls in DOM order; flex layout pinned via inline styles
- [x] Row #8: screenshot event row renders `.screenshot-placeholder` (no `<img>`) by default; clicking placeholder reveals `<img src="data:...">`
- [x] Row #9: storage change setting `session.end_time` to non-null unmounts all revealed `<img>` elements
- [x] Row #10: storage change appending one event to a 3-event list adds one row; existing DOM nodes are preserved by identity (`data-seq` unchanged)
- [x] Row #14: controls region contains `#start-btn`, `#stop-btn`, `#screenshot-btn`, `#annotation-text`, `#pii-mode-fieldset`, `#metrics-row`
- [x] Row #15: typing into `#annotation-text` and clicking `#add-note-btn` sends `ADD_ANNOTATION` with the typed text
- [x] Row #18: scrolling `#events-list` does not throw; panel remains mounted (round-trip pinned in unit test)
- [x] Row #19: `#controls` is a direct sibling of `#events-list` (not a descendant), enabling independent scroll
- [x] Row #20: when `getFirstRunSeen()` returns false, `#first-run-notice` renders inline; when true, it does not render; clicking `.dismiss-btn` calls `markFirstRunSeen` and removes the notice
- [x] Row #22: `chrome.windows.onFocusChanged` listener fires `GET_SESSION_STATE` resend; `WINDOW_ID_NONE` (-1) is ignored
- [x] Row #23: storage change setting `session.end_time` transitions `getState()` from `"active"` to `"idle"`

### Manual (2 rows — deferred to PR review)
- [ ] Row #27: visual styling matches dark theme palette (slate-900 bg, blue-500 accent, per-row accents) — *manual smoke required*
- [ ] Row #28: end-to-end smoke: load unpacked → click toolbar → side panel opens → start session → take screenshot → placeholder shown → click reveal → stop → thumbnails gone → multi-window check — *manual smoke required*

## Privacy invariants (cross-cutting)

- [x] Placeholder-by-default: `eventToRow` returns the dataUrl as a string field on the view-model; the glue layer renders it only on explicit user click. Pinned at unit level (row #7) and integration level (row #8).
- [x] Unmount-on-stop: revealed thumbnails are removed from the DOM when the session ends. Pinned at integration level (row #9).
- [x] No direct capture from side panel: grep test (row #16) pins zero references to `captureVisibleTab`, `chrome.debugger`, `chrome.scripting`.
- [x] Append-only delta subscription: spy test asserts the change handler never calls store accessors (row #11).
- [x] Single privacy-notice source of truth: `buildFirstRunNoticeModel()` shared by widget and side panel (row #21).
- [x] PII mode rendering: SW remains the single PII enforcement point at capture time (feature #4 invariant preserved); side panel renders whatever is in storage with no second-layer enforcement.

## Diff stats

- 17 files added (4 pure lib modules + 4 lib tests + 4 sidepanel files + 4 build tests + 1 session-store test)
- 6 files modified (manifest.json, package.json, service-worker.ts, sidepanel-storage.ts, sidepanel.ts, .orchestrator/current-task.md)
- 3 files deleted (src/popup/{index.html, popup.ts, popup.css})

## Plans → tests → implementation mapping

- All three competing plans (speed, quality, safety) committed at `.orchestrator/plans/feature-8/` for audit trail
- Selected plan: quality (base) + 7 safety grafts; rationale in `.orchestrator/plans/feature-8/selected-plan.md`
- 61 failing acceptance tests committed in Phase 3 → 0 failing in Phase 5

## Conclusion

**Validation gate PASSED on first attempt.** All automated checks green, all DoD checkboxes covered (manual rows deferred to PR review). Ready for Phase 6 (architecture/roadmap update + PR).
