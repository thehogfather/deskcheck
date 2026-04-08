---
agent: safety-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-8
perspective: safety
---

# Safety Plan: Side panel UX with live event timeline

This is a **privacy-sensitive UX migration**. Three things make it dangerous:

1. The side panel is the new front door for starting a recording, so any privacy gate that lived only in the popup or only in the in-page widget must be re-affirmed in the side panel before recording can start.
2. The side panel inlines screenshot data URLs directly into a long-lived chrome surface that survives tab switches — a screen-share or shoulder-surfer can see prior captures from a previous private session.
3. Removing the popup is irreversible from the user's standpoint within a single shipped build, and several keyboard shortcuts + the screenshot gate were tested against the popup-era assumptions. A regression here is silent: the extension still loads.

The plan is paranoid by design. It pins regressions, isolates rollback to a single revert, and explicitly rejects any "convenient" shortcut that weakens an existing privacy invariant.

## Architecture Impact

**Components affected:**
- `manifest.json` — adds `side_panel`, `sidePanel` permission; removes `action.default_popup`.
- `src/background/service-worker.ts` — adds `chrome.sidePanel.setPanelBehavior` call at top-level (must run on every SW wake, not only `onInstalled`). No new message handlers.
- `src/popup/*` — removed from build entirely (tracked dead code is the worst kind).
- New `src/sidepanel/*` directory — HTML, TS entry, CSS, and pure render helpers.
- `src/lib/session-store.ts` — **read-only consumer added**, no schema or write-path changes.
- `src/lib/privacy-store.ts` — `getFirstRunSeen` / `markFirstRunSeen` consumed by side panel before its first `START_SESSION` send.

**New patterns or abstractions introduced:**
- A storage-driven, append-only event subscription pattern (`subscribeToEvents(onAppend, onReset)`) wrapped around `chrome.storage.onChanged`. This is the first time a UI surface in DeskCheck reads events live; previously only the SW wrote them and only the exporter read them. The pattern is explicit and isolated to one helper so it can be replaced (e.g., when feature #5 introduces incremental persistence) without rewriting consumers.
- A side-panel state machine (`idle → starting → recording → stopping → idle`, plus `error` sink) — explicit, exhaustively tested, and the only place that decides which buttons are enabled.

**Dependencies added or modified:**
- None. `chrome.sidePanel` is a Manifest V3 built-in.

**Breaking changes to existing interfaces:**
- The popup HTML/JS is removed. There are no shipped users, no Web Store listing, no documentation outside the repo. The change is reversible by `git revert`.
- The `action.default_popup` manifest field is removed; toolbar click semantics change from "open popup" to "open side panel". This is observable to manual testers and any future Playwright/extension test that locates the popup by URL.
- Internal: nothing in `src/types.ts`, `src/lib/`, or the message protocol changes shape. The side panel reuses every existing `Message` variant.

**Risk points in architecture this task touches:**
- Service-worker termination model — the side panel is a long-lived document but the SW is not. Any sequence that assumes `START_SESSION` → immediate read of events without a round-trip can race against a cold SW start.
- Append-only assumption on `STORAGE_EVENTS` — true today, but if feature #5 (incremental persistence) ever rewrites the array (e.g., to flush to OPFS and reset the in-memory list), the naive `slice(oldLen)` delta breaks. We pin this with an invariant test.
- The screenshot gate (`canCaptureRecordedTab`) lives in the SW and operates on the recorded `activeTabId`. The side panel does not pass a tab id to `TAKE_SCREENSHOT` — it must continue to delegate to the SW, which already enforces the gate. We add a regression test that asserts this delegation path is unchanged.

## Risk Assessment

### Identified Risks

| # | Risk | Severity | Likelihood | Impact | Mitigation |
|---|------|----------|------------|--------|------------|
| R1 | Screenshot thumbnail leakage in side panel during screen-share / shoulder-surf | High | Medium | Sensitive pixel content visible outside the recorded tab | Default thumbnails to a redacted placeholder; click-to-reveal; auto-hide after stop session; clear all on `clearSession` |
| R2 | First-run privacy notice bypassed (toolbar-only user never sees it) | High | High (default behavior pre-fix) | User records without informed consent, export contains data they didn't expect | Side panel checks `getFirstRunSeen()` on mount; renders modal blocking `START_SESSION` until acknowledged; calls `markFirstRunSeen()` only on explicit acknowledgement |
| R3 | PII mode rendering leak — full-mode `value` shown in metadata/none mode session | High | Low (data already absent) | False sense of sanitisation | Render layer never reads `value` if `pii_mode != "full"`; even if data is present (legacy), the renderer suppresses it. Defence in depth. |
| R4 | Event subscription thrashes storage (re-fetches whole array per `onChanged`) | Medium | High (default if naive impl) | OOM on long sessions, amplifies feature #5 problem | Read once on mount; subsequently use `change.newValue` from `onChanged` directly; never call `getEvents()` in the change handler |
| R5 | Append-only assumption breaks if events array is reset or rewritten mid-session | Medium | Low today, Medium after feature #5 | Side panel shows stale data or duplicates | Detect non-append delta (`newValue.length < oldValue.length` or sequence mismatch); fall back to full reset of side panel state |
| R6 | Service worker asleep when side panel mounts; `START_SESSION` response races storage observer | Medium | Medium | Side panel shows empty list or duplicate initial events | Side panel awaits the `START_SESSION` response before subscribing; subscription starts after the `recording: true` ack |
| R7 | Cross-window race: two windows, one global session, side panel in window B mistakenly shows window B as the recording window | Medium | Medium | User confusion; might stop the wrong session | Side panel always asks `GET_SESSION_STATE` and renders the global state. UI labels the recorded tab id explicitly so user knows which tab is being recorded |
| R8 | Toolbar click no longer opens anything because `setPanelBehavior` only ran in `onInstalled` and SW was terminated before user clicked | High | Medium | Extension appears broken; user retries, possibly starting a session unintentionally via shortcut | Call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at SW top-level (every wake), with a try/catch and console warning |
| R9 | Keyboard shortcuts (`take-screenshot`, `toggle-annotation`, `toggle-session`) silently regress because the popup-era message flow is gone | High | Low | Power-user workflows broken | Shortcuts are wired to `chrome.commands.onCommand` in the SW and do not depend on the popup. Add an explicit regression test that verifies the SW handler calls the same downstream paths it did before |
| R10 | `windowId === WINDOW_ID_NONE` (-1) leaks into scroll-position storage key | Low | Medium | Stale scroll restored to wrong window; corrupted storage | Validate `windowId >= 0` before reading/writing scroll state |
| R11 | Side panel test file imports real `chrome.*` and breaks CI (Vitest node env has no `chrome` global) | Medium | High | CI failure | Mock `chrome.storage`, `chrome.runtime.sendMessage`, `chrome.sidePanel`, `chrome.windows` minimally in test setup |
| R12 | Manifest edit silently re-introduces `default_popup` (auto-merge, IDE auto-format, copy-paste) | Medium | Low | Two competing UI surfaces; popup wins because Chrome prefers it | Regression test loads `manifest.json` and asserts `action.default_popup` is undefined AND `side_panel.default_path` exists |
| R13 | Screenshot gate bypassed by side panel calling `chrome.tabs.captureVisibleTab` directly | High | Low (only if implementer takes a shortcut) | Leaks content from non-recorded tab | Side panel **never** calls capture APIs directly; it only sends `TAKE_SCREENSHOT` to the SW. Pinned by a grep-style test (`expect(sidepanelSource).not.toMatch(/captureVisibleTab/)`) |
| R14 | Side panel re-mount on tab switch loses unsent annotation textarea content | Low | High | User loses their typed note | Persist textarea draft to `chrome.storage.session` keyed by `windowId`; restore on mount |
| R15 | Two side panel instances (two windows) race on `markFirstRunSeen` | Low | Low | Harmless duplicate write | `markFirstRunSeen` is idempotent; documented |
| R16 | Stop session leaves screenshots visible in side panel until next recording starts | Medium | High (default behavior) | Privacy leak across sessions | On `STOP_SESSION` ack, immediately drop all in-memory event/screenshot rendering; show "Session ended — download or discard" only |
| R17 | SW crashes mid-write; `STORAGE_EVENTS` is partially written or unparseable | Low | Low (chrome.storage is atomic per key) | Side panel renders broken state | Wrap render in try/catch; on parse error, show "Reload to recover" banner; never throw out of the event handler |

### Failure Modes Analysis

1. **Toolbar click does nothing.**
   - Cause: `chrome.sidePanel.setPanelBehavior` was called only in `onInstalled` and the SW has since been terminated and respawned without re-applying the behavior.
   - Detection: User reports "extension is broken"; manual test by clicking the icon after Chrome restart.
   - Recovery: Move `setPanelBehavior` call to top-level SW initialisation (runs on every wake). Wrap in try/catch so a transient API failure does not crash the SW.

2. **Side panel shows stale events from a prior session.**
   - Cause: `clearSession()` removed the storage keys but the side panel cached state in memory and the `onChanged` handler did not reset on key removal.
   - Detection: Manual test — start session, stop, export, start a new session; first second of new session should show empty list.
   - Recovery: In the storage observer, treat removal of `STORAGE_EVENTS` (newValue undefined) as a full reset; clear all rendered rows.

3. **Toolbar-only user records without seeing privacy notice.**
   - Cause: Notice is only shown by the in-page widget (which is injected after `START_SESSION` runs). The side panel did not check the first-run flag.
   - Detection: Acceptance test — simulate `getFirstRunSeen() === false`, mount side panel, verify Start button is disabled until ack.
   - Recovery: Side panel mount checks `getFirstRunSeen`; if false, renders blocking modal; `START_SESSION` button is disabled until ack handler calls `markFirstRunSeen`.

4. **Two-window race shows wrong session in window B.**
   - Cause: Side panel cached the first `GET_SESSION_STATE` response and never refreshed.
   - Detection: Open window A, start session in window A, open window B, observe window B's side panel.
   - Recovery: Side panel re-fetches `GET_SESSION_STATE` on `chrome.windows.onFocusChanged` and on every `STORAGE_SESSION` change.

5. **Screenshot thumbnail visible during screen-share of unrelated work.**
   - Cause: User stops session, switches to a meeting, screen-shares Chrome with the side panel still open showing the last screenshot thumbnails.
   - Detection: Manual test — stop session, leave side panel open, verify thumbnails are not visible.
   - Recovery: On `STOP_SESSION` ack, all thumbnails are unmounted from the DOM (not just hidden via CSS — fully removed from the document).

### Blast Radius

- **Affected users**: All users (extension is unreleased, internal/dev only). Pre-launch — blast radius for shipped users is zero. Blast radius for dev workflow is large because the popup is the only entry today.
- **Affected systems**: Toolbar click behavior, all keyboard shortcuts, the in-page widget (if its first-run notice path is altered), the export pipeline (must remain untouched).
- **Data at risk**: Screenshot data URLs (visible pixel content), input field values when `pii_mode === "full"`, network failure headers. All already in `chrome.storage.local`; the side panel changes who can *see* them, not what is *stored*.

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 1 | Add `src/sidepanel/` skeleton + manifest entry, **without** removing popup | `make build` succeeds; both popup and side panel load; no behavior change for existing flows | `git revert HEAD` — popup still default |
| 2 | Wire `chrome.sidePanel.setPanelBehavior` at SW top level + add unit test for SW startup path | Manual: open Chrome, click icon → side panel opens. Existing keyboard shortcuts still fire. | `git revert HEAD` |
| 3 | Implement storage subscription + state machine + render layer (events, no screenshots yet) | Unit tests for delta computation, state transitions, append-only invariant pass. Manual: start session, observe live events. | `git revert HEAD` |
| 4 | Add screenshot thumbnail renderer with **placeholder-by-default** + click-to-reveal | Unit test asserts no `<img src="data:">` rendered until reveal flag is set. Manual: take screenshot, verify placeholder shown. | `git revert HEAD` |
| 5 | Wire first-run privacy notice into side panel (blocking modal until ack) | Unit test: mounting with `getFirstRunSeen()=false` disables Start button until ack handler runs. | `git revert HEAD` |
| 6 | Wire annotation textarea, take-screenshot button, metrics panel | All existing message handlers reused; no new SW handlers. | `git revert HEAD` |
| 7 | Add scroll persistence keyed by validated `windowId` (use `chrome.storage.session`) | Unit test: invalid windowId is rejected. | `git revert HEAD` |
| 8 | **Remove popup** (`src/popup/` deleted, `manifest.action.default_popup` removed) | Regression test: build artifact does not contain `popup.html`; manifest test asserts no `default_popup` and presence of `side_panel.default_path`. | `git revert HEAD` |
| 9 | Update `CLAUDE.md` and any README references to popup | Grep for "popup" in repo root docs returns only historical references | `git revert HEAD` |
| 10 | Full smoke test (validation checklist below) | Every checklist item passes | Revert the whole feature branch |

Each phase is a **separate commit**. Each commit is independently revertable. Phase 8 (popup removal) is the point of no return for users who rely on the popup; all phases before it are additive.

## Files to Create/Modify

| File | Action | Purpose | Risk Notes | Est. LOC |
|------|--------|---------|------------|----------|
| `manifest.json` | Modify | Remove `action.default_popup`; add `side_panel.default_path`; add `sidePanel` permission | High — pinned by regression test | -1, +5 |
| `src/sidepanel/index.html` | Create | Side panel root document | Low — static markup | 40 |
| `src/sidepanel/sidepanel.ts` | Create | Entry point: bootstrap, state machine, message handlers | High — privacy gate, screenshot delegation, no direct capture API calls | 220 |
| `src/sidepanel/sidepanel.css` | Create | Two-region layout, widget-theme colors, scroll containment | Low | 180 |
| `src/sidepanel/state-machine.ts` | Create | Pure state machine: `idle → starting → recording → stopping → idle`, plus `error` | Pure, fully testable | 80 |
| `src/sidepanel/state-machine.test.ts` | Create | Exhaustive transition tests | — | 120 |
| `src/sidepanel/event-subscription.ts` | Create | `subscribeToEvents(onAppend, onReset)` wrapper around `chrome.storage.onChanged` | Append-only assumption, partial-write tolerance | 90 |
| `src/sidepanel/event-subscription.test.ts` | Create | Append delta, reset detection, partial-write tolerance, key-removal handling | — | 180 |
| `src/sidepanel/render.ts` | Create | Pure render helpers: event row, thumbnail placeholder, PII-aware value rendering | Privacy: no `value` rendering when `pii_mode != "full"` | 140 |
| `src/sidepanel/render.test.ts` | Create | PII rendering rules, thumbnail-hidden-by-default, screenshot row structure | — | 200 |
| `src/sidepanel/privacy-gate.ts` | Create | First-run modal logic; reads `getFirstRunSeen`, blocks Start until ack | Privacy critical | 60 |
| `src/sidepanel/privacy-gate.test.ts` | Create | Modal shows when not seen; ack calls markFirstRunSeen; Start disabled until ack | — | 100 |
| `src/sidepanel/scroll-persistence.ts` | Create | Validates `windowId`, persists scroll to `chrome.storage.session` | Validation critical | 50 |
| `src/sidepanel/scroll-persistence.test.ts` | Create | WINDOW_ID_NONE rejected, missing windowId rejected | — | 60 |
| `src/sidepanel/sidepanel.integration.test.ts` | Create (jsdom) | Mount side panel with mocked `chrome.*`; verify state-machine + render integration | High value | 200 |
| `src/background/service-worker.ts` | Modify | Add top-level `chrome.sidePanel.setPanelBehavior` call wrapped in try/catch | Must not block SW startup on failure | +10 |
| `src/background/service-worker.test.ts` | Create (new) | Test that `setPanelBehavior` is invoked on SW init; test that toolbar click path opens panel | Mock `chrome.sidePanel` | 80 |
| `tests/manifest-regression.test.ts` | Create | Asserts `action.default_popup` is absent; `side_panel.default_path` exists; `sidePanel` permission is present | Pins manifest invariants | 40 |
| `tests/sidepanel-no-direct-capture.test.ts` | Create | Greps `src/sidepanel/*.ts` for forbidden API calls (`captureVisibleTab`, `chrome.debugger`) | Pins privacy invariant | 30 |
| `src/popup/index.html` | **Delete** (phase 8) | Remove dead code | Tracked by manifest regression | -23 |
| `src/popup/popup.ts` | **Delete** (phase 8) | Remove dead code | — | -91 |
| `src/popup/popup.css` | **Delete** (phase 8) | Remove dead code | — | -98 |
| `CLAUDE.md` | Modify | Update component list to mention side panel, not popup | Doc consistency | +/-5 |
| `README.md` (if exists) | Modify | Update load instructions if they reference popup | — | +/-5 |

Total new/modified LOC: ~1900. Net after popup removal: ~1700.

## Manifest Changes

### Exact diff

```diff
 {
   "manifest_version": 3,
   "name": "DeskCheck",
   "description": "Debug session recorder for AI-assisted bug fixing",
   "version": "0.3.0",
   "icons": {...},
   "permissions": [
     "activeTab",
     "debugger",
     "storage",
     "unlimitedStorage",
     "tabs",
     "downloads",
-    "scripting"
+    "scripting",
+    "sidePanel"
   ],
   ...
   "action": {
-    "default_popup": "src/popup/index.html",
     "default_icon": {...}
   },
+  "side_panel": {
+    "default_path": "src/sidepanel/index.html"
+  },
   "commands": {...}
 }
```

### Safety justification

- **Removing `default_popup` is safe** because there are no shipped users (pre-launch, no Web Store listing, no documentation outside the repo). The only callers of the popup are the developer team's manual test workflow, which is updated in the same PR.
- **Adding `sidePanel` permission** is the minimum delta required to call `chrome.sidePanel.setPanelBehavior` and to have Chrome honor `side_panel.default_path`. This permission does not grant access to any user data — it is purely a UI surface registration. No `permissions warning` is shown to users on install.
- **Why not keep both popup and side panel temporarily?** Chrome's manifest does not document the precedence of `default_popup` vs `side_panel.default_path` when both are set. Empirically, `default_popup` wins on toolbar click. If we leave both, the side panel becomes unreachable from the toolbar, and users have to find another way in (the omnibox or `chrome://side-panel`). Better to remove the popup in the same commit and pin the manifest with a regression test.
- **Bumping the version**: this is a UX migration; bump `manifest.json` and `package.json` from `0.3.0` to `0.4.0` (minor) per the project versioning conventions in CLAUDE.md. Note: do this in the same commit as the manifest change so a future bisect lines up.

## Service Worker Changes

### `setPanelBehavior` placement (the critical bit)

`chrome.sidePanel.setPanelBehavior` **must** be called at top-level on every SW wake, not in `chrome.runtime.onInstalled`. The SW can be terminated and respawned at any time; if `setPanelBehavior` only runs in `onInstalled`, the toolbar-click-opens-panel behavior is lost after the next wake.

```ts
// At top level of src/background/service-worker.ts, after the imports:
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("[DeskCheck] Failed to set side panel behavior:", err));
```

This sits alongside `restoreState()` — both run unconditionally on every wake.

### No new message handlers

Every interaction the side panel needs is already handled by the SW:
- `GET_SESSION_STATE` — recording? hasExportable? piiMode?
- `GET_SESSION_METRICS` — counts and sizes
- `START_SESSION`, `STOP_SESSION` — lifecycle
- `TAKE_SCREENSHOT`, `ADD_ANNOTATION` — capture
- `EXPORT_SESSION` — download

**Reusing the existing message contract is a deliberate safety choice**: it means the side panel cannot accidentally bypass the SW-side gates (the screenshot tab gate, the recording-state check on `RECORD_EVENT`, the auth header stripping in network capture). Any new message handler is a new attack surface; we add zero.

### Keyboard shortcuts unchanged

`chrome.commands.onCommand` is already wired in the SW and operates on the SW's `recording`, `activeTabId`, `activeSessionId` globals. None of those globals depend on the popup. The shortcuts continue to work unchanged. We add an explicit regression test that calls the SW command handler with each shortcut name and asserts the expected downstream behavior.

## Side Panel Module Structure

### `src/sidepanel/sidepanel.ts` — entry point
- Bootstraps the state machine.
- On mount: calls `getFirstRunSeen()`. If false, renders the privacy modal and disables `START_SESSION` until acknowledged.
- Calls `GET_SESSION_STATE` to learn the current session state.
- If a session is already active (e.g., panel was just opened for an in-progress session), calls `getEvents()` once for the initial backlog, then subscribes.
- Sends `START_SESSION` / `STOP_SESSION` based on user action; **awaits the SW response before subscribing** (R6 mitigation).
- Listens to `chrome.storage.onChanged` for `STORAGE_SESSION` to detect cross-window state changes (R7).
- Listens to `chrome.windows.onFocusChanged` to refresh `GET_SESSION_STATE` when the user switches windows.
- Safety invariant: never imports `chrome.tabs`, `chrome.debugger`, `chrome.scripting`. The grep test enforces this.

### `src/sidepanel/state-machine.ts` — pure logic
- States: `idle | startingPrivacyBlocked | starting | recording | stopping | error`.
- Transitions are pure: `transition(state, event) → state`. Tested exhaustively.
- The render layer reads state, never sets it.

### `src/sidepanel/event-subscription.ts` — storage observer
- `subscribeToEvents(initial: TimelineEvent[], onAppend: (events: TimelineEvent[]) => void, onReset: () => void): () => void`
- Caches `lastSeenLength` (the length of the events array we last rendered).
- On `chrome.storage.onChanged` for `STORAGE_EVENTS`:
  - If `change.newValue` is `undefined` → `onReset()` (storage was cleared).
  - If `change.newValue.length < lastSeenLength` → `onReset()` then re-seed (defends against R5).
  - If `change.newValue.length === lastSeenLength` → no-op (defensive).
  - Else → `onAppend(change.newValue.slice(lastSeenLength))`, then update `lastSeenLength`.
- Wrapped in try/catch; on parse error, calls `onError` callback (R17).
- Returns an unsubscribe function (cleanup on unmount).
- Safety invariant: **never calls `getEvents()`** in the change handler. The whole point is to use the delta directly.

### `src/sidepanel/render.ts` — pure render helpers
- `renderEventRow(event: TimelineEvent, piiMode: PiiCaptureMode, screenshotsRevealed: Set<string>): HTMLElement`
- `renderThumbnail(screenshotId, dataUrl, revealed: boolean): HTMLElement` — if `!revealed`, returns a placeholder div with click handler. Never returns an `<img>` until reveal.
- Privacy invariants:
  - For `interaction` events with `subtype === "input"`: if `piiMode !== "full"`, never read or render `event.value`. Render `value_metadata` if present (length, word count, etc.) — these are already privacy-safe by construction.
  - For `screenshot` events: render placeholder, not `<img>`, until user clicks.
  - For `annotation` events: render the user's typed text (which they explicitly authored — not PII-bearing in the same way).
  - For `network_error` events: render method, URL, status. Do not render `request_headers` or `response_body_preview` inline (these can contain tokens). Show "details" expandable on click (deferred to a future feature; safe default is to omit).

### `src/sidepanel/privacy-gate.ts` — first-run modal
- `shouldBlockStart(seen: boolean): boolean` — wraps `shouldShowFirstRunNotice`.
- `acknowledgePrivacyNotice(): Promise<void>` — calls `markFirstRunSeen()`.
- The modal renders the same `PRIVACY_NOTICE_BULLETS` content as the in-page widget, so messaging is consistent (already pinned by `privacy.test.ts`).
- Safety invariant: `START_SESSION` button is disabled until `seen === true`.

### `src/sidepanel/scroll-persistence.ts` — scroll state
- `saveScroll(windowId, scrollTop)` — validates `windowId >= 0`, writes to `chrome.storage.session` (in-memory, cleared on browser restart).
- `loadScroll(windowId): Promise<number>` — validates, returns 0 on miss or invalid.
- Safety invariant: `WINDOW_ID_NONE` (-1) is rejected at both read and write.

## Storage Subscription Design

### Wiring

```
side panel mount
  ↓
chrome.runtime.sendMessage({ type: "GET_SESSION_STATE" })  ← awaited
  ↓
if recording: getEvents() → seed initial render
  ↓
chrome.storage.onChanged.addListener(handler)
  ↓
handler:
  for change in (STORAGE_EVENTS, STORAGE_SCREENSHOTS, STORAGE_SESSION):
    route to appropriate observer
```

### Append-only assumption

Today, `appendEvent()` in `session-store.ts` is **strictly append-only**: it reads the array, pushes a new item, writes it back. The `seq` field is monotonically increasing. We pin this with a unit test:

```
test "appendEvent preserves the prefix" — read events, append, read again, assert
  newEvents.slice(0, oldLen) deep-equals oldEvents
```

The side panel's delta logic depends on this. If feature #5 (incremental persistence) lands and changes the contract, **this test must fail loudly**, and the subscription helper must be updated in the same PR.

### Delta computation

```ts
const delta = newValue.slice(lastSeenLength);
```

Cheap, correct under append-only. No JSON parse, no deep diff, no per-event message round trip.

### Partial-write tolerance

`chrome.storage.local.set` is atomic per key — Chrome guarantees you never read a partially-written value. We assert this in code via try/catch around the parse, but in practice the failure mode is "storage callback error", not "half-written array".

### Reset detection

If `change.newValue` is `undefined` (key removed via `clearSession()`), or the new length is less than the cached length (someone trimmed the array — should never happen, but defensive), we treat it as a reset: clear all rendered rows, reset `lastSeenLength` to 0.

## State Machine for the Side Panel

### States

| State | Description | Buttons enabled | Transitions out |
|-------|-------------|-----------------|-----------------|
| `idle` | No session active | Start (if privacy ack'd), Download (if exportable) | Start → `starting` |
| `startingPrivacyBlocked` | First-run user hasn't acknowledged notice | None until ack | ack → `idle` |
| `starting` | START_SESSION sent, waiting for SW response | None (loading) | success → `recording`, failure → `error` |
| `recording` | Session active, events streaming in | Stop, Screenshot, Annotate | Stop → `stopping` |
| `stopping` | STOP_SESSION sent, waiting for SW response | None (loading) | success → `idle` (with hasExportable=true), failure → `error` |
| `error` | Last operation failed | Dismiss | dismiss → `idle` |

### Transition diagram

```
                ┌─── ack ─── startingPrivacyBlocked
                ▼                       ▲
             idle ─── click Start ──────┘ (if !seen)
              │  ▲
              │  │
       click Start (if seen)
              │  │
              ▼  │
           starting
              │  │
       success│  │failure
              ▼  └─→ error ─── dismiss ──→ idle
          recording
              │
        click Stop
              ▼
           stopping
              │  │
       success│  │failure
              ▼  └─→ error
            idle
```

### Invariants

- The Start button is **only ever enabled** when state is `idle` and `firstRunSeen === true`.
- The Stop button is **only ever enabled** when state is `recording`.
- No state transition happens without a successful SW response (no optimistic UI).
- Errors are sticky — the user must explicitly dismiss them.

## Privacy Mitigations

### Thumbnail reveal strategy (R1)

**Chosen approach**: Default to a redacted placeholder; click-to-reveal individual thumbnails; auto-clear all thumbnails on session stop.

**Rationale**: Option (a) — placeholder + click-to-reveal — is strictly safer than option (b) — show with a banner. Banners are dismissable and ignored after the first session. Defaulting to hidden is the only behavior that survives a "I forgot the side panel was open and started a screen-share" scenario.

Implementation:
- `renderThumbnail` returns `<div class="dc-screenshot-placeholder" data-id="...">📷 Click to view</div>` by default.
- On click: render the actual `<img src="data:...">` in place. Track the revealed set in component state.
- On `STOP_SESSION` ack: clear the revealed set; re-render all rows so any visible thumbnails revert to placeholders.
- On `clearSession` (export complete): unmount the entire event list.

This is a deliberate tradeoff against UX convenience. The plan acknowledges this and documents it in the side panel's README/CLAUDE.md note. If user feedback indicates this is too aggressive, the fallback is to add a per-session "reveal all" toggle — but the default must remain hidden.

### PII mode rendering rules (R3)

The render layer **must** consult `session.pii_mode` (passed in from `GET_SESSION_STATE`) before rendering input event values. The rule:

```
if (event.type === "interaction" && event.subtype === "input"):
  if piiMode === "full":
    render event.value (truncated to 40 chars in UI; full value in storage)
  else if piiMode === "metadata":
    render "<input: 12 chars, 2 words>" from event.value_metadata
  else (piiMode === "none"):
    render "<input>"
```

**Defence in depth**: even if a non-`full` session somehow has a `value` field (legacy session, bug in capture), the renderer suppresses it. We add a unit test that constructs an event with both `value` and `value_metadata` set in a `metadata` mode session, and asserts the rendered HTML contains the metadata description and **does not** contain the raw value.

### First-run notice integration (R2)

The side panel mounts a blocking modal before the user can click Start. The modal renders `PRIVACY_NOTICE_BULLETS` (the same content shown by the in-page widget). Acknowledgement calls `markFirstRunSeen()`. The flag is shared with the in-page widget, so users who already saw the notice via the widget are not re-prompted in the side panel.

**Critical**: the modal must show **before** `START_SESSION` is sent, not after. The current popup-based flow has a bug where a user could in principle race the widget's notice (start session, switch to another tab before the widget injects). The side panel closes this hole by gating at the source.

## Cross-Window Behavior

DeskCheck supports **one global session at a time** (the SW has `let recording = false; let activeTabId; let activeSessionId`). The side panel reflects this:

- Side panel in window A: shows the active session (correct).
- Side panel in window B (no session in window B, but session active globally in window A): shows the active session, including a label "Recording tab in window A (id N)" so the user knows which tab is being recorded.
- Side panel in window B with no session anywhere: shows the idle state with the Start button (which would create a session in window B's active tab).
- User clicks Stop in window B's side panel while session is in window A: this stops the global session. The side panel in window A receives the `STORAGE_SESSION` change and transitions to `idle`.

**Refresh triggers** (when to re-fetch `GET_SESSION_STATE`):
1. On mount.
2. On `chrome.windows.onFocusChanged`.
3. On `chrome.storage.onChanged` for `STORAGE_SESSION`.

**Test**: integration test mounts two side panel instances (mocked), starts a session via instance A's Start button, asserts instance B's UI updates to reflect the recording state within one tick of the storage change.

## Test Plan

### Unit tests (Vitest, node env)

#### `state-machine.test.ts`
- T1 `idle + click Start (privacy seen) → starting`
- T2 `idle + click Start (privacy not seen) → startingPrivacyBlocked`
- T3 `startingPrivacyBlocked + ack → idle`
- T4 `starting + START_SESSION success → recording`
- T5 `starting + START_SESSION failure → error`
- T6 `recording + click Stop → stopping`
- T7 `stopping + STOP_SESSION success → idle`
- T8 `stopping + STOP_SESSION failure → error`
- T9 `error + dismiss → idle`
- T10 `recording + recording (no-op) → recording` (idempotency)
- T11 unknown event from any state → no transition (defensive)

#### `event-subscription.test.ts`
- T12 append delta: `[a,b]` → `[a,b,c,d]` calls `onAppend([c,d])`
- T13 delta with no change: `[a,b]` → `[a,b]` is a no-op
- T14 reset: `[a,b]` → `undefined` calls `onReset()`
- T15 unexpected shrink: `[a,b,c]` → `[a,b]` calls `onReset()`
- T16 cached length updates after each successful append
- T17 unsubscribe removes the storage listener
- T18 partial parse failure (malformed change) is caught and logged, does not throw
- T19 listener never calls `getEvents()` (verified by spy on session-store import)
- T20 append-only contract: appending event N+1 preserves all of [1..N] (pinned via session-store integration)

#### `render.test.ts`
- T21 input event in `full` mode renders `event.value`
- T22 input event in `metadata` mode renders `value_metadata.length` and word_count, NOT `event.value`
- T23 input event in `metadata` mode with both `value` and `value_metadata` present → renders metadata, does NOT render value (defence in depth)
- T24 input event in `none` mode renders `<input>` placeholder, NOT value or metadata
- T25 screenshot event renders placeholder by default (no `<img>` in DOM)
- T26 screenshot event with `revealed=true` renders `<img src="data:...">`
- T27 screenshot event after stop session renders placeholder (revealed set was cleared)
- T28 annotation event renders user-typed text
- T29 network_error event renders method/URL/status, does NOT render request_headers
- T30 console_error event renders message, does NOT render `stack_trace` inline (collapsed by default)
- T31 timestamps render in human-readable form (HH:MM:SS) and event-type label is present

#### `privacy-gate.test.ts`
- T32 mounting with `getFirstRunSeen() === false` puts state machine in `startingPrivacyBlocked`
- T33 mounting with `getFirstRunSeen() === true` puts state machine in `idle`
- T34 clicking acknowledge calls `markFirstRunSeen()` exactly once
- T35 acknowledge transitions from `startingPrivacyBlocked` to `idle`
- T36 Start button is disabled while in `startingPrivacyBlocked`
- T37 the modal renders all three `PRIVACY_NOTICE_BULLETS` (content invariant)

#### `scroll-persistence.test.ts`
- T38 `saveScroll(1, 100)` writes to `chrome.storage.session`
- T39 `saveScroll(-1, 100)` (WINDOW_ID_NONE) is rejected, no write
- T40 `saveScroll(undefined, 100)` is rejected
- T41 `loadScroll(1)` returns saved value
- T42 `loadScroll(2)` returns 0 when no value stored
- T43 `loadScroll(-1)` returns 0 (rejected windowId)

#### `service-worker.test.ts` (new)
- T44 SW init calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` exactly once
- T45 SW init catches `setPanelBehavior` rejection and logs a warning, does not throw
- T46 keyboard shortcut `take-screenshot` calls `takeScreenshot(activeTabId, "manual")` only when recording
- T47 keyboard shortcut `take-screenshot` is a no-op when not recording (regression for shortcut independence)
- T48 keyboard shortcut `toggle-session` from idle starts a session via the same code path as a side panel `START_SESSION`
- T49 keyboard shortcut `toggle-session` from recording stops the session
- T50 keyboard shortcut `toggle-annotation` sends `FOCUS_ANNOTATION` to the recorded tab when recording

### Integration tests (jsdom)

#### `sidepanel.integration.test.ts`
- T51 mount with no session, privacy seen → renders Start button enabled, empty event list
- T52 mount with no session, privacy not seen → renders blocking modal, Start disabled
- T53 mount with active session → fetches `GET_SESSION_STATE`, fetches events, renders the backlog
- T54 user clicks Start → sends `START_SESSION`, awaits response, transitions to recording
- T55 events appear in real time as `STORAGE_EVENTS` changes (simulated `onChanged` fire)
- T56 user clicks Stop → sends `STOP_SESSION`, transitions to idle, all thumbnails unmounted
- T57 cross-window: two side panel instances; starting session in instance A causes instance B to update via `STORAGE_SESSION` change
- T58 storage event with non-append change triggers full reset
- T59 SW response for `START_SESSION` returns warnings → side panel renders warning banner
- T60 export flow: clicking Download sends `EXPORT_SESSION`, success removes the Download button

### Regression tests (top-level `tests/`)

#### `tests/manifest-regression.test.ts`
- T61 `manifest.json` does **not** contain `action.default_popup` (prevents silent re-introduction)
- T62 `manifest.json` contains `side_panel.default_path === "src/sidepanel/index.html"`
- T63 `manifest.json` contains `"sidePanel"` in permissions
- T64 `manifest.json` and `package.json` versions match (existing convention; pin in same test file)

#### `tests/sidepanel-no-direct-capture.test.ts`
- T65 grep `src/sidepanel/*.ts` for `chrome.tabs.captureVisibleTab` → must return zero matches
- T66 grep `src/sidepanel/*.ts` for `chrome.debugger` → must return zero matches
- T67 grep `src/sidepanel/*.ts` for `chrome.scripting` → must return zero matches

#### `tests/popup-removed.test.ts`
- T68 `src/popup/` directory does not exist
- T69 build artifact `dist/` does not contain `popup.html`, `popup.js`, or `popup.css` (run after `make build` in CI)

### Test → DoD mapping

| DoD # | DoD criterion | Tests |
|-------|---------------|-------|
| 1 | Extension registers a side panel; toolbar click opens it | T44, T45, T62, T63 |
| 2 | Legacy popup removed | T61, T68, T69 |
| 3 | Start Session in side panel form | T51, T54 |
| 4 | Two-region layout: events above, form below | T31, integration smoke |
| 5 | Live chronological event list with timestamp + type label | T31, T55 |
| 6 | Inline screenshot thumbnails for events with images | T25, T26 |
| 7 | Real-time updates without manual refresh | T12, T55 |
| 8 | Lower region: start/stop, annotation, screenshot, metrics | T54, T56, T59, T60 |
| 9 | Event list scrolls independently; form pinned bottom | manual + CSS smoke |
| 10 | Side panel state persists across tab switches within a window | T57, T38–T43 |
| 11 | Visual styling consistent with widget theme | manual review |

### Test → threat mapping

| Threat | Tests |
|--------|-------|
| R1 (thumbnail leakage) | T25, T26, T27 |
| R2 (privacy notice bypass) | T32–T37, T52 |
| R3 (PII mode rendering leak) | T22, T23, T24 |
| R4 (subscription thrashing) | T19 |
| R5 (append-only break) | T15, T20 |
| R6 (SW asleep race) | T54 (awaits response), T59 |
| R7 (cross-window race) | T57 |
| R8 (toolbar click broken) | T44, T45 |
| R9 (shortcut regression) | T46–T50 |
| R10 (WINDOW_ID_NONE) | T39, T40, T43 |
| R11 (CI breakage) | All tests run in node/jsdom with mocked chrome |
| R12 (manifest re-introduction) | T61, T62, T63 |
| R13 (direct capture bypass) | T65, T66, T67 |
| R14 (annotation draft loss) | jsdom integration: type → unmount → remount → assert restored |
| R15 (markFirstRunSeen race) | manual reasoning + idempotency comment |
| R16 (post-stop screenshot leak) | T56 |
| R17 (partial-write tolerance) | T18 |

### Test files to create/modify

- `src/sidepanel/state-machine.test.ts`
- `src/sidepanel/event-subscription.test.ts`
- `src/sidepanel/render.test.ts`
- `src/sidepanel/privacy-gate.test.ts`
- `src/sidepanel/scroll-persistence.test.ts`
- `src/sidepanel/sidepanel.integration.test.ts`
- `src/background/service-worker.test.ts` (new)
- `tests/manifest-regression.test.ts`
- `tests/sidepanel-no-direct-capture.test.ts`
- `tests/popup-removed.test.ts`

### E2E Test Impact

- **Existing e2e tests affected**: None — there is no `e2e/` directory in the current repo (the `vite.config.ts` excludes `e2e/**` defensively but no tests live there).
- **New e2e tests needed**: None for this feature. The side panel is exercised end-to-end by the manual smoke checklist below. If a Playwright extension harness is added later (out of scope for this feature), the first e2e should be: load extension → click action → assert side panel opens → start session → assert events render → stop → export.
- **Cost note**: N/A.

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Side panel registered; toolbar opens it | Unit (manifest assertion) + Unit (SW init) | Pinned by static manifest test + behavioral test on the SW init code path. No real Chrome needed. |
| 2 | Popup removed | Unit (filesystem + manifest) | Cheap regression that pins the migration. |
| 3 | Start Session in side panel | Integration (jsdom) | Need DOM + state machine + message round trip; mock SW. |
| 4 | Two-region layout | Integration (jsdom) + manual | DOM structure can be asserted; pixel rendering is manual. |
| 5 | Live chronological event list | Unit (render) + Integration (subscription wired to render) | Pure render logic is unit-testable; the subscription→render path is integration. |
| 6 | Inline screenshot thumbnails | Unit (render with reveal flag) | Pure logic; deterministic. |
| 7 | Real-time updates without refresh | Unit (event-subscription) + Integration | Delta computation is unit; the whole pipeline is integration. |
| 8 | Lower region controls + metrics | Integration (jsdom) | Each control sends a known message; verify with mocked SW. |
| 9 | Independent scroll | Manual smoke | Layout/CSS — too brittle to assert in jsdom. |
| 10 | Persist state across tab switches | Unit (scroll-persistence) + Integration (cross-window) | Validation logic is unit; cross-window race is integration with two mounts. |
| 11 | Styling consistent with widget | Manual review | Visual; no automated coverage justifies the cost. |

**Safety planner bias**: Lean toward integration tests at boundaries where failures are costly (privacy gate, screenshot render, cross-window state). Use unit tests for pure logic (state machine, delta computation, PII rendering rules).

**Determinism rule**: All tests must be deterministic. No live Chrome, no real `chrome.storage`, no timing-dependent assertions. Mock `chrome.runtime.sendMessage` to return synchronously-resolving promises with canned responses. No LLM API calls anywhere — this feature has none, but the rule stands.

## Acceptance Test Seeds

For each DoD checkbox, a one-sentence given/when/then seed for Phase 3 test generation:

1. **DoD 1 (side panel registered)**: Given a freshly built extension, when the SW initialises, then `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` is called and the manifest declares `side_panel.default_path = "src/sidepanel/index.html"`.
2. **DoD 2 (popup removed)**: Given the built extension, when the manifest is parsed, then `action.default_popup` is undefined and the `src/popup/` source directory does not exist.
3. **DoD 3 (Start in side panel)**: Given the side panel is mounted with no active session and privacy notice acknowledged, when the user clicks Start, then `START_SESSION` is sent to the SW with the active tab's metadata and the state machine transitions to `recording` after the SW responds.
4. **DoD 4 (two-region layout)**: Given the side panel is mounted, when the DOM is inspected, then there are two regions with `data-region="events"` and `data-region="form"`, and the form is pinned to the bottom with the events region above it.
5. **DoD 5 (live event list)**: Given an active session, when an event is appended to `STORAGE_EVENTS`, then a row appears in the events region with the event's timestamp (HH:MM:SS) and type label.
6. **DoD 6 (screenshot thumbnails)**: Given a screenshot event in the timeline, when the row renders, then a placeholder is shown by default and clicking it reveals the `<img src="data:...">`.
7. **DoD 7 (real-time updates)**: Given the side panel is subscribed and the events array goes from length 5 to length 7, when the storage change fires, then exactly two new rows are appended without re-rendering the existing five.
8. **DoD 8 (lower region controls)**: Given the side panel in `recording` state, when the user clicks each of Stop / Screenshot / Annotate, then `STOP_SESSION` / `TAKE_SCREENSHOT` / `ADD_ANNOTATION` are sent respectively, and metrics are polled every 2s.
9. **DoD 9 (independent scroll)**: Given the events region is overflowing, when the user scrolls within it, then the form region remains pinned at the bottom of the side panel viewport.
10. **DoD 10 (state persists across tab switches)**: Given the side panel is open in window 1 and the user has scrolled to row 50, when the user switches tabs within window 1 and the panel re-mounts, then the scroll position is restored to row 50 (within the same browser session).
11. **DoD 11 (visual styling)**: Given the side panel is rendered, when compared to the in-page widget, then it uses the same color palette (`#f9fafb` headers, `#dc2626` recording dot, `#e5e7eb` borders) and font stack.

## Rollback Plan

### Trigger conditions

Roll back if **any** of these occur during dogfooding:
- Toolbar click opens nothing (R8 regression).
- Any keyboard shortcut stops working (R9 regression).
- A screenshot from a previous session appears in the side panel after the session was stopped or exported (R1, R16 leak).
- A user reports that recording started without seeing the privacy notice (R2 regression).
- Any test in the regression suite fails (manifest, popup-removed, no-direct-capture).
- The side panel renders an `<img>` for a screenshot that the user did not click (R1 regression).
- Side panel shows raw input values when `pii_mode !== "full"` (R3 leak).

### Rollback steps

1. `git revert <commit-range>` for the feature branch (single revert for all 10 phase commits, or per-phase reverts if a partial rollback is acceptable).
2. `make build` and verify `dist/` contains `popup.html` again.
3. Reload the unpacked extension at `chrome://extensions`.
4. Run `make test` to verify all tests pass.
5. Manually smoke-test: click toolbar → popup opens → start session → existing flow works.

### Verification after rollback

- [ ] `make test` passes
- [ ] `make typecheck` passes
- [ ] `dist/popup.html` exists
- [ ] `manifest.json` contains `action.default_popup`
- [ ] Toolbar click opens the popup
- [ ] All keyboard shortcuts still fire
- [ ] No data in `chrome.storage.local` is corrupted (existing sessions still exportable)

### Rollback tested?

- [ ] **Yes**: rollback is tested as part of the PR review by checking out `main`, running `make build`, and confirming the popup loads. The revert is mechanically equivalent.
- [ ] **No, but documented**: the steps above are sufficient because no schema change accompanies this feature. There is no data migration to undo, no storage key to clean up, no service worker upgrade path to reverse.

## Monitoring & Alerting

This is a Chrome extension with no telemetry pipeline. There is no monitoring infrastructure to alert against. The feedback loop is:

1. Manual smoke test before merge.
2. Dogfood by the development team for 1 week post-merge.
3. Bug reports go to the team chat / GitHub issues.

If feature #N adds PostHog or similar analytics, the side panel mount, Start button click, and Privacy modal acknowledgement should each be instrumented. **Out of scope for this feature**.

| Metric | Normal Range | Alert Threshold | Notes |
|--------|--------------|-----------------|-------|
| (none — no telemetry) | — | — | Add when telemetry feature lands |

## Deployment Recommendations

- [x] **Feature flag**: Not needed — there are no shipped users and the change is bisectable to a single commit per phase.
- [x] **Gradual rollout**: Not applicable — local-load extension.
- [x] **Staging verification**: Required before merge — manual smoke test against an unpacked build.
- [x] **Off-hours deployment**: Not applicable.
- [x] **Version bump**: Bump `manifest.json` and `package.json` from `0.3.0` → `0.4.0` (minor) per the conventions in CLAUDE.md.

## Estimated Effort

- Planning: Already done.
- Implementation: ~180 minutes (10 phased commits, each small).
- Safety verification (writing the unit tests, regression tests, integration tests): ~150 minutes.
- Manual smoke test (validation checklist below): ~30 minutes.
- **Total**: ~360 minutes (~6 hours).

This is more than the speed plan and roughly in line with the quality plan. The cost is concentrated in the regression and integration test suites, which protect against R1, R2, R8, R9, R12, and R13 — the highest-severity threats.

## Formal Verification Assessment

- **Concurrency concerns**: Yes (R6, R7) — service worker termination races, two-window race, storage observer + message response interleaving. The state machine is the safety surface.
- **State machine complexity**: Yes — six states, ~10 transitions. Worth pinning exhaustively in unit tests; not complex enough to need TLA+.
- **Conservation laws**: Yes (mild) — append-only events array (`length` is non-decreasing). Pinned by T20.
- **Authorization model**: No — no users, no roles.
- **Recommendation**: **Formal verification (TLA+/TLC) NOT recommended**. The state space is small enough to enumerate exhaustively in Vitest unit tests (T1–T11). The race conditions (R6, R7) are mitigated by serializing through SW responses, which is testable with mocked chrome APIs. If the side panel ever grows to support multiple concurrent sessions or background prefetch, revisit this assessment.
- **Key invariants** (in business language):
  - "Recording cannot start until the user has acknowledged the privacy notice."
  - "An event in storage that has been rendered once is never re-rendered (no duplicates) and never disappears (no losses), as long as the events array remains append-only."
  - "A screenshot thumbnail is never visible in the side panel until the user explicitly clicks to reveal it."
  - "The side panel never calls a Chrome API that captures content from a tab — only the SW does that, and only via the existing gated path."
  - "Stopping a session immediately removes all rendered screenshots from the DOM."

## Security Considerations

- [x] No secrets in code — confirmed; no API keys or tokens needed.
- [x] Input validation complete — `windowId` validated before storage write; manifest schema validated by chrome at load time.
- [x] Output encoding where needed — event values rendered as text content (`textContent`), never as HTML. Annotation text rendered as text, not HTML.
- [x] Authentication/authorization verified — N/A (local extension, no auth).
- [x] OWASP top 10 considered:
  - A01 Broken Access Control: N/A.
  - A02 Cryptographic Failures: N/A.
  - A03 Injection: side panel uses `textContent` everywhere; no `innerHTML` from event data.
  - A04 Insecure Design: privacy gate is the only entry to recording — addresses by design.
  - A05 Security Misconfiguration: pinned by manifest regression test.
  - A06 Vulnerable Components: no new dependencies.
  - A07 Identification/Auth Failures: N/A.
  - A08 Software/Data Integrity: append-only invariant is pinned.
  - A09 Logging/Monitoring: existing console warnings preserved; no new sensitive logging.
  - A10 SSRF: N/A.

## Validation Checklist (manual smoke test)

After implementation, run the following manually before merge:

### Setup
- [ ] `make build` succeeds with no warnings.
- [ ] `make test` passes all tests.
- [ ] `make typecheck` passes.
- [ ] Load unpacked extension from `dist/` in `chrome://extensions`.

### Toolbar + side panel basics
- [ ] Click the DeskCheck toolbar icon. Side panel opens on the right.
- [ ] Close and reopen Chrome. Click the icon. Side panel still opens (verifies SW wake path).
- [ ] Verify `chrome://extensions` shows no errors for the extension.

### Privacy gate
- [ ] In a fresh profile (or after `chrome.storage.local.clear()`), click the toolbar icon. Side panel shows the first-run privacy modal. Start button is disabled.
- [ ] Click Acknowledge. Modal closes. Start button becomes enabled.
- [ ] Reload the side panel. Modal does NOT reappear. Start button is enabled immediately.

### Recording flow
- [ ] Click Start. Side panel transitions to recording state. Events appear as you click around the page.
- [ ] Type into a text input. Verify the event row shows the correct rendering for the current PII mode.
- [ ] Switch PII mode to "metadata". Start a new session. Type into an input. Verify only metadata is shown (length, word count), no raw value.
- [ ] Switch PII mode to "none". Start a new session. Type into an input. Verify only `<input>` placeholder is shown.

### Screenshot thumbnails
- [ ] Take a screenshot via the side panel button. A row appears with a placeholder, NOT an image.
- [ ] Click the placeholder. The screenshot reveals.
- [ ] Click Stop session. The revealed screenshot reverts to a placeholder (or is unmounted entirely — both acceptable per design).
- [ ] Take a screenshot via the keyboard shortcut Alt+Shift+S. Verify the side panel updates with the new row.

### Cross-window
- [ ] Open a second Chrome window. Click the toolbar icon there. Side panel opens.
- [ ] Start a session in window A. Verify window B's side panel shows the recording state with a label indicating the recording is in window A's tab.
- [ ] Click Stop in window B's side panel. Verify both side panels return to idle.

### Cross-tab persistence
- [ ] In window A, scroll the events region to the middle. Switch tabs. Verify scroll position is restored on return.
- [ ] Close and reopen Chrome. Verify scroll position is NOT restored (it should reset because we use `chrome.storage.session`).

### Keyboard shortcuts
- [ ] Alt+Shift+R toggles a session (start when idle, stop when recording).
- [ ] Alt+Shift+S takes a screenshot during a session.
- [ ] Alt+Shift+A focuses the in-page annotation widget.

### Service worker termination
- [ ] Open `chrome://serviceworker-internals` (or DevTools → Application → Service Workers). Manually terminate the DeskCheck SW.
- [ ] Click the toolbar icon. Side panel still opens. Existing session (if any) is restored.

### Export
- [ ] Stop a session. Click Download Report. Zip downloads with the expected filename.
- [ ] Open the zip. `session.json` and `screenshots/` are present and well-formed.
- [ ] After download, the side panel shows idle state with no exportable session.

### Regression verification
- [ ] `chrome://extensions` does NOT show a popup when clicking the icon (regression for popup removal).
- [ ] `dist/popup.html` does not exist.
- [ ] `manifest.json` does not contain `default_popup`.
