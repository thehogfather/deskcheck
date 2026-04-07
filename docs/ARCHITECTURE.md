# DeskCheck Architecture

Chrome extension (Manifest V3) that records debugging sessions for AI-assisted bug fixing. Captures user interactions, console errors, network failures, JS exceptions, screenshots, and user annotations into an exportable zip.

## Components

```
┌─────────────┐     chrome.runtime.sendMessage     ┌──────────────────┐
│   Popup     │ ──────────────────────────────────► │  Service Worker  │
│ (start only)│                                     │  (background)    │
└─────────────┘                                     │                  │
                                                    │  - Session mgmt  │
┌─────────────┐     chrome.runtime.sendMessage      │  - CDP client    │
│  Content    │ ◄──────────────────────────────────► │  - Screenshots   │
│  Script     │                                     │  - Export (zip)  │
│             │                                     │  - Storage I/O   │
│ - Recorder  │     chrome.storage.local            └──────┬───────────┘
│ - Widget    │ ◄──────────────────────────────────────────►│
│ - Picker    │                                             │
└─────────────┘                                    chrome.debugger (CDP)
                                                            │
                                                    ┌───────▼───────┐
                                                    │  Target Tab   │
                                                    │  (observed)   │
                                                    └───────────────┘
```

### Service Worker (`src/background/`)
- **service-worker.ts** — Message router, session lifecycle, keyboard shortcuts, export orchestration. Restores state on wake.
- **screenshot.ts** — `chrome.tabs.captureVisibleTab` wrapper scoped to the recorded tab. Exports a pure `canCaptureRecordedTab()` gate that refuses capture if the recorded tab is not currently active, so mid-session tab switches cannot leak content from an unrelated tab.

### Content Script (`src/content/`)
- **index.ts** — Injection guard, message listener, session state sync with fallbacks (message + storage.onChanged).
- **recorder.ts** — DOM event recording (click, input, scroll, resize, SPA navigation). Input events are debounced (800ms) to capture final values, not keystrokes.
- **widget.ts** — Annotation overlay (closed Shadow DOM). Contains all session controls: annotation textarea, element picker, screenshot, stop & download.
- **element-picker.ts** — Interactive element selector with closed Shadow DOM overlay.

### Popup (`src/popup/`)
Minimal session-start trigger. Shows "Start Session" when idle, "Download Report" if an unexported session exists. Auto-closes on session start.

### Shared Libraries (`src/lib/`)
- **session-store.ts** — chrome.storage.local CRUD for sessions, events, screenshots. `getSession` back-fills `pii_mode` to `"full"` for legacy sessions.
- **exporter.ts** — Builds zip (fflate) from session data. Strips internal fields (tab_id). Skips corrupted screenshots gracefully. Embeds `agents.md` from `agents-doc.ts` so the export is self-documenting.
- **agents-doc.ts** — Single source of truth for the export schema version and the `agents.md` reference doc shipped inside every zip. Includes a compile-time exhaustiveness helper (`assertExhaustiveEventTypes`) so adding a new `TimelineEvent` variant fails `make typecheck` until the doc is updated.
- **debugger-client.ts** — CDP v1.3 client. Subscribes to Network, Log, Runtime domains. Filters extension URLs. Sanitizes sensitive headers (Authorization, Cookie, etc.) before storing.
- **session-metrics.ts** — Pure functions for session metrics: size estimation, duration/bytes formatting, threshold checking. Polled by widget every 2s via `GET_SESSION_METRICS`.
- **privacy.ts** — Pure module: single source of truth for the in-widget first-run notice bullets, the pre-export reminder line, and the `PRIVACY.md` template shipped in every export. Imported by both `widget.ts` and `exporter.ts` so the copy cannot drift.
- **privacy-store.ts** — `chrome.storage.local` wrapper for the first-run notice flag. Read failures default to "not seen" so the notice errs on the side of being shown; write failures are logged but not thrown.
- **pii-modes.ts** — Pure module for PII capture mode policy. **PRIVACY-CRITICAL**: `capturePayloadForMode` is the only code path that reads `target.value` for input events. Defines the `PiiCaptureMode` (`full` | `metadata` | `none`) and metadata extraction (length, word count, digit/emoji/special-char flags).
- **dom-utils.ts** — CSS selector generation, element info extraction, throttle utility.
- **image-utils.ts** — Screenshot cropping for element annotations.

### Types (`src/types.ts`)
Discriminated union for timeline events: interaction, viewport_resize, network_error, console_error, js_exception, annotation, screenshot. Message types for inter-component communication.

## Data Flow

1. User clicks "Start Session" in popup
2. Service worker creates session in storage, attaches CDP debugger, injects content script
3. Content script starts recorder (DOM events) + shows widget overlay
4. Events flow: content script → `RECORD_EVENT` message → service worker → `appendEvent()` → storage
5. CDP events (network errors, console, exceptions) flow directly from debugger client → storage
6. User clicks "Stop & Download" in widget → service worker ends session, builds zip, triggers download, clears storage

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
omit `value` and instead carry `value_metadata` ({length, word_count,
has_digits, has_emoji, has_special}). In `none` mode, no input events are
emitted at all.

## Security

- A session is bound to the **single tab** it started on. DOM events come from the content script injected into that tab, CDP events come from the debugger attached to that tab, and `takeScreenshot()` refuses to capture unless that tab is currently active (`canCaptureRecordedTab`). This prevents a mid-session tab switch from silently leaking content from an unrelated tab into the export.
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
| schema 1.1.0 | Added `agents.md` self-documenting schema reference inside every export zip (`src/lib/agents-doc.ts`). Compile-time exhaustiveness guard keeps the doc in lockstep with `TimelineEvent`. PII capture modes (feature #4): per-session Full/Metadata/None selector in the popup controls how form inputs are recorded. New pure module `src/lib/pii-modes.ts` is the single chokepoint that reads `target.value`. `SessionMetadata.pii_mode` and `InteractionEvent.value_metadata` added. |
| (unreleased) | Sensitive data warnings (feature #2): first-run notice in the widget, pre-export reminder panel with explicit Keep-recording cancel, and a `PRIVACY.md` shipped in every export. New `src/lib/privacy.ts` (pure copy + decision helper) and `src/lib/privacy-store.ts` (storage wrapper). Single source of truth for notice copy across the widget and the exporter. Tightened `takeScreenshot()` to refuse capture when the recorded tab is not the currently-active tab (new pure `canCaptureRecordedTab()` gate), so mid-session tab switches cannot leak content from an unrelated tab into the export. |
| 0.3.0   | Consolidated UI into widget overlay, debounced input recording, security hardening, new icon |
| 0.2.0   | Initial release as DeskCheck (renamed from Examiner) |
