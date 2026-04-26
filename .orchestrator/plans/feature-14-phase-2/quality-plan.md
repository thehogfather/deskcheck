---
agent: quality-planner
generated: 2026-04-11T00:00:00Z
task_id: feature-14-phase-2
perspective: quality
---

# Quality Plan: Feature 14 Phase 2 — Terminal-launched sessions (`deskcheck record <url>`)

## 1. Executive summary

- Ship Phase 2 as a thin layer of **pure modules** on top of the existing Phase 1 machinery: a CLI `record` subcommand that delegates to `startListener` from Phase 1, a small Node-side `chrome-launcher.mjs`, three new pure TS helpers (`handoff-marker.ts`, `pending-handoff-store.ts`, `cli-cancel.ts`), one new content script entry, and exactly **two new switch arms** in `service-worker.ts` (`MARKER_DETECTED`, `OPEN_PANEL_REQUEST`). Total new production code: ~600 LOC. No edits to `handoff.ts`, `handoff-store.ts`, `handoff-post.ts`, `exporter.ts`, or `agents-doc.ts`.
- Use `child_process.spawn` of the Chrome binary directly (resolved via a `findChrome()` helper that probes the macOS canonical path with a `LSRegisterURL`/`mdfind`-free fallback chain) so we can detach, capture stderr, and exit cleanly without waiting on `open(1)`. Reasons in §2.
- Marker grammar: `#_deskcheck=v1.<sessionId>.<token>.<port>` URL-encoded as a single hash segment, **always last**, with a deterministic strip-and-preserve algorithm that handles hash routers. Grammar pinned in a pure module with adversarial unit tests.
- Side panel auto-open is honestly impossible without a user gesture from the **content script** message path (Chrome resets gesture across processes). We do not pretend otherwise: the content script forwards the marker to the SW, the SW arms a **pending handoff** keyed by tab id, and the SW shows a flashing toolbar action badge (`"OPEN"` text on the existing badge surface) plus a Chrome notification with a button. The first toolbar click is the gesture that opens the bound panel; the panel reads the pending handoff at mount and pre-fills the attach row. Documented honestly in the README.
- CLI is blocking, prints periodic stderr keepalive lines, returns one-line JSON on stdout on success, and uses a clean cancellation path (`POST /upload` with `Content-Type: application/x-deskcheck-cancel` + zero-byte body) so the cancel path **reuses every existing security check** in the listener — no new endpoint surface.
- Risk: depends on the user clicking the toolbar action once. We accept this — it is the **only** non-fragile gesture path, and the badge + notification reduce the friction to "look at the badge, click it." Technical-debt cleanup: extract the synchronous gesture-window dance into a named helper `openPanelInGestureWindow(tabId)` so Phase 2 can call it from `chrome.action.onClicked` without re-implementing the IPC ordering invariant.

## 2. Proposed architecture

### 2.1 New files

| File | Purpose | Quality considerations |
|---|---|---|
| `cli/deskcheck-record.mjs` | `deskcheck record <url>` subcommand. Imports `startListener` + `formatReadyLine` from `deskcheck.mjs`. Owns the blocking wait, JSON summary, exit codes, cancellation path. | Single-responsibility module. Zero re-implementation of Phase 1 listener. Tested by spawning the subcommand and POSTing to its embedded listener — same harness style as `cli/deskcheck.test.mjs`. |
| `cli/chrome-launcher.mjs` | Pure(-ish) Node helper: `findChrome()`, `launchChrome({url, profile, extensionDir})`, `quitChromeChild(child)`. macOS-only paths, with a clear `UnsupportedPlatformError` for Linux/Windows. | Isolated from the CLI subcommand so it can be unit-tested by injecting a fake `spawn` and a fake `existsSync`. No `osascript` — see §2.3. |
| `cli/cli-summary.mjs` | Pure builder: `buildJsonSummary({sessionId, zipPath, events, screenshots, durationS})` and `buildErrorSummary({code, message})`. | Pure JSON construction extracted so the CLI test can assert the exact stdout shape without spinning a real listener. |
| `cli/cli-exit-codes.mjs` | Single source of truth for exit codes. | Avoids magic numbers scattered through the CLI. |
| `src/lib/handoff-marker.ts` | **Pure** module. Exports: `MARKER_PREFIX`, `parseMarker(hash) → {sessionId, token, port} \| null`, `stripMarker(originalHref) → {cleanHref, marker} \| null`, `isMarkerWellFormed(value)`. **No chrome imports.** | Marker grammar lives in exactly one place. Adversarial unit tests pin every reject case (path-based attack, oversized, wrong version, non-numeric port, embedded null bytes, etc.). Zero coupling to the content script — the content script imports this helper. |
| `src/lib/pending-handoff-store.ts` | Wrapper over `chrome.storage.local['deskcheck_pending_handoffs']` (a tab-id-keyed map). API: `armPendingHandoff(tabId, config)`, `consumePendingHandoff(tabId) → config\|null`, `clearPendingHandoff(tabId)`, `listPendingHandoffs() → Map<tabId, config>`. Mirrors the style of `handoff-store.ts`. | New key — does NOT reuse `deskcheck_handoff` (different lifetime, different scope, different invalidation rules). Decision rationale in §2.5. |
| `src/background/handoff-pending.ts` | **Pure** orchestration helper. `armFromMarker(marker, tabId, store, clock)` → `PendingHandoffConfig`, `promotePendingToActive(tabId, store)` → moves the per-tab record into the global `deskcheck_handoff` slot, `cancelPending(tabId, store, fetchImpl)` → POSTs the cancel sentinel and clears the pending record. | Single-responsibility orchestration extracted from the SW handler so it can be unit-tested with a fake store. No chrome imports — the SW message handler injects them. |
| `src/content/marker-detector.ts` | Slim content-script entry that runs at `document_start`. Does only three things: (1) calls `stripMarker(location.href)`; (2) if a marker is present, calls `history.replaceState(null, "", cleanHref)` BEFORE the page can read `location.hash`; (3) sends a single `MARKER_DETECTED` message to the SW. **Does not import the recorder, the picker, or anything from `src/lib/` except `handoff-marker.ts`.** | Tiny (~40 LOC). Imports only one pure helper. Cannot accidentally read the token off the URL after the strip. Tested in jsdom. |
| `src/sidepanel/sidepanel-handoff-badge.ts` | Pure view-model: `buildHandoffBadgeModel(pending: PendingHandoffConfig \| null) → BadgeModel`. Returns `{visible, sessionIdShort, tone}`. | Isolated from DOM rendering — same pattern as `sidepanel-controls.ts` / `sidepanel-render.ts`. Tested without jsdom. |
| `tests/handoff-marker.test.ts` | Unit tests for `handoff-marker.ts`. | Covers grammar, strip-and-preserve, adversarial inputs. |
| `tests/pending-handoff-store.test.ts` | Unit tests for the pending-handoff store wrapper. | Mirrors `src/lib/handoff-store.test.ts`. |
| `tests/handoff-pending.test.ts` | Unit tests for the orchestration helper. | Fake store + fake fetch. |
| `tests/marker-detector.test.ts` | jsdom test for the content-script entry. | Stubs `chrome.runtime.sendMessage`. |
| `tests/service-worker-pending-handoff.test.ts` | Service worker integration tests for `MARKER_DETECTED` handler, badge promotion path, and the discard-cancels-pending path. **Matches the harness style of `tests/service-worker-handoff.test.ts`.** | Single source of truth for the SW wiring matrix. |
| `tests/sidepanel-handoff-badge.test.ts` | Unit + jsdom tests for the badge model and its render. | |
| `cli/deskcheck-record.test.mjs` | Acceptance tests for the `record` subcommand. Spawns the subcommand with a fake `chrome-launcher` env override, POSTs a fixture zip, asserts JSON stdout shape, exit code, and cancellation. | Mirrors `cli/deskcheck.test.mjs` style. |
| `cli/chrome-launcher.test.mjs` | Unit tests for `findChrome` and `launchChrome` with a fake `spawn`. | No real Chrome binary required. |

### 2.2 Modified files

| File | Change | Quality considerations |
|---|---|---|
| `cli/deskcheck.mjs` | Add `record` to `parseArgv`, add `formatJsonSummary` re-export, **NO change** to `startListener` or `handleRequest` other than adding the cancel sentinel content-type branch. | Phase 1 invariants (auth, replay, content-length, traversal) all still apply to the cancel path because we route it through the same `handleRequest` chokepoint. |
| `manifest.json` | Add a SECOND `content_scripts` entry for the marker detector at `run_at: "document_start"`. The existing recorder entry stays at `document_idle`. **No new permissions.** | Two-entry approach is cleaner than mutating the existing recorder's `run_at`: (a) the recorder's `init()` must run after DOM is ready in some paths; (b) the marker detector has zero overlap with recorder state and should fail in isolation; (c) keeps the diff to a single `content_scripts[].js` entry. |
| `src/background/service-worker.ts` | Two new `case` arms in `handleMessage` (`MARKER_DETECTED`, `CANCEL_PENDING_HANDOFF`); one new helper `openPanelInGestureWindow(tabId)` that **extracts the existing 4-line dance** from `chrome.action.onClicked` so it is named and reusable; one new badge-update call in `chrome.action.onClicked` (call `consumePendingHandoff` BEFORE the `void enablePanelOnTab` so the gesture window is preserved); one new `discardPendingIfArmed(tabId)` call inside the existing `DISCARD_SESSION` handler. | Net SW addition: ~60 LOC. The existing `chrome.action.onClicked` listener stays SYNC. The pending-handoff lookup is a sync `globalThis.__pending` mirror updated by the asynchronous `armPendingHandoff` write — see §2.5. |
| `src/sidepanel/sidepanel.ts` | Mount the badge into the existing `handoff-row` region (above the paste affordance, same CSS family). Subscribe to a new `PENDING_HANDOFF_CHANGED` runtime broadcast. On mount, call `consumePendingHandoff(activeTabId)` (via `sendMessage({type: "GET_PENDING_HANDOFF"})`) and pre-fill the attach row. | Reuses the existing `handoff-row` CSS / region — no new layout code. No new top-level subscription style — uses the same `chrome.runtime.onMessage` listener that already handles `EVENT_APPENDED`. |
| `src/sidepanel/sidepanel.css` | Add `.handoff-badge`, `.handoff-badge--armed`, `.handoff-badge--connected` rules. ~25 LOC. | Same naming convention as existing BEM-ish classes. |
| `src/types.ts` | Add `MARKER_DETECTED`, `CANCEL_PENDING_HANDOFF`, `GET_PENDING_HANDOFF`, `PENDING_HANDOFF_CHANGED` to the `Message` union. | Discriminated union — no `any`. |
| `src/constants.ts` | Add `STORAGE_PENDING_HANDOFFS = "deskcheck_pending_handoffs"`. | Single source of truth. |
| `Makefile` | Add `record` target: `cd cli && node deskcheck-record.mjs`. | Convention parity with `make demo`. |
| `docs/ARCHITECTURE.md` | New "CLI handoff (feature #14 phase 2)" subsection under the existing Phase 1 section. Adds a sequence diagram (CLI → Chrome → content script → SW → side panel → SW → CLI) and documents the gesture rule honestly. | Architecture doc stays the source of truth. |
| `README.md` | New `deskcheck record` walkthrough alongside the existing `deskcheck listen` walkthrough. Includes the "click the badge to open the panel" step. | |
| `PRIVACY.md` and the first-run notice | One sentence: "DeskCheck may detect a `#_deskcheck=...` marker on a page you load via `deskcheck record`. The marker is stripped from the visible URL before any timeline event is recorded; the token never lands in `session.json`." | Privacy invariant promoted to user-visible copy. |

### 2.3 Chrome launch strategy on macOS

**Choice: `child_process.spawn` directly on the resolved Chrome binary path, with `detached: false` and `stdio: ['ignore', 'pipe', 'pipe']`.**

```js
// pseudo-code from cli/chrome-launcher.mjs
function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new ChromeNotFoundError();
}
```

**Why not `open -na "Google Chrome" --args ...`:**
- `open(1)` exits immediately on success and gives us no child handle, so we cannot wait on Chrome's lifetime, capture its stderr, or know when it exited unexpectedly.
- `open` reuses an already-running Chrome instance with no clean way to wait for the new tab to open. Tabs do open against an existing instance fine, but we lose the ability to know "did Chrome open at all" vs "did the user already kill it".
- For `--profile isolated` we want to control the user-data-dir explicitly and pass `--load-extension=dist/`. `open -na ... --args` does pass through args, but combined with the no-child-handle issue it adds zero value over `spawn`.

**Why not `osascript`:**
- AppleScript is a separate binary contract per macOS version and is fragile against Chrome version updates.
- It requires the Accessibility permission for some flows, which would break clean-machine UX.
- It cannot pass arbitrary command-line flags cleanly.

**Why `spawn` wins:**
- We get a child PID, can capture stderr (for diagnostics on launch failure), can `unref()` so the CLI exits cleanly when the user just wants to close the terminal, and can pass exact flags including `--user-data-dir` and `--load-extension`.
- Unit-testable by injecting a fake `spawn`.
- macOS-only is a feature, not a bug — we throw `ChromeNotFoundError` with a "Linux/Windows are future work" message on any other platform.

The `--profile isolated` path:
```
spawn(chromeBin, [
  url + markerHash,
  `--user-data-dir=${tmpProfileDir}`,
  `--load-extension=${distPath}`,
  "--no-first-run",
  "--no-default-browser-check",
])
```

### 2.4 Hash-fragment marker grammar

**Literal grammar:**

```
marker      = "#_deskcheck=" version "." sessionId "." token "." port
version     = "v1"
sessionId   = 1*128 ( ALPHA / DIGIT / "-" / "_" )    ; matches the existing SESSION_ID_REGEX
token       = 64 HEXDIG                               ; from randomBytes(32).toString("hex")
port        = 1*5 DIGIT                               ; 1..65535
```

The marker is **always last** in the URL hash (or, equivalently, the entire hash if the page has none of its own).

**Strip-and-preserve algorithm (in `stripMarker(href)`):**

1. Parse `href` with the `URL` constructor. Extract `url.hash` (which includes the leading `#`).
2. If `url.hash === ""`, return `null` (no marker).
3. Look for the substring `_deskcheck=v1.` inside `url.hash`. If absent, return `null`.
4. The marker may be the entire hash (`#_deskcheck=v1...`) or appended to a hash router fragment (`#/login&_deskcheck=v1...` or `#/login#_deskcheck=v1...`).
5. Try, in order:
   - **Pattern A — pure marker**: `^#_deskcheck=v1\.([A-Za-z0-9._-]+)\.([a-f0-9]{64})\.(\d{1,5})$`. If matches, set `cleanHash = ""`.
   - **Pattern B — appended via `&`**: `^(#.*)&_deskcheck=v1\.([A-Za-z0-9._-]+)\.([a-f0-9]{64})\.(\d{1,5})$`. If matches, set `cleanHash = group1`.
   - **Pattern C — appended via second `#`**: `^(#.*)#_deskcheck=v1\.([A-Za-z0-9._-]+)\.([a-f0-9]{64})\.(\d{1,5})$`. (URL spec allows only one `#` so this is observed in `location.hash` as a literal `#` inside the hash text.) If matches, set `cleanHash = group1`.
6. Validate the captured `sessionId` against `SESSION_ID_REGEX`, the `token` against `/^[a-f0-9]{64}$/`, the `port` against `1..65535`.
7. If validation fails, return `null` (the marker is malformed — do NOT strip a partial match).
8. Reconstruct the clean href: `url.protocol + "//" + url.host + url.pathname + url.search + cleanHash`.
9. Return `{cleanHref, marker: {sessionId, token, port}}`.

**Why this grammar:**

- Dot separator (`.`) is not in the session-id regex, the hex token alphabet, or the digit port alphabet, so it cannot collide.
- Token is fixed-length 64 hex chars (the existing CLI token is `randomBytes(32).toString("hex")` = 64 chars). Length-validating the token cheaply rejects forged markers.
- Version prefix (`v1`) future-proofs the grammar.
- The "always last" rule plus the strict regex means a hash router fragment like `#/login` is preserved exactly. We do **not** try to URL-encode the marker — encoding adds parser surface for adversarial inputs and the literal grammar is already URL-safe by construction.
- The CLI tells the user this is the marker format in the help output so they can recognise it if it leaks into a screenshot.

**Strip happens at `document_start`** (see §2.6) via `history.replaceState(null, "", cleanHref)`. This fires BEFORE the page's own `popstate`/`hashchange` handlers, BEFORE any `DOMContentLoaded` listener, and BEFORE the recorder's content script runs (`document_idle`) — so the recorder records the clean URL as the initial URL, never the marker.

### 2.5 Pending-handoff storage

**Choice: a NEW `chrome.storage.local['deskcheck_pending_handoffs']` key, holding a tab-id-keyed map. Distinct from the existing `deskcheck_handoff` key.**

```ts
// in pending-handoff-store.ts
export interface PendingHandoffConfig {
  listener_url: string;          // reconstructed from marker.port
  token: string;                  // marker.token
  session_id_hint: string;        // marker.sessionId — passed back to the CLI for matching
  armed_at: string;               // ISO timestamp; used for badge UX + GC of stale records
}

// keyed by tab id (string because chrome.storage keys must be strings; tab ids are integers)
export type PendingHandoffMap = Record<string, PendingHandoffConfig>;
```

**Why a new key, not `deskcheck_handoff`:**

| Concern | `deskcheck_handoff` (existing) | `deskcheck_pending_handoffs` (new) |
|---|---|---|
| Lifetime | Until user clicks Detach | Until user clicks the action and the panel mounts (consumed) OR until tab close OR until 1 hour stale-GC |
| Cardinality | Singleton | One per pending tab |
| Invariant | "Every export to a CLI listener uses THIS config" | "When the user opens the panel on tab X with a pending handoff, pre-fill from this config" |
| Owner | Side panel paste affordance | SW marker handler |
| Visible to user | "Attached: http://..." in panel | "Connected to terminal session abc123" badge |

Mixing the two would break the structural invariant Phase 1 pinned: "manual sessions started from the side panel continue to download as today with no behaviour change." If we wrote the Phase 2 marker into `deskcheck_handoff`, then a user who runs `deskcheck record https://a.com` and then opens an unrelated tab `https://b.com` would have `b.com`'s manual session ship to the listener — a Phase 1 regression.

**Why `chrome.storage.local`, not in-memory in the SW:**

- Service worker eviction is expected. If the user runs `deskcheck record`, the SW arms the pending handoff, then Chrome evicts the SW before the user clicks the action, an in-memory map is lost. Storage survives eviction.
- Chrome auto-cleans nothing here, so we add a stale-GC: on each `armPendingHandoff` we drop entries older than 1 hour.

**Why also a sync mirror in the SW:**

- `chrome.action.onClicked` is SYNC for gesture-window reasons (see Phase 1's documented invariant). We cannot `await chrome.storage.local.get` inside it. We keep a `globalThis.__pendingHandoffs: Map<number, PendingHandoffConfig>` mirror, populated by the `MARKER_DETECTED` handler (which runs async) and rehydrated on SW wake from storage. The action click reads from the sync mirror.

**Tab close cleanup:**

- The existing `chrome.tabs.onRemoved` listener gets one new line: `void clearPendingHandoff(tabId)` and `__pendingHandoffs.delete(tabId)`.

### 2.6 Content script `run_at` strategy

**Choice: a NEW slim content-script entry (`src/content/marker-detector.ts`) at `run_at: "document_start"`, in addition to the existing recorder entry at `document_idle`. Two `content_scripts` entries in `manifest.json`.**

```jsonc
"content_scripts": [
  {
    "matches": ["<all_urls>"],
    "js": ["src/content/marker-detector.ts"],
    "run_at": "document_start"
  },
  {
    "matches": ["<all_urls>"],
    "js": ["src/content/index.ts"],
    "run_at": "document_idle"
  }
]
```

**Why two entries, not one moved entry:**

- The recorder calls `startRecording()` which queries `document.body` and the like. Moving it to `document_start` would force defensive `null`-checks throughout.
- The marker detector needs **only** `location.href`, `history.replaceState`, and `chrome.runtime.sendMessage`. All three are available at `document_start`. It does not need the DOM at all.
- Two entries means the marker detector cannot be broken by a recorder regression and vice versa.
- Build size cost: ~2 KB. Negligible.

**Marker-detector contents (sketch):**

```ts
import { stripMarker } from "../lib/handoff-marker";
import type { Message } from "../types";

const result = stripMarker(location.href);
if (result) {
  // Strip BEFORE the page can read location.hash. history.replaceState
  // is sync, available at document_start, and does not fire popstate.
  history.replaceState(null, "", result.cleanHref);
  // Forward to SW. The SW arms a pending handoff keyed by sender.tab.id.
  chrome.runtime
    .sendMessage({ type: "MARKER_DETECTED", marker: result.marker } satisfies Message)
    .catch(() => {
      // SW may be evicting; non-fatal — the user can still attach manually.
    });
}
```

**The detector does NOT import the recorder, picker, or any non-pure module.** Pinned by a grep test (`tests/marker-detector-imports.test.ts`).

### 2.7 Side panel auto-open gesture strategy

**Honest answer: Chrome resets the user-gesture token when a message crosses from a content script to the service worker. The SW cannot call `chrome.sidePanel.open()` from a `MARKER_DETECTED` handler.** The "fake the gesture" trick from one of the open Chromium issues works on some Chrome versions and not others, and is a **fragility we refuse to inherit** in the quality plan.

**Three-step user flow:**

1. The CLI launches Chrome at the URL with the marker. The tab loads. The marker detector strips it and sends `MARKER_DETECTED`. The SW arms the pending handoff for that tab id (storage + sync mirror) and immediately:
   - Calls `chrome.action.setBadgeText({tabId, text: "OPEN"})` and `setBadgeBackgroundColor({tabId, color: "#2563eb"})`. Per-tab badge, distinct from the recording-active red `"REC"` badge.
   - Calls `chrome.action.setTitle({tabId, text: "DeskCheck — terminal session waiting. Click to open."})`.
   - Optionally fires a `chrome.notifications.create` with a "Click here" button (requires the `notifications` permission — **we choose NOT to add it** in the v1 because the badge plus the CLI's own stderr message ("Waiting for you to click the DeskCheck toolbar action…") is sufficient, and minimising permissions is a Phase 1 invariant we want to keep).
2. The user clicks the toolbar action — that IS a gesture. The existing `chrome.action.onClicked` handler fires sync and:
   - Reads `__pendingHandoffs.get(tab.id)` from the sync mirror.
   - If a pending entry exists for this tab, calls the existing `void enablePanelOnTab(tabId)` + `chrome.sidePanel.open({tabId})` sync dance — exactly the same pattern Phase 1 already pins.
   - In the async IIFE that follows, calls `promotePendingToActive(tabId)` which copies the pending entry into the global `deskcheck_handoff` slot AND broadcasts `PENDING_HANDOFF_CHANGED` to the panel.
   - Clears the badge (`setBadgeText({tabId, text: ""})`).
3. The side panel mounts, observes `PENDING_HANDOFF_CHANGED`, renders the "Connected to terminal session abc123" badge, and the user clicks Start as normal.

**Why this is the right answer:**

- It's the only path that does not rely on Chromium internals we cannot test against.
- It composes with the Phase 1 gesture-window invariant (and lets us extract `openPanelInGestureWindow(tabId)` as a paid-down debt).
- The badge is **highly visible** because it lives on the toolbar action the user is already trained to click.
- The CLI prints exact instructions to stderr so the user is never confused.
- The DoD's literal text says "The service worker opens the side panel bound to that tab" — we open the panel **bound to that tab** on the very next click. The user does have to click. We will document this honestly in the README and in the brief follow-up.

### 2.8 Side panel badge UI

**Visual:** A small text-chip rendered in the existing `handoff-row` region, ABOVE the paste affordance. Two visual states:

| State | Render | CSS class |
|---|---|---|
| Armed (pending, not yet promoted) | `Connected to terminal session abc12345 (waiting for Start)` with a blue dot | `.handoff-badge .handoff-badge--armed` |
| Connected (promoted; the SW will POST on Stop) | `Connected to terminal session abc12345` with a green dot | `.handoff-badge .handoff-badge--connected` |

**How it reads state:**

- On mount, the panel sends `{type: "GET_PENDING_HANDOFF"}` to the SW. The SW returns the pending entry for the current tab (if any) plus a flag indicating whether the global `deskcheck_handoff` is also set (i.e., promoted).
- On every `PENDING_HANDOFF_CHANGED` broadcast, the panel re-renders.
- The badge model is computed by a pure function `buildHandoffBadgeModel(pending, attached)` so it can be unit-tested without DOM.

**Where the session-id-short comes from:** The CLI writes a 64-hex token but the marker also carries `sessionId` (a UUID-ish string from `crypto.randomUUID()` on the CLI side). The badge truncates to 8 chars. The full id is exposed on the badge title attribute for accessibility / debugging.

### 2.9 CLI `record` subcommand ergonomics

```
deskcheck record <url> [--timeout S] [--profile existing|isolated] [--json]
```

**Defaults:**
- `--timeout` default: `600` seconds (10 minutes). Long enough for a real bug repro, short enough that a forgotten terminal does not hang forever.
- `--profile` default: `existing`.
- `--json` default: off (human-readable summary).

**stderr while waiting (non-`--json` mode):**

```
deskcheck: launched Chrome PID 41523 against https://app.example.com/login#…
deskcheck: listener http://127.0.0.1:54329 ready, waiting for session…
deskcheck:   click the DeskCheck toolbar action when the page loads
deskcheck:   then press Start in the side panel and reproduce the bug
deskcheck:   waiting… (12s elapsed, 588s remaining)
deskcheck:   waiting… (24s elapsed, 576s remaining)
```

Keepalive lines every 12 seconds so the user knows the CLI is alive. In `--json` mode, stderr is silent except for fatal errors.

**stdout on success:**

Non-`--json`:
```
deskcheck: session received
  session_id:   abc-1234-uuid
  path:         /Users/me/sessions/abc-1234-uuid.zip
  events:       742
  screenshots:  9
  duration:     143s
```

`--json` (single line, suitable for `jq` piping):
```json
{"session_id":"abc-1234-uuid","path":"/Users/me/sessions/abc-1234-uuid.zip","events":742,"screenshots":9,"duration_s":143}
```

**Exit codes (in `cli/cli-exit-codes.mjs`):**

| Code | Meaning |
|---|---|
| 0 | Session received and written successfully |
| 1 | Generic / unknown error |
| 2 | Argument parse error (matches Phase 1 convention) |
| 3 | Chrome launch failed (binary not found, profile dir not writable, spawn error) |
| 4 | Timeout — listener never received a matching session |
| 5 | Cancelled — user clicked Discard in the side panel |
| 6 | Listener bind failed (port in use, etc.) |

**JSON error shape (with `--json`, written to stdout in addition to non-zero exit):**
```json
{"error":"timeout","message":"no session received within 600s","exit_code":4}
```

**Why these defaults:**
- 10-minute default is the median real bug-repro session length (estimate; revisit after dogfooding).
- Distinct exit codes let a CI caller (or Claude Code) distinguish "bug exists, retry" from "configuration error, do not retry."
- `--json` makes stdout machine-parseable and stderr human-readable, the standard Unix convention.

### 2.10 Discard cancels CLI

**Choice: a sentinel `Content-Type: application/x-deskcheck-cancel` POST to the existing `/upload` endpoint, with a zero-byte body.**

**Why this and not `DELETE /session/<id>`:**

- Zero new endpoint surface in the CLI listener — `handleRequest` already has the auth check, the session-id check, the replay-defence check. A new endpoint means duplicating all of those checks (or extracting them into a helper, which is a bigger refactor than Phase 2 needs).
- `DELETE` would require a CORS preflight on some Chrome versions, which means an `OPTIONS` handler, which means more endpoint surface.
- The sentinel content-type is unambiguous: `application/x-deskcheck-cancel` cannot collide with anything else.
- **Reuses 100% of the Phase 1 security checks**: bearer token auth, session-id regex, replay defence (a cancelled session is "used" and cannot be re-cancelled).

**CLI listener changes (`cli/deskcheck.mjs` `handleRequest`, ~10 LOC):**

```js
// After the auth + session-id checks, BEFORE the content-length / streaming logic:
if (contentType.startsWith("application/x-deskcheck-cancel")) {
  if (ctx.usedSessions.has(sessionId)) {
    res.writeHead(409, ...);
    return;
  }
  ctx.usedSessions.add(sessionId);
  ctx.cancelledSessions.add(sessionId);  // signal to startListener's awaiter
  res.writeHead(200, {"Content-Type": "application/json"});
  res.end(JSON.stringify({cancelled: true, session_id: sessionId}));
  return;
}
```

**`deskcheck record` waits on either** an upload landing in the out dir OR a cancellation matching the session id. Implemented by extending `startListener`'s return handle with an event emitter:

```js
// in startListener
const emitter = new EventEmitter();
// in handleRequest, after a successful upload OR a cancel:
emitter.emit("settled", {kind: "uploaded"|"cancelled", sessionId});
return { server, token, boundPort, outDir, emitter };
```

The `record` subcommand awaits `emitter.once("settled", ...)` with a timeout. If `kind === "cancelled"` it exits 5; if `kind === "uploaded"` it reads the path and exits 0; if the timeout fires it exits 4.

**Service worker side (`DISCARD_SESSION` handler):**

```ts
case "DISCARD_SESSION": {
  // ... existing logic ...
  const handoff = await getHandoffConfig();      // promoted, attached listener
  const pending = await getPendingForActiveTab();
  const targetConfig = handoff ?? pending;       // either path
  if (targetConfig && activeSessionId) {
    void postCancelSentinel(targetConfig, activeSessionId, fetch).catch(() => {
      // best-effort; the CLI will time out if the cancel POST fails
    });
  }
  void clearPendingForActiveTab();
  // ... rest of existing logic ...
}
```

`postCancelSentinel` is a new pure function in `src/background/handoff-cancel.ts` (separate file, follows the `handoff-post.ts` pattern).

## 3. Implementation sequence

The order is dependency-first: pure modules → wiring → integration → docs. Each step has tests written **before or alongside** the implementation, never after.

1. **Pure marker module + tests** (`src/lib/handoff-marker.ts`, `tests/handoff-marker.test.ts`).
   - Adversarial inputs first (all the reject cases), happy path second.
   - No chrome imports. Runs as a plain unit test.
2. **Pending-handoff store + tests** (`src/lib/pending-handoff-store.ts`, `tests/pending-handoff-store.test.ts`).
   - Mirrors `handoff-store.ts`. Mock `chrome.storage.local`.
3. **Handoff-pending orchestration + tests** (`src/background/handoff-pending.ts`, `tests/handoff-pending.test.ts`).
   - `armFromMarker`, `promotePendingToActive`, `cancelPending`. Pure functions with injected store + fetch.
4. **Cancel sentinel + tests** (`src/background/handoff-cancel.ts`, `tests/handoff-cancel.test.ts`).
   - Mirrors `handoff-post.ts`. Discriminated result.
5. **Marker detector content script + tests** (`src/content/marker-detector.ts`, `tests/marker-detector.test.ts`).
   - jsdom test, stub chrome global. Asserts: marker present → `history.replaceState` called with cleanHref → message sent. Marker absent → no message sent.
6. **Manifest + Vite glue** — add the second `content_scripts` entry; verify `make build` still bundles both content scripts.
7. **Service worker wiring + tests** (`src/background/service-worker.ts`, `tests/service-worker-pending-handoff.test.ts`).
   - New cases: `MARKER_DETECTED`, `GET_PENDING_HANDOFF`, `CANCEL_PENDING_HANDOFF`.
   - Edit `chrome.action.onClicked` to consume the pending handoff and broadcast `PENDING_HANDOFF_CHANGED`.
   - Edit `DISCARD_SESSION` to call `postCancelSentinel`.
   - Edit `chrome.tabs.onRemoved` to call `clearPendingHandoff`.
   - Extract `openPanelInGestureWindow(tabId)` as a named helper (paid-down debt).
   - Tests use the same `installFakeChrome` harness as `tests/service-worker-handoff.test.ts`.
8. **Side panel badge + tests** (`src/sidepanel/sidepanel-handoff-badge.ts`, `src/sidepanel/sidepanel.ts`, `tests/sidepanel-handoff-badge.test.ts`).
   - Pure model first, DOM render second.
9. **CLI `chrome-launcher.mjs` + tests** (`cli/chrome-launcher.mjs`, `cli/chrome-launcher.test.mjs`).
   - Inject fake `spawn`. Test the find-Chrome chain.
10. **CLI `cli-summary.mjs` and `cli-exit-codes.mjs`** (pure, trivial — co-located tests).
11. **CLI `deskcheck-record.mjs` + tests** (`cli/deskcheck-record.mjs`, `cli/deskcheck-record.test.mjs`).
    - Extends `startListener` from Phase 1 with the `emitter`. **No mutation of the existing listen path.**
    - Tests spawn the subcommand with `DESKCHECK_FAKE_CHROME=1` env var so the launcher returns a no-op.
12. **CLI listener cancel branch** (`cli/deskcheck.mjs` `handleRequest`).
    - Add the `application/x-deskcheck-cancel` content-type branch. Add the `cancelledSessions` set and `emitter.emit` calls.
    - Add an acceptance test in `cli/deskcheck.test.mjs` that pins: cancel POST → 200, replay cancel → 409, cancel without auth → 401, cancel with bad session-id → 400.
13. **End-to-end smoke** (`e2e/feature-14-phase-2.spec.ts` — Playwright).
    - **One** e2e test only. Spawns the real CLI, opens a fixture page via the launcher, drives the toolbar click, asserts the badge appears, presses Start, presses Stop, asserts the zip lands. This is the only e2e because each one costs a full extension load.
14. **Docs** — `docs/ARCHITECTURE.md`, `README.md`, `PRIVACY.md`, `docs/roadmap.md` Phase 2 checkboxes.
15. **Final pass** — `make build`, `make test`, `make e2e`. Manual walkthrough on a clean profile via `--profile isolated`.

## 4. Test Level Matrix

| # | DoD criterion (from brief / roadmap) | Suggested level | Test file | Rationale |
|---|---|---|---|---|
| 1 | `deskcheck record <url>` parses args, defaults timeout to 600s, accepts `--timeout`, `--profile`, `--json` | Unit | `cli/deskcheck-record.test.mjs` | Pure argv parsing |
| 2 | `record` starts a listener, launches Chrome, blocks until upload | Integration | `cli/deskcheck-record.test.mjs` | Spawn subcommand with fake Chrome launcher; POST a fixture zip; assert exit 0 + JSON stdout |
| 3 | `record --json` prints exact one-line JSON shape on success | Unit | `cli/cli-summary.test.mjs` | Pure builder, no I/O |
| 4 | `record` exits non-zero with structured error on timeout / cancellation / failed upload | Integration | `cli/deskcheck-record.test.mjs` | Three sub-tests, one per exit code |
| 5 | Content script detects `#_deskcheck=ID:TOKEN:PORT` marker, strips it from the URL, passes to SW | Unit | `tests/marker-detector.test.ts` | jsdom; stub chrome global; assert `history.replaceState` and message dispatch |
| 6 | Marker grammar accepts well-formed and rejects every adversarial variant | Unit | `tests/handoff-marker.test.ts` | Pure parser, table-driven |
| 7 | Marker is stripped before any timeline event records the URL | Integration | `tests/marker-detector.test.ts` + `tests/service-worker-pending-handoff.test.ts` | jsdom test asserts strip happens BEFORE message is sent; SW test asserts the SW never sees the unstripped URL in any event |
| 8 | SW arms a pending handoff on `MARKER_DETECTED` and persists it to storage | Integration | `tests/service-worker-pending-handoff.test.ts` | Fake chrome storage; dispatch `MARKER_DETECTED`; assert `chrome.storage.local.set` was called with the pending key |
| 9 | SW shows a per-tab "OPEN" badge when a pending handoff is armed | Integration | `tests/service-worker-pending-handoff.test.ts` | Assert `chrome.action.setBadgeText({tabId, text: "OPEN"})` was called |
| 10 | Toolbar click on a pending tab opens the side panel bound to that tab AND promotes the pending handoff | Integration | `tests/service-worker-pending-handoff.test.ts` | Dispatch `chrome.action.onClicked`; assert sync `setOptions` + `open` calls + async `set` of the global handoff key |
| 11 | Side panel renders "Connected to terminal session <id>" badge whenever a handoff is pending or attached | Unit | `tests/sidepanel-handoff-badge.test.ts` | Pure model + jsdom render |
| 12 | Side panel reads pending handoff on mount via `GET_PENDING_HANDOFF` | Unit | `tests/sidepanel-handoff-badge.test.ts` | Mock `sendMessage`; assert call |
| 13 | Discard sends the cancel sentinel to the listener; CLI exits with cancelled code | Integration | `tests/service-worker-pending-handoff.test.ts` + `cli/deskcheck.test.mjs` (cancel branch) | Two tests: SW side asserts the POST was made with the sentinel content-type; listener side asserts the response shape |
| 14 | Cancel sentinel reuses Phase 1 auth + session-id + replay checks | Integration | `cli/deskcheck.test.mjs` | Add `cancel without auth → 401`, `cancel bad session id → 400`, `cancel replay → 409` |
| 15 | Pause / Resume / Stop / Discard behave exactly as today | Integration | Existing `tests/service-worker-handoff.test.ts` (re-run) + new `tests/service-worker-pending-handoff.test.ts` | Phase 1 tests must remain green; pinning Phase 2 doesn't change Phase 1 lifecycle behaviour |
| 16 | `--profile isolated` spins a dedicated user-data-dir with `--load-extension=dist/` | Unit | `cli/chrome-launcher.test.mjs` | Inject fake `spawn`, assert flag list |
| 17 | macOS `findChrome()` resolves the canonical path, falls through alternatives, throws on Linux/Windows | Unit | `cli/chrome-launcher.test.mjs` | Inject fake `existsSync` |
| 18 | Listener still binds 127.0.0.1 only (no regression) | Integration | Existing `cli/deskcheck.test.mjs` D5 | Phase 1 test must remain green |
| 19 | `deskcheck_handoff` opt-in invariant: a page that contains `#_deskcheck=...` but does NOT match a running listener is a no-op | Integration | `tests/service-worker-pending-handoff.test.ts` | Dispatch `MARKER_DETECTED` with no listener running; assert no fetch + no panel auto-open + no badge promotion (only the "OPEN" badge, which is harmless) |
| 20 | Forged marker on a normal page never causes a silent POST | Integration | `tests/service-worker-pending-handoff.test.ts` + `tests/service-worker-handoff.test.ts` D6 | The opt-in invariant from Phase 1 still holds — the SW only POSTs on `EXPORT_SESSION` when `deskcheck_handoff` is set, which only happens after the user clicks Start in the panel |
| 21 | Token never lands in `session.json` | Unit | `tests/handoff-marker.test.ts` + `tests/service-worker-pending-handoff.test.ts` | Marker test asserts strip happens; SW test asserts no event in any captured timeline contains the token substring |
| 22 | Stale pending handoffs (>1h) are GC'd on next arm | Unit | `tests/pending-handoff-store.test.ts` | Inject a fake clock |
| 23 | End-to-end: real CLI + real Chrome + real extension records a session and the zip lands | E2E | `e2e/feature-14-phase-2.spec.ts` | Single e2e — one assertion bundle, full flow |
| 24 | macOS Chrome launch path works on a clean profile | Manual | (manual walkthrough section in PR description) | E2E in CI cannot test a fresh user-data-dir reliably; this is a one-shot manual verification |
| 25 | Linux/Windows are noted as future work in docs | Manual | `docs/ARCHITECTURE.md` review | Doc review, no automated test |

**Determinism rule:** Every automated test above is fully deterministic. No live network, no real Chrome (except the one e2e), no LLM calls. The CLI tests inject `DESKCHECK_FAKE_CHROME=1` to bypass `findChrome`.

## 5. Risks and tradeoffs (technical debt paid down)

**Debts paid down by Phase 2:**

1. **Gesture-window dance is unnamed.** Phase 1 has 4 inline lines repeated in `chrome.action.onClicked` and `chrome.commands.onCommand` (twice). Phase 2 extracts these into `openPanelInGestureWindow(tabId)` so the SW callsites become two-liners and the IPC-ordering invariant is documented in exactly one place.
2. **`handoff-store.ts` is plural-aware in name only.** The Phase 1 store is a singleton-by-design but the file name suggests "store" generically. Phase 2 introduces `pending-handoff-store.ts` as the explicit per-tab map, making the intent of `handoff-store.ts` (singleton-attached) clearer by contrast. We will add a 3-line comment to `handoff-store.ts` clarifying that it is the "attached" listener and should not be used for per-tab pending state.
3. **Marker-format coupling.** Without Phase 2, the only place that knows about "the marker format" is implicit. Phase 2 introduces `handoff-marker.ts` as the single source of truth, which a future v2 grammar can evolve from in one place.
4. **Cancel path was implicit.** Phase 1 has no concept of "the user changed their mind" — the user just closes the terminal. Phase 2 makes cancellation a first-class operation with a sentinel content-type, an exit code, and a CLI test.

**Debts NOT paid down (deliberately):**

1. **Linux/Windows Chrome launch.** Out of scope per the brief.
2. **Refactoring `service-worker.ts` into smaller files.** It is 870 lines. Splitting it is a larger refactor than Phase 2 should attempt; we add 60 lines of well-tested wiring and extract one helper. A future cycle can split it.
3. **MV3 gesture token forwarding.** There is an open Chromium discussion about forwarding gesture tokens across `runtime.sendMessage`. We do not depend on it, so we do not need to wait for it.

**Tradeoffs:**

| Decision | Quality cost | Quality benefit |
|---|---|---|
| Two `content_scripts` entries instead of one | +1 manifest entry, +2 KB build size | Marker detector + recorder fail in isolation; recorder doesn't pay for `document_start` defensiveness |
| New `pending-handoffs` storage key instead of extending `handoff` | One new constant, one new file | Phase 1 invariants stay intact; per-tab semantics are explicit |
| Cancel sentinel via content-type instead of `DELETE /session/<id>` | Slightly less RESTful | Reuses every Phase 1 security check; zero new endpoint surface |
| Spawn Chrome directly instead of `open -na` | Need a `findChrome` helper | We get a real child handle, exit codes, stderr capture, and unit testability |
| User must click the toolbar action once | One extra click vs the dream of "Chrome opens, panel opens, recording armed, all without user input" | We never depend on undocumented Chromium gesture-token behaviour |

## 6. Effort estimate

| Step | Effort |
|---|---|
| 1. Marker module + tests | 0.5 day |
| 2. Pending-handoff store + tests | 0.25 day |
| 3. Handoff-pending orchestration + tests | 0.5 day |
| 4. Cancel sentinel + tests | 0.25 day |
| 5. Marker detector content script + tests | 0.25 day |
| 6. Manifest + Vite | 0.1 day |
| 7. Service worker wiring + tests + extract `openPanelInGestureWindow` | 1.0 day |
| 8. Side panel badge + tests | 0.5 day |
| 9. CLI `chrome-launcher.mjs` + tests | 0.5 day |
| 10. CLI summary + exit codes (pure) | 0.1 day |
| 11. CLI `deskcheck-record.mjs` + tests | 1.0 day |
| 12. CLI listener cancel branch + tests | 0.25 day |
| 13. E2E smoke | 0.5 day |
| 14. Docs (ARCHITECTURE, README, PRIVACY, roadmap) | 0.5 day |
| 15. Manual walkthrough on a clean profile | 0.25 day |
| **Total** | **6.45 person-days** |

Buffer for review revisions and Chrome version surprises: **+1 day**.

**Total budget: ~7.5 person-days.**

For comparison, a speed-optimised plan would skip steps 1, 2, 3, 4, 8 (collapse into the SW handler), and 13 (no e2e), saving roughly 3 days. Worth the extra investment because (a) this is the second use of the handoff machinery — it's about to become load-bearing — and (b) the marker grammar is a security surface that deserves its own pure module.

## 7. Open questions for the judge

1. **Should the badge state be persisted across SW evictions?** The sync mirror is an optimisation; the canonical truth lives in `chrome.storage.local`. On SW wake we rehydrate `__pendingHandoffs` from storage. The mirror is still needed because `chrome.action.onClicked` is sync. The judge should confirm this is the right tradeoff vs "just always read from storage in `MARKER_DETECTED` and accept the gesture loss." (Recommendation: mirror it.)

2. **Should the cancel sentinel ALSO support an `EXPORT_WARNING`-style downgrade?** I.e., if `postCancelSentinel` fails (CLI already exited), do we surface a side-panel warning, or silently swallow? (Recommendation: silently swallow — the user clicked Discard intentionally, the CLI will time out on its own, no need for a confusing warning.)

3. **Is one e2e test enough?** I propose a single e2e covering the entire flow. The judge could push for two (one for the success path, one for the cancel path). The success path covers the load-bearing wiring; the cancel path is well-covered by the SW + CLI integration tests already. (Recommendation: one e2e, plus the manual walkthrough for `--profile isolated`.)

4. **Should `findChrome` also probe `which google-chrome` / `command -v chrome`?** macOS users sometimes alias these. (Recommendation: no — the canonical `.app` paths are sufficient and adding shell-out probes opens an injection surface for `$PATH`-poisoning.)

5. **Should we add the `notifications` permission for a Chrome notification on marker detection?** It would make the "click the toolbar action" step more visible. Cost: one new permission in the manifest, one more thing the user has to allow on first install. (Recommendation: NO for v1 — keep permissions minimal. Revisit if dogfooding shows the badge alone is insufficient.)

6. **Should the marker grammar be `v1.<sessionId>.<token>.<port>` or the literal roadmap text `ID:TOKEN:PORT`?** The roadmap text has no version prefix and uses `:`. I propose deviating because (a) `:` is a valid character in URL fragments but is also used by hash-router conventions like `#/users/:id`, increasing collision risk, and (b) a version prefix is cheap insurance. The judge should bless this deviation from the roadmap text. (Recommendation: deviate with a docstring noting the deviation.)

7. **Should `discardPendingIfArmed` run even when `currentStatus === "idle"`?** A user could open the panel via the toolbar, see the badge, then click Discard before clicking Start. There is no active session to discard, but the pending handoff should still be cleared and the CLI should still receive the cancel. (Recommendation: yes — the Discard button on a pre-session pending state should be re-purposed as "Cancel terminal session," and the SW should detect the pending case and call `postCancelSentinel` even with no active session. This is a small additional case in the `DISCARD_SESSION` handler — covered in Step 7 above.)

8. **Should `deskcheck record` also leave the Chrome window open after the upload, or quit the launched Chrome on success?** If the user passed `--profile isolated`, leaving an orphan Chrome window with a tmp profile is messy. If the user passed `--profile existing`, killing their main Chrome is hostile. (Recommendation: quit ONLY when `--profile isolated` was used, by killing the spawned child. Document this behaviour.)
