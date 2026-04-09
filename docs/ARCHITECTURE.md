# DeskCheck Architecture

Chrome extension (Manifest V3) that records debugging sessions for AI-assisted bug fixing. Captures user interactions, console errors, network failures, JS exceptions, screenshots, and user annotations into an exportable zip.

## Components

```
┌──────────────┐    chrome.runtime.sendMessage     ┌──────────────────┐
│  Side Panel  │ ─────────────────────────────────► │  Service Worker  │
│  (chrome UI) │ ◄───── chrome.storage.onChanged    │  (background)    │
│              │                                    │                  │
│ - Event feed │                                    │  - Session mgmt  │
│ - Controls   │                                    │  - CDP client    │
│ - Metrics    │                                    │  - Screenshots   │
└──────────────┘                                    │  - Export (zip)  │
                                                    │  - Storage I/O   │
┌──────────────┐    chrome.runtime.sendMessage      │  - sidePanel reg │
│  Content     │ ◄────────────────────────────────► └──────┬───────────┘
│  Script      │                                           │
│              │    chrome.storage.local                   │
│ - Recorder   │ ◄────────────────────────────────────────►│
│ - Widget     │                                           │
│ - Picker     │                                  chrome.debugger (CDP)
└──────────────┘                                           │
                                                   ┌───────▼───────┐
                                                   │  Target Tab   │
                                                   │  (observed)   │
                                                   └───────────────┘
```

### Service Worker (`src/background/`)
- **service-worker.ts** — Message router, session lifecycle, keyboard shortcuts, export orchestration. Restores state on wake. **Side panel uses a bind-on-open model**: the manifest has NO `side_panel.default_path` (a global default would cause Chrome to create a single panel instance that ignores per-tab `setOptions` and never hides on tab switch — tracked as [GoogleChrome/chrome-extensions-samples#987](https://github.com/GoogleChrome/chrome-extensions-samples/issues/987)). The panel HTML is bundled via `vite-plugin-web-extension`'s `additionalInputs` option and declared as a `web_accessible_resource`. At top level the SW calls `setPanelBehavior({ openPanelOnActionClick: false })` so Chrome forwards toolbar clicks to our `chrome.action.onClicked` handler. The handler is SYNCHRONOUS (not async) and fires both `chrome.sidePanel.setOptions({ tabId, path: SIDEPANEL_PATH, enabled: true })` and `chrome.sidePanel.open({ tabId })` inside the gesture window, without awaiting either — Chrome processes the IPCs in order, so the per-tab override is established before the panel opens, and both calls get a valid gesture token. Only then, in an async IIFE after the gesture expires, the SW walks every OTHER tab and calls `setOptions({ tabId, enabled: false })` (no path — fresh per-tab entries with a matching path hit the same #987 trap) so switching away from the bound tab hides the panel and returning to it shows the panel again. `START_SESSION` and `STOP_SESSION` never touch `setOptions`; the panel's home tab is decided at click time, not at recording start time. If a session is active and the user clicks the action on a different tab, the handler routes them back to the recording tab (`chrome.tabs.update(activeTabId, { active: true })`) rather than migrating the panel. When the bound tab is closed we just drop the `panelBoundTabId` — Chrome auto-cleans per-tab entries for removed tabs. The SW also listens for `chrome.tabs.onCreated` and proactively disables the panel on new tabs while a binding is active. Pinned by `tests/service-worker-setpanel.test.ts` (unit) and `e2e/sidepanel-debug.spec.ts` (end-to-end visibility verification via the sidepanel page's own `document.visibilityState`).
- **screenshot.ts** — `chrome.tabs.captureVisibleTab` wrapper scoped to the recorded tab. Exports a pure `canCaptureRecordedTab()` gate that refuses capture if the recorded tab is not currently active, so mid-session tab switches cannot leak content from an unrelated tab.

### Content Script (`src/content/`)
- **index.ts** — Injection guard, message listener, session state sync with fallbacks (message + storage.onChanged). Also handles `START_ELEMENT_PICKER` from the side panel and replies via `PICK_ELEMENT_RESULT` (containing the picked `ElementInfo` plus `window.devicePixelRatio` for crop math).
- **recorder.ts** — DOM event recording (click, input, scroll, resize, SPA navigation). Input events are debounced (800ms) to capture final values, not keystrokes.
- **element-picker.ts** — Interactive element selector with closed Shadow DOM overlay. Triggered on demand by the side panel; not exposed via any in-page UI of its own.

There is **no in-page widget**. Earlier versions hosted a floating annotation panel on the recorded tab; that surface was removed in 0.4.0 in favor of the side panel, which lives in the browser chrome and never overlaps with page content.

### Side Panel (`src/sidepanel/`)
Chrome side panel UI — the only DeskCheck surface other than the in-page recorder + element picker. Opens when the user clicks the toolbar action and is **bound to the tab it was summoned from**. Switching to another tab closes it, switching back reopens it — this is true whether or not a recording session is active. Clicking the action on a different tab rebinds the panel to that tab (unless a session is active, in which case the click routes the user back to the recording tab). Replaces both the legacy browser-action popup AND the legacy in-page widget.

- **index.html** — Minimal shell hosting `#sidepanel-root`.
- **sidepanel-entry.ts** — Production entry point that wires real Chrome APIs (`chrome.runtime.sendMessage`, `chrome.runtime.onMessage`, `chrome.storage.onChanged`, `chrome.windows.onFocusChanged`, `chrome.storage.session`) into the glue layer.
- **sidepanel.ts** — Glue layer (`mountSidePanel`). Two-region flex layout: scrollable event feed above, sticky controls form below. 2-state machine (`idle` | `active`) plus a `paused` flag. Hosts: start / pause / stop, annotation textarea, "Pick element" trigger, screenshot button, PII mode selector, session metrics (with paused badge), first-run notice, inline pre-export reminder. **Never imports privileged Chrome capture APIs** (verified by `tests/sidepanel-no-direct-capture.test.ts`); all capture goes through the service worker. Uses `image-utils.cropScreenshot` to crop element-only screenshots client-side at annotation submit time, with the recorded tab's `devicePixelRatio` carried in via `PICK_ELEMENT_RESULT`.
- **sidepanel.css** — Dark theme palette (`slate-900` background, `blue-500` accent, per-row accents for danger/warning/annotation/screenshot rows). Thumbnails are `100px` square (`object-fit: cover`) and visible by default — there is no click-to-reveal gate (the side panel lives in the user's own browser chrome, where the user already controls visibility during screen sharing).

### Shared Libraries (`src/lib/`)
- **session-store-types.ts** — The `SessionStore` port. Every caller (service worker, exporter, metrics) depends on this interface, never on OPFS or `chrome.storage` directly.
- **opfs-session-store.ts** — Production `SessionStore` implementation backed by the Origin Private File System. Per-session layout: `sessions/<id>/events.jsonl` + `sessions/<id>/screenshots/<id>.png`. Uses async `FileSystemFileHandle.createWritable()` — NOT `FileSystemSyncAccessHandle`, which is `[Exposed=DedicatedWorker]` per the WHATWG FS spec and is unavailable in an MV3 service worker. A module-private `writeChain` promise serialises appends against `events.jsonl`; `ensureReady()` rehydrates the store after a service-worker wake by reading the session id from `chrome.storage.local` and re-opening the OPFS directory. `createSession` sweeps stale trees before starting fresh so orphaned sessions from a crashed run do not accumulate.
- **fake-session-store.ts** — In-memory `SessionStore` implementation. Executable spec: the contract test suite (`session-store.test.ts`) runs against both the fake and the real OPFS impl to prove the spec is consistent.
- **jsonl.ts** — Pure encode/decode helpers for the OPFS events log. `decodeAll` tolerates empty input, crash-truncated trailing lines, and malformed intermediate lines without ever throwing.
- **exporter.ts** — `exportSessionStreaming(store, session)` is the production path. Reads events via `store.readEvents()` (single pass feeds both the timeline array and the summary), drives `fflate.Zip` + `ZipPassThrough` with each screenshot pushed one at a time from `store.readScreenshots()` so the whole session is never held in memory. Legacy `exportSession(session, events, screenshots)` is retained for pre-existing unit tests. Strips internal fields (`tab_id`) and embeds `agents.md` from `agents-doc.ts` so the export is self-documenting.
- **agents-doc.ts** — Single source of truth for the export schema version and the `agents.md` reference doc shipped inside every zip. Includes a compile-time exhaustiveness helper (`assertExhaustiveEventTypes`) so adding a new `TimelineEvent` variant fails `make typecheck` until the doc is updated.
- **debugger-client.ts** — CDP v1.3 client. Subscribes to Network, Log, Runtime domains. Filters extension URLs. Sanitizes sensitive headers (Authorization, Cookie, etc.) before storing.
- **session-metrics.ts** — Pure functions for session metrics: size estimation, duration/bytes formatting, threshold checking. Polled by widget every 2s via `GET_SESSION_METRICS`.
- **privacy.ts** — Pure module: single source of truth for the in-widget first-run notice bullets, the pre-export reminder line, and the `PRIVACY.md` template shipped in every export. Imported by `widget.ts`, `exporter.ts`, and `privacy-notice.ts` so the copy cannot drift.
- **privacy-notice.ts** — Pure module: `buildFirstRunNoticeModel()` view-model shared between the in-page widget and the side panel so both surfaces render the same first-run bullets. Pinned by `privacy-notice.test.ts` against `PRIVACY_NOTICE_BULLETS`.
- **privacy-store.ts** — `chrome.storage.local` wrapper for the first-run notice flag. Read failures default to "not seen" so the notice errs on the side of being shown; write failures are logged but not thrown.
- **sidepanel-render.ts** — Pure view-model module for the side panel event feed. Maps each `TimelineEvent` variant to a `SidePanelEventRow` with timestamp, label, detail, accent, and **privacy-safe** screenshot fields (`screenshotPlaceholderId` + `screenshotDataUrl` as a string field — never embedded in HTML). Exports `assertExhaustiveSidePanelEvent` for compile-time exhaustiveness, mirroring `agents-doc.assertExhaustiveEventTypes`. Adding a new `TimelineEvent` variant fails `make typecheck` until the side panel renderer handles it.
- **sidepanel-storage.ts** — Per-window scroll position persistence backed by `chrome.storage.session` (in-memory, cleared on browser restart so stale scroll positions don't survive). Rejects `WINDOW_ID_NONE` (-1) and clamps negative values. Injectable `SessionStorageApi` seam for tests.
- **sidepanel-events-source.ts** — Wraps `chrome.runtime.onMessage` to expose a clean `subscribeToEvents` API for the side panel. The service worker broadcasts `EVENT_APPENDED` / `SESSION_CLEARED` runtime messages whenever the OPFS store changes (events no longer flow through `chrome.storage.local` after feature #5). Computes append-only deltas; falls back to a full reset on `SESSION_CLEARED`. Initial state is hydrated via a separate `GET_EVENTS_SNAPSHOT` message handled by the service worker.
- **pii-modes.ts** — Pure module for PII capture mode policy. **PRIVACY-CRITICAL**: `capturePayloadForMode` is the only code path that reads `target.value` for input events. Defines the `PiiCaptureMode` (`full` | `metadata` | `none`) and metadata extraction. In metadata mode, records exact counts for each character class (`letter_count`, `digit_count`, `emoji_count`, `whitespace_count`, `special_count`) plus `length` and `word_count` — enough for an engineer to reconstruct a realistic repro input without the raw value.
- **dom-utils.ts** — CSS selector generation, element info extraction, throttle utility.
- **image-utils.ts** — Screenshot cropping for element annotations.

### Types (`src/types.ts`)
Discriminated union for timeline events: interaction, viewport_resize, network_error, console_error, js_exception, annotation, screenshot. Message types for inter-component communication.

## Data Flow

1. User clicks the toolbar action → `chrome.action.onClicked` fires (because `openPanelOnActionClick` is off) → the handler fires `chrome.sidePanel.setOptions({ tabId, path, enabled: true })` + `chrome.sidePanel.open({ tabId })` synchronously within the user-gesture window. Then, in an async IIFE, it walks every other tab and disables the panel there with `setOptions({ tabId, enabled: false })`. From this point the panel is visible only on that tab; switching away hides it, returning shows it again.
2. User clicks "Start session" in the side panel → service worker creates a `SessionStore` session (`OpfsSessionStore.createSession`), attaches CDP debugger, injects content script. The panel binding is unchanged — `START_SESSION` is a capture-only transition.
3. Content script starts recorder (DOM events). There is no in-page widget — the side panel hosts all chrome UI, and the content script is invisible.
4. Events flow: content script → `RECORD_EVENT` message → service worker → `store.appendEvent()` → OPFS `events.jsonl` (one JSONL line per event; writes serialised through an internal promise chain so concurrent calls never interleave bytes). The service worker also broadcasts an `EVENT_APPENDED` runtime message after each successful append.
5. CDP events (network errors, console, exceptions) flow directly from debugger client → `store.appendEvent()` → OPFS, then a runtime broadcast.
6. Screenshots: `chrome.tabs.captureVisibleTab` returns a data URL which is decoded once via `dataUrlToPngBytes`; raw PNG bytes go to `store.appendScreenshot(id, bytes)` which writes `sessions/<id>/screenshots/<id>.png`. The service worker broadcasts `SCREENSHOT_APPENDED` with the data URL so the side panel can show the inline thumbnail without an extra round-trip to OPFS.
7. **Live event feed**: side panel subscribes to `chrome.runtime.onMessage` and processes `EVENT_APPENDED` / `SCREENSHOT_APPENDED` / `SESSION_CLEARED` broadcasts. Each delta appends new rows to the feed without re-rendering existing rows (DOM nodes are preserved by identity). On mount the panel hydrates state via `GET_EVENTS_SNAPSHOT`, which reads events + screenshots from OPFS one batch at a time.
8. **Cross-window**: switching focus to another window fires `chrome.windows.onFocusChanged` → side panel re-fetches `GET_SESSION_STATE` so each window's panel reflects the global session.
9. User clicks "Stop & download" in the side panel → service worker ends session, drives `exportSessionStreaming(store, session)` which pipes events + screenshots one at a time into `fflate.Zip`, triggers download via a chunk-encoded `data:application/zip;base64,...` URL, and then `store.deleteSession()` clears both the OPFS directory and the metadata key. (A `URL.createObjectURL(new Blob(...))` approach would be nicer but is currently non-functional: MV3 service workers in Chrome 147 still do not expose `URL.createObjectURL` — confirmed empirically in `e2e/session.spec.ts`. The streaming zip writer still caps peak memory during recording; the base64 encode is a bounded one-shot cost at download time only.) The side panel observes the `SESSION_CLEARED` runtime broadcast (and the `STORAGE_SESSION` metadata key going away via `chrome.storage.onChanged`) and transitions to idle.

### Persistence layout

| Location | Contents |
|----------|----------|
| `chrome.storage.local[deskcheck_session]` | Session metadata only (`SessionMetadata`). Survives service-worker sleep and is the source of truth for `ensureReady()` on wake |
| `chrome.storage.local[deskcheck_privacy_first_run_seen]` | First-run privacy notice flag |
| OPFS `/sessions/<id>/events.jsonl` | Append-only JSONL log of timeline events |
| OPFS `/sessions/<id>/screenshots/<id>.png` | Individual PNG files, one per screenshot |

`STORAGE_EVENTS` and `STORAGE_SCREENSHOTS` are gone from `chrome.storage.local`. Putting events and screenshots in OPFS removes both the per-event read-modify-write that used to rewrite the whole events array and the base64 retention that used to hold every screenshot in memory until export. The side panel's live feed is now powered by runtime broadcasts from the service worker rather than `chrome.storage.onChanged`.

## Export Schema (v1.1.0)

```
deskcheck-session-{timestamp}.zip
├── session.json    # { schema_version, session, timeline[], summary }
├── agents.md       # self-documenting schema reference for AI consumers
├── PRIVACY.md      # Privacy notice — sibling artifact, not part of session.json
└── screenshots/    # PNGs referenced by timeline events
```

`schema_version` follows semver and tracks the *whole zip layout*, not
just `session.json`. The single source of truth lives in `src/lib/agents-doc.ts`
as `SCHEMA_VERSION` and is consumed by `exporter.ts`.

`PRIVACY.md` is a sibling artifact in the zip, not a field of `session.json`.
It is added to `zipData` BEFORE the screenshots loop in `exportSession` and is
intentionally not wrapped in try/catch — a missing privacy notice is a louder
failure mode than a missing screenshot.

`session.pii_mode` records which PII capture mode the session ran under
(`full` | `metadata` | `none`). In `metadata` mode, input interaction events
omit `value` and instead carry `value_metadata` with exact counts per
character class: `{length, word_count, letter_count, digit_count,
emoji_count, whitespace_count, special_count}`. The counts are precise
rather than boolean flags so an engineer can reproduce the input shape
from the metadata alone. In `none` mode, no input events are emitted.

## Security

- A session is bound to the **single tab** it started on. DOM events come from the content script injected into that tab, CDP events come from the debugger attached to that tab, and `takeScreenshot()` refuses to capture unless that tab is currently active (`canCaptureRecordedTab`). This prevents a mid-session tab switch from silently leaking content from an unrelated tab into the export.
- **Side panel never captures directly.** The side panel UI is forbidden from importing `chrome.tabs.captureVisibleTab`, `chrome.debugger`, or `chrome.scripting`. Pinned by a grep test (`tests/sidepanel-no-direct-capture.test.ts`) so a future shortcut cannot bypass the service-worker chokepoint.
- **Annotation-attached screenshots are stored once.** When the user submits an annotation, the SW captures the full-page screenshot (and crops the picked element if any) but does NOT append a separate `screenshot` timeline event for either image. The screenshots live in the screenshots map and are rendered inline on the annotation row in the side panel feed. This prevents "screenshot, screenshot, annotation" triple-rows in the timeline for a single user action.
- Sensitive headers (Authorization, Cookie, Set-Cookie, Proxy-Authorization, X-Api-Key) are stripped from network error events before storage
- Widget and element picker use closed Shadow DOM
- Password fields are masked as `[password]` in `full` mode; in `metadata` mode only their length/char-class flags are recorded; in `none` mode they are not recorded at all
- PII capture mode (`full` | `metadata` | `none`) is selected per-session in the popup. `capturePayloadForMode` in `src/lib/pii-modes.ts` is the single chokepoint that decides whether the raw input value reaches the timeline; negative property tests assert raw values never appear in serialized events for non-`full` modes
- No external network requests; all data stays local
- Session data cleared from storage after export
- First-run privacy notice (shown once per install via `chrome.storage.local`) explains that DeskCheck captures the recorded tab's viewport, form inputs, and network headers — not the whole screen, not other tabs
- Pre-export reminder panel surfaces inside the widget on every Stop & Download click; "Keep recording" cancels with no state changes, "Download" proceeds with the unchanged stop/export flow
- Every export zip ships a `PRIVACY.md` describing exactly what is (and is not) in the contents, and an `agents.md` describing the schema for AI consumers
- Single production dependency (fflate)

## Conventions

- Vanilla TypeScript, no framework
- Vitest for testing; pure functions tested without Chrome API mocks
- Semver versioning; manifest.json and package.json versions must match
- `make build` = typecheck + vite build + copy icons

## Changelog

| Version | Changes |
|---------|---------|
| 0.4.0   | Side panel UX (feature #8): primary UI moves from the browser-action popup into a Chrome side panel (`chrome.sidePanel`). The panel uses a **bind-on-open** model carefully structured around the Chrome sidePanel API's behaviour documented in [chrome-extensions-samples#987](https://github.com/GoogleChrome/chrome-extensions-samples/issues/987): the manifest has NO `side_panel.default_path` (a global default would cause Chrome to create a single panel instance that ignores per-tab `setOptions` and never hides on tab switch). The panel HTML is bundled via `vite-plugin-web-extension`'s `additionalInputs` option and declared as a `web_accessible_resource`. The SW calls `setPanelBehavior({ openPanelOnActionClick: false })` so Chrome forwards toolbar clicks to a synchronous `chrome.action.onClicked` handler, which fires both `setOptions({ tabId, path, enabled: true })` and `sidePanel.open({ tabId })` inside the user-gesture window without awaiting either — Chrome processes the IPCs in order, so the per-tab override is registered before the panel opens, and both calls retain a valid gesture. An async IIFE afterwards walks every OTHER tab and calls `setOptions({ tabId, enabled: false })` (no path) so switching away from the bound tab hides the panel and returning restores it. Action clicks during an active session route the user back to the recording tab. `START_SESSION` and `STOP_SESSION` don't touch `setOptions`; binding is decided at click time, not at recording start time. When the bound tab is closed, we just drop `panelBoundTabId` — Chrome auto-cleans per-tab entries. New tabs created during a binding are proactively disabled via `chrome.tabs.onCreated`. Two-region layout — scrollable live event feed above, sticky controls form below — with dark-theme palette. New pure modules: `sidepanel-render.ts` (exhaustive `eventToRow` mapper mirroring `agents-doc.assertExhaustiveEventTypes`), `sidepanel-storage.ts` (per-window scroll persistence in `chrome.storage.session`), `sidepanel-events-source.ts` (append-only delta subscription that reads runtime broadcasts from the service worker), `privacy-notice.ts` (single source of truth for the first-run notice copy). The side panel hosts: start / pause / stop, annotation textarea, "Pick element" trigger, screenshot button, PII mode selector, session metrics with paused badge, first-run notice, inline pre-export reminder. Element picker round-trips via `START_ELEMENT_PICKER`/`PICK_ELEMENT_RESULT` messages between the side panel and the recorded tab's content script; element-screenshot cropping happens client-side in the side panel at annotation submit time, using the recorded tab's `devicePixelRatio` from the pick result. Annotation-attached screenshots are stored once and rendered inline on the annotation row instead of producing separate `screenshot` timeline events. Thumbnails are 100px square and visible by default. **Privacy hardening**: the side panel never imports `captureVisibleTab`/`debugger`/`scripting` (grep-pinned by `tests/sidepanel-no-direct-capture.test.ts`). The legacy `src/popup/` and `src/content/widget.ts` surfaces are deleted; manifest no longer declares `default_popup` or the `toggle-annotation` keyboard shortcut. SW gains a transient in-memory `paused` flag (gates DOM + CDP events; manual screenshot/annotation actions still work while paused). |
| (unreleased) | Incremental persistence (feature #5): replaced the `chrome.storage.local` accumulation model with streaming writes to OPFS. New `SessionStore` port (`src/lib/session-store-types.ts`) with two implementations: `OpfsSessionStore` for production and `FakeSessionStore` for tests. Events stream into `/sessions/<id>/events.jsonl` one JSONL line at a time; screenshots are individual PNG files at `/sessions/<id>/screenshots/<id>.png`. Export uses `fflate`'s streaming `Zip` class via `exportSessionStreaming(store, session)` so the full session is never held in memory during recording. (The download path still uses a chunked base64 `data:` URL because MV3 service workers in Chrome 147 do not expose `URL.createObjectURL` — a Blob URL approach would have removed one final encode pass but is currently unimplementable in this runtime.) `chrome.storage.local` is now metadata-only (`STORAGE_EVENTS` and `STORAGE_SCREENSHOTS` removed). Uses async `FileSystemFileHandle.createWritable()` — `FileSystemSyncAccessHandle` is `[Exposed=DedicatedWorker]` per the WHATWG FS spec and cannot be called from an MV3 service worker. Recovery on service-worker wake re-opens OPFS handles from the session id in `chrome.storage.local`, reconstructs `nextSeq`, and tolerates a crash-truncated trailing JSONL line. The side panel's live event feed switched from `chrome.storage.onChanged` to runtime broadcasts (`EVENT_APPENDED` / `SCREENSHOT_APPENDED` / `SESSION_CLEARED`) since events no longer live in `chrome.storage.local`; on mount it hydrates from a new `GET_EVENTS_SNAPSHOT` message that reads events and screenshot bytes one batch at a time from OPFS. |
| schema 1.1.0 | Added `agents.md` self-documenting schema reference inside every export zip (`src/lib/agents-doc.ts`). Compile-time exhaustiveness guard keeps the doc in lockstep with `TimelineEvent`. PII capture modes (feature #4): per-session Full/Metadata/None selector in the popup controls how form inputs are recorded. New pure module `src/lib/pii-modes.ts` is the single chokepoint that reads `target.value`. `SessionMetadata.pii_mode` and `InteractionEvent.value_metadata` added; metadata mode records exact per-class counts (letter/digit/emoji/whitespace/special) for repro fidelity. |
| (unreleased) | Sensitive data warnings (feature #2): first-run notice in the widget, pre-export reminder panel with explicit Keep-recording cancel, and a `PRIVACY.md` shipped in every export. New `src/lib/privacy.ts` (pure copy + decision helper) and `src/lib/privacy-store.ts` (storage wrapper). Single source of truth for notice copy across the widget and the exporter. Tightened `takeScreenshot()` to refuse capture when the recorded tab is not the currently-active tab (new pure `canCaptureRecordedTab()` gate), so mid-session tab switches cannot leak content from an unrelated tab into the export. |
| 0.3.0   | Consolidated UI into widget overlay, debounced input recording, security hardening, new icon |
| 0.2.0   | Initial release as DeskCheck (renamed from Examiner) |
