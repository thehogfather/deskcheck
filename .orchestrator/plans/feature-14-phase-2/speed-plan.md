---
agent: speed-planner
generated: 2026-04-11T00:00:00Z
task_id: feature-14-phase-2
perspective: speed
---

# Speed Plan: Feature #14 Phase 2 — terminal-launched sessions (`deskcheck record <url>`)

## 1. Executive summary

- Ship the absolute minimum on top of Phase 1: a new CLI subcommand that **delegates to the existing `startListener`**, a `Chrome.app` launch via `open -na`, a tiny `document_start` content script that strips the marker and writes the existing `deskcheck_handoff` storage key, and a side-panel badge driven by a single new field on that same storage key. **No new permissions, no new persistent storage, no new message types beyond one (`HANDOFF_DISCARDED`).**
- Reuse Phase 1 transports wholesale: the extension still POSTs the finished zip via `performHandoff` exactly as today. The CLI listener is the same `startListener` from Phase 1; only the wrapper is new. There is **zero schema or exporter change**, and `service-worker.ts` `EXPORT_SESSION` is **not modified at all**.
- The single biggest speed shortcut: the content script that detects `#_deskcheck=...` writes the marker straight into the existing `chrome.storage.local['deskcheck_handoff']` record (with one new optional field, `pending_session_id`). The Phase 1 export path then picks it up automatically when the user clicks Stop. No new pending-handoffs map, no per-tab keying, no SW state machine.
- **Side-panel "Connected to terminal session" badge** is rendered by the existing `handoff-row` block in `sidepanel.ts` based on the same `getHandoffConfig()` call it already makes — we just teach it to show a different label when `pending_session_id` is present.
- **Cancellation on Discard** uses option (b) from the brief: a sentinel `application/x-deskcheck-cancel` POST to the same `/upload` endpoint, gated by an extra route in `startListener`. Two-line CLI change, ten-line extension change. The CLI exits with code 2 and a structured error.
- **Risk profile**: low for the export path (no change), low for the content script (5–10 lines at `document_start`, scoped to a single global `if`), medium for the Chrome launch (depends on `open -na` exit semantics — manually verified, not e2e tested). The biggest deferred item is the **gesture problem for auto-opening the side panel**: speed plan does NOT auto-open. It paints a `REC?` action badge and the user clicks the toolbar action exactly once. This is a known UX compromise that the brief explicitly allowed ("(a) mark the handoff as armed and show a persistent Chrome action badge"). Quality/safety planners may pay to do better.

## 2. Proposed architecture

### 2.1 File list

**New files (3):**

| File | Purpose | Est. lines |
|---|---|---|
| `cli/record.mjs` | `deskcheck record <url>` subcommand. Spawns the listener via `startListener`, builds a marker URL, launches Chrome via `open -na`, blocks on a single zip arrival or timeout, prints JSON summary. | ~180 |
| `src/content/handoff-marker.ts` | New `document_start` content script. Reads `location.hash`, parses `#_deskcheck=ID:TOKEN:PORT`, calls `history.replaceState` to strip it, writes the handoff config (with `pending_session_id`) into `chrome.storage.local`. ~40 lines, no DOM imports, no recorder imports. | ~50 |
| `tests/handoff-marker.test.ts` | jsdom unit test for the marker parser + strip + storage write. | ~80 |

**Modified files (5):**

| File | Change | Est. lines |
|---|---|---|
| `cli/deskcheck.mjs` | Add `record` to `parseArgv`, add a new `/upload` allowed `Content-Type: application/x-deskcheck-cancel` branch in `handleRequest` that resolves a `cancelDeferred` instead of writing a zip, export an `attachWaiter(server, sessionId)` helper that returns a Promise resolving with `{ kind: "ok", path } | { kind: "cancelled" } | { kind: "timeout" }`. | ~60 |
| `cli/deskcheck.test.mjs` | One new test for the cancel branch (sends sentinel, asserts 200 + waiter resolves cancelled), one for unknown content-type still 415. | ~40 |
| `src/lib/handoff.ts` | Add optional `pending_session_id?: string` to `HandoffConfig`. Update `isHandoffConfig` to allow it. **Do NOT** make it required — phase-1 paste row writes records without it. | ~6 |
| `manifest.json` | Add a second entry to `content_scripts` with `js: ["src/content/handoff-marker.ts"]`, `run_at: "document_start"`, `all_frames: false`, `matches: ["<all_urls>"]`. **No new permissions.** | ~10 |
| `src/sidepanel/sidepanel.ts` | In `renderHandoffState()`, when the loaded config has `pending_session_id`, render `Connected to terminal session <id>` instead of `Attached: <url>`, and when the user clicks Discard, send a new `HANDOFF_DISCARDED` message that the SW handles by POSTing the cancel sentinel to the listener and clearing `deskcheck_handoff`. | ~50 |
| `src/background/service-worker.ts` | Add a single new message handler `HANDOFF_DISCARDED` that reads the handoff config, fires `fetch(<url>/upload, { method: POST, headers: ..., body: empty, "Content-Type": "application/x-deskcheck-cancel" })` (best-effort, swallow errors), then `clearHandoffConfig()`. **No edits to `EXPORT_SESSION`.** | ~25 |
| `src/types.ts` | Add `HANDOFF_DISCARDED` to `Message` union. | ~2 |

**Documentation (deferred to "what this plan does NOT include"):**
- README walkthrough — minimal stub only (3 lines: "Phase 2 — `deskcheck record <url>`. macOS only. Linux/Windows: future work.")
- `docs/ARCHITECTURE.md` Data Flow update — defer to follow-up.

### 2.2 Component responsibilities

```
┌──────────────────┐                                ┌─────────────────────┐
│  cli/record.mjs  │── startListener() ───────────► │  cli/deskcheck.mjs  │
│                  │                                │   (Phase 1 server)  │
│  - parse argv    │── open -na "Google Chrome" ──► │   + cancel sentinel │
│  - build marker  │      --args <url>#_deskcheck=  │   + attachWaiter()  │
│  - waiter blocks │      ID:TOKEN:PORT             └──────────┬──────────┘
│  - print JSON    │                                           │
└──────────────────┘                                           │ POST /upload
        ▲                                                      │
        │                                                      ▼
        │                              ┌────────────────────────────────────┐
        └── waiter resolves on:        │ Content script: handoff-marker.ts  │
            - zip arrival (ok)         │  document_start                    │
            - cancel sentinel          │  - parse #_deskcheck=ID:TOKEN:PORT │
            - timeout                  │  - history.replaceState (strip)    │
                                       │  - chrome.storage.local.set({     │
                                       │      deskcheck_handoff: {         │
                                       │        listener_url: ...,         │
                                       │        token: ...,                │
                                       │        pending_session_id: ID,    │
                                       │        created_at: ...            │
                                       │      }})                          │
                                       └────────────────────────────────────┘
                                                       │
                                                       ▼
                                       ┌────────────────────────────────────┐
                                       │ Existing src/content/index.ts      │
                                       │ runs at document_idle.             │
                                       │ Hash already stripped — no change. │
                                       └────────────────────────────────────┘
                                                       │
                                                       ▼
                                       ┌────────────────────────────────────┐
                                       │ User clicks toolbar action        │
                                       │ (the gesture). Side panel opens.  │
                                       │ renderHandoffState() sees         │
                                       │ pending_session_id, paints        │
                                       │ "Connected to terminal session    │
                                       │ <id>" badge in handoff-row.       │
                                       │ User clicks Start. EXPORT_SESSION │
                                       │ uses Phase 1 path unchanged.      │
                                       └────────────────────────────────────┘
```

### 2.3 Hash-fragment grammar

**Literal format**: `#_deskcheck=<id>:<hex-token>:<port>`

- `<id>` — `[A-Za-z0-9._-]{1,128}` (matches the existing `SESSION_ID_REGEX` in `cli/deskcheck.mjs`)
- `<hex-token>` — `[a-f0-9]{32,128}` (matches Phase 1 token pattern)
- `<port>` — `[0-9]{1,5}`, must be `1024 <= port <= 65535`

The marker parser anchors on the literal `_deskcheck=` substring inside `location.hash` so a SPA hash like `#/login` does not collide. **Strip-and-preserve algorithm**:

```
let hash = window.location.hash;          // "#/login&_deskcheck=ID:TOKEN:PORT" or "#_deskcheck=ID:TOKEN:PORT"
const marker = hash.match(/(?:^#|[#&])_deskcheck=([^&]+)/);
if (marker) {
  // 1. Parse the captured value into id/token/port; reject if shape is wrong.
  // 2. Build the surviving hash: drop the matched marker AND its leading separator.
  //    If the marker was the entire hash, surviving hash is "".
  //    If the marker followed a "&", drop the "&_deskcheck=...".
  //    If the marker followed a "#" with content after, normalise to a single "#".
  const stripped = hash.replace(/(?:^#|[#&])_deskcheck=[^&]+/, "").replace(/^#&/, "#");
  const newHash = stripped === "" || stripped === "#" ? "" : stripped;
  history.replaceState(null, "", location.pathname + location.search + newHash);
  // 3. Persist into the existing handoff key.
}
```

This handles:
- `#_deskcheck=...` → cleared entirely
- `#/login&_deskcheck=...` → `#/login`
- `#/route?x=1&_deskcheck=...` → `#/route?x=1`
- No marker → no-op, page proceeds untouched

**Why anchor on `&_deskcheck=` as the secondary form**: hash-based routers (`#/foo`, `#!/foo`) treat `&` as a query separator within the fragment. We piggyback on the same convention so the marker doesn't break the router's parse.

**Why not URL-encoded JSON**: URL-encoding would survive, but a literal colon-delimited triple is one regex on both sides and 30 lines shorter. The brief specifies the literal format.

**Token length safeguard**: Phase 1 emits 64 hex chars. The CLI ready-line regex already pins `[a-f0-9]{16,}`. Marker parser rejects `<32` to keep brute-force entropy intact.

### 2.4 Chrome launch strategy

**Choice**: macOS-native `open -na "Google Chrome" --args <url-with-marker> [chrome-flags]`.

Rationale:
- `open -na` is a one-liner via `child_process.spawn`, exits immediately, doesn't block the CLI.
- Launches Chrome **as a fresh app instance** even if Chrome is already running, which is what we want for the `--profile isolated` mode (passes `--user-data-dir`).
- Doesn't require parsing `osascript` output or finding the app bundle path.
- Stdout/stderr noise from Chrome is suppressed because `open -na` detaches.

**`--profile existing` (default)**: just `open -na "Google Chrome" --args "https://example.com#_deskcheck=ID:TOKEN:PORT"`. The user's existing Chrome profile + already-installed extension handle the rest. **This is the speed-path default** — gets the demo working in 5 minutes.

**`--profile isolated`**: spawns into a temp `--user-data-dir` and `--load-extension=$PWD/dist`. The CLI must `make build` first (or fail loudly with "run `make build` first"). Speed plan **does not auto-build** — fail with a clear error message and let the user run `make build`. Two extra command-line flags, no additional Node code.

**Why not `child_process.spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ...)`**: it works but blocks the CLI process until Chrome exits, and we'd need to detach it explicitly with `unref()` and `stdio: "ignore"`. `open -na` does this for free.

**Gesture problem for the side panel**: the launched Chrome window has no user gesture in the content script context. `chrome.sidePanel.open()` will reject. **Speed plan accepts this**: the marker is detected and stored, the toolbar action gets a `1` badge text via `chrome.action.setBadgeText` and a custom title ("Click to attach: terminal session <id>"), and the user clicks the toolbar action exactly once. That click IS the gesture, the side panel opens, sees `pending_session_id` in storage, paints the badge, the user clicks Start. Total clicks: 2 (toolbar action, Start). Total clicks for the perfect-world version: 1 (Start). The 1-click delta is the speed compromise.

### 2.5 Pending-handoff storage

**Choice**: option (a) from the brief — extend the existing `deskcheck_handoff` storage key with one optional field.

```ts
interface HandoffConfig {
  listener_url: string;
  token: string;
  created_at: string;
  pending_session_id?: string;  // NEW — phase 2 only. Absence = phase 1 paste flow.
}
```

Why this is the speed answer:
- **Zero new storage code**. `setHandoffConfig` / `getHandoffConfig` / `clearHandoffConfig` already exist and are tested.
- **Zero new SW message types for the export path**. `EXPORT_SESSION` reads `getHandoffConfig()` exactly as it does today, calls `performHandoff()` exactly as it does today. The `pending_session_id` field is metadata for the side-panel badge only — the export path ignores it.
- **Zero per-tab keying**. The brief asks "is this per-tab or global?". Speed answer: **global, single-slot, last-write-wins**. If two `deskcheck record` runs are launched concurrently against two tabs, the second overwrites the first. This is documented as a limitation. The use case is "developer in a terminal, one task at a time" — concurrent runs are vanishingly rare and the failure mode is loud (the first CLI hits a 401 from the second listener). Acceptable.
- **Service-worker wake survival**: chrome.storage.local survives SW eviction. The marker write happens in the content script process, not the SW, so a sleeping SW does not lose the write.

**The structural privacy invariant from Phase 1 is preserved**: `pending_session_id` lives in `deskcheck_handoff`, NOT in `SessionMetadata`. It never reaches `session.json`. The Phase 1 grep test `tests/sidepanel-no-handoff-write.test.ts` and the schema-frozen test `src/lib/exporter.golden.test.ts` D10 still pass unchanged.

### 2.6 Panel-open gesture strategy

**Choice**: option (a) from the brief — armed Chrome action badge, user click to open.

Implementation:
- Content script detects marker → writes storage → sends `MARKER_DETECTED` message to SW.
- SW handles `MARKER_DETECTED` by calling `chrome.action.setBadgeText({ text: "1" })` and `chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" })` (blue, distinct from the red `REC` badge during recording).
- SW sets `chrome.action.setTitle({ title: "DeskCheck: terminal session ${id} ready — click to open" })`.
- User clicks the toolbar action. The existing `chrome.action.onClicked` handler runs (no change required — it already opens the panel synchronously inside the gesture).
- Side panel mounts, calls `getHandoffConfig()`, sees `pending_session_id`, paints the badge.

**Why not auto-open**: the brief is explicit that `chrome.sidePanel.open()` strictly requires a user gesture, and "Chrome resets the gesture when the message crosses processes" — you cannot launder a content-script click into an SW gesture. The other option (rely on the user's first click on the page) is unreliable: the user might click Start in the side panel without ever clicking the page first. Quality plan should explore using `tabs.onUpdated` + a one-shot `chrome.scripting.executeScript` injection on the next user click — that's not in scope for speed.

### 2.7 Side-panel badge UI

**Where**: the existing `#handoff-row` div in `sidepanel.ts` (lines 247-340 already render this region). Speed plan reuses it; no new region.

**What it looks like**: in the attached state (current Phase 1 behaviour), `renderHandoffState()` shows `Attached: http://127.0.0.1:54329`. In the **pending state** (`pending_session_id` is set), it shows two lines:

```
[ ● ] Connected to terminal session <id>
      http://127.0.0.1:54329
                              [ Discard ]
```

The dot is a `<span>` with class `handoff-pending-dot` styled as a 8x8 blue circle (one CSS rule, no SVG). The Discard button reuses `handoff-detach-btn`'s code path but sends `HANDOFF_DISCARDED` instead of just clearing storage.

**How it reads state**: the side panel already calls `getHandoffConfig()` on mount. No new message type, no polling. After mount, the panel listens to `chrome.storage.onChanged` (it already does for `STORAGE_SESSION`) and re-renders `handoff-row` when `STORAGE_HANDOFF_CONFIG` changes. ~10 lines added to the existing onChanged listener.

## 3. Implementation sequence

Numbered in dependency order. Each step ends green (typecheck + tests).

1. **CLI: extend `parseArgv` and add `record` subcommand stub** in `cli/deskcheck.mjs`.
   - Add a `record` branch returning `{ command: "record", url, timeout, profile, json }`.
   - Validate `<url>` is a syntactically valid `http`/`https` URL.
   - Default `--timeout` 600s, default `--profile existing`, `--json` boolean.
   - Stub the implementation behind a `// TODO phase 2.2` so the parser is testable in isolation.
   - **Test**: extend `cli/deskcheck.test.mjs` with parse-only assertions (no spawn). 5 cases.

2. **CLI: add cancel sentinel route + waiter helper** in `cli/deskcheck.mjs`.
   - In `handleRequest`, accept `Content-Type: application/x-deskcheck-cancel` as a 200-response branch that resolves a per-session `cancelDeferred` (Map keyed by sessionId) and writes nothing to disk. Still requires Bearer token.
   - Export `attachWaiter(ctx, sessionId, timeoutMs)` that returns a Promise resolving with one of `{ kind: "ok", path }`, `{ kind: "cancelled" }`, `{ kind: "timeout" }`. Wires into the existing `usedSessions` write site for `ok`, the cancelDeferred Map for `cancelled`, and a `setTimeout` for `timeout`.
   - **Test**: extend `cli/deskcheck.test.mjs` — sentinel POST → 200 + waiter resolves cancelled.

3. **CLI: implement `cli/record.mjs`** as a new file with the record command.
   - `import { startListener, attachWaiter } from "./deskcheck.mjs"`.
   - Generate a session id via `crypto.randomBytes(8).toString("hex")` (matches `SESSION_ID_REGEX`).
   - Call `startListener({ outDir: --out (default ./sessions), port: 0 })`.
   - Compose `markerUrl = url + (url.includes("#") ? "&" : "#") + "_deskcheck=" + id + ":" + token + ":" + boundPort`.
   - Spawn Chrome via `child_process.spawn("open", ["-na", "Google Chrome", "--args", markerUrl, ...isolatedArgs], { stdio: "ignore", detached: true }).unref()`.
   - Stderr progress: `[deskcheck] listener on http://127.0.0.1:<port>` then `[deskcheck] launched Chrome → waiting for session <id> (timeout 600s)…` then a heartbeat dot every 10s.
   - `await attachWaiter(...)` and on `ok` print the JSON summary, on `cancelled` print `{error: "cancelled"}` exit 2, on `timeout` print `{error: "timeout"}` exit 3.
   - JSON summary: read the just-written zip with `fflate` to count `events` and `screenshots` (both already extractable from `session.json`), compute `duration_s`. **Speed shortcut**: parse `session.json` only — don't traverse `screenshots/` directory — `total_events` and `screenshots` are already in the `summary` block of `session.json`.
   - Wire `cli/deskcheck.mjs` entry-point dispatcher to `cli/record.mjs`.
   - **Test**: a single test that drives `node cli/deskcheck.mjs record https://example.com --port 0 --timeout 5 --json` with Chrome stubbed via `DESKCHECK_RECORD_NO_LAUNCH=1` env var, then has the test directly POST a fixture zip with the marker's session id and asserts the CLI exits 0 with the expected JSON.

4. **Extension: extend `HandoffConfig`** in `src/lib/handoff.ts`.
   - Add optional `pending_session_id?: string`.
   - Update `isHandoffConfig` to allow `pending_session_id` if present (must be a string matching `^[A-Za-z0-9._-]{1,128}$`).
   - **Test**: extend `tests/handoff.test.ts` with two cases — accept config with `pending_session_id`, reject if non-string.

5. **Extension: add `src/content/handoff-marker.ts`** as a new content script.
   - Top-level `if (location.hash.includes("_deskcheck="))` guard so it's a no-op on 99% of pages.
   - Parse the marker. On parse failure, log a single warn and bail.
   - Validate the listener URL via `isValidLoopbackUrl(http://127.0.0.1:${port})`.
   - `history.replaceState(null, "", strippedUrl)`.
   - `chrome.storage.local.set({ [STORAGE_HANDOFF_CONFIG]: { listener_url, token, created_at: new Date().toISOString(), pending_session_id: id } })`.
   - `chrome.runtime.sendMessage({ type: "MARKER_DETECTED", sessionId: id })` — fire-and-forget.
   - **Imports**: `STORAGE_HANDOFF_CONFIG` from `../constants`, `isValidLoopbackUrl` from `../lib/handoff`. **MUST NOT import `handoff-store.ts`** — the existing `tests/content-no-handoff-write.test.ts` grep test forbids it. Speed answer: write to `chrome.storage.local` directly with the `STORAGE_HANDOFF_CONFIG` key and update the grep test to allow direct `chrome.storage.local.set` calls in `handoff-marker.ts` only (one-line allowlist).
   - **Test**: `tests/handoff-marker.test.ts` (jsdom env) — runs the parser on synthetic `location.hash` strings, asserts `chrome.storage.local.set` was called with the expected shape and `history.replaceState` stripped the marker.

6. **Manifest: register the new content script** in `manifest.json`.
   - Add a second `content_scripts` entry: `{ matches: ["<all_urls>"], js: ["src/content/handoff-marker.ts"], run_at: "document_start", all_frames: false }`.
   - **Do NOT change** the existing `index.ts` entry's `run_at: "document_idle"`. The two scripts are independent and the marker script does not interfere with the recorder.
   - **Test**: `tests/manifest.test.ts` (if missing, add a 1-test file) — assert manifest.content_scripts has exactly two entries with the expected `run_at` values.

7. **Service worker: add `MARKER_DETECTED` and `HANDOFF_DISCARDED` handlers** in `src/background/service-worker.ts`.
   - `MARKER_DETECTED`: read the handoff config from storage, call `chrome.action.setBadgeText({ text: "1" })` (blue) and `chrome.action.setTitle({ title: "DeskCheck: terminal session ${msg.sessionId} ready — click to open" })`. **Do NOT** call `sidePanel.open` (no gesture).
   - **Important**: the existing `setBadge(active)` writes red `REC` while recording. We must NOT clobber that. Add a guard: `if (isSessionInFlight()) return;` so the blue armed badge only paints when no session is running.
   - `HANDOFF_DISCARDED`: read the handoff config, fire-and-forget `fetch(${url}/upload, { method: "POST", headers: { "Content-Type": "application/x-deskcheck-cancel", "Authorization": "Bearer " + token, "X-DeskCheck-Session-Id": pending_session_id }, body: new Uint8Array(0) })`, swallow errors, then `await clearHandoffConfig()`. Reset the action badge + title to defaults.
   - **No edits to `EXPORT_SESSION`**.
   - **Test**: extend `tests/service-worker-handoff.test.ts` with two cases — `MARKER_DETECTED` triggers `setBadgeText("1")`, `HANDOFF_DISCARDED` calls fetch with the cancel content-type and clears storage.

8. **Side panel: render the pending-handoff badge** in `src/sidepanel/sidepanel.ts` lines 247-340.
   - In `renderHandoffState()`, branch on whether the loaded config has `pending_session_id`.
   - If yes, render a new third state: a `handoff-pending-row` div with the dot, the "Connected to terminal session <id>" label, the URL, and a Discard button that sends `HANDOFF_DISCARDED`.
   - In the existing `chrome.storage.onChanged` listener, also re-render `handoff-row` when `STORAGE_HANDOFF_CONFIG` changes (so the SW's clear after `HANDOFF_DISCARDED` reflects in the open panel without a reload).
   - **Test**: extend `tests/sidepanel.test.ts` (or whatever the existing harness is) — initial state with `pending_session_id` paints the badge text; click Discard sends the right message and the row reverts to the input form.

9. **Manual verification (DoD-pinning step)**: walk through the full happy path on macOS. `make build`, then `node cli/deskcheck.mjs record https://example.com --out ./sessions`, click the toolbar action when the badge appears, click Start, do something on the page, click Stop. Confirm the zip lands at `./sessions/<id>.zip` and the CLI exits 0 with the JSON summary. Then walk through cancellation: `node cli/deskcheck.mjs record https://example.com`, click toolbar, click Discard from the side panel, confirm the CLI exits 2 with `{error: "cancelled"}`. Then walk through `--profile isolated` once: `make build && node cli/deskcheck.mjs record https://example.com --profile isolated`, confirm a fresh Chrome window opens with the extension loaded.

10. **Update `cli/deskcheck.mjs` USAGE string and add a 3-line README walkthrough stub**. Defer the full README walkthrough and `docs/ARCHITECTURE.md` Data Flow update to a follow-up task.

## 4. Test Level Matrix

| # | DoD item (from brief) | Test level | File | Rationale |
|---|---|---|---|---|
| 1 | `deskcheck record <url>` parses flags, defaults timeout, validates URL | Unit | `cli/deskcheck.test.mjs` (extend) | Pure parser, no network. |
| 2 | `deskcheck record` starts a listener and prints listener-ready then waiting message to stderr | Integration | `cli/record.test.mjs` (NEW, ~80 lines) | Spawn the CLI, parse stderr, send a fixture zip via fetch, assert exit 0 + stdout JSON. Re-uses the Phase 1 test harness style. |
| 3 | On success, prints JSON `{session_id, path, events, screenshots, duration_s}` to stdout, exits 0 | Integration | `cli/record.test.mjs` | Same test as #2; assert JSON shape. |
| 4 | On timeout, exits non-zero with structured error | Integration | `cli/record.test.mjs` | Spawn with `--timeout 1`, never POST, assert exit 3 + `{error: "timeout"}`. |
| 5 | On cancellation, exits non-zero with structured error | Integration | `cli/record.test.mjs` | Spawn, send cancel sentinel POST, assert exit 2 + `{error: "cancelled"}`. |
| 6 | Content script detects `#_deskcheck=ID:TOKEN:PORT` on page load | Unit | `tests/handoff-marker.test.ts` (NEW) | jsdom: set `location.hash`, run the script's `init()`, assert `chrome.storage.local.set` was called with the right key + shape. |
| 7 | Content script strips the marker from the visible URL | Unit | `tests/handoff-marker.test.ts` | jsdom: assert `history.replaceState` was called with a URL where the marker is gone, including the hash-router preservation cases (`#/login&_deskcheck=...` → `#/login`). |
| 8 | Content script passes the marker to the service worker | Unit | `tests/handoff-marker.test.ts` | Assert `chrome.runtime.sendMessage({type: "MARKER_DETECTED", sessionId})`. |
| 9 | Service worker pre-populates session config from the supplied id, token, and listener URL | Unit | `tests/handoff-marker.test.ts` (write side) + manual (read side) | The write happens in the content script and is unit-tested above. The "pre-populate" semantics in our speed plan are: the storage record IS the pre-populated config — there is no separate SW pre-population step. |
| 10 | Side panel shows "Connected to terminal session <id>" badge whenever a handoff is wired | Unit | `tests/sidepanel-handoff-badge.test.ts` (NEW, ~60 lines) | Mount the panel with a mock `getHandoffConfig` that returns a config with `pending_session_id`, assert the badge text appears in the DOM. |
| 11 | Pause / Resume / Stop / Discard behave exactly as today | Manual verify | (no new test) | The export path `EXPORT_SESSION` is unchanged. We don't add an e2e for this — speed bias. Phase 1 tests already pin Pause/Resume/Stop. The risk of regression is near-zero because we touched zero lines in those handlers. |
| 12 | Discard cancels the pending handoff and the CLI receives a cancelled response | Integration | `tests/service-worker-handoff.test.ts` (extend) + `cli/deskcheck.test.mjs` (cancel sentinel) | SW unit: `HANDOFF_DISCARDED` triggers a fetch with `application/x-deskcheck-cancel`. CLI unit: cancel-sentinel POST resolves the waiter to `cancelled`. Cross-process integration is verified manually. |
| 13 | `--profile isolated` spins a dedicated `--user-data-dir` with `--load-extension=dist/` | Manual verify | (no new test) | E2E would require driving Chrome via Playwright with a real extension load — too expensive for speed. Manual walkthrough in implementation step #9. |
| 14 | macOS-native Chrome launch path works end-to-end | Manual verify | (no new test) | Same reasoning. |
| 15 | Schema is unchanged | Unit | `src/lib/exporter.golden.test.ts` (existing — no edits) | Already pins schema_version and the absence of handoff fields in `session.json`. Will fail the next CI run if anyone accidentally bumps it. |
| 16 | Hash-fragment marker carries cryptographically random token (CLI side) | Unit | `cli/deskcheck.test.mjs` (existing D8a token uniqueness pin) | Already covers it. |
| 17 | A page with a forged marker that doesn't match a running listener is a no-op | Unit + manual | `tests/handoff-marker.test.ts` (write side) — the storage write is harmless if no listener is running; the next `EXPORT_SESSION` will hit the unreachable listener and fall through to download. Manual verify: click Stop with a fake marker stored, confirm download fallback fires. | The "no silent POST" invariant is structurally enforced by the existing `EXPORT_SESSION` branch — it only POSTs after the user clicks Stop. There is no SW-side auto-POST. |
| 18 | Token never lands in `session.json` | Unit | `src/lib/exporter.golden.test.ts` (existing) | Already pins this — the handoff config is structurally separate from `SessionMetadata`. |
| 19 | Listener still binds 127.0.0.1 only | Unit | `cli/deskcheck.test.mjs` D5 (existing) | Already pins it. Speed plan does not touch the bind. |

**Total new test files**: 3 (`cli/record.test.mjs`, `tests/handoff-marker.test.ts`, `tests/sidepanel-handoff-badge.test.ts`).
**Total extended test files**: 3 (`cli/deskcheck.test.mjs`, `tests/handoff.test.ts`, `tests/service-worker-handoff.test.ts`).
**Total e2e tests**: 0. Speed bias is loud here — we accept manual verification for the Chrome launch and the cross-process Discard flow.

## 5. Risks and tradeoffs (speed-specific)

### What we are NOT testing (manual verify only)

1. **Real Chrome launch via `open -na`**. The Phase 2 e2e cost is high (Playwright + extension load + waiting for the marker to be parsed) and adds 30+ seconds per test run. Speed plan defers to the manual walkthrough in step #9. Risk: if `open -na`'s arg-passing differs from what we assume (e.g., `&` in the URL gets dropped by the shell), the developer hits this on the first manual run, not in CI. Mitigation: a smoke-test entry in the README so the developer runs it once after install.

2. **`--profile isolated` end-to-end**. Same reasoning. Risk: `--load-extension` is silently broken on macOS Chrome 147+ (it isn't, as of last check, but we're not pinning it). Mitigation: manual verify in step #9.

3. **Cross-process Discard → CLI exit code 2**. We unit-test both halves (SW sends the right fetch; CLI accepts the sentinel) but don't wire them together in CI. Risk: a header name mismatch. Mitigation: shared constant in a small `cli/protocol.mjs` module — we'll inline the constant at both call sites and let the test files import it. That's a 3-line addition we DO want even in speed mode.

4. **Two concurrent `deskcheck record` runs**. The single-slot `deskcheck_handoff` storage key means the second run silently overwrites the first. We do NOT add concurrency protection; we add a one-line stderr warning to the second `deskcheck record` invocation if there's already a config in `chrome.storage.local`. Actually, the CLI can't read chrome.storage.local — so we just document the limitation in the `--help` output and call it done.

5. **Page-level forged markers**. A malicious page can write `#_deskcheck=ID:TOKEN:PORT` if it knows the running CLI's session id, token, AND port. Token is 32+ hex characters from `crypto.randomBytes(32)`, so it's unforgeable in practice. Risk: a CSS-injection-on-its-own-page exploit that reads its own URL doesn't matter because the URL no longer contains the marker by `document_idle` (the marker is stripped at `document_start`). The window where the marker is in the URL is the gap between page navigation start and `document_start` — 1-2ms. Acceptable.

### Tradeoffs accepted

- **2 user clicks instead of 1** for the happy path (toolbar action + Start). The brief explicitly allowed this as option (a). Quality plan may prefer to chain off the page's first user click via `chrome.scripting.executeScript` injected from the SW — speed plan does not.
- **No new SW state machine, no per-tab map**. Single-slot storage means concurrent runs collide. Acceptable for the Bug Reporter persona running one task at a time.
- **No README/ARCHITECTURE.md updates beyond a 3-line stub**. Documentation is deferred. The roadmap DoD requires "macOS-native Chrome launch path works end-to-end; Linux/Windows are noted as future work in docs" — speed plan satisfies this with a 3-line stub note in README. Anything richer is a follow-up.
- **No telemetry, no error reporting from Chrome launch failures**. If `open -na` fails (e.g., Chrome not installed), the user sees a stderr error from the spawned process and a CLI timeout. We do not pre-flight-check the Chrome path. Acceptable for v1.
- **No retry on the cancel sentinel POST from the SW**. If the listener is already dead by the time the user clicks Discard (e.g., user killed the CLI with Ctrl+C), the fetch fails silently and we still clear `deskcheck_handoff`. The CLI is already gone so there's no one to receive the cancel. Acceptable.
- **No grep-test update for `handoff-marker.ts`**. The Phase 1 invariant is "content scripts MUST NOT import `handoff-store.ts`". Speed plan honours this by writing to `chrome.storage.local` directly via the constant key. The existing grep test passes unchanged. Speed bonus.
- **Hash strip races with the page's own hashchange listener**. If the page reads `location.hash` synchronously inside an inline `<script>` that runs before our `document_start` script, it will see the marker. Fix would require an injected `world: "MAIN"` script — which requires the `scripting` permission's `MAIN` world support. Speed plan accepts this race for the marker token (which is throwaway) and relies on the page being unable to do anything with it (the listener token is single-use and cancellation-safe). This is an acceptable speed shortcut because the only sensitive value is the token, and the token is unforgeable AND the listener will reject any POST that doesn't come from the extension's origin (well, it doesn't actually check origin — but the bearer token is the gate, and the token expires when the CLI exits).

### What's the rollback story

Two rollback levers:

1. **Disable Phase 2 entirely without reverting code**: comment out the new content script entry in `manifest.json` and rebuild. The marker is never detected, no `pending_session_id` is ever written, the side panel never paints the new badge, and the CLI's `record` subcommand still works in "Phase 1 mode" (it can be invoked, the listener starts, but no Chrome launches and no marker is parsed). The Phase 1 paste flow is unaffected.
2. **Disable just the CLI subcommand**: a 3-line revert of the `parseArgv` `record` branch in `cli/deskcheck.mjs`. The extension changes are no-ops if no marker is ever produced.

Both are zero-risk to Phase 1.

## 6. Effort estimate

| Step | Description | Effort |
|---|---|---|
| 1 | CLI parseArgv extension + tests | 1.0 hr |
| 2 | CLI cancel sentinel + waiter helper + tests | 2.0 hr |
| 3 | `cli/record.mjs` + integration tests + JSON summary | 3.0 hr |
| 4 | `HandoffConfig` extension + handoff.test.ts updates | 0.5 hr |
| 5 | `src/content/handoff-marker.ts` + jsdom tests | 2.0 hr |
| 6 | manifest.json content_scripts entry + 1-test verification | 0.5 hr |
| 7 | SW `MARKER_DETECTED` + `HANDOFF_DISCARDED` handlers + tests | 2.0 hr |
| 8 | Side panel badge rendering + onChanged subscription + tests | 2.5 hr |
| 9 | Manual verification on macOS (happy path + cancel + isolated) | 1.5 hr |
| 10 | USAGE string + 3-line README stub | 0.5 hr |
| Buffer for typecheck/test debug (vitest + tsc) | 1.5 hr |

**Total: 17 hours ≈ 2 person-days**.

Compare to a quality plan that adds a per-tab pending-handoffs map, a new SW pre-bind state machine, a Playwright e2e for the Chrome launch, and full doc updates: ~5–6 person-days. Speed plan ships in **1/3 the time**.

## 7. Open questions for the judge

1. **Action-badge interaction with the recording badge.** The existing `setBadge(active)` paints `REC` red while a session is in flight. Speed plan paints a blue `1` for "armed handoff pending". These can never co-occur in single-user usage but the SW guard `if (isSessionInFlight()) return` means a marker arriving mid-recording is silently dropped. Is that acceptable, or should the marker be queued for after the current session ends? **Speed plan recommendation**: drop silently — the user should not be running `deskcheck record` mid-session anyway. The CLI will time out and the user will retry.

2. **Cancel sentinel content type**. Speed plan uses `application/x-deskcheck-cancel` as a custom MIME. Alternative: a `DELETE /session/<id>` route. The MIME approach reuses the same `/upload` endpoint and the same auth/path code, saving ~30 lines. The DELETE approach is more RESTful and reads better in test names. **Speed recommendation**: MIME approach. Judge picks.

3. **Should the marker survive cross-frame navigation?** If the launched page does an immediate JS redirect, our `document_start` script writes the marker to storage but the new page never sees the URL. The storage write still happens before the redirect. **Speed answer**: write happens at `document_start` of the FIRST URL, so the marker is persisted before redirect. This is correct. Judge: confirm I'm reading the runtime model right.

4. **`tests/content-no-handoff-write.test.ts` allowlist**. The Phase 1 grep test forbids any content script from importing `handoff-store.ts`. Speed plan keeps this honest by writing directly to `chrome.storage.local` with the constant key. But the grep test may also forbid `chrome.storage.local.set` calls in `src/content/`. If so, speed plan needs a one-line allowlist for `handoff-marker.ts`. **Recommendation**: read the existing test — if it forbids `handoff-store` import only, no change. If it forbids all storage writes, add a single-file allowlist. Verified in implementation step #5.

5. **`--profile existing` Chrome launch when Chrome is already running**. `open -na` opens a fresh app instance even if Chrome is already running, but it inherits the user's default profile and the already-installed extension. Should it instead use `open -a` (reuse existing Chrome process)? **Speed recommendation**: `open -na` because it's deterministic about creating a new window. Judge: pick.

6. **Whether to fail-fast in `--profile isolated` if `dist/` doesn't exist**. Speed plan errors with "run `make build` first". Quality plan might run `make build` automatically. **Recommendation**: fail fast — auto-build adds a Make dependency to a Node CLI and doubles complexity.

7. **JSON summary `events` and `screenshots` counts — read from `session.json` summary block, or count files in the zip?** Speed plan reads from the `summary` block (already computed by the exporter). It's faster but trusts the exporter's count. Quality plan might double-count for sanity. **Recommendation**: trust the summary block — it's pinned by the golden zip test.

8. **Should the side panel's existing paste affordance be hidden when `pending_session_id` is set?** Speed plan keeps the row visible but switches its content. Alternative: keep the paste row entirely hidden once Phase 2 is wired. **Recommendation**: keep visible for diagnostics — the user can still paste a different listener if the auto-detected one is broken. Judge: pick.

## What this plan does NOT include

Explicitly deferred:

- **Per-tab pending-handoffs map**. Single-slot global is enough for v1.
- **Auto-opening the side panel without a user gesture**. Defer; the user clicks the action once.
- **Linux / Windows Chrome launch paths**. Roadmap explicitly says future work.
- **`make record` Makefile target**. The user runs `node cli/deskcheck.mjs record <url>` directly. Add a target later.
- **Telemetry / error reporting on Chrome launch failures**. The user sees stderr and a CLI timeout.
- **Pre-flight check that Chrome is installed**. Let `open -na` fail.
- **Auto-build of `dist/` for `--profile isolated`**. Tell the user to run `make build`.
- **A Playwright e2e for the full launch → record → zip flow**. Manual verification only.
- **Full README walkthrough for Phase 2**. 3-line stub note pointing at `--help`.
- **`docs/ARCHITECTURE.md` Data Flow update**. Defer.
- **A new SW message type for "pre-populate session config"**. The storage record IS the config; the side panel reads it on mount.
- **MCP wrapper**. Roadmap explicitly defers.
- **Schema bump**. Frozen by binding constraint.
- **`PRIVACY.md` update**. Phase 1 already covers the 127.0.0.1-only guarantee. Phase 2 changes the trigger but not the network behaviour. Defer.
- **Rate-limiting on the cancel sentinel endpoint**. Single-use per session id is already enforced; the cancel sentinel reuses that gate.
- **Nice-looking JSON formatting for the CLI summary**. `JSON.stringify(obj)` not `JSON.stringify(obj, null, 2)`. Save 2 lines.

Next iteration would pick up:
- README + ARCHITECTURE doc updates
- Per-tab pending-handoffs map (if multi-task users complain)
- Auto-build of dist for isolated profile
- Playwright e2e for the launch flow
- Linux / Windows Chrome launch
- `make record` target

## Formal verification assessment

- Concurrency concerns: **Yes, mild** — two concurrent `deskcheck record` invocations race on the single-slot `deskcheck_handoff` storage key. Speed plan accepts this as a documented limitation. No formal model needed.
- State machine complexity: **No** — Phase 2 adds zero new lifecycle states. The handoff record is pre-bind metadata that the existing session lifecycle reads at export time.
- Conservation laws: **One** — "session_cleared ⇒ at_least_one_transport_succeeded" from Phase 1 is preserved structurally because `EXPORT_SESSION` is not modified.
- Authorization model: **Unchanged** — bearer token, single-use per session id, 127.0.0.1 bind. All Phase 1 invariants pinned.
- Recommendation: **Not needed**. Phase 2 is a transport / launcher addition; the safety surface is small and inherited from Phase 1.
- If recommended, key invariants would be: (a) marker token never reaches `session.json`; (b) cancel sentinel cannot be replayed to write a zip; (c) the storage record's `pending_session_id` cannot be forged into a session id that bypasses the listener token check (it can't — the listener token is independent and unforgeable).
