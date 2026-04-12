---
agent: plan-judge
generated: 2026-04-11T12:00:00Z
task_id: feature-14-phase-2
selected: quality (synthesized with safety elements)
---

# Plan Evaluation: Feature #14 Phase 2 -- Terminal-launched sessions (`deskcheck record <url>`)

## 1. Selection

The **Quality plan wins**, synthesized with specific safety hardening elements. The Quality plan strikes the best balance: it reuses Phase 1 machinery wholesale, introduces clean module boundaries (pure marker parser, separate pending-handoff store, orchestration helper), and includes one e2e test -- all at a reasonable 7.5 person-day budget. From the Safety plan, I incorporate the `armedSessions` Set (cheap structural defence against forged markers on the CLI side), the SW-side `stripMarker` defence-in-depth on `START_SESSION`, the Chrome crash watchdog, and the adversarial test cases for cross-tab contamination and token-never-in-session.json property tests. From the Speed plan, I adopt the simpler colon-delimited marker grammar (matching the roadmap text) instead of the Quality plan's dot-delimited `v1.` prefix format, and the Speed plan's pragmatic approach to JSON summary (trust the exporter's summary block). The one-line rationale: **this is load-bearing security-adjacent infrastructure that will be used by agents and CI pipelines, so quality + targeted safety hardening is worth the extra 3 days over speed**.

## 2. Scorecard

### Scoring against the 10 Key Decisions

| # | Decision | Speed | Quality | Safety | Notes |
|---|----------|-------|---------|--------|-------|
| 1 | Chrome launch strategy | `open -na` (3/5) | `spawn` direct (5/5) | `spawn` direct (5/5) | `open -na` loses child handle, stderr, exit detection. Quality/Safety agree on `spawn`. |
| 2 | Hash-fragment marker format | `ID:TOKEN:PORT` colon (4/5) | `v1.ID.TOKEN.PORT` dot (3/5) | `SID:TOKEN:PORT:v1` colon (4/5) | Roadmap text says `ID:TOKEN:PORT`. Quality's dot separator is cleaner but deviates. Speed/Safety stay closer. I adopt colon with version suffix: `ID:TOKEN:PORT:v1`. |
| 3 | Content script strategy | New `document_start` entry (5/5) | New `document_start` entry (5/5) | New `document_start` entry (5/5) | All three agree. Correct. |
| 4 | Pending-handoff storage | Extend `deskcheck_handoff` single-slot (2/5) | New `deskcheck_pending_handoffs` per-tab in storage (4/5) | In-memory per-tab Map in SW (4/5) | Speed's single-slot breaks Phase 1 invariant on concurrent use. Quality's storage survives SW eviction. Safety's in-memory is simpler but loses state on SW eviction. I pick Quality's storage approach with Safety's TTL cleanup. |
| 5 | Panel-open gesture strategy | Badge "1" + user click (4/5) | Badge "OPEN" + user click (4/5) | Badge "REC?" + user click + auto-start (4/5) | All three agree no auto-open is possible. Safety's auto-start on toolbar click is a nice UX shortcut. I adopt the badge cue but NOT auto-start (user should verify PII mode). |
| 6 | Side panel badge UI | Reuse handoff-row, dot + text (4/5) | Pure view-model + two visual states (5/5) | Badge chip in toolbar region (4/5) | Quality's pure model approach is the most testable. |
| 7 | CLI `record` ergonomics | Minimal stderr, exit 0/2/3 (3/5) | Full stderr keepalive, 6 exit codes (5/5) | Full stderr keepalive, Chrome watchdog (5/5) | Quality + Safety both have rich CLI UX. |
| 8 | Discard cancels CLI | Sentinel POST `x-deskcheck-cancel` (4/5) | Sentinel POST `x-deskcheck-cancel` (4/5) | Sentinel POST with `X-DeskCheck-Cancelled` header (4/5) | All three agree on sentinel approach. Good. |
| 9 | Test strategy | 0 e2e, manual verify (2/5) | 1 e2e, unit + integration (5/5) | 1 gated e2e, extensive adversarial (5/5) | Speed skips too much. Quality + Safety both thorough. |
| 10 | Rollback | Comment out manifest entry (4/5) | Same + doc pointer (4/5) | Same + `DESKCHECK_DISABLE_MARKER` env var (5/5) | All reasonable. Safety's env var is cheap insurance. |

### Accuracy Check

| Plan | Accuracy | Notes |
|------|----------|-------|
| Speed | 4/5 | Claims `tests/content-no-handoff-write.test.ts` grep test -- exists and checks imports correctly. Claims the content script can write to `chrome.storage.local` directly with the constant key without violating the grep test -- TRUE, the grep test only checks for `handoff-store` and `handoff-post` imports, not raw `chrome.storage.local.set` calls. Line number references for `onClicked` (228-253), `EXPORT_SESSION` (661-732) are accurate. Claims `tests/sidepanel-no-handoff-write.test.ts` and `src/lib/exporter.golden.test.ts` pins -- both exist. Mostly accurate. |
| Quality | 5/5 | All line number references verified. Correctly identifies the gesture-window pattern, the `enablePanelOnTab` helper, the `EXPORT_SESSION` branch structure. Content-script grep test analysis is accurate. Correctly identifies the `formatReadyLine` export. |
| Safety | 4/5 | Generally accurate on code structure. Claims `handleRequest` checks can be reused for cancel sentinel -- correct, the auth/session-id/replay path applies. The `armedSessions` Set idea is novel and structurally sound. The claim about `--password-store=basic` being critical for macOS isolated profile is a genuine insight. Minor: references `OPFS` for session deletion, but the code uses `store.deleteSession()` which is the OPFS store -- this is accurate but could confuse implementers who don't know the store is OPFS-backed. |

### Fit-for-Phase-2

| Plan | Score | Notes |
|------|-------|-------|
| Speed | 5/5 | Strictly Phase 2 scope, no overreach. |
| Quality | 4/5 | Slight over-engineering with the `cli-exit-codes.mjs` and `cli-summary.mjs` as separate files, but within scope. |
| Safety | 4/5 | The `START_FROM_HANDOFF` auto-start-session-on-toolbar-click is arguably a UX innovation beyond the DoD (which says "pre-populates the session config" not "auto-starts"). I trim this to just pre-populate. |

## 3. Synthesized Plan

### 3.1 Exact File List

**New files (11 production + 8 test):**

| File | Purpose | Est. LOC |
|------|---------|----------|
| `cli/chrome-launcher.mjs` | `findChrome()`, `launchChrome({url, profile, extensionDir})`. macOS-only. Returns `{child, userDataDir, cleanup}`. | ~90 |
| `cli/deskcheck-record.mjs` | `deskcheck record <url>` subcommand. Imports `startListener` + `formatReadyLine` from `deskcheck.mjs`. Owns blocking wait, JSON summary, exit codes, Chrome launch, cancellation. | ~200 |
| `src/lib/handoff-marker.ts` | **Pure** module. `MARKER_PREFIX`, `parseMarker(hash)`, `stripMarker(originalHref)`, `isMarkerWellFormed(value)`. Zero chrome imports. Single source of truth for the grammar. | ~80 |
| `src/lib/pending-handoff-store.ts` | Wrapper over `chrome.storage.local['deskcheck_pending_handoffs']` (tab-id-keyed map). `armPendingHandoff(tabId, config)`, `consumePendingHandoff(tabId)`, `clearPendingHandoff(tabId)`, `listPendingHandoffs()`. Stale-GC entries older than 1 hour on each `arm`. | ~60 |
| `src/background/handoff-pending.ts` | Pure orchestration: `armFromMarker(marker, tabId, store, clock)`, `promotePendingToActive(tabId, store)`, `cancelPending(tabId, store, fetchImpl)`. Injected deps for testability. | ~80 |
| `src/background/handoff-cancel.ts` | Pure: `sendCancelSentinel(config, sessionId, fetchImpl)`. POSTs `Content-Type: application/x-deskcheck-cancel` with empty body. Mirrors `handoff-post.ts` shape. | ~30 |
| `src/content/marker-detector.ts` | Slim content script at `document_start`. Calls `stripMarker(location.href)`, `history.replaceState`, then sends `MARKER_DETECTED` message. NEVER imports the recorder. | ~40 |
| `src/sidepanel/sidepanel-handoff-badge.ts` | Pure view-model: `buildHandoffBadgeModel(pending, attached)` returning `{visible, sessionIdShort, tone}`. | ~30 |
| `tests/handoff-marker.test.ts` | Adversarial unit tests for the marker parser. Table-driven corpus. | ~120 |
| `tests/pending-handoff-store.test.ts` | Unit tests for the store wrapper with mock chrome.storage. | ~60 |
| `tests/handoff-pending.test.ts` | Unit tests for orchestration helper with fake store + fake fetch. | ~60 |
| `tests/marker-detector.test.ts` | jsdom test for the content script entry. | ~50 |
| `tests/service-worker-pending-handoff.test.ts` | Integration tests for MARKER_DETECTED handler, badge promotion, discard-cancels-pending, cross-tab isolation, token-never-in-initial-url. Matches `tests/service-worker-handoff.test.ts` harness. | ~200 |
| `tests/sidepanel-handoff-badge.test.ts` | Unit + jsdom tests for badge model and render. | ~60 |
| `cli/deskcheck-record.test.mjs` | Integration tests for the `record` subcommand. Spawn + POST fixture zip + assert JSON stdout. | ~150 |
| `cli/chrome-launcher.test.mjs` | Unit tests for `findChrome` with fake `existsSync`. | ~40 |
| `tests/manifest-content-scripts.test.ts` | Assert manifest has exactly two content_scripts entries with expected `run_at` values. | ~20 |
| `e2e/feature-14-phase-2.spec.ts` | Single e2e: real CLI + real Chrome + real extension, full flow. Gated on `RUN_CHROME_TESTS=1`. | ~80 |
| `cli/__fixtures__/marker-corpus.json` | Shared corpus for marker parse/strip tests (TS and JS sides). 15+ rows. | ~60 |

**Modified files (11):**

| File | Change | Est. delta |
|------|--------|------------|
| `cli/deskcheck.mjs` | Add `record` to `parseArgv`. Add `application/x-deskcheck-cancel` content-type branch in `handleRequest` (after auth + session-id checks, before content-length). Add `armedSessions` Set support (only used when `ctx.armedSessions` is provided; `listen` subcommand does not pass it, preserving Phase 1 behaviour). Add EventEmitter to `startListener` return for settled events. Export helpers for `record` subcommand reuse. | ~80 LOC |
| `manifest.json` | Add second `content_scripts` entry: `{"matches": ["<all_urls>"], "js": ["src/content/marker-detector.ts"], "run_at": "document_start", "all_frames": false}`. No new permissions. | ~8 LOC |
| `src/background/service-worker.ts` | (a) Two new case arms: `MARKER_DETECTED`, `CANCEL_PENDING_HANDOFF`. (b) Extract `openPanelInGestureWindow(tabId)` helper from the existing inline code in `onClicked`. (c) In `onClicked`, check `__pendingHandoffs.get(tab.id)` from sync mirror -- if present, promote to `deskcheck_handoff` and broadcast `PENDING_HANDOFF_CHANGED`. (d) In `DISCARD_SESSION`, call `postCancelSentinel` if a handoff is active. (e) In `START_SESSION`, add a `stripMarker(msg.url)` call as defence-in-depth before `buildSessionMetadata`. (f) `chrome.tabs.onRemoved` calls `clearPendingHandoff(tabId)`. | ~70 LOC |
| `src/sidepanel/sidepanel.ts` | Mount badge into existing `handoff-row` region (above paste affordance). Subscribe to `PENDING_HANDOFF_CHANGED` broadcast. On mount, send `GET_PENDING_HANDOFF` to SW. | ~40 LOC |
| `src/sidepanel/sidepanel.css` | Add `.handoff-badge`, `.handoff-badge--armed`, `.handoff-badge--connected` rules. | ~25 LOC |
| `src/types.ts` | Add `MARKER_DETECTED`, `CANCEL_PENDING_HANDOFF`, `GET_PENDING_HANDOFF`, `PENDING_HANDOFF_CHANGED` to Message union. | ~8 LOC |
| `src/constants.ts` | Add `STORAGE_PENDING_HANDOFFS = "deskcheck_pending_handoffs"`. | ~1 LOC |
| `cli/deskcheck.test.mjs` | Add cancel sentinel tests (cancel POST -> 200, replay cancel -> 409, cancel without auth -> 401). Add `armedSessions` rejection test (unarmed sid -> 403). | ~50 LOC |
| `docs/ARCHITECTURE.md` | New "CLI handoff (phase 2)" subsection with sequence diagram and gesture model. | ~40 LOC |
| `README.md` | `deskcheck record` walkthrough. "Click the badge to open the panel" step. macOS-only note. Linux/Windows future work note. | ~30 LOC |
| `PRIVACY.md` | One sentence about `#_deskcheck=...` marker being stripped before any timeline event. | ~3 LOC |

### 3.2 Marker Grammar (Final)

```
marker      = "_deskcheck=" sessionId ":" token ":" port ":" version
sessionId   = 1*128 ( ALPHA / DIGIT / "-" / "_" )    ; matches SESSION_ID_REGEX
token       = 64 HEXDIG                               ; from randomBytes(32).toString("hex")
port        = 1*5 DIGIT                               ; 1024..65535
version     = "v1"
```

**Why colon separator**: matches the roadmap's literal `#_deskcheck=ID:TOKEN:PORT` text, extended with `:v1` for forward compatibility. Colon is safe in URL fragments and does not appear in session-id, hex token, or port values -- no ambiguity.

**Strip-and-preserve algorithm** (in `stripMarker(href)`):

1. Parse `href` with `URL` constructor. Extract `url.hash`.
2. If `url.hash === ""` or does not contain `_deskcheck=`, return `null`.
3. Try, in order:
   - **Pattern A -- pure marker**: `^#_deskcheck=([A-Za-z0-9._-]+):([a-f0-9]{64}):(\d{1,5}):v1$`. If matches, `cleanHash = ""`.
   - **Pattern B -- appended via `&`**: `^(#.*)&_deskcheck=([A-Za-z0-9._-]+):([a-f0-9]{64}):(\d{1,5}):v1$`. If matches, `cleanHash = group1`.
4. Validate captured fields. If validation fails, return `null`.
5. Reconstruct clean href: `url.origin + url.pathname + url.search + cleanHash`.
6. Return `{cleanHref, marker: {sessionId, token, port}}`.

This handles: `#_deskcheck=...` -> cleared; `#/login&_deskcheck=...` -> `#/login`; no marker -> no-op.

**Why `&` separator for existing hashes**: hash routers treat `&` as a query separator within the fragment. `_deskcheck` starts with `_`, which is conventional for "do not route". The marker is always last.

**Why the version field**: so a future grammar change is structurally rejectable. The content script rejects markers without `v1`.

### 3.3 Chrome Launch Strategy (Final)

**`child_process.spawn` directly on the resolved Chrome binary path.** NOT `open -na`.

```js
function findChrome() {
  const envBin = process.env.CHROME_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new ChromeNotFoundError(candidates);
}
```

**Rationale**: `spawn` gives us a child PID, can capture stderr (Chrome warnings help debugging), can detect Chrome exit via `child.on('exit')` for the crash watchdog, and can be unit-tested by injecting a fake `spawn`. `open -na` loses all of these.

**`--profile existing` (default)**: `spawn(chromeBin, [url])`. Relies on the user's already-installed extension.

**`--profile isolated`**: `spawn(chromeBin, [url, "--user-data-dir=" + mkdtempDir, "--load-extension=" + distPath, "--no-first-run", "--no-default-browser-check", "--password-store=basic"])`. The `--password-store=basic` prevents a macOS keychain prompt on first launch that would silently hang the CLI.

**Cleanup**: `process.on('exit')` + `SIGINT`/`SIGTERM` handlers remove the temp user-data-dir. Path printed to stderr for forensic access.

**Crash watchdog** (from Safety): `child.on('exit', (code) => { if (!sessionReceived) finish({kind: "chrome_exited", code}); })`. Without this, Chrome dying mid-record blocks the CLI forever.

### 3.4 Pending Handoff Storage (Final)

**New `chrome.storage.local['deskcheck_pending_handoffs']` key, tab-id-keyed map.** (Quality plan approach, with Safety's TTL.)

```ts
export interface PendingHandoffConfig {
  listener_url: string;          // reconstructed from marker.port
  token: string;                  // marker.token
  session_id_hint: string;        // marker.sessionId
  armed_at: string;               // ISO timestamp
}
type PendingHandoffMap = Record<string, PendingHandoffConfig>;
```

**Why a new key, not `deskcheck_handoff`**: different lifetime (until panel mount vs until detach), different cardinality (per-tab vs singleton), different invariant. Mixing them breaks the Phase 1 structural invariant: a user running `deskcheck record https://a.com` and then opening an unrelated tab `https://b.com` would have `b.com`'s manual session ship to the listener -- a Phase 1 regression.

**Why `chrome.storage.local`, not in-memory only**: SW eviction is expected. If the user runs `deskcheck record`, the SW arms the pending handoff, then Chrome evicts the SW before the user clicks the action, an in-memory-only map is lost. Storage survives eviction.

**Sync mirror in SW**: `globalThis.__pendingHandoffs: Map<number, PendingHandoffConfig>`, populated by the `MARKER_DETECTED` handler and rehydrated on SW wake from storage. The `chrome.action.onClicked` handler reads from the sync mirror (the handler must be sync for gesture-window reasons).

**Stale-GC**: on each `armPendingHandoff`, drop entries older than 1 hour.

**Tab close cleanup**: `chrome.tabs.onRemoved` calls `clearPendingHandoff(tabId)`.

### 3.5 Gesture / Panel-open Strategy (Final)

The content script triggering on page load is NOT a user gesture in Chrome's eyes. We therefore:

1. When SW receives `MARKER_DETECTED`, it sets a per-tab badge: `chrome.action.setBadgeText({tabId, text: "OPEN"})` with blue background `#2563eb`, and `chrome.action.setTitle({tabId, text: "DeskCheck -- terminal session waiting. Click to open."})`.
2. The user clicks the toolbar action. The existing `chrome.action.onClicked` handler fires sync. It checks `__pendingHandoffs.has(tab.id)` BEFORE its existing `enablePanelOnTab` + `sidePanel.open` calls. If a pending entry exists, the gesture window opens the panel and the async IIFE that follows calls `promotePendingToActive(tabId)` -- which copies the pending entry into the global `deskcheck_handoff` slot and broadcasts `PENDING_HANDOFF_CHANGED`.
3. The side panel mounts, observes `PENDING_HANDOFF_CHANGED` (or reads via `GET_PENDING_HANDOFF` on mount), renders the "Connected to terminal session <id>" badge. The user clicks Start as normal.

**Total clicks for happy path: 2** (toolbar action + Start). The user keeps control over PII mode selection before recording starts.

**Badge guard**: if a session is already in flight (`isSessionInFlight()`), the MARKER_DETECTED handler still arms the pending handoff but does NOT overwrite the red `REC` badge. The pending entry waits until the current session completes.

### 3.6 Side Panel Badge UI (Final)

**Where**: the existing `#handoff-row` div region, ABOVE the paste affordance.

**View model** (`buildHandoffBadgeModel`): pure function returning `{visible, sessionIdShort, tone: "armed" | "connected"}`.

| State | Render | CSS class |
|-------|--------|-----------|
| Armed (pending, not yet promoted) | `Connected to terminal session abc1234... (click Start)` with blue dot | `.handoff-badge .handoff-badge--armed` |
| Connected (promoted, session will POST on Stop) | `Connected to terminal session abc1234...` with green dot | `.handoff-badge .handoff-badge--connected` |

**How it reads state**: on mount, sends `{type: "GET_PENDING_HANDOFF"}` to SW. Subscribes to `PENDING_HANDOFF_CHANGED` broadcast for updates. Token is NEVER rendered. Only the session-id-hint (truncated to 8 chars) is shown; full id in `title` attribute.

**Paste affordance**: remains visible below the badge. The user can still paste a different listener URL manually if the auto-detected one is broken.

### 3.7 CLI `record` Ergonomics (Final)

```
deskcheck record <url> [--timeout S] [--profile existing|isolated] [--json] [--port N] [--out DIR]
```

**Defaults**: `--timeout 600`, `--profile existing`, `--out ./sessions`, `--port 0` (kernel-assigned).

**stderr while waiting** (non-`--json` mode):
```
deskcheck: listener http://127.0.0.1:54329 ready
deskcheck: launched Chrome PID 41523 against https://app.example.com/login
deskcheck:   click the DeskCheck toolbar action when the page loads
deskcheck:   then press Start in the side panel and reproduce the bug
deskcheck:   waiting... (12s elapsed, 588s remaining)
deskcheck:   waiting... (24s elapsed, 576s remaining)
```

Keepalive every 12 seconds. In `--json` mode, stderr is silent except for fatal errors.

**stdout on success** (`--json` or `!process.stdout.isTTY`):
```json
{"session_id":"abc-1234-uuid","path":"/Users/me/sessions/abc-1234-uuid.zip","events":742,"screenshots":9,"duration_s":143}
```

**JSON summary field population**: read `session.json` from the just-written zip's summary block (already computed by the exporter). Trust the exporter -- it is pinned by the golden zip test.

**Exit codes**:

| Code | Meaning |
|------|---------|
| 0 | Session received and written |
| 1 | Generic / unknown error |
| 2 | Argument parse error |
| 3 | Chrome launch failed |
| 4 | Timeout |
| 5 | Cancelled (user clicked Discard) |
| 6 | Listener bind failed |

**Error JSON shape**: `{"error":"timeout","message":"no session received within 600s","exit_code":4}`

### 3.8 Discard-cancels-CLI Mechanism (Final)

**Sentinel `Content-Type: application/x-deskcheck-cancel` POST to the existing `/upload` endpoint, with a zero-byte body and the same `Authorization: Bearer <token>` header.**

**Why not `DELETE /session/<id>`**: zero new endpoint surface. The cancel sentinel goes through the same `handleRequest` chokepoint and reuses all Phase 1 security checks (auth, session-id regex, replay defence).

**CLI listener changes**: after auth + session-id checks, before content-length check, detect the sentinel content-type. Mark the session as used in `usedSessions`. Emit `{kind: "cancelled"}` on the `settled` EventEmitter. Return 200.

**SW side**: in `DISCARD_SESSION` handler (and in a new `CANCEL_PENDING_HANDOFF` handler for pre-session discard), call `sendCancelSentinel(config, sessionId, fetch)` best-effort (swallow errors). The local OPFS session is deleted regardless of whether the sentinel reaches the listener.

**armedSessions Set** (from Safety): the `record` subcommand's listener keeps a Set of armed session-ids. Any POST whose `X-DeskCheck-Session-Id` is not in that Set returns 403. The `listen` subcommand does NOT use this -- backward compatibility with Phase 1. This is a structural defence on top of the token: even if an attacker somehow guesses the token, they cannot upload against a session-id the CLI did not arm.

### 3.9 Rollback Mechanism

Two levers:

1. **Disable Phase 2 in the extension**: comment out the new `content_scripts` entry in `manifest.json` and rebuild. The marker is never detected, no pending handoff is armed, the badge never appears. All Phase 1 behaviour is unchanged.
2. **Disable the CLI subcommand**: revert the `parseArgv` `record` branch (3 lines) in `cli/deskcheck.mjs`. `deskcheck listen` is unchanged.

Both are zero-risk to Phase 1.

### 3.10 Implementation Sequence

Each step ends green (`make test && make typecheck`).

1. **Pure marker module + corpus tests** (`src/lib/handoff-marker.ts`, `tests/handoff-marker.test.ts`, `cli/__fixtures__/marker-corpus.json`). Adversarial inputs first, happy path second. Zero chrome imports.

2. **Pending-handoff store + tests** (`src/lib/pending-handoff-store.ts`, `tests/pending-handoff-store.test.ts`). Mirrors `handoff-store.ts` style. Mock `chrome.storage.local`.

3. **Handoff-pending orchestration + cancel sentinel** (`src/background/handoff-pending.ts`, `src/background/handoff-cancel.ts`, `tests/handoff-pending.test.ts`). Pure functions with injected store + fetch.

4. **Marker detector content script** (`src/content/marker-detector.ts`, `tests/marker-detector.test.ts`). jsdom test, stub chrome global.

5. **Manifest + Vite glue** -- add second `content_scripts` entry, verify `make build` bundles both. Add `tests/manifest-content-scripts.test.ts`.

6. **Service worker wiring** (`src/background/service-worker.ts`, `tests/service-worker-pending-handoff.test.ts`). New cases: `MARKER_DETECTED`, `GET_PENDING_HANDOFF`, `CANCEL_PENDING_HANDOFF`. Edit `onClicked` to consume pending handoff. Edit `DISCARD_SESSION` to call cancel sentinel. Edit `START_SESSION` to strip marker from `msg.url`. Edit `tabs.onRemoved`. Extract `openPanelInGestureWindow(tabId)` helper.

7. **Side panel badge** (`src/sidepanel/sidepanel-handoff-badge.ts`, `src/sidepanel/sidepanel.ts`, `src/sidepanel/sidepanel.css`, `tests/sidepanel-handoff-badge.test.ts`). Pure model first, DOM render second.

8. **CLI chrome-launcher** (`cli/chrome-launcher.mjs`, `cli/chrome-launcher.test.mjs`). Fake `spawn` + fake `existsSync`.

9. **CLI cancel branch** (`cli/deskcheck.mjs`, `cli/deskcheck.test.mjs`). Cancel sentinel content-type. `armedSessions` Set. EventEmitter on `startListener` return.

10. **CLI `deskcheck-record.mjs`** (`cli/deskcheck-record.mjs`, `cli/deskcheck-record.test.mjs`). Full subcommand: parseArgv, startListener, buildMarker, launchChrome, awaitSettled, JSON summary, exit codes, watchdog, heartbeat.

11. **E2E smoke** (`e2e/feature-14-phase-2.spec.ts`). One test, gated on `RUN_CHROME_TESTS=1`.

12. **Docs** (`docs/ARCHITECTURE.md`, `README.md`, `PRIVACY.md`).

13. **Manual walkthrough** -- happy path, cancel path, `--profile isolated`.

---

## 4. Test Level Matrix

Each DoD item from `docs/roadmap.md` lines 136-143 is mapped to a test level and concrete file.

### Core DoD Items

| # | DoD Criterion | Test Level | File | Description |
|---|---------------|-----------|------|-------------|
| D1 | `deskcheck record <url>` starts a listener, launches Chrome, blocks until session arrives or timeout | Integration | `cli/deskcheck-record.test.mjs` | Spawn subcommand with `DESKCHECK_FAKE_CHROME=1` env, POST fixture zip to listener, assert exit 0 + JSON stdout |
| D2 | On success, prints JSON `{session_id, path, events, screenshots, duration_s}` to stdout, exits 0 | Integration | `cli/deskcheck-record.test.mjs` | Same spawn test, assert JSON shape and field types |
| D3 | On timeout, exits non-zero with structured error | Integration | `cli/deskcheck-record.test.mjs` | Spawn with `--timeout 1`, never POST, assert exit 4 + stdout `{"error":"timeout",...}` |
| D4 | On cancellation, exits non-zero with structured error | Integration | `cli/deskcheck-record.test.mjs` | Spawn, POST cancel sentinel, assert exit 5 + stdout `{"error":"cancelled",...}` |
| D5 | Content script detects `#_deskcheck=ID:TOKEN:PORT:v1` on page load | Unit | `tests/marker-detector.test.ts` | jsdom: set `location.hash`, run detector, assert `chrome.runtime.sendMessage({type: "MARKER_DETECTED", marker})` called |
| D6 | Content script strips the marker from the visible URL | Unit | `tests/marker-detector.test.ts` | jsdom: assert `history.replaceState` called with clean URL; corpus includes `#/login&_deskcheck=...` -> `#/login`, `#_deskcheck=...` -> no hash |
| D7 | Content script passes marker to service worker | Unit | `tests/marker-detector.test.ts` | Assert `sendMessage` shape |
| D8 | SW opens side panel bound to tab and pre-populates session config | Integration | `tests/service-worker-pending-handoff.test.ts` | Dispatch `MARKER_DETECTED`, then simulate `onClicked` for that tab -- assert `setOptions({tabId, ...})` + `open({tabId})` called sync, then assert `deskcheck_handoff` storage set with correct values |
| D9 | Side panel shows "Connected to terminal session <id>" badge | Unit | `tests/sidepanel-handoff-badge.test.ts` | Pure model test: `buildHandoffBadgeModel(pending)` returns `{visible: true, sessionIdShort: "abc12345"}`. jsdom test: mount panel with mock pending, assert badge text in DOM, assert token NOT in DOM |
| D10 | Pause / Resume / Stop / Discard behave exactly as today | Regression | existing `tests/service-worker-handoff.test.ts` + existing `tests/service-worker.test.ts` | All existing Phase 1 tests must pass without modification |
| D11 | Discard cancels the pending handoff and CLI receives cancelled | Integration | `tests/service-worker-pending-handoff.test.ts` + `cli/deskcheck.test.mjs` | SW test: dispatch `DISCARD_SESSION` with active handoff -> assert cancel sentinel POST made. CLI test: cancel sentinel POST -> waiter resolves `{kind: "cancelled"}` |
| D12 | `--profile isolated` spins dedicated user-data-dir with `--load-extension=dist/` | Unit + Manual | `cli/chrome-launcher.test.mjs` + manual walkthrough | Unit: inject fake `spawn`, assert flag list includes `--user-data-dir`, `--load-extension`, `--no-first-run`, `--password-store=basic`. Manual: walkthrough on real macOS. |
| D13 | macOS-native Chrome launch path works end-to-end | E2E (gated) + Manual | `e2e/feature-14-phase-2.spec.ts` + manual walkthrough | E2E gated on `RUN_CHROME_TESTS=1`. Manual walkthrough in PR description. |
| D14 | Linux/Windows noted as future work in docs | Manual | `README.md` review | Doc review only |

### Adversarial / Security Tests (from Safety plan -- MUST NOT be dropped)

| # | Criterion | Test Level | File | Description |
|---|-----------|-----------|------|-------------|
| A1 | Token never lands in `session.json` | Unit | `tests/service-worker-pending-handoff.test.ts` | Property test: 20 random URLs with marker injected -> dispatch `START_SESSION` -> assert `SessionMetadata.initial_url` does not contain `_deskcheck=` |
| A2 | SW defence-in-depth: `START_SESSION` re-strips `msg.url` | Unit | `tests/service-worker-pending-handoff.test.ts` | Call `START_SESSION` with a URL containing the marker directly (bypassing content script). Assert the metadata's `initial_url` is clean. |
| A3 | Forged-marker rejection: unarmed session-id returns 403 | Integration | `cli/deskcheck.test.mjs` | POST with valid token but unarmed sid to `record` listener -> 403 |
| A4 | Cross-tab contamination prevented | Integration | `tests/service-worker-pending-handoff.test.ts` | Arm tab A with handoff X, arm tab B with handoff Y. Click action on tab A -> assert tab A's promoted handoff is X, not Y |
| A5 | Listener still binds 127.0.0.1 only (record subcommand) | Integration | `cli/deskcheck-record.test.mjs` | Mirror of Phase 1 D5: spawn `record`, attempt connect from non-loopback, assert rejection |
| A6 | Marker grammar rejects adversarial inputs | Unit | `tests/handoff-marker.test.ts` | Corpus: wrong version -> null, missing port -> null, oversized sid -> null, embedded null bytes -> null, non-hex token -> null, port 0 -> null, port 99999 -> null |
| A7 | Marker survives existing hash routers | Unit | `tests/handoff-marker.test.ts` | Corpus: `#/login` injected -> `#/login&_deskcheck=...` -> strip -> `#/login`. Round-trip is byte-equal. |
| A8 | Pending-handoff stale-GC on arm | Unit | `tests/pending-handoff-store.test.ts` | Inject fake clock, arm entry, advance 61 minutes, arm another, assert first is garbage-collected |
| A9 | Tab close clears pending handoff | Unit | `tests/service-worker-pending-handoff.test.ts` | Dispatch `chrome.tabs.onRemoved` for armed tab -> assert entry gone |
| A10 | Chrome crash mid-record -> CLI exits non-zero | Integration | `cli/deskcheck-record.test.mjs` | Stub launcher to spawn `node -e 'process.exit(7)'`. Assert CLI exits with code and `error: "chrome_exited"` |
| A11 | Cancel sentinel reuses Phase 1 auth checks | Integration | `cli/deskcheck.test.mjs` | Cancel without auth -> 401. Cancel with bad session-id -> 400. Cancel replay -> 409. |
| A12 | Discard succeeds locally even if listener died | Integration | `tests/service-worker-pending-handoff.test.ts` | Arm handoff, stub fetch to reject, dispatch `DISCARD_SESSION` -> assert OPFS session still deleted, `EXPORT_WARNING` broadcast |
| A13 | Schema unchanged | Unit | existing `src/lib/exporter.golden.test.ts` | Already pins schema_version. Must pass without modification. |
| A14 | Existing grep tests still pass | Unit | existing `tests/content-no-handoff-write.test.ts` + `tests/sidepanel-no-handoff-write.test.ts` | The new `marker-detector.ts` does NOT import `handoff-store` or `handoff-post`. It imports only `handoff-marker.ts` (which is a pure module with no chrome imports). The grep test's `FORBIDDEN_IMPORTS` list (`handoff-store`, `handoff-post`, `lib/handoff"`, `lib/handoff'`) does NOT match `handoff-marker` -- so the test passes without changes. |

### Manual-verify Checklist

The implementer must walk through these and document results in the PR description:

- [ ] **Happy path**: `make build && node cli/deskcheck.mjs record https://example.com --out ./sessions`. Blue "OPEN" badge appears. Click toolbar action. Side panel shows "Connected to terminal session <id>". Click Start. Do something on page. Click Stop. Zip lands at `./sessions/<id>.zip`. CLI exits 0 with JSON summary.
- [ ] **Cancel path**: `node cli/deskcheck.mjs record https://example.com`. Click toolbar action. Click Discard in side panel. CLI exits 5 with `{"error":"cancelled",...}`.
- [ ] **Isolated profile**: `make build && node cli/deskcheck.mjs record https://example.com --profile isolated`. Fresh Chrome window opens with extension loaded. Record a session. Confirm `~/Library/Application Support/Google/Chrome` is not modified (run `find ~/Library/Application\ Support/Google/Chrome -newer /tmp/before` after the test run).
- [ ] **Chrome not installed**: `CHROME_BIN=/nonexistent node cli/deskcheck.mjs record https://example.com`. Assert CLI exits with code 3 and a descriptive error.
- [ ] **Hash router page**: `node cli/deskcheck.mjs record "https://app.example.com/#/login"`. Confirm the page's hash router still works (the app navigates to `/login`), the marker is stripped, and the session records the clean URL.

---

## 5. Open Questions Explicitly Resolved

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | **Marker grammar: `v1.` prefix (Quality) vs `:v1` suffix (Safety) vs no version (Speed)?** | `:v1` suffix. Full format: `ID:TOKEN:PORT:v1`. | Suffix preserves the roadmap's `ID:TOKEN:PORT` ordering while adding a version field. Colon separator is consistent throughout. The content script rejects markers without `:v1`. |
| 2 | **Should badge state survive SW eviction?** | Yes, via `chrome.storage.local` + sync mirror. | Storage survives eviction. The sync mirror is rehydrated on wake. `chrome.action.onClicked` is sync and must read from the mirror. |
| 3 | **Should cancel sentinel failure surface an `EXPORT_WARNING`?** | No, silently swallow. | The user clicked Discard intentionally. The CLI will time out on its own. A confusing warning would make the user think Discard failed. |
| 4 | **Is one e2e test enough?** | Yes. One e2e for the success path, gated on `RUN_CHROME_TESTS=1`. | The cancel path is thoroughly covered by SW + CLI integration tests. Adding a second e2e doubles the Chrome extension load cost for marginal coverage. |
| 5 | **Should `findChrome` probe `which google-chrome`?** | No. Canonical `.app` paths only + `CHROME_BIN` env var override. | Shell-out probes open an injection surface via `$PATH` poisoning. `CHROME_BIN` is the explicit escape hatch. |
| 6 | **Should we add `notifications` permission?** | No. Badge + CLI stderr is sufficient for v1. | Minimising permissions is a Phase 1 invariant. Revisit if dogfooding shows the badge alone is insufficient. |
| 7 | **Should the existing paste affordance be hidden when a pending handoff is set?** | No, keep visible below the badge. | The user can still paste a different listener if the auto-detected one is broken. Diagnostics benefit. |
| 8 | **Should `record` auto-build `dist/` for `--profile isolated`?** | No, fail fast with "run `make build` first". | Auto-build adds a Make dependency to a Node CLI and doubles complexity. Clear error message is sufficient. |
| 9 | **JSON summary fields: parse zip or trust summary block?** | Trust the exporter's summary block in `session.json`. | The summary block is pinned by the golden zip test. Parsing the zip with Node's stdlib is possible (the zip is already on disk) but adds unnecessary complexity. |
| 10 | **Should the toolbar click auto-start the session (Safety plan's `START_FROM_HANDOFF`)?** | No. Open the panel and pre-populate; user clicks Start. | The user should verify PII mode and session settings before recording. Two clicks is acceptable. Auto-start removes user agency in a security-relevant decision. |
| 11 | **Action badge interaction with recording badge** | `MARKER_DETECTED` handler guards with `if (isSessionInFlight()) return` for the badge display (still arms the pending handoff). A marker arriving mid-recording is silently dropped from badge display but stored. | The user should not be running `deskcheck record` mid-session. If they do, the pending entry waits in storage. |
| 12 | **Cancel sentinel content type** | `application/x-deskcheck-cancel`. No new endpoint. | Reuses the same `/upload` endpoint and all Phase 1 security checks. Less RESTful than `DELETE` but zero new surface area. |
| 13 | **Marker survives cross-frame navigation?** | Yes. The `document_start` script writes to storage before any redirect. The storage write persists regardless of subsequent navigations. | The marker is parsed and stored at `document_start` of the first URL. A JS redirect creates a new navigation, but the storage write has already completed. |
| 14 | **Two concurrent `deskcheck record` runs** | Supported via per-tab pending-handoffs map. Each tab's pending entry is independent. | The per-tab storage key means two `deskcheck record` runs target two different tabs, each with their own pending handoff. The `armedSessions` Set on the CLI side ensures each listener only accepts its own session-id. |
| 15 | **Should `record` quit the launched Chrome on success?** | Quit ONLY when `--profile isolated` was used, by killing the spawned child. When `--profile existing`, leave Chrome alone. | Killing the user's main Chrome would be hostile. An orphan isolated-profile Chrome with a temp dir is messy. |
| 16 | **`discardPendingIfArmed` should run even when `currentStatus === "idle"`?** | Yes. The Discard button in the side panel on a pre-session pending state sends `CANCEL_PENDING_HANDOFF` (a new message type), which clears the pending entry and POSTs the cancel sentinel. | The user can open the panel, see the badge, and decide to cancel before starting. The CLI must receive the cancel signal. |
| 17 | **Should the content-script grep test be updated?** | No changes needed. The new `marker-detector.ts` imports `handoff-marker.ts`, not `handoff-store`, `handoff-post`, or `lib/handoff`. The forbidden-imports list does not match `handoff-marker`. Verified against the actual grep test. | The marker detector writes to `chrome.storage.local` directly using the `STORAGE_PENDING_HANDOFFS` constant from `constants.ts` -- this is a different key from `deskcheck_handoff` and a different module from `handoff-store.ts`. |
| 18 | **Marker version field rejection for unknown versions?** | Yes. `parseMarker` returns null for any version other than `v1`. No `--legacy-marker` escape hatch. | `v1` is the only version. Version mismatches should fail loudly. |
| 19 | **`record` vs `listen` listener code sharing** | One file (`cli/deskcheck.mjs`) with `handleRequest` gaining a cancel-sentinel branch and optional `armedSessions` parameter. The `record` subcommand lives in a separate file (`cli/deskcheck-record.mjs`) that imports `startListener` and extends it. `listen` never passes `armedSessions`, preserving Phase 1 behaviour exactly. | Single `handleRequest` chokepoint means all security checks apply uniformly. The mode difference is just "does `armedSessions` exist in the context." |

---

## Definition of Done (Final)

- [ ] `deskcheck record <url>` ships with `--timeout`, `--profile`, `--json`, `--port`, `--out` flags
- [ ] On success, prints JSON summary to stdout and exits 0
- [ ] On timeout/cancellation/error, exits non-zero with structured error JSON
- [ ] Content script detects `#_deskcheck=ID:TOKEN:PORT:v1` at `document_start` and strips it before any timeline event
- [ ] SW arms a per-tab pending handoff on `MARKER_DETECTED` and shows a blue `OPEN` badge
- [ ] Toolbar click with pending handoff opens the side panel, promotes the pending entry to `deskcheck_handoff`
- [ ] Side panel shows "Connected to terminal session <id>" badge (token never rendered)
- [ ] Pause / Resume / Stop / Discard behave exactly as today
- [ ] Discard cancels the pending handoff and the CLI receives a cancelled exit code
- [ ] `--profile isolated` spins a dedicated user-data-dir with `--load-extension=dist/`
- [ ] macOS-native Chrome launch works end-to-end (manual verified)
- [ ] Linux/Windows noted as future work in docs
- [ ] `record` listener binds 127.0.0.1 only (test pinned)
- [ ] `record` listener rejects unarmed session-ids with 403 (test pinned)
- [ ] Token never lands in `session.json` (property test)
- [ ] SW defence-in-depth: `START_SESSION` re-strips marker from `msg.url`
- [ ] Cross-tab contamination prevented (integration test)
- [ ] Chrome crash watchdog exits CLI non-zero
- [ ] Cancel sentinel reuses Phase 1 auth + replay checks
- [ ] Existing Phase 1 tests pass without modification
- [ ] Golden export test unchanged
- [ ] Content-script and sidepanel grep tests unchanged
- [ ] No schema bump in `agents-doc.ts`
- [ ] `make test && make typecheck && make build` all green
- [ ] Documentation updated (ARCHITECTURE.md, README, PRIVACY.md)

---

## Testing Strategy (Final)

- **Unit** (14 test files, ~700 LOC): marker grammar corpus, pending-handoff store, orchestration helpers, cancel sentinel, content-script marker detection, badge view-model, chrome-launcher, manifest assertions, exit codes.
- **Integration** (4 test files, ~400 LOC): CLI record subcommand spawn tests, SW pending-handoff wiring matrix (MARKER_DETECTED, onClicked promotion, DISCARD cancel, cross-tab isolation, token-not-in-initial-url), CLI cancel sentinel protocol tests, CLI armedSessions rejection.
- **E2E** (1 test file, gated): Full flow -- real CLI + real Chrome + real extension. Gated on `RUN_CHROME_TESTS=1`. Not in CI by default.
- **Manual** (5 items): Happy path, cancel path, isolated profile, Chrome-not-found, hash-router page.

**Determinism**: all automated tests are fully deterministic. No live Chrome (except gated e2e), no LLM calls, no live network. CLI tests use `DESKCHECK_FAKE_CHROME=1` env to bypass `findChrome`.

---

## Risk Mitigations (Final)

1. **Chrome launch fails silently**: mitigated by the crash watchdog (`child.on('exit')`) and the CLI's timeout. User sees descriptive stderr.
2. **Marker token leak in session.json**: mitigated by two-layer strip (content script at `document_start` + SW defence-in-depth in `START_SESSION`), both independently tested.
3. **Cross-tab session contamination**: mitigated structurally by tab-keyed pending-handoff map. Integration test pins isolation.
4. **SW eviction loses pending handoff**: mitigated by `chrome.storage.local` persistence. Sync mirror rehydrated on wake.
5. **Phase 2 breaks Phase 1**: mitigated by all Phase 1 tests running unchanged. Rollback is a single manifest entry comment-out.
6. **Cancel sentinel races with export**: the cancel sentinel and zip upload both go through `usedSessions` -- whichever arrives first wins, second gets 409. No double-delivery.
7. **`--profile isolated` leaks state to main Chrome profile**: mitigated by `mkdtemp` under `os.tmpdir()`, `--user-data-dir` flag, cleanup on exit, and manual-verify checklist.

---

## Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | Y (mild) | N | Y | Y |
| State machine | N | N | Y | N |
| Conservation | Y (inherited) | N | Y | N |
| Authorization | N | N | Y | N |

**Recommendation**: SKIP full TLA+/TLC. The concurrency concern (two `deskcheck record` runs) is addressed structurally by per-tab pending-handoffs and per-listener `armedSessions` Sets. Property tests in `tests/service-worker-pending-handoff.test.ts` cover the cross-tab isolation invariant. The state transitions for pending handoffs (armed -> consumed | expired | tab-closed) are simple enough to verify with unit tests rather than model checking.

**Key invariants** (verified by tests, not TLC):
- I1: Marker token never appears in any exported `session.json`
- I2: A session zip uploaded to a `record` listener was armed by that same CLI invocation
- I3: A pending handoff bound to tab T is consumed only by a session started on tab T
- I4: The `listen` subcommand's behaviour is identical before and after Phase 2

---

## Effort Estimate

| Step | Effort |
|------|--------|
| 1. Marker module + corpus tests | 0.5 day |
| 2. Pending-handoff store + tests | 0.25 day |
| 3. Orchestration helper + cancel sentinel + tests | 0.5 day |
| 4. Marker detector content script + tests | 0.25 day |
| 5. Manifest + Vite + manifest test | 0.1 day |
| 6. Service worker wiring + tests + extract helper | 1.0 day |
| 7. Side panel badge + tests | 0.5 day |
| 8. CLI chrome-launcher + tests | 0.5 day |
| 9. CLI cancel branch + armedSessions + tests | 0.5 day |
| 10. CLI deskcheck-record + tests + watchdog | 1.0 day |
| 11. E2E smoke (gated) | 0.5 day |
| 12. Docs | 0.5 day |
| 13. Manual walkthrough | 0.25 day |
| Buffer for test debug + Chrome version surprises | 1.0 day |
| **Total** | **~7.5 person-days** |

---

## Orchestrator Handoff

This evaluation is the **final decision**. The orchestrator will:
1. Commit all plans to `docs/plans/feature-14-phase-2/` for audit trail
2. Use the Test Level Matrix to generate acceptance tests at the correct levels
3. Proceed directly to implementation

**Summary for git commit**:
- Selected plan: Quality (synthesized with Safety elements)
- Key rationale: Load-bearing security-adjacent infrastructure deserves quality modules + targeted safety hardening
- Estimated effort: 7.5 person-days
- Key risks: Chrome launch reliability, token leak in session.json, cross-tab contamination, SW eviction
- Test levels: ~18 unit, ~6 integration, 1 e2e (gated), 5 manual-verify items
