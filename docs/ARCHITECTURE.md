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
- **screenshot.ts** — `chrome.tabs.captureVisibleTab` wrapper, stores data URLs in chrome.storage.local.

### Content Script (`src/content/`)
- **index.ts** — Injection guard, message listener, session state sync with fallbacks (message + storage.onChanged).
- **recorder.ts** — DOM event recording (click, input, scroll, resize, SPA navigation). Input events are debounced (800ms) to capture final values, not keystrokes.
- **widget.ts** — Annotation overlay (closed Shadow DOM). Contains all session controls: annotation textarea, element picker, screenshot, stop & download.
- **element-picker.ts** — Interactive element selector with closed Shadow DOM overlay.

### Popup (`src/popup/`)
Minimal session-start trigger. Shows "Start Session" when idle, "Download Report" if an unexported session exists. Auto-closes on session start.

### Shared Libraries (`src/lib/`)
- **session-store.ts** — chrome.storage.local CRUD for sessions, events, screenshots.
- **exporter.ts** — Builds zip (fflate) from session data. Strips internal fields (tab_id). Skips corrupted screenshots gracefully.
- **debugger-client.ts** — CDP v1.3 client. Subscribes to Network, Log, Runtime domains. Filters extension URLs. Sanitizes sensitive headers (Authorization, Cookie, etc.) before storing.
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

## Export Schema (v1.0.0)

```
deskcheck-session-{timestamp}.zip
├── session.json    # { schema_version, session, timeline[], summary }
└── screenshots/    # PNGs referenced by timeline events
```

## Security

- Sensitive headers (Authorization, Cookie, Set-Cookie, Proxy-Authorization, X-Api-Key) are stripped from network error events before storage
- Widget and element picker use closed Shadow DOM
- Password fields are masked as `[password]`
- No external network requests; all data stays local
- Session data cleared from storage after export
- Single production dependency (fflate)

## Conventions

- Vanilla TypeScript, no framework
- Vitest for testing; pure functions tested without Chrome API mocks
- Semver versioning; manifest.json and package.json versions must match
- `make build` = typecheck + vite build + copy icons

## Changelog

| Version | Changes |
|---------|---------|
| 0.3.0   | Consolidated UI into widget overlay, debounced input recording, security hardening, new icon |
| 0.2.0   | Initial release as DeskCheck (renamed from Examiner) |
