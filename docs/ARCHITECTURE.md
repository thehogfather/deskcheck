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
- **sidepanel.ts** — Glue layer (`mountSidePanel`). Three-region flex layout: `#toolbar` (lifecycle controls + metrics) at the top, scrollable `#events-list` (event feed + sticky new-events chip) in the middle, `#controls` (annotation area) at the bottom. Drives the 4-state `SessionStatus` machine (`idle` / `running` / `paused` / `stopped`) on the panel side, reading `chrome.storage.local` via `onChanged`. Control visibility is **hide-not-disable**: children of `#toolbar` and `#controls` are structurally appended/removed from `buildControlsModel()` — nothing is toggled via `display: none`, so the DoD phrase "absent from the DOM" is pinned by `querySelector === null` tests. **Toolbar** hosts: start / reset, pause (icon + label swap to Resume) / stop / discard, session metrics (with paused badge), empty-state hint. **Controls** hosts: PII mode selector, annotation textarea with embedded element picker icon (inside `.annotation-wrapper`), add-note button, first-run notice, inline pre-export reminder, inline discard-confirmation dialog (danger-tinted, default focus on Cancel, Escape closes), shared `#async-error` line (errors from save/export persist until the next success). All buttons use `<span class="btn-icon">` + `<span class="btn-label">` structure; `withLoadingState(btn, busyLabel, fn)` targets only `.btn-label` to preserve icons during the disabled + `aria-busy="true"` envelope. The standalone screenshot button was removed in feature #12 — the element picker is the only mechanism for attaching a focused (cropped) screenshot to an annotation. **Never imports privileged Chrome capture APIs** (verified by `tests/sidepanel-no-direct-capture.test.ts`); all capture goes through the service worker. The discard dialog reads event + screenshot counts from a fresh `chrome.storage.local.get` at dialog-open time (not in-memory mirror) so the "Delete N events and M screenshots" count never lies. Cancel on the dialog is a pure UI close — ZERO storage writes, spy-pinned.
- **sidepanel.css** — Dark theme palette (`slate-900` background, `blue-500` accent, per-row accents for danger/warning/annotation/screenshot rows). Thumbnails are `100px` square (`object-fit: cover`) and visible by default — there is no click-to-reveal gate (the side panel lives in the user's own browser chrome, where the user already controls visibility during screen sharing).

### Shared Libraries (`src/lib/`)
- **session-status.ts** — Pure state machine for the session lifecycle (`idle | running | paused | stopped`). Exports `nextStatus(current, action)` with a full transition table, plus `isCaptureActive` / `isLifecycleControlVisible` / `isResetEligible` predicates. Zero I/O, zero Chrome APIs. The 4-state × 7-action transition table is pinned by a table-driven unit test (`session-status.test.ts`) — this IS the formal model for the lifecycle.
- **sidepanel-controls.ts** — Pure view-model: `buildControlsModel({status, hasResidualState})` returns a declarative `ControlVisibility` shape describing which nodes should be mounted in `#controls`. Consumed by `sidepanel.ts` for the hide-not-disable structural rendering.
- **scroll-anchor.ts** — Stateful but pure helper that tracks whether the user is pinned to the bottom of the event list and how many events have appeared while scrolled up. Wraps `sidepanel-render.shouldAutoScroll`. Drives the "new events ↓" chip.
- **session-store-types.ts** — The `SessionStore` port. Every caller (service worker, exporter, metrics) depends on this interface, never on OPFS or `chrome.storage` directly. Feature #11 lifecycle methods (`pauseSession` / `resumeSession` / `discardSession`) are composed from `appendEvent()` + `updateSession()` + `deleteSession()` in the service worker.
- **opfs-session-store.ts** — Production `SessionStore` implementation backed by the Origin Private File System. Per-session layout: `sessions/<id>/events.jsonl` + `sessions/<id>/screenshots/<id>.png`. Uses async `FileSystemFileHandle.createWritable()`. A module-private `writeChain` serialises appends; `ensureReady()` rehydrates the store after a service-worker wake. `createSession` sweeps stale trees before starting fresh.
- **fake-session-store.ts** — In-memory `SessionStore` implementation. Executable spec for the contract test suite.
- **jsonl.ts** — Pure encode/decode helpers for the OPFS events log.
- **exporter.ts** — `exportSessionStreaming(store, session)` is the production path. Reads events via `store.readEvents()` and streams screenshots via `store.readScreenshots()` so the whole session is never held in memory. Legacy `exportSession(session, events, screenshots)` retained for unit tests. Strips internal fields (`tab_id`). Embeds `agents.md` from `agents-doc.ts`.
- **agents-doc.ts** — Single source of truth for the export schema version and the `agents.md` reference doc shipped inside every zip. Includes a compile-time exhaustiveness helper (`assertExhaustiveEventTypes`) so adding a new `TimelineEvent` variant fails `make typecheck` until the doc is updated.
- **debugger-client.ts** — CDP v1.3 client. Subscribes to Network, Log, Runtime domains. Filters extension URLs. Sanitizes sensitive headers (Authorization, Cookie, etc.) before storing.
- **session-metrics.ts** — Pure functions for session metrics: size estimation, duration/bytes formatting, threshold checking. Polled by widget every 2s via `GET_SESSION_METRICS`.
- **privacy.ts** — Pure module: single source of truth for the in-widget first-run notice bullets, the pre-export reminder line, and the `PRIVACY.md` template shipped in every export. Imported by `widget.ts`, `exporter.ts`, and `privacy-notice.ts` so the copy cannot drift.
- **privacy-notice.ts** — Pure module: `buildFirstRunNoticeModel()` view-model shared between the in-page widget and the side panel so both surfaces render the same first-run bullets. Pinned by `privacy-notice.test.ts` against `PRIVACY_NOTICE_BULLETS`.
- **privacy-store.ts** — `chrome.storage.local` wrapper for the first-run notice flag. Read failures default to "not seen" so the notice errs on the side of being shown; write failures are logged but not thrown.
- **sidepanel-render.ts** — Pure view-model module for the side panel event feed. Maps each `TimelineEvent` variant to a `SidePanelEventRow` with timestamp, label, detail, accent, and **privacy-safe** screenshot fields (`screenshotPlaceholderId` + `screenshotDataUrl` as a string field — never embedded in HTML). Exports `assertExhaustiveSidePanelEvent` for compile-time exhaustiveness, mirroring `agents-doc.assertExhaustiveEventTypes`. Adding a new `TimelineEvent` variant fails `make typecheck` until the side panel renderer handles it.
- **sidepanel-storage.ts** — Per-window scroll position persistence backed by `chrome.storage.session` (in-memory, cleared on browser restart so stale scroll positions don't survive). Rejects `WINDOW_ID_NONE` (-1) and clamps negative values. Injectable `SessionStorageApi` seam for tests.
- **sidepanel-events-source.ts** — Wraps `chrome.storage.onChanged` to expose a clean `subscribeToEvents` API for the side panel. Reads `change.newValue` directly (never calls `session-store` accessors — pinned by spy test). Computes append-only deltas; falls back to a full reset if the events array shrinks, becomes undefined, or is replaced with the same length (defensive against partial writes).
- **pii-modes.ts** — Pure module for PII capture mode policy. **PRIVACY-CRITICAL**: `capturePayloadForMode` is the only code path that reads `target.value` for input events. Defines the `PiiCaptureMode` (`full` | `metadata` | `none`) and metadata extraction. In metadata mode, records exact counts for each character class (`letter_count`, `digit_count`, `emoji_count`, `whitespace_count`, `special_count`) plus `length` and `word_count` — enough for an engineer to reconstruct a realistic repro input without the raw value.
- **dom-utils.ts** — CSS selector generation, element info extraction, throttle utility.
- **image-utils.ts** — Screenshot cropping for element annotations.

### Types (`src/types.ts`)
Discriminated union for timeline events: interaction, viewport_resize, network_error, console_error, js_exception, annotation, screenshot. Message types for inter-component communication.

## Data Flow

1. User clicks the toolbar action → `chrome.action.onClicked` fires (because `openPanelOnActionClick` is off) → the handler fires `chrome.sidePanel.setOptions({ tabId, path, enabled: true })` + `chrome.sidePanel.open({ tabId })` synchronously within the user-gesture window. Then, in an async IIFE, it walks every other tab and disables the panel there with `setOptions({ tabId, enabled: false })`. From this point the panel is visible only on that tab; switching away hides it, returning shows it again.
2. User clicks "Start session" in the side panel → service worker creates session in storage, attaches CDP debugger, injects content script. The panel binding is unchanged — `START_SESSION` is a capture-only transition.
3. Content script starts recorder (DOM events) + shows in-page widget overlay
4. Events flow: content script → `RECORD_EVENT` message → service worker → `appendEvent()` → `chrome.storage.local`
5. CDP events (network errors, console, exceptions) flow directly from debugger client → storage
6. **Live event feed**: side panel subscribes to `chrome.storage.onChanged` filtered to the events key. Each delta appends new rows to the feed without re-rendering existing rows (DOM nodes are preserved by identity)
7. **Cross-window**: switching focus to another window fires `chrome.windows.onFocusChanged` → side panel re-fetches `GET_SESSION_STATE` so each window's panel reflects the global session
8. User clicks "Stop & download" in the side panel → service worker ends session, builds zip, routes the zip via the selected transport (CLI handoff if attached, else the existing `chrome.downloads.download` path), and only clears OPFS once at least one transport has succeeded. The side panel observes `session.end_time` flipping via storage onChanged and transitions to idle (revealed screenshot thumbnails are unmounted from the DOM).

### CLI handoff (feature #14 phase 1)

Optional export transport that lets a developer run `deskcheck listen --out DIR` in a terminal and receive session zips directly at a known on-disk path instead of going through the browser Downloads folder. The handoff is **opt-in** — absence of the `deskcheck_handoff` key in `chrome.storage.local` is the structural kill switch; manual sessions behave exactly as they did pre-feature-14.

```
┌─────────────┐    paste-line              ┌──────────────┐
│  Side panel │ ─────────────────────────► │ chrome.storage│
│ attach row  │                            │  .local key   │
└─────────────┘                            │deskcheck_handoff
                                           └──────┬───────┘
                                                  │ read
┌─────────────┐                                   ▼
│  Service    │  EXPORT_SESSION  ┌──────────────────────┐
│  Worker     │ ────────────────►│  getHandoffConfig()  │
└──────┬──────┘                  └──────┬───────────────┘
       │                                │ ok + valid URL
       ▼                                ▼
┌──────────────┐              ┌─────────────────┐
│exportSession │  zipBytes    │ performHandoff  │ ───► POST http://127.0.0.1:<port>/upload
│ Streaming()  │ ───────────► │  (handoff-post) │      Authorization: Bearer <token>
└──────┬───────┘              └──────┬──────────┘      X-DeskCheck-Session-Id: <id>
       │                             │ ok → skip download
       │                             │ error → fall through + EXPORT_WARNING
       ▼                             ▼
   ┌──────────────────────┐   ┌──────────────────────┐
   │ chrome.downloads     │ ◄─│ #async-error slot in │
   │  .download (fallback)│   │  the side panel      │
   └──────────────────────┘   └──────────────────────┘
                │
                ▼
    ┌────────────────────┐
    │  store.deleteSession
    │  ONLY if ≥1 transport
    │  succeeded (S12 invariant)
    └────────────────────┘
```

**Binding constraints pinned by tests:**
- Listener binds 127.0.0.1 only (`cli/deskcheck.test.mjs` D5 — non-loopback connect refused at the kernel).
- Opt-in: no `deskcheck_handoff` key → zero network traffic from `EXPORT_SESSION` (`tests/service-worker-handoff.test.ts` D6).

### CLI handoff (feature #14 phase 2)

Terminal-launched sessions via `deskcheck record <url>`. The CLI starts a listener, generates a session-id + token, launches Chrome with a hash-fragment marker (`#_deskcheck=ID:TOKEN:PORT:v1`), and blocks until the session zip arrives or the timeout fires.

```
  Terminal                  Chrome Extension                  Browser
  ────────                  ─────────────────                 ───────
  deskcheck record <url>
    │
    ├── startListener(...)  ──────── 127.0.0.1:<port> ──────────┐
    │                                                            │
    ├── launchChrome(url#_deskcheck=ID:TOKEN:PORT:v1)            │
    │                                                            ▼
    │                       marker-detector.ts (document_start)
    │                         ├── stripMarker(href) → replaceState
    │                         └── sendMessage({MARKER_DETECTED})
    │                                     │
    │                       service-worker.ts
    │                         ├── armPendingHandoff(tabId, {...})
    │                         └── setBadgeText({tabId, "OPEN"})
    │                                     │
    │                        User clicks toolbar action
    │                         ├── promotePendingToActive(tabId)
    │                         └── sidePanel.open({tabId})
    │                                     │
    │                        Side panel shows "Connected to terminal
    │                        session <id>" badge. User clicks Start.
    │                                     │
    │                        User records bug, clicks Stop.
    │                                     │
    │                       EXPORT_SESSION → performHandoff(...)
    │                                     │
    │              ◄── POST /upload ───────┘
    │                  (same Phase 1 path)
    │
    ├── Zip written to <out>/<session-id>.zip
    └── JSON summary on stdout, exit 0
```

**Key additions over Phase 1:**
- `src/content/marker-detector.ts` — slim `document_start` script that detects and strips the marker before any page JS runs
- `src/lib/handoff-marker.ts` — pure marker grammar parser (`ID:TOKEN:PORT:v1`)
- `src/lib/pending-handoff-store.ts` — per-tab storage for pending handoffs with 1h stale-GC
- `src/background/handoff-cancel.ts` — cancel sentinel POST for Discard
- `cli/deskcheck-record.mjs` — the `record` subcommand
- `cli/chrome-launcher.mjs` — macOS Chrome discovery and launch

**Security invariants (all test-pinned):**
- Token never lands in `session.json` (SW defence-in-depth strips marker from `msg.url` in START_SESSION)
- `armedSessions` Set rejects unarmed session-ids with 403 (forged-marker defence)
- Cancel sentinel reuses all Phase 1 auth checks (no new endpoint surface)
- Record listener binds 127.0.0.1 only (`cli/deskcheck-record.test.mjs` A5)
- Marker grammar rejects adversarial inputs (17-case corpus in `tests/handoff-marker.test.ts`)
- Token lifetime: per-CLI-process bearer, single-use per session-id via an in-memory `usedSessions` set on the CLI (`cli/deskcheck.test.mjs` S17 replay → 409).
- Data retention: both transports failing leaves the OPFS session intact (`tests/service-worker-handoff.test.ts` S12).
- No schema change — `schema_version` stays at 1.2.0 and no handoff-related fields reach `session.json` (`src/lib/exporter.golden.test.ts` D10).

**Files:**
- `cli/deskcheck.mjs` — zero-dep Node CLI (stdlib `http`/`fs`/`crypto`/`path` only).
- `src/lib/handoff.ts` — pure URL validator (strict loopback, rejects `127.0.0.1.evil.com`, `/../`, `?q`, `#frag`, `https`, credentials), `constantTimeEqual`, `redactToken`.
- `src/lib/handoff-store.ts` — `chrome.storage.local` wrapper mirroring `privacy-store.ts`.
- `src/background/handoff-post.ts` — pure `performHandoff(config, zipBytes, sessionId, fetchImpl)` returning a discriminated union.
- `src/background/service-worker.ts` — transport selection in `EXPORT_SESSION` (single `if (handoff) { POST } else { download }` branch, ~50 lines).
- `src/sidepanel/sidepanel.ts` — "Attach CLI listener" paste row, pre-session only. Token is never rendered back to the DOM (pinned by `tests/sidepanel-no-handoff-write.test.ts`).
- Content scripts are forbidden from importing `handoff-store` (pinned by `tests/content-no-handoff-write.test.ts`).

## Export Schema (v1.2.0)

```
deskcheck-session-{timestamp}.zip
├── session.json    # { schema_version, session, timeline[], summary }
├── agents.md       # self-documenting schema reference for AI consumers
├── PRIVACY.md      # Privacy notice — sibling artifact, not part of session.json
└── screenshots/    # PNGs referenced by timeline events
```

**v1.2.0 (feature #11)** added a `session.status` field (`running` | `paused` | `stopped`) and two new additive `TimelineEvent` discriminators (`session_paused`, `session_resumed`) that mark pause/resume transitions in the timeline. Readers that ignore unknown fields and event types continue to parse v1.1.0 exports without changes. Legacy sessions written before v1.2.0 default `status` from `end_time` in `session-store.getSession()`.

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
- No external network requests. The only network traffic DeskCheck can emit is an **opt-in** loopback POST to `http://127.0.0.1:<port>/upload` when the user has explicitly attached a CLI listener via `deskcheck listen`. The listener binds 127.0.0.1 only, requires a per-run bearer token, and the zip never leaves the machine
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
| (unreleased) | Freeze PII capture mode at session start (feature #16): the PII mode selector becomes pre-session-only — its fieldset is removed from the DOM during running/paused (hide-not-disable, matches feature #11 contract) and replaced by a non-interactive `#capture-mode-pill` indicator in the toolbar that surfaces the locked mode (`Capture: Full | Metadata | None`). The pill reuses the `.handoff-status` base class for visual consistency with the connection-status pill, distinguished by an accent-colour `.pii-indicator` modifier. `ControlVisibility` gains a `piiIndicator` flag that is the mutual-exclusive complement of `piiMode` — exactly one is true at any status. The recorder now captures `const piiMode = opts.piiMode` once at start (`src/content/recorder.ts:20-26`); the prior implementation read `opts.piiMode` lazily inside `capturePayloadForMode`, which would have leaked raw values if a future refactor introduced a mutable opts source. No `schema_version` change — `session.session.pii_mode` was already write-once at creation in the service worker; the metadata field shape is unchanged. The freeze contract now spans three layers: (1) sidepanel removes the selector from the DOM during a running session, (2) recorder closure captures the start-time mode, (3) service worker writes `pii_mode` once at `buildSessionMetadata` and never updates it. Adversarial e2e test (`e2e/input-capture.spec.ts`) attempts a mid-session DOM mutation and asserts the export's `pii_mode` and event payloads remain unchanged. |
| (unreleased) | Standalone dogfooding mode (feature #13): new `demo/` entry point (`demo/standalone.html` + `demo/standalone-entry.ts`) mounts the real side panel UI at `http://localhost` via the existing `mountSidePanel(deps)` function with mock `SidePanelDeps` — zero copied or forked panel code. The mock deps simulate realistic service-worker behaviour: `sendMessage` handles all message types (GET_SESSION_STATE, START/PAUSE/RESUME/STOP/DISCARD/RESET_SESSION, ADD_ANNOTATION, etc.) by maintaining local session state and emitting events on a 1.5s interval; `onChanged` and `onRuntimeMessage` are backed by lightweight event emitters that fire `EVENT_APPENDED` / `SESSION_CLEARED` broadcasts. A separate Vite config (`demo/vite.config.ts`) serves the standalone page; `make demo` starts the dev server. The page renders identically to the real side panel — same CSS, same component tree, same layout — and works without any `chrome.*` API calls at runtime (pinned by `tests/demo-standalone.test.ts`). Developers load this page in a regular Chrome tab and use the DeskCheck extension to record issues, creating a self-referential dogfooding loop. No production code paths were altered. |
| (unreleased) | Side panel control layout refinement (feature #12): the side panel layout changes from two regions to three — `#toolbar` (lifecycle controls + session metrics) above the event feed, `#events-list` (scrollable timeline + sticky new-events chip) in the middle, `#controls` (annotation area) at the bottom. All buttons now use `<span class="btn-icon">` + `<span class="btn-label">` structure with Unicode icons; `withLoadingState` targets only `.btn-label` so icons survive the busy/restore cycle. The standalone screenshot button is removed — the element picker (embedded inside `.annotation-wrapper` alongside the textarea) is the only mechanism for attaching a focused cropped screenshot to an annotation. Lifecycle controls (Start, Pause/Resume, Stop, Discard, Reset) live in the toolbar; the bottom controls region contains only PII selector, annotation wrapper, add-note button, and dialogs. The `screenshot` field is removed from `ControlVisibility`. `newEventsChip` relocates from `#controls` to `#events-list` for correct sticky positioning. Pre-export reminder and discard confirmation dialogs remain in `#controls` as intentional friction for privacy-critical actions. |
| (unreleased) | Automatic tab group for active recording (feature #9): when a session starts, the recording tab is moved into a distinctive blue "DeskCheck" tab group in its window so Bug Reporters can see at a glance which tab is under recording. New pure module `src/lib/tab-group.ts` exposes `assignTabToDeskCheckGroup` / `removeTabFromDeskCheckGroup` through an injectable `TabGroupApi` seam, with `isAvailable()` feature detection and a top-level try/catch that swallows every Chrome rejection — tab grouping is decorative, best-effort metadata and must never regress the recording lifecycle. Stateless: queries `chrome.tabGroups.query({windowId, title})` on every call instead of caching a group id, so manual user edits (drag out, rename, delete) self-heal on the next operation. Empty-group cleanup is delegated to Chrome's built-in auto-delete. Service worker wires the helper into three call sites — end of `START_SESSION`, end of `STOP_SESSION`, inside `chrome.tabs.onRemoved` — all fire-and-forget via `void`. Critical feature-8 invariant: tab-group calls are forbidden inside `chrome.action.onClicked` / `chrome.commands.onCommand` because they would consume the user-gesture budget and break `chrome.sidePanel.open`; pinned by `tests/service-worker-tab-group.test.ts`. New `tabGroups` permission in `manifest.json`. |
| schema 1.2.0 | Side panel session controls (feature #11): the side panel now owns a typed `SessionStatus` state machine (`idle` / `running` / `paused` / `stopped`) in `src/lib/session-status.ts` with a full transition table pinned by table-driven unit tests. Control visibility is **hide-not-disable**: pre-session the form renders only Start, the PII mode selector, metrics, and (conditionally) a Reset button + empty-state hint — the annotation textarea, screenshot button, element picker, and lifecycle controls are structurally absent from the DOM, not toggled via `display:none`. `src/lib/sidepanel-controls.ts` is the pure decision module that drives this. On session start, the interaction and lifecycle controls (Pause, Stop, Discard) appear. Pause/Resume are recorded as `session_paused` / `session_resumed` timeline markers in `session.json` with **marker-before-flag** write ordering in `session-store.ts` — the marker is awaited before `session.status` flips, so SW eviction between the two writes leaves the export interpretable. Discard is a destructive mid-session action gated by a confirmation dialog (`#discard-confirm-dialog`) that mirrors the pre-export reminder: danger styling, default focus on Cancel, Escape closes via Cancel, counts computed from a fresh `chrome.storage.local.get` at dialog-open time (never from the panel's in-memory mirror). Cancel is a pure UI close with ZERO storage writes (spy-pinned). Confirmed discard calls a single atomic `remove([SESSION, EVENTS, SCREENSHOTS])` so the panel sees one batched onChanged rather than three torn intermediate states. Reset is a non-destructive clear that runs only from `stopped` / `idle` with residual state — no confirmation, since the session has already ended and any user data was either exported on Stop or dropped on Discard. Reset's click handler defensively re-checks `status === "idle" || "stopped"` as a belt-and-braces guard. Loading feedback: `withLoadingState(btn, busyLabel, fn)` inline helper wraps Save annotation ("Saving…"), Capture screenshot ("Capturing…"), and Download ("Exporting…") with `disabled` + `aria-busy="true"` + label swap; errors land in a shared `#async-error` line that persists until the next successful action. Auto-scroll: new `src/lib/scroll-anchor.ts` tracks whether the user is pinned to the bottom and how many events appeared while scrolled up; a sticky "N new events ↓" chip jumps to bottom on click, driven by `onUserScroll` / `onAppend` / `onJumpToBottom`. Schema bumped 1.1.0 → 1.2.0 additively (new `session.status` field, new `session_paused` / `session_resumed` event types); legacy compat in `getSession()` synthesises missing `status` from `end_time`. SW replaces parallel `recording` / `paused` booleans with a single `currentStatus: SessionStatus` cache; new `DISCARD_SESSION` and `RESET_SESSION` message handlers both run through `nextStatus()` before touching storage. The debugger is NOT detached on Pause — the existing CDP callback gate (`if (currentStatus !== "running") return`) drops events, which is cheaper than detach/reattach and less likely to regress. |
| 0.4.0   | Side panel UX (feature #8): primary UI moves from the browser-action popup into a Chrome side panel (`chrome.sidePanel`). The panel uses a **bind-on-open** model carefully structured around the Chrome sidePanel API's behaviour documented in [chrome-extensions-samples#987](https://github.com/GoogleChrome/chrome-extensions-samples/issues/987): the manifest has NO `side_panel.default_path` (a global default would cause Chrome to create a single panel instance that ignores per-tab `setOptions` and never hides on tab switch). The panel HTML is bundled via `vite-plugin-web-extension`'s `additionalInputs` option and declared as a `web_accessible_resource`. The SW calls `setPanelBehavior({ openPanelOnActionClick: false })` so Chrome forwards toolbar clicks to a synchronous `chrome.action.onClicked` handler, which fires both `setOptions({ tabId, path, enabled: true })` and `sidePanel.open({ tabId })` inside the user-gesture window without awaiting either — Chrome processes the IPCs in order, so the per-tab override is registered before the panel opens, and both calls retain a valid gesture. An async IIFE afterwards walks every OTHER tab and calls `setOptions({ tabId, enabled: false })` (no path) so switching away from the bound tab hides the panel and returning restores it. Action clicks during an active session route the user back to the recording tab. `START_SESSION` and `STOP_SESSION` don't touch `setOptions`; binding is decided at click time, not at recording start time. When the bound tab is closed, we just drop `panelBoundTabId` — Chrome auto-cleans per-tab entries. New tabs created during a binding are proactively disabled via `chrome.tabs.onCreated`. Two-region layout — scrollable live event feed above, sticky controls form below — with dark-theme palette. New pure modules: `sidepanel-render.ts` (exhaustive `eventToRow` mapper mirroring `agents-doc.assertExhaustiveEventTypes`), `sidepanel-storage.ts` (per-window scroll persistence in `chrome.storage.session`), `sidepanel-events-source.ts` (append-only delta subscription that reads `change.newValue` directly and never calls store accessors), `privacy-notice.ts` (single source of truth for the first-run notice copy). The side panel hosts: start / pause / stop, annotation textarea, "Pick element" trigger, screenshot button, PII mode selector, session metrics with paused badge, first-run notice, inline pre-export reminder. Element picker round-trips via `START_ELEMENT_PICKER`/`PICK_ELEMENT_RESULT` messages between the side panel and the recorded tab's content script; element-screenshot cropping happens client-side in the side panel at annotation submit time, using the recorded tab's `devicePixelRatio` from the pick result. Annotation-attached screenshots are stored once and rendered inline on the annotation row instead of producing separate `screenshot` timeline events. Thumbnails are 100px square and visible by default. **Privacy hardening**: the side panel never imports `captureVisibleTab`/`debugger`/`scripting` (grep-pinned by `tests/sidepanel-no-direct-capture.test.ts`). The legacy `src/popup/` and `src/content/widget.ts` surfaces are deleted; manifest no longer declares `default_popup` or the `toggle-annotation` keyboard shortcut. SW gains a transient in-memory `paused` flag (gates DOM + CDP events; manual screenshot/annotation actions still work while paused). |
| schema 1.1.0 | Added `agents.md` self-documenting schema reference inside every export zip (`src/lib/agents-doc.ts`). Compile-time exhaustiveness guard keeps the doc in lockstep with `TimelineEvent`. PII capture modes (feature #4): per-session Full/Metadata/None selector in the popup controls how form inputs are recorded. New pure module `src/lib/pii-modes.ts` is the single chokepoint that reads `target.value`. `SessionMetadata.pii_mode` and `InteractionEvent.value_metadata` added; metadata mode records exact per-class counts (letter/digit/emoji/whitespace/special) for repro fidelity. |
| (unreleased) | Sensitive data warnings (feature #2): first-run notice in the widget, pre-export reminder panel with explicit Keep-recording cancel, and a `PRIVACY.md` shipped in every export. New `src/lib/privacy.ts` (pure copy + decision helper) and `src/lib/privacy-store.ts` (storage wrapper). Single source of truth for notice copy across the widget and the exporter. Tightened `takeScreenshot()` to refuse capture when the recorded tab is not the currently-active tab (new pure `canCaptureRecordedTab()` gate), so mid-session tab switches cannot leak content from an unrelated tab into the export. |
| 0.3.0   | Consolidated UI into widget overlay, debounced input recording, security hardening, new icon |
| 0.2.0   | Initial release as DeskCheck (renamed from Examiner) |
