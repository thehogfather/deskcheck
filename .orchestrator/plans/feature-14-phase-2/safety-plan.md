---
agent: safety-planner
generated: 2026-04-11T00:00:00Z
task_id: feature-14-phase-2
perspective: safety
---

# Safety Plan: Feature #14 Phase 2 — `deskcheck record <url>`

> Optimization focus: **harden failure modes**. Every section below names a specific way Phase 2 can leak a token, mis-bind a session, or fail silently, and proposes a concrete defence.

---

## 1. Executive summary

- **Ship a CLI subcommand `deskcheck record <url>` that reuses Phase 1 `startListener` unchanged**, plus a 90-line Chrome launcher (`cli/launch-chrome.mjs`) that wraps `child_process.spawn` against the absolute Chrome binary path. The `listen` subcommand is untouched — that is the rollback lever.
- **Hash-fragment marker is opaque, single-use, and CLI-validated.** Format `#_deskcheck=<sid>:<token>:<port>:<v>`. The CLI listener keeps a Set of *armed session ids* it just emitted; any POST whose `X-DeskCheck-Session-Id` is not in that Set returns 403 (not 401, so we can distinguish from token brute force in logs). A page that pre-populates its own hash with a guessed marker cannot mint a sid the CLI armed.
- **Token never lands in `session.json`.** The content script strips the marker via `history.replaceState` at `document_start` BEFORE any other DeskCheck code runs. Sender-side defence-in-depth: the SW also runs `stripDeskcheckMarker(url)` on `msg.url` inside `START_SESSION` before calling `buildSessionMetadata`. Two layers, both independently tested.
- **Pending handoffs are tab-scoped, in-memory, and self-expire after 5 minutes.** No new `chrome.storage.local` key. Cross-tab contamination is structurally impossible because each tab has at most one entry, and the SW resolves `msg.tabId` → entry on START_SESSION.
- **Discard signals the CLI via a sentinel POST** (`X-DeskCheck-Cancelled: 1`, empty body, same auth header). The `record` listener wakes, exits non-zero with `{error: "cancelled"}`. No new HTTP verb, no new endpoint — Phase 1's transport surface stays minimal.
- **Watchdog + timeout + visible stderr ticks.** `record` prints a heartbeat every 5s to stderr ("waiting for session… 10s elapsed"). Default `--timeout 600`. Chrome process death is detected via `child.on('exit')` and triggers a non-zero exit. The user-data-dir for `--profile isolated` is created under `mkdtemp(tmpdir(), "deskcheck-chrome-")`, registered with a `process.on('exit')` cleanup, and its path is printed to stderr so the user can inspect it after a crash.

---

## 2. Proposed architecture

### 2.1 File list (new + modified)

| File | New / Mod | Role |
|---|---|---|
| `cli/deskcheck.mjs` | mod | Add `record` subcommand. Reuses `startListener` from Phase 1 unchanged. New helpers: `armSession`, `awaitSessionUpload`, `installWatchdog`. |
| `cli/launch-chrome.mjs` | new | Pure-ish module: `findChromeBinary()`, `launchChrome({url, profile, userDataDir, extensionDir})`. Returns `{child, userDataDir, cleanup}`. macOS-only path resolution. |
| `cli/marker.mjs` | new | Pure module shared with extension: `buildMarker({sid, token, port, v})`, `parseMarker(hashFragment)`, `injectMarkerIntoUrl(url, marker)`. Same parsing rules on both sides. |
| `cli/deskcheck.test.mjs` | mod | Add `record` subcommand tests. Marker injection round-trip test. Loopback bind test for record subcommand (D5 mirror). Forged-marker rejection. Discard sentinel acceptance. Watchdog timeout. Cleanup of isolated user-data-dir. |
| `cli/launch-chrome.test.mjs` | new | Pure tests for `findChromeBinary` (with stubbed `existsSync`) and `injectMarkerIntoUrl` against a 12-row corpus including `#/login`, empty path, query strings, IPv6. Skipped suite that actually spawns Chrome (gated on `RUN_CHROME_TESTS=1` env). |
| `src/lib/marker.ts` | new | TypeScript twin of `cli/marker.mjs`. Pure: `parseMarker`, `stripMarker(url)`. Re-implements (does not import) the parser so the extension has zero CLI imports. Both modules tested against a shared corpus JSON. |
| `src/lib/marker.test.ts` | new | Adversarial corpus tests. Cases below in §4. |
| `src/content/marker-detect.ts` | new | NEW slim content script. Runs at `document_start`. Single responsibility: parse `location.hash`, if it matches the marker, `history.replaceState` to strip it, then `chrome.runtime.sendMessage({type: "DESKCHECK_MARKER", marker})`. NEVER touches DOM. NEVER imports the recorder. |
| `src/content/marker-detect.test.ts` | new | jsdom unit test pinning the strip-and-preserve algorithm against the corpus. |
| `src/content/index.ts` | unchanged | Phase 1 `document_idle` recorder is untouched. |
| `manifest.json` | mod | Add a SECOND `content_scripts` entry: `marker-detect.js` at `run_at: "document_start"`, `all_frames: false`, `match_about_blank: false`. The existing recorder entry is unchanged. |
| `src/background/service-worker.ts` | mod | New message handler `DESKCHECK_MARKER`. New in-memory `pendingHandoffs: Map<tabId, PendingHandoff>` with a 5-minute TTL via `setTimeout`. Modified `START_SESSION` to (a) re-strip the marker from `msg.url`, (b) consume the pending handoff for `msg.tabId` and write it to `chrome.storage.local['deskcheck_handoff']` ONLY for the duration of that session. New helper `armBadgeForPendingHandoff(tabId)` sets a badge text "ARM" with a tooltip "Click to start CLI session". New `chrome.action.onClicked` branch: if a pending handoff exists for the clicked tab, the gesture-window opens the panel AND fires `START_SESSION` synchronously through a new `START_FROM_HANDOFF` shortcut so the user gesture is consumed by the same click. New SW logic in `EXPORT_SESSION` and `DISCARD_SESSION` to clear the pending handoff entry and (for discard) POST the cancel sentinel. |
| `src/sidepanel/sidepanel.ts` | mod | Add a "Connected to terminal session <id>" badge chip in the toolbar region. Reads from a new SW message `GET_PENDING_HANDOFF` on mount, AND subscribes to runtime broadcasts `PENDING_HANDOFF_ARMED` / `PENDING_HANDOFF_CLEARED`. Token never rendered. |
| `src/types.ts` | mod | Add `DESKCHECK_MARKER`, `PENDING_HANDOFF_ARMED`, `PENDING_HANDOFF_CLEARED`, `GET_PENDING_HANDOFF`, `START_FROM_HANDOFF` message types. |
| `src/background/handoff-cancel.ts` | new | Pure: `sendCancelSentinel(config, sessionId, fetchImpl)` — POSTs `application/x-deskcheck-cancel` with `X-DeskCheck-Cancelled: 1` header and empty body. Mirrors `handoff-post.ts` in shape. |
| `cli/deskcheck.mjs` (handler) | mod | `handleRequest` recognises the cancel sentinel and resolves the awaiting `record` promise with `{kind: "cancelled"}`. Returns 202. Does NOT mark the session id used (so a re-record with the same sid is permitted on the next CLI run). |
| `docs/ARCHITECTURE.md` | mod | New "CLI handoff (phase 2)" section with the marker grammar, the pending-handoff lifecycle diagram, and the gesture model. |
| `PRIVACY.md`, README, first-run notice | mod | Mention the auto-launch path as opt-in. README adds a `deskcheck record` walkthrough. |
| `Makefile` | mod | New `make record` target wrapping `node cli/deskcheck.mjs record` for dogfooding. New `make e2e-record` target gated on `RUN_CHROME_TESTS=1`. |

### 2.2 Component responsibilities

```
┌──────────────┐  spawn  ┌────────────┐  http GET URL+#marker  ┌───────────────┐
│ deskcheck    │────────►│  Chrome    │───────────────────────►│  Target page  │
│ record CLI   │         │ (isolated  │                        │               │
│              │  POST   │ user-data- │   ┌──────────────────┐ │               │
│ - listener   │◄────────│  dir)      │   │ marker-detect.ts │◄┤ document_start
│ - launcher   │ /upload │            │   │ (content script) │ │               │
│ - watchdog   │         │            │   │ strip + send     │ │               │
└──────┬───────┘         │            │   └─────┬────────────┘ │               │
       │ stdout          │            │         │              │               │
       ▼                 │            │         ▼              │               │
   { json }              │            │   ┌─────────────┐      │               │
                         │  badge ARM │   │ SW pending  │      │               │
                         │            │◄──┤ handoff map │      │               │
                         │            │   │ (in-memory) │      │               │
                         │            │   └─────────────┘      │               │
                         └────────────┘                        └───────────────┘
                              │
                              │ user click toolbar (gesture)
                              ▼
                       ┌────────────────────┐
                       │  Side panel opens, │
                       │  pre-bound badge,  │
                       │  start session     │
                       └────────────────────┘
```

Explicit non-responsibilities (load-bearing):
- The marker-detect content script does NOT touch the recorder. The recorder still runs at `document_idle` and is unchanged.
- The pending-handoff Map lives ONLY in SW memory. SW eviction wipes it. This is a feature: a pending handoff that survives an SW wake is not actionable (the awaiting CLI may have died) so dropping it is correct.
- The CLI does NOT inspect `chrome.storage.local`. Phase 1's structural invariant — listener URL/token never enter `SessionMetadata` — is preserved by the SW writing the handoff config to `deskcheck_handoff` and clearing it on EXPORT/DISCARD. The pending-handoff Map and `deskcheck_handoff` are distinct stores.

### 2.3 Hash-fragment marker grammar

```
marker        := "_deskcheck=" sid ":" token ":" port ":" version
sid           := /[A-Za-z0-9_-]{8,64}/      ; opaque, CLI-generated, randomBytes(16).hex by default
token         := /[a-f0-9]{32,128}/         ; same shape as Phase 1 bearer
port          := /[1-9][0-9]{0,4}/          ; 1..65535
version       := "v1"
```

Rules:
1. The marker is the LAST hash component. If the URL already has a hash (`https://app.example.com/#/login`) we APPEND ours after a literal `&`, so the in-page URL becomes `https://app.example.com/#/login&_deskcheck=…`. The strip algorithm splits on `&_deskcheck=` and keeps the prefix. If there is no existing hash, the URL becomes `https://app.example.com/page#_deskcheck=…` and strip yields `https://app.example.com/page` (no trailing `#`).
2. Strip preserves the existing hash router. `#/login&_deskcheck=...` → `#/login`. `#/login` → `#/login` (no-op, no marker).
3. The strip algorithm is `splitByMarker(url)` and is implemented identically in `cli/marker.mjs` and `src/lib/marker.ts`. Both modules are tested against a shared corpus `cli/__fixtures__/marker-corpus.json` so they cannot drift.
4. **Why `&` separator instead of `?`/`;`?** Hash routers like React Router treat `&` as a query separator inside the hash. A naive router will route to `/login` and ignore `&_deskcheck=…` because the marker key starts with `_`, which is conventional for "do not route". A `?` would be routed by some routers and could be reflected back to the recorder's `to_url`. We pin a regression test for this.
5. **Why a version field?** So a future Phase 3 marker change is structurally rejectable. The CLI emits `v1`; the content script rejects markers without a known version.

### 2.4 Chrome launch strategy (macOS-first)

- **Binary discovery.** `findChromeBinary()` checks, in order: `CHROME_BIN` env var, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`, `~/Applications/Google Chrome.app/...`. First hit wins. Returns null → CLI exits with `{error: "chrome_not_found", searched: [...]}`. Linux/Windows fallthrough is a single `console.error` saying "macOS only — see docs/cli-record.md".
- **Spawn.** `child_process.spawn(binary, args, {detached: false, stdio: ["ignore", "ignore", "pipe"]})`. We discard stdout (Chrome is noisy) but keep stderr piped because Chrome warning lines about extension loading help debugging. The CLI prefixes stderr lines with `chrome:` so they don't get mistaken for CLI output.
- **`open -na` is rejected.** It detaches from the CLI process so we cannot watch Chrome's exit, cannot reliably pipe stderr, and on a system with multiple Chrome windows it brings the existing one to the front instead of spawning a new instance. Direct `spawn` of the binary is unambiguous.
- **`--profile isolated`.** `mkdtemp(join(tmpdir(), "deskcheck-chrome-"))`, then args `["--user-data-dir=" + udd, "--load-extension=" + extDir, "--no-first-run", "--no-default-browser-check", "--disable-component-update", "--password-store=basic", url]`. The `--password-store=basic` is critical on macOS — without it Chrome prompts for the keychain password on first launch and the launcher would silently hang waiting for user input.
- **`--profile existing`.** Args reduce to `[url]`. We rely on the user's already-installed extension. We do NOT pass `--user-data-dir` because that would force a new profile against the user's normal profile directory and corrupt it. Documented prominently.
- **Cleanup.** For `--profile isolated`, register `process.on('exit', () => rmSync(udd, {recursive: true, force: true}))` AND a `SIGINT`/`SIGTERM` handler that runs the same. The path is also printed to stderr at launch time so a CLI crash leaves the user a forensic copy. macOS leaves no files outside `udd` for a self-contained `--user-data-dir` (verified by manually grepping `~/Library/Application Support/Google/Chrome` after a test run; this is documented in the test plan as a manual-verify item).
- **Crash watchdog.** `child.on('exit', (code) => { if (!sessionReceived) finish({kind: "chrome_exited", code}); })`. The CLI exits non-zero with the Chrome exit code. Without this, Chrome dying mid-record would leave the CLI blocked forever.

### 2.5 Pending-handoff storage

In-memory only, in the service worker:

```ts
interface PendingHandoff {
  sessionId: string;       // CLI-armed sid
  token: string;
  port: number;
  listenerUrl: string;     // `http://127.0.0.1:${port}`
  armedAt: number;         // Date.now()
  expiresAt: number;       // armedAt + 5*60*1000
  expiryTimer: number;     // setTimeout handle
}
const pendingHandoffs = new Map<number /* tabId */, PendingHandoff>();
```

- **Key is `tabId`**, not sessionId. This makes cross-tab contamination structurally impossible: tab A's pending entry cannot be read by tab B.
- **5-minute TTL** because a user who has not clicked Start in 5 minutes has likely abandoned the flow. Expiry clears the badge and broadcasts `PENDING_HANDOFF_CLEARED` to any open side panel.
- **SW eviction wipes it.** That's fine — see §2.2 non-responsibilities.
- **Tab close clears it.** `chrome.tabs.onRemoved` listener calls `pendingHandoffs.delete(tabId)`.
- **Why not `chrome.storage.local`?** Persistence is a footgun: a pending handoff that survives a Chrome restart would let an attacker who controls a page on that tab fire the bound listener URL much later. In-memory + SW-eviction is the right TTL.
- **Why not `chrome.storage.session`?** It survives SW eviction but not browser restart. We could use it as a defence-in-depth tier but it adds complexity for no concrete win — the in-memory Map is enough because the failure mode (SW evicts before user clicks) is already covered by the badge-and-CLI-watchdog combination.

### 2.6 Panel-open gesture strategy

`chrome.sidePanel.open()` requires a user gesture. The content script triggering on page load is **not** a gesture in Chrome's eyes. We therefore:

1. **Show a visible cue.** When the SW receives `DESKCHECK_MARKER` from `marker-detect.ts`, it sets a tab-scoped badge text `"REC?"` (existing badge code is reused with a new color: `#f59e0b` amber). The action's `title` is set to `"DeskCheck: terminal session armed — click to start"`. The user knows the toolbar action is the next step.
2. **The user clicks the toolbar action.** `chrome.action.onClicked` fires with the same gesture token the panel-open path needs. The handler checks `pendingHandoffs.has(tab.id)` BEFORE its existing `enablePanelOnTab` + `chrome.sidePanel.open` calls. Both are still synchronous within the gesture window — this preserves the Phase 1 invariant.
3. **The handler also fires START_SESSION immediately** (NOT awaited) so the side panel sees the running session on first render. This is new: today the user must click Start in the panel after the panel opens. For a CLI-armed session we shortcut that click because the user's intent is obvious and the badge has been their explicit ack.
4. **`START_FROM_HANDOFF` is the new path.** It writes the pending handoff into `chrome.storage.local['deskcheck_handoff']` (so the existing `EXPORT_SESSION` Phase 1 path can read it without modification), then dispatches the existing `START_SESSION` flow. The pending-handoff Map entry stays in place until `EXPORT_SESSION` or `DISCARD_SESSION` clears both stores.
5. **Edge: panel was already open on a different tab when the marker fires.** The badge cue still shows on the marker tab. The user has to click the toolbar action on the marker tab — and the existing onClicked logic re-routes to the recording tab if a session is in flight, OR opens a new panel binding on the marker tab if not. We pin both paths in tests.
6. **Why not auto-open?** Because Chrome would reject the open() call without a gesture, the SW would log a warning, and the user would see no UI cue at all — the silent-failure mode the brief is asking us to harden against. The amber badge is the visible cue that converts "silent rot" into "user knows what to click".

---

## 3. Implementation sequence

Each step is independently testable. After every step, `make test && make typecheck` must be green.

1. **Marker module + corpus tests** (TS + JS twins)
   - Add `cli/__fixtures__/marker-corpus.json` (12+ rows, see §4 for required cases).
   - Add `src/lib/marker.ts` with `parseMarker`, `stripMarker`, `injectMarkerIntoUrl` (SW + content side).
   - Add `cli/marker.mjs` with the same functions.
   - Add `src/lib/marker.test.ts` and extend `cli/deskcheck.test.mjs` to test the JS twin against the same corpus.
   - Tests pin: forged markers (wrong version, missing port, oversized sid) are rejected; existing hash routers are preserved; round-trip is byte-equal.
   - **Safety gate**: 100% corpus coverage. CI blocks on any drift between TS and JS implementations.

2. **CLI `record` subcommand (no Chrome launch yet)**
   - Extend `parseArgv` to recognise `record <url> [--timeout S] [--profile existing|isolated] [--json] [--port N] [--out DIR]`.
   - Add `armSession()` that generates a sid, calls `startListener()` (Phase 1), and returns `{ready, sid, port, token, marker, listenerUrl}`.
   - Add `awaitSessionUpload({ready, sid, timeoutMs, onCancelled})` that returns a Promise resolving to `{kind: "ok", path}` / `{kind: "cancelled"}` / `{kind: "timeout"}` / `{kind: "transport_error", reason}`.
   - Modify `handleRequest` in `cli/deskcheck.mjs` so that:
     - It only accepts uploads whose `X-DeskCheck-Session-Id` is in the `armedSessions` Set (returns 403 otherwise — distinct from 401 token-mismatch). For backward compatibility, the `listen` subcommand keeps the Phase 1 behaviour (no armedSessions filter).
     - It recognises the cancel sentinel (`Content-Type: application/x-deskcheck-cancel`, empty body) and resolves the awaiter with `{kind: "cancelled"}`.
   - Stub the Chrome launch: at this step `record` just prints the marker URL to stderr and waits.
   - Add tests:
     - `record-without-chrome` test that POSTs a zip to the listener with the armed sid → 201, CLI exits with `{kind: "ok"}`.
     - `record-rejects-unarmed-sid` test that POSTs with a different sid → 403.
     - `record-cancel-sentinel` test that POSTs the sentinel → CLI exits non-zero with stdout `{error: "cancelled"}`.
     - `record-loopback-bind` test mirroring D5 — the `record` subcommand's listener also binds 127.0.0.1 only.
     - `record-watchdog` test that uses `--timeout 1` and asserts non-zero exit + stderr containing "timed out".

3. **Chrome launcher (no extension wiring yet)**
   - Add `cli/launch-chrome.mjs` with `findChromeBinary` and `launchChrome`.
   - Add `cli/launch-chrome.test.mjs` with `findChromeBinary` tests using a fake `existsSync`.
   - Wire `launchChrome` into the `record` subcommand. After this step, `node cli/deskcheck.mjs record https://example.com --profile isolated` should open a real Chrome, but the extension does nothing yet — the user has to manually click the toolbar action in the launched Chrome window and paste the marker. Manual verify only at this point.
   - **Safety gate**: confirm by manual inspection that `~/Library/Application Support/Google/Chrome` is NOT modified by an `--profile isolated` run. Document the verification in `docs/cli-record.md`.

4. **Marker-detect content script**
   - Add `src/content/marker-detect.ts` (very small — 30 lines).
   - Add `src/content/marker-detect.test.ts` against the corpus.
   - Add the second content_scripts entry in `manifest.json`.
   - Add a `DESKCHECK_MARKER` message handler in `service-worker.ts` that creates a `pendingHandoffs` entry, sets the amber badge, and broadcasts `PENDING_HANDOFF_ARMED`. No START_SESSION yet — manual verify by clicking the toolbar action.
   - **Safety gate**: `tests/service-worker-marker.test.ts` pins that the marker handler ignores messages whose marker fails `parseMarker`, that it dedupes per-tab (a second marker on the same tab replaces the first and clears its expiry timer — no leaked timers), and that it CLEARS the entry on `chrome.tabs.onRemoved`.

5. **Toolbar gesture path**
   - Modify `chrome.action.onClicked` in `service-worker.ts` to check `pendingHandoffs.has(tab.id)` first. If present, fire `START_FROM_HANDOFF` synchronously inside the gesture window AFTER the existing `enablePanelOnTab` + `sidePanel.open` calls.
   - `START_FROM_HANDOFF` writes to `chrome.storage.local['deskcheck_handoff']` and dispatches `START_SESSION`. The existing `EXPORT_SESSION` Phase 1 path then takes care of the POST.
   - **Sender-side defence-in-depth**: inside `START_SESSION`, run `stripMarker(msg.url)` regardless of whether the call came from the side panel or `START_FROM_HANDOFF`. This is the second layer that catches the case where the side panel reads `tab.url` before the content script's `history.replaceState` has propagated.
   - **Safety gate**: `tests/service-worker-marker.test.ts` pins that `initial_url` in `SessionMetadata` never contains `_deskcheck=`. Property test: 50 random URLs with marker injected → strip → assert marker substring absent.

6. **Side panel badge**
   - Add the "Connected to terminal session <id>" chip in the toolbar region. Reads from `GET_PENDING_HANDOFF` on mount. Subscribes to `PENDING_HANDOFF_ARMED` and `PENDING_HANDOFF_CLEARED` broadcasts.
   - Token is NEVER rendered. Only the sid (truncated to 8 chars) is shown.
   - **Safety gate**: `tests/sidepanel-no-handoff-write.test.ts` (existing) is extended to also assert the new badge code does not write `token` into the DOM.

7. **Discard wires the cancel sentinel**
   - Modify `DISCARD_SESSION` to: (a) clear the `pendingHandoffs` entry for the active tab, (b) call `sendCancelSentinel(handoff, sessionId, fetch)` if a handoff is configured. Failures of the sentinel are non-fatal (the session is discarded regardless), but they DO surface a warning to the side panel.
   - **Safety gate**: the OPFS session is deleted REGARDLESS of whether the sentinel succeeds. Race window: user hits Discard while listener has already died → sentinel POST fails with ECONNREFUSED → discard still completes locally. Pinned by `tests/service-worker-discard-handoff.test.ts`.

8. **CLI watchdog + heartbeat**
   - `awaitSessionUpload` runs a `setInterval(5000)` that prints `[deskcheck] waiting for session… Ns elapsed` to stderr. Cleared when the awaiter resolves.
   - `--timeout` default is 600 seconds. 0 means "no timeout, only Ctrl+C exits".
   - On SIGINT during a record run, the CLI: stops the heartbeat, kills the Chrome child (best-effort `child.kill('SIGTERM')` + 2s grace + `SIGKILL`), removes the user-data-dir, then exits 130.
   - **Safety gate**: `cli/deskcheck.test.mjs` adds a SIGINT test that asserts the user-data-dir is removed.

9. **JSON summary on stdout**
   - On `--json` (or by default if `process.stdout.isTTY` is false), the CLI prints `{session_id, path, events, screenshots, duration_s}` as the LAST line of stdout. Heartbeats go to stderr regardless. Cancellation/timeout/error prints `{error, ...}` to stdout AND exits non-zero.
   - The events/screenshots/duration_s come from a quick zip-inspect of the file the listener just wrote. We use fflate (already in the extension dep tree) — but the CLI is supposed to be zero-dep. Compromise: use Node's `node:zlib` + a tiny inline zip-central-directory parser. If that proves fragile, fall back to leaving those fields null and documenting that they require Phase 3.
   - **Safety gate**: stderr and stdout are NEVER intermixed. `cli/deskcheck.test.mjs` asserts the last stdout line of a successful `record` run is parseable JSON.

10. **Documentation, rollback notes, manual verify checklist**
    - Update `docs/ARCHITECTURE.md` with the Phase 2 diagram and the marker grammar.
    - Update README with a `deskcheck record` walkthrough.
    - Update `PRIVACY.md` with the auto-launch path noted as opt-in.
    - Add `docs/cli-record.md` with the manual-verify checklist (isolated user-data-dir cleanup, hash routers, Chrome version compatibility, password-store basic).
    - Add a "Rollback" section: `deskcheck listen` is unchanged and remains the supported path; `deskcheck record` can be disabled by simply not invoking it.

---

## 4. Test Level Matrix

> Ordering: each row is a DoD criterion mapped to a test level + concrete test file. Adversarial tests are explicitly numbered.

| # | DoD criterion | Level | File | Notes |
|---|---|---|---|---|
| **R1** | `deskcheck record <url>` starts listener, launches Chrome, blocks until upload | integration | `cli/deskcheck.test.mjs::record-happy-path` | Stubs Chrome launcher to a fake child that POSTs the zip. Real listener. |
| **R2** | On success, JSON summary on stdout, exit 0 | integration | `cli/deskcheck.test.mjs::record-json-summary` | Asserts last stdout line is JSON-parseable; exit code 0. |
| **R3** | On timeout, structured error to stdout, non-zero exit | integration | `cli/deskcheck.test.mjs::record-timeout` | `--timeout 1`, no upload, exit code != 0, stdout contains `"error":"timeout"`. |
| **R4** | On cancellation (sentinel), structured error, non-zero exit | integration | `cli/deskcheck.test.mjs::record-cancel-sentinel` | POSTs sentinel; CLI exits non-zero with `"error":"cancelled"`. |
| **R5** | Content script detects marker at `document_start` and strips it | unit (jsdom) | `src/content/marker-detect.test.ts` | Asserts `location.hash` is rewritten BEFORE any other code runs; `chrome.runtime.sendMessage` called once with parsed marker. |
| **R6** | Service worker opens side panel bound to that tab | unit | `tests/service-worker-marker.test.ts::badge-armed` | Asserts amber badge is set on `DESKCHECK_MARKER`; asserts `chrome.action.onClicked` for that tab fires `START_FROM_HANDOFF`. |
| **R7** | Side panel shows "Connected to terminal session <id>" badge | unit (jsdom) | `tests/sidepanel-handoff-badge.test.ts` | Mounts panel with mocked `GET_PENDING_HANDOFF` response; asserts badge text contains truncated sid; asserts token is absent from DOM (querySelector + textContent grep). |
| **R8** | Pause/Resume/Stop/Discard behave exactly as today | unit | `tests/service-worker.test.ts` (existing) | No regression — existing tests must still pass without modification. |
| **R9** | Discard cancels pending handoff → CLI receives cancelled response | integration | `tests/service-worker-discard-handoff.test.ts` | Spawns the listener, arms a session, dispatches `DISCARD_SESSION`, asserts the listener observes the cancel sentinel and the OPFS session is deleted. |
| **R10** | `--profile isolated` works on a clean machine | manual | `docs/cli-record.md` | Manual checklist: (a) `mkdtemp` succeeds, (b) Chrome launches with extension loaded, (c) cleanup removes the dir on exit, (d) `~/Library/Application Support/Google/Chrome` unchanged. |
| **R11** | macOS-native Chrome launch works end-to-end | e2e (gated) | `cli/launch-chrome.test.mjs::e2e` | Skipped unless `RUN_CHROME_TESTS=1`. Spawns real Chrome at `about:blank`, asserts process started, kills it, asserts `userDataDir` cleaned. |
| **A1** | **Token never lands in `session.json`** | unit | `tests/service-worker-marker.test.ts::initial-url-stripped` | Property test: 50 random URLs × 50 random markers; for each, dispatch `START_FROM_HANDOFF` with the marked URL, assert `SessionMetadata.initial_url` does not contain `_deskcheck=`. |
| **A2** | **Sender-side strip is the second layer** | unit | `tests/service-worker-marker.test.ts::start-session-restrips` | Even when `START_SESSION` is called directly (bypassing `START_FROM_HANDOFF`), the SW re-strips `msg.url`. Pinned by spy. |
| **A3** | **Forged-marker rejection — wrong sid** | integration | `cli/deskcheck.test.mjs::record-rejects-unarmed-sid` | Listener returns 403 (not 401, not 201) when `X-DeskCheck-Session-Id` is not in the armed Set. No file written. |
| **A4** | **Forged-marker rejection — guessed port** | integration | `cli/deskcheck.test.mjs::record-rejects-cross-listener` | Spawn TWO `record` listeners with different sids on different ports. POST to listener A with listener B's sid → 403. |
| **A5** | **Cross-tab contamination** | integration | `tests/service-worker-marker.test.ts::cross-tab-isolation` | Arm tab A with handoff X, arm tab B with handoff Y. Click action on tab A → tab A's session is wired to listener X, NOT Y. Pinned by spy on `chrome.storage.local.set`. |
| **A6** | **Listener binds 127.0.0.1 only — RECORD subcommand** | integration | `cli/deskcheck.test.mjs::record-loopback-bind` | Mirror of Phase 1 D5: connect from 0.0.0.0 to the record listener's port; assert ECONNREFUSED or non-loopback rejection. |
| **A7** | **Gesture-missing visible cue** | unit | `tests/service-worker-marker.test.ts::badge-shows-when-armed` | Asserts `chrome.action.setBadgeText({tabId, text: "REC?"})` is called on `DESKCHECK_MARKER`; asserts `chrome.action.setTitle` is called with the user-facing prompt. |
| **A8** | **Discard races the POST — listener already died** | integration | `tests/service-worker-discard-handoff.test.ts::discard-with-dead-listener` | Arm a handoff, kill the listener process, dispatch `DISCARD_SESSION`, assert the local OPFS session is still deleted and `EXPORT_WARNING` is broadcast (not thrown). |
| **A9** | **Discard races Stop & Download** | unit | `tests/service-worker.test.ts::discard-after-stop-noop` | Stop transitions to `stopped`. Subsequent Discard either no-ops (status machine guard) or completes the deletion. Either is acceptable; the test pins which one and prevents accidental regression. |
| **A10** | **Chrome crashes mid-record** | integration | `cli/deskcheck.test.mjs::record-chrome-exit-aborts-cli` | Stub the launcher to spawn `node -e 'process.exit(7)'`. Assert CLI exits with code 7 and `error: chrome_exited`. |
| **A11** | **macOS isolation escape** | manual | `docs/cli-record.md` | Manual checklist: list every file Chrome creates, confirm none are outside `--user-data-dir`. Run `find ~/Library/Application\ Support/Google/Chrome -newer /tmp/before` after a `record` run; assert empty. |
| **A12** | **Marker survives existing hash routers** | unit | `src/lib/marker.test.ts::corpus-hash-router` | Corpus row: `https://app.example.com/#/login` injected → `https://app.example.com/#/login&_deskcheck=...` → strip → `https://app.example.com/#/login`. |
| **A13** | **Marker version field rejection** | unit | `src/lib/marker.test.ts::reject-unknown-version` | A marker with `:v2` is rejected by `parseMarker` (returns null). |
| **A14** | **Pending-handoff TTL** | unit (fake timers) | `tests/service-worker-marker.test.ts::pending-handoff-expires` | Arm a handoff, advance fake timers 5 minutes, assert entry is gone and `PENDING_HANDOFF_CLEARED` was broadcast. |
| **A15** | **Tab close clears pending handoff** | unit | `tests/service-worker-marker.test.ts::pending-handoff-clears-on-tab-close` | Dispatch `chrome.tabs.onRemoved` for the tab; assert entry gone, expiry timer cleared (no leak). |
| **A16** | **`--profile isolated` cleanup on SIGINT** | integration | `cli/deskcheck.test.mjs::record-sigint-cleanup` | Spawn record, send SIGINT, assert the user-data-dir is removed and exit code is 130. |
| **A17** | **No marker in `session.json`** | unit (golden) | `src/lib/exporter.golden.test.ts` (existing) | Golden file is unchanged. Adding the marker code paths must not change the golden. |
| **A18** | **Manifest second content_scripts entry is `document_start` and only the slim script** | unit | `tests/manifest.test.ts` (new — small) | Asserts `manifest.json.content_scripts[1].run_at === "document_start"` and `js === ["src/content/marker-detect.js"]`. Also asserts the recorder entry is unchanged. |
| **A19** | **Token redaction in console.warn paths** | unit | `tests/service-worker-marker.test.ts::redact-on-error` | Trigger a marker handler error; assert the captured console.warn arguments do NOT contain the token (use `redactToken` from Phase 1). |
| **A20** | **`listen` subcommand is unchanged** | regression | `cli/deskcheck.test.mjs` (all D-series tests) | Phase 1 D1, D2, D4, D5, D7, D8a–c, S13–S17 must still pass without modification. |

**Test count budget**: ~25 new unit tests, ~8 new integration tests, 1 gated e2e, 2 manual checklists. Estimated runtime impact: +6 seconds on `make test` (the new tests are fast), +0 seconds default on `make e2e` (record e2e is gated).

**Determinism rule**: zero LLM calls. The Chrome launch tests are gated behind `RUN_CHROME_TESTS=1` so the default `make test` does not depend on Chrome being installed.

---

## 5. Risks and tradeoffs

The defences in this plan add work in three places. The cost of NOT paying that cost is described first.

### 5.1 Failure modes we are hardening (cost is justified)

| Failure mode | Hardening | Cost | Why we accept the cost |
|---|---|---|---|
| **Token in session.json** | Two-layer strip: content script at `document_start` + SW re-strip in `START_SESSION`. Property test on 2500 combinations. | +1 file (marker-detect.ts), +1 manifest entry, +1 SW helper, +20 LoC of tests. | A leaked token is a credential leak. The user could share the zip with an LLM/colleague/upload it. The blast radius is "anyone with the zip can POST to the loopback listener while it's running" — small blast in absolute terms but unbounded in trust impact. |
| **Forged marker** | CLI maintains an `armedSessions` Set and rejects unarmed sids with 403. Distinct status code from token mismatch so logs distinguish brute force from squatter. | +5 LoC in `handleRequest`, +2 tests. | Without this, a malicious page could pre-populate its own hash with `#_deskcheck=guessedSid:guessedToken:guessedPort` and trigger the recorder against a CLI listener it didn't summon. The token is 32-byte hex so guessing is infeasible — but the structural defence is cheaper than relying on entropy alone. |
| **Cross-tab contamination** | Pending handoffs are keyed by tabId in an in-memory Map. Each tab has at most one entry. | None — the Map is the simplest data structure. | A user running two `deskcheck record` commands in two terminals must NOT have tab A's session uploaded to tab B's listener. Structurally enforced rather than tested-into. |
| **Gesture-missing silent failure** | Amber `REC?` badge + setTitle prompt. The user knows what to click. | +5 LoC in SW, +1 test. | Without the badge the marker would fire, the SW would log a warning that `sidePanel.open` failed (no gesture), and the user would see nothing. The CLI would block forever. This is the "silent rot" the brief calls out. |
| **Discard races the POST** | Cancel sentinel is fire-and-forget; the local discard completes regardless. The CLI watchdog handles listener-already-dead by timing out. | +1 file (handoff-cancel.ts), +1 SW branch, +2 tests. | The user must always be able to discard. A failed sentinel must not block the local cleanup. |
| **Listener binding regression** | A1-mirror test for the `record` subcommand. | +1 test. | The Phase 1 invariant must be reasserted for every new entry point. |
| **Chrome crashes mid-record** | `child.on('exit')` watchdog. Default `--timeout 600`. SIGINT cleans up. | +10 LoC in CLI, +2 tests. | Without this, Chrome dying would block the CLI forever and waste the user's terminal. |
| **macOS isolation escape** | `--user-data-dir` under `mkdtemp`, registered cleanup, manual verify checklist. `--password-store=basic` to avoid keychain prompt. | +20 LoC in launcher, +1 manual checklist. | A `--profile isolated` run that leaks state into the user's main Chrome profile would be a privacy regression vs the README claim. |

### 5.2 Tradeoffs we are accepting

- **Two content_scripts entries instead of one.** The slim `marker-detect.ts` runs at `document_start`, the existing recorder still runs at `document_idle`. Cost: a tiny extra script injection on every page. Benefit: the recorder code does not need to handle the early-injection edge cases (no DOM, no visibility events) and stays unchanged. The recorder is the more privacy-critical surface; isolating the marker detection from it is a clear win.
- **Pending handoffs are in-memory.** Cost: SW eviction wipes them. Benefit: no persistence footgun; cross-restart "stale handoff" attack surface eliminated. Mitigation: the CLI watchdog handles the case where the user goes away long enough for SW eviction (the CLI heartbeat keeps the user oriented; the eventual timeout tells them to retry).
- **`--profile isolated` requires `--password-store=basic`.** Cost: documented quirk. Benefit: the launcher does not silently hang on first launch waiting for a keychain prompt the user cannot see.
- **JSON summary's events/screenshots/duration_s require zip parsing.** Cost: ~40 LoC of zip central directory parser, OR null fields and a Phase 3 follow-up. Recommend null + follow-up; ship the structurally-required fields (`session_id`, `path`) immediately.
- **No support for Firefox/Chromium-based Edge.** Cost: macOS Chrome only. Benefit: the launcher is 90 lines, not 300, and the manual-verify surface is small.
- **No DELETE /session/<id> endpoint.** Cost: the cancel mechanism uses a sentinel POST to `/upload`. Benefit: no new endpoint, no new auth surface, the existing replay-defence semantics apply uniformly.

### 5.3 Tradeoffs we are explicitly NOT accepting

- We are NOT relying on token entropy alone. The `armedSessions` Set is a structural defence on top of the timing-safe token compare.
- We are NOT auto-opening the side panel. Chrome's gesture model makes this unreliable; the badge cue is the right answer.
- We are NOT persisting pending handoffs across SW eviction. The narrower window is safer.
- We are NOT bumping `schema_version`. The export format is unchanged.
- We are NOT modifying `cli/deskcheck.mjs` `listen` subcommand behaviour. Phase 1 tests are the regression contract.

---

## 6. Effort estimate

| Step | Person-days |
|---|---|
| 1. Marker module + corpus tests (TS + JS twins) | 0.75 |
| 2. CLI `record` subcommand (no Chrome launch) + tests | 1.0 |
| 3. Chrome launcher + tests + manual verify | 0.75 |
| 4. `marker-detect` content script + manifest + SW handler + tests | 0.75 |
| 5. Toolbar gesture path (`START_FROM_HANDOFF`) + tests | 0.75 |
| 6. Side panel badge + tests | 0.5 |
| 7. Discard sentinel wiring + tests | 0.5 |
| 8. CLI watchdog + heartbeat + SIGINT cleanup + tests | 0.5 |
| 9. JSON summary on stdout (with null events/screenshots fallback) | 0.25 |
| 10. Documentation (ARCHITECTURE.md, README, cli-record.md, PRIVACY.md) | 0.5 |
| Manual verify (isolated profile, hash routers, Chrome versions) | 0.5 |
| Buffer for adversarial-test wrangling | 0.75 |
| **Total** | **7.5 person-days** |

For comparison, the speed planner will likely come in at ~3 days and the quality planner at ~5–6. The +1.5 to +4.5 days I'm asking for buys: the property test on `initial_url`, the cancel sentinel mechanism, the watchdog, the cross-tab contamination test, the JSON-twin marker module, and the manual verify checklist. If the judge considers any of these optional, see the open questions below.

---

## 7. Open questions for the judge

1. **JSON summary fields.** Shipping `events`/`screenshots`/`duration_s` requires parsing the just-written zip. The CLI is currently zero-dep. Three options:
   - **(a)** Inline a 40-line zip-central-directory parser. Adds CLI complexity but keeps zero-dep.
   - **(b)** Make these fields null in the v1 JSON summary; promise Phase 3 fills them in.
   - **(c)** Add `fflate` as a CLI dep. Loses the zero-dep property.
   - **Safety planner recommendation**: (b). The structurally required fields (`session_id`, `path`) are the ones a calling agent needs; `events`/`screenshots` are nice-to-have. Punting them keeps Phase 2 small.

2. **Auto-start vs explicit click after the badge.** The plan auto-starts the session inside the toolbar-click gesture (`START_FROM_HANDOFF`). The user might want to inspect PII mode etc. before recording starts. Two alternatives:
   - **(a)** Auto-start (current plan). One click gets the user from "page loaded" to "recording".
   - **(b)** Open the panel only on click; require a second click on Start. Two clicks total but the user gets to verify settings.
   - **Safety planner recommendation**: (a) for terminal-launched flows specifically, because the user already committed by typing `deskcheck record <url>`. Document the PII default (`metadata`) loudly so the user knows what they're getting.

3. **`record` vs `listen` listener rules.** The plan has the `record` listener enforce an `armedSessions` Set; the `listen` listener accepts any sid (Phase 1 behaviour). Should the two share more code, or should `record` always go through a separate `recordSessionListener` factory? My plan keeps them in one file with a `mode` flag. If the judge wants stricter separation, +0.25 days.

4. **Marker version field.** The plan emits `v1` and rejects unknown versions. Does the judge want a `--legacy-marker` escape hatch for users who copy a marker out of an older CLI build? My instinct is no — `v1` is the only version, version mismatches should fail loudly.

5. **Should the marker include a timestamp?** A 5-minute TTL on the extension side covers the "page loaded long after CLI exited" case. A timestamp inside the marker would let the content script reject stale markers without involving the SW. Cost: marker length grows; signature verification gets uglier. My plan does NOT include a timestamp because the SW-side TTL plus the CLI's `armedSessions` Set already covers the risk surface. Open to the judge overriding this.

6. **Manifest content_scripts ordering.** Adding a second `content_scripts` entry — does the existing recorder's GUARD (`__deskcheck_loaded__`) need to coordinate with marker-detect, or are they fully independent? My plan keeps them fully independent (different files, different responsibilities, different injection times). If the judge spots a conflict I'm missing, this is the place to flag it.

7. **Effort estimate vs other planners.** I'm asking for 7.5 days. The judge should weigh the property test and the cancel sentinel against speed. If the answer is "skip the property test, skip the cancel sentinel, skip the manual verify, ship in 4 days", explicitly say so so the implementer doesn't quietly add them anyway.

---

## Appendix A — Definition of Done (consolidated)

- [ ] `deskcheck record <url>` ships with `--timeout`, `--profile`, `--json`, `--port`, `--out` flags
- [ ] `record` subcommand listener binds 127.0.0.1 only (test pinned)
- [ ] `record` subcommand listener returns 403 on unarmed sid (test pinned)
- [ ] Hash-fragment marker is parsed and stripped at `document_start` (test pinned)
- [ ] Marker is stripped a second time inside `START_SESSION` (test pinned)
- [ ] `initial_url` in `SessionMetadata` never contains `_deskcheck=` (property test, 2500 cases)
- [ ] Pending handoffs are tab-keyed and in-memory (test pinned)
- [ ] Pending handoff TTL is 5 minutes (fake-timer test)
- [ ] Pending handoff cleared on `chrome.tabs.onRemoved` (test pinned)
- [ ] Amber badge `REC?` shows when a handoff is armed (test pinned)
- [ ] Side panel "Connected to terminal session <id>" badge renders without showing the token (DOM grep test)
- [ ] Discard cancels the pending handoff and POSTs the cancel sentinel (integration test)
- [ ] Discard succeeds locally even if the listener died (integration test)
- [ ] CLI exits non-zero on timeout (test pinned)
- [ ] CLI exits non-zero on Chrome crash (test pinned)
- [ ] CLI exits 130 on SIGINT and removes the isolated user-data-dir (test pinned)
- [ ] CLI prints heartbeat to stderr every 5 seconds during wait
- [ ] CLI prints JSON summary to stdout on success
- [ ] `--profile isolated` cleanup verified manually on macOS
- [ ] No files left under `~/Library/Application Support/Google/Chrome` after `--profile isolated` run (manual verify)
- [ ] `listen` subcommand and all Phase 1 tests are unchanged (regression)
- [ ] No schema bump in `agents-doc.ts`
- [ ] Golden export test (`exporter.golden.test.ts`) is unchanged
- [ ] Sidepanel-no-handoff-write grep test is extended to cover the new badge code
- [ ] `make test && make typecheck && make build` all green
- [ ] Documentation updated (ARCHITECTURE.md, README, PRIVACY.md, docs/cli-record.md)

---

## Appendix B — Rollback strategy

**If Phase 2 ships broken**, the user's path back to Phase 1 behaviour is:

1. **Stop running `deskcheck record`.** Use `deskcheck listen --out ./sessions` instead. The Phase 1 listen subcommand is structurally untouched and remains the supported fallback.
2. **No code change required for the user.** The rollback is a documentation pointer, not a flag flip.
3. **For the maintainer**: revert only the new files (`marker.ts`, `marker-detect.ts`, `launch-chrome.mjs`, `handoff-cancel.ts`) and the three modified files (`service-worker.ts`, `sidepanel.ts`, `manifest.json`). The `cli/deskcheck.mjs` `listen` subcommand revert is empty — Phase 1 code is unchanged.
4. **Feature flag option**: if the maintainer wants a softer rollback, add a `DESKCHECK_DISABLE_MARKER` env var that the SW reads on startup and short-circuits the `DESKCHECK_MARKER` handler. Cost: +5 LoC. Benefit: ship-then-disable without a code change.

**Detection of breakage in production:**
- User reports: "the CLI hung", "Chrome did not launch", "the badge never appeared", "the marker is in my export".
- Self-diagnostic: the CLI heartbeat lets the user distinguish "hung" from "still waiting".
- The `make e2e-record` Playwright test (gated) is the canary to run before any release that touches Phase 2 code.

**Verification after rollback:**
- [ ] `deskcheck listen --out ./sessions` still works against the unchanged extension export path
- [ ] Phase 1 paste-line affordance in the side panel still functions
- [ ] All Phase 1 tests pass

---

## Appendix C — Formal verification assessment

- Concurrency concerns: **Yes** — two `deskcheck record` invocations on different terminals plus two open browser tabs is a 4-actor system. The pending-handoffs Map prevents cross-tab contamination structurally, but the interleaving "tab A armed → tab B armed → tab A clicked → tab B clicked" is worth a model-checker pass.
- State machine complexity: **Yes** — pending handoff has states `unset → armed → consumed → cleared` and `unset → armed → expired → cleared` and `unset → armed → tab-closed → cleared`. Three transitions, six edges; small enough to write out by hand but complex enough that property tests are warranted.
- Conservation laws: **Yes** — "every armed sid is either consumed exactly once OR resolves to cancelled/timeout exactly once". Property: no sid is consumed twice; no sid is silently dropped.
- Authorization model: **Yes** — `armedSessions` Set is the access control list. A request with an unarmed sid is unauthorized.
- **Recommendation**: lightweight property tests via `fast-check` for the marker round-trip and the pending-handoff state machine. Full TLA+/TLC is not necessary for this scope but the property tests should explicitly model cross-tab contamination, expiry, and tab-close as adversarial inputs.
- **Key invariants** (business language):
  - I1: A session zip uploaded to a `record` listener was emitted by THE SAME `record` invocation that armed its sid.
  - I2: The marker token never appears in any exported `session.json`.
  - I3: A discarded session's local OPFS data is deleted regardless of whether the cancel sentinel reaches the listener.
  - I4: A pending handoff bound to tab T is consumed only by a session started on tab T.
  - I5: The `listen` subcommand's behaviour is byte-equivalent before and after Phase 2.

---

## Appendix D — Security checklist

- [x] Listener binds 127.0.0.1 only (Phase 1 invariant + new D5-mirror test for record)
- [x] Per-run bearer token (Phase 1)
- [x] Constant-time token compare (Phase 1)
- [x] Token redaction in console.warn paths (Phase 1, extended to new SW handlers)
- [x] Single-use per session id (Phase 1 replay defence)
- [x] **NEW**: armed-sessions allowlist (record subcommand)
- [x] **NEW**: marker version field for forward compatibility
- [x] **NEW**: marker stripped at `document_start` BEFORE any other DeskCheck code runs
- [x] **NEW**: SW-side defence-in-depth strip in `START_SESSION`
- [x] **NEW**: pending handoffs are in-memory, tab-keyed, TTL-bounded
- [x] **NEW**: cancel sentinel is auth'd (uses the same bearer token)
- [x] **NEW**: cancel sentinel cannot be replayed to mark a session "cancelled" forever (CLI does NOT add the sid to `usedSessions` on cancel)
- [x] **NEW**: isolated user-data-dir is mkdtemp'd, cleanup-registered, never under user's main Chrome profile
- [x] No new permissions in `manifest.json`
- [x] No new network destinations beyond loopback
- [x] No schema change → no new fields visible to LLM consumers
- [x] Token never rendered in side panel DOM (existing grep test extended)
