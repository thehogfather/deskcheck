---
agent: quality-planner
generated: 2026-04-11T00:00:00Z
task_id: feature-14
perspective: quality
---

# Quality Plan: Feature #14 Phase 1 — local handoff receiver (`deskcheck listen`)

## 1. Executive summary

- Ship a Node (TypeScript) CLI in a new top-level `cli/` workspace so the listener shares the `SessionExport` / `TimelineEvent` / `SCHEMA_VERSION` types with the extension through a dedicated `src/lib/handoff-protocol.ts` module. This is the single strongest quality lever available: both sides of the wire compile against the same discriminated unions, and a schema drift is a `make typecheck` failure instead of a runtime 400.
- Introduce a tiny, named port — `ExportTransport` — in `src/lib/export-transport.ts` with exactly two implementations: `DownloadExportTransport` (wraps the existing `chrome.downloads.download` + `bytesToBase64` path already in `service-worker.ts:672-673`) and `ListenerExportTransport` (POSTs the zip via `fetch`). The service worker's `EXPORT_SESSION` handler (lines 658-683) selects the transport by reading a single `session.handoff` field — no sprawling `if/else`, no flags, no feature toggle. A `FakeExportTransport` lands alongside for tests, mirroring the `SessionStore` + `FakeSessionStore` pattern already used throughout `src/lib/`.
- Keep `exportSessionStreaming` entirely unchanged (line 81 of `src/lib/exporter.ts`). Both transports consume the exact same `Uint8Array` it returns. The zip is byte-for-byte identical across download and POST — the DoD "reference download byte-for-byte" test becomes trivial because the transport is a thin wrapper around one call.
- Store the listener URL + token as one typed nested field on `SessionMetadata` (`handoff: { listener_url, session_id, token } | null`) rather than three loose strings. Set at `START_SESSION` time from a small "Connect to local listener" affordance on the existing PII-mode row of the side panel that persists the listener URL in `chrome.storage.local`. The opt-in constraint is satisfied by structural absence: if `handoff` is null, the listener code path is unreachable.
- The listener is a ~150-line `node:http` server — no Express, no dependencies outside Node built-ins and the types package we already use. Written in TS, compiled with the existing `tsc`, invoked via `npx tsx cli/src/index.ts` in dev and via `node cli/dist/index.js` in prod. Zero new runtime dependencies for the extension side. Fits `make` conventions with `make cli-build` / `make cli-test`.

**Phase 2 hooks left in place**: `session.handoff` is the exact same shape the phase-2 launcher will set, the `ExportTransport` port is the only seam a future "launcher heartbeat" path needs, and the CLI already has a `--out` dir + per-session subdirectory layout that phase 2's hash-fragment detection can target without refactor.

## 2. Proposed architecture

### 2.1 Module layout

```
src/
├── background/
│   └── service-worker.ts              [MODIFY — EXPORT_SESSION branch]
├── lib/
│   ├── handoff-protocol.ts            [NEW — shared wire types, path constants]
│   ├── export-transport.ts            [NEW — ExportTransport port + 2 impls]
│   ├── fake-export-transport.ts       [NEW — FakeExportTransport for SW tests]
│   ├── handoff-config-store.ts        [NEW — chrome.storage wrapper for listener URL]
│   ├── exporter.ts                    [UNCHANGED — zip bytes consumed as-is]
│   ├── session-store-types.ts         [UNCHANGED]
│   └── privacy.ts                     [MODIFY — one line in PRIVACY.md template]
├── sidepanel/
│   ├── sidepanel.ts                   [MODIFY — add "Connect to listener" row]
│   └── sidepanel.css                  [MODIFY — minimal — new row styling]
└── types.ts                           [MODIFY — add optional handoff field]

cli/
├── package.json                       [NEW — Node workspace config]
├── tsconfig.json                      [NEW — references extension for type sharing]
├── src/
│   ├── index.ts                       [NEW — CLI entrypoint + arg parsing]
│   ├── listener.ts                    [NEW — pure http.Server factory]
│   ├── token-registry.ts              [NEW — pure token storage + validation]
│   ├── upload-handler.ts              [NEW — pure request handler]
│   └── writer.ts                      [NEW — disk writer port + impl]
├── src/listener.test.ts               [NEW]
├── src/token-registry.test.ts         [NEW]
├── src/upload-handler.test.ts         [NEW]
└── src/writer.test.ts                 [NEW]

tests/
└── service-worker-handoff.test.ts     [NEW — SW branch selection + opt-in]

Makefile                               [MODIFY — add cli-build, cli-test, cli-dev targets]
package.json                           [MODIFY — add cli workspace OR project reference]
manifest.json                          [MODIFY — add host_permissions entry for http://127.0.0.1/*]
PRIVACY.md                             [MODIFY — one paragraph on CLI handoff]
docs/ARCHITECTURE.md                   [MODIFY — new "CLI handoff" subsection]
```

**Total new files**: 12 (4 `src/lib/`, 1 test file, 7 `cli/`).
**Total modified files**: 8.

### 2.2 The port: `ExportTransport`

```ts
// src/lib/export-transport.ts
import type { SessionMetadata } from "../types";

export interface ExportResult {
  readonly kind: "downloaded" | "uploaded";
  /** For downloads: the filename Chrome wrote to. For uploads: the
   *  relative path the listener reported (e.g. `<session-id>/session.zip`). */
  readonly path: string;
}

/**
 * The destination for a finished session zip.
 *
 * Two production implementations:
 *   - DownloadExportTransport — wraps chrome.downloads.download (today's
 *     path, unchanged bytes for unchanged behaviour).
 *   - ListenerExportTransport — POSTs the zip to a 127.0.0.1 listener
 *     registered in session.handoff at START_SESSION time.
 *
 * Selection happens in service-worker.ts EXPORT_SESSION once, by
 * inspecting session.handoff — no scattered feature flags.
 *
 * FakeExportTransport exists for SW unit tests; it records what would
 * have been sent without touching chrome.downloads or fetch.
 */
export interface ExportTransport {
  send(
    session: SessionMetadata,
    zipBytes: Uint8Array,
    filename: string,
  ): Promise<ExportResult>;
}
```

**Why this port, not a function parameter**: the service worker constructs one instance of each at module init (mirroring `new OpfsSessionStore()` at line 24 of `service-worker.ts`) and the branch in `EXPORT_SESSION` becomes `const transport = session.handoff ? listenerTransport : downloadTransport;`. That line is the entire kill switch, the entire feature flag, and the entire rollback story. A future engineer reading the PR sees one line and knows exactly where the handoff lives.

**What this port is NOT**: not a plugin system, not a registry, not a discriminated union of "transport kinds". There are exactly two implementations today and we have no evidence anyone will add a third. Invent no abstraction the DoD does not require.

### 2.3 The shared protocol: `src/lib/handoff-protocol.ts`

```ts
// src/lib/handoff-protocol.ts
//
// Single source of truth for the wire contract between the extension
// and the deskcheck listener CLI. Imported by:
//   - src/background/service-worker.ts (sender)
//   - src/lib/export-transport.ts (typed request construction)
//   - cli/src/upload-handler.ts (receiver, via cli/tsconfig.json refs)
//
// A schema drift across the wire is a `make typecheck` failure.

/** Uploaded to POST /handoff/v1/sessions/:session_id. */
export const HANDOFF_UPLOAD_PATH = "/handoff/v1/sessions" as const;
export const HANDOFF_HEALTH_PATH = "/handoff/v1/health" as const;

/** The auth header the extension sets and the CLI validates. */
export const HANDOFF_TOKEN_HEADER = "x-deskcheck-token" as const;

/** The content-type used for the POST body — raw zip, no multipart. */
export const HANDOFF_CONTENT_TYPE = "application/zip" as const;

/**
 * JSON response from a successful upload. Intentionally minimal —
 * a larger envelope is a phase-2 problem if ever.
 */
export interface HandoffUploadResponse {
  readonly ok: true;
  readonly path: string;     // e.g. "<session-id>/session.zip"
  readonly bytes: number;
}

export interface HandoffErrorResponse {
  readonly ok: false;
  readonly error: "unauthorized" | "bad_request" | "internal";
  readonly message: string;
}

/**
 * The per-session handoff config stored on SessionMetadata. Written
 * at START_SESSION if the user has connected to a listener, null
 * otherwise. Its mere presence is the opt-in switch.
 */
export interface SessionHandoff {
  readonly listener_url: string;   // "http://127.0.0.1:<port>"
  readonly session_id: string;     // matches SessionMetadata.id
  readonly token: string;          // per-session cryptographic nonce
}
```

**Why one file**: the CLI's `cli/tsconfig.json` will add a single `path: "../src/lib/handoff-protocol"` reference. That is the whole type-sharing story. No monorepo tooling, no lerna, no `npm workspaces` gymnastics. The file is pure types + constants, zero runtime.

### 2.4 SessionMetadata extension

```ts
// src/types.ts
import type { SessionHandoff } from "./lib/handoff-protocol";

export interface SessionMetadata {
  // ...existing fields unchanged...
  status: Exclude<SessionStatus, "idle">;
  /**
   * Per-session handoff config, set at START_SESSION when the user
   * has connected the side panel to a deskcheck listener CLI. Null
   * for ordinary (download-path) sessions. Its presence is the
   * opt-in signal for service-worker.ts EXPORT_SESSION; absence is
   * a hard guarantee that no network traffic goes to 127.0.0.1.
   *
   * Does NOT appear in exported session.json — stripped at export
   * time alongside tab_id, because it is operational metadata not
   * session content. Schema version is unchanged.
   */
  handoff?: SessionHandoff | null;
}
```

**One clean field** rather than three loose strings on the metadata root. Grouped under `handoff` so:
1. A reader sees the whole config as one unit.
2. Absence (`handoff == null`) is the opt-in check (`if (session.handoff) …`).
3. The exporter's existing field-stripping pattern (`const { tab_id: _tab, ...sessionExport } = session;` at `exporter.ts:92`) extends to `const { tab_id: _, handoff: _h, ...sessionExport } = session;` — one line change.

**Schema version stays 1.2.0.** Pinned by extending `exporter.golden.test.ts` to assert that a session with `handoff` set still produces the same `session.json` byte-for-byte as the committed golden fixture.

### 2.5 Wire protocol (end-to-end)

**Connect flow (one-time per listener session)**:
1. User runs `deskcheck listen --out ~/deskcheck-sessions` in a terminal.
2. CLI binds `127.0.0.1` on an ephemeral port (port 0, OS-chosen), prints:
   ```
   deskcheck listen ready
     url:   http://127.0.0.1:54329
     out:   /Users/patrick/deskcheck-sessions
     token: 9f3c2e4a-...  (copy into side panel → Connect to listener)
   ```
3. User opens the side panel, clicks "Connect to listener", pastes the URL + token into a small inline form. The values are stored in `chrome.storage.local` via `handoff-config-store.ts`. The panel shows "Connected to http://127.0.0.1:54329" and offers "Disconnect".
4. On the next `START_SESSION`, the SW reads the stored config, generates a **fresh per-session token** by combining the stored CLI token + a random nonce (see token model below), calls `POST /handoff/v1/health` to verify the listener is alive, and writes `session.handoff = { listener_url, session_id, token }` into metadata. If health-check fails, the SW logs a warning and leaves `handoff = null` — the session falls through to the download path silently. (Visible warning: side panel shows "Listener unreachable — will download on stop" once.)

**Upload flow (at `EXPORT_SESSION`)**:
1. `EXPORT_SESSION` builds `zipBytes` via existing `exportSessionStreaming(store, session)`.
2. Service worker reads `session.handoff`. If present, calls `listenerTransport.send(session, zipBytes, filename)`. Otherwise calls `downloadTransport.send(...)`. One line.
3. `ListenerExportTransport.send()` does:
   ```
   POST http://127.0.0.1:<port>/handoff/v1/sessions/<session_id>
   Content-Type: application/zip
   X-DeskCheck-Token: <session_token>
   Content-Length: <zipBytes.length>
   Body: <zipBytes>
   ```
4. On 200: parses `HandoffUploadResponse`, returns `{ kind: "uploaded", path }`.
5. On 401 / network error: **hard fail**, surfaces an error in the side panel `#async-error` line ("Listener rejected upload — session retained, try again"), and **does NOT fall back to download**. The session stays in OPFS so the user can retry. The user's explicit mental model ("I connected to the listener") should not be silently overridden.
6. On timeout (15s): same as 401 — hard fail, session retained.

**Why hard-fail instead of fallback**: the opt-in constraint says "manual sessions continue to download with zero behaviour change" (satisfied by structural absence of `session.handoff`). Sessions that *are* opted into the listener must either succeed or visibly fail — a silent fallback to download is the worst of both worlds because the user goes looking in `~/deskcheck-sessions/` and finds nothing, or worse, an older export. Predictability beats cleverness.

### 2.6 Token model (single-use, per-session)

The CLI holds one long-lived **bearer token** (generated at process start, printed once). The extension holds this in `chrome.storage.local` as part of the listener config.

At `START_SESSION`, the SW derives a **per-session token** by calling the CLI's `POST /handoff/v1/sessions/:session_id/tokens` with the bearer token in the header. The CLI generates a cryptographically random per-session token via `crypto.randomBytes(32).toString("hex")`, stores it in its in-memory `TokenRegistry` keyed by `session_id`, and returns it. The extension writes it to `session.handoff.token`.

On upload, the CLI:
1. Reads `x-deskcheck-token` + `:session_id` from the URL.
2. Looks up the token in `TokenRegistry`.
3. If mismatch or missing → 401, **no disk write**.
4. If match → accepts upload, writes to disk, **deletes the token** (single-use enforcement).

When the CLI process exits, the registry dies with it — the TTL is implicit.

**Why this model**:
- One secret (`bearer`) the user manually copies; per-session tokens are machine-issued and never leave process memory.
- Single-use is enforced at the server, not via clock drift or TTL bookkeeping.
- Phase 2's launcher will use the same `/tokens` endpoint — no refactor.

### 2.7 Listener structure (pure + thin I/O shell)

```
cli/src/
├── index.ts           — arg parsing (node:util parseArgs), calls startListener()
├── listener.ts        — pure factory: startListener({ out, bearer, logger }) → { url, stop() }
│                        wires node:http.Server + binds 127.0.0.1 only
├── token-registry.ts  — pure class: issueToken(sessionId), validate(sessionId, token), revoke(sessionId)
├── upload-handler.ts  — pure function: handleUpload(req, res, deps) where deps is
│                        { registry, writer, logger }. Testable without http.
└── writer.ts          — port + impl: SessionWriter.write(sessionId, zipBytes) → path.
                         Fake for tests; prod impl uses node:fs/promises.
```

**Each file is small and either pure or I/O-only.** `upload-handler.test.ts` injects a fake `SessionWriter` and asserts:
- Missing token → 401, writer never called.
- Bad token → 401, writer never called.
- Valid token → 200, writer called once with the right session_id + bytes.
- Revoked token (second call) → 401, writer never called.

`listener.test.ts` spins up a real `node:http` server on port 0, makes real `fetch` calls to `http://127.0.0.1:<port>/...`, asserts the three DoD binding properties (only 127.0.0.1, only documented routes, token enforcement). This is fast (node:http is local) and deterministic.

## 3. Implementation sequence

Each step is an independently reviewable commit.

### Step 1 — Extension-side wire types, no behaviour change

**Files**:
- `src/lib/handoff-protocol.ts` (new)
- `src/types.ts` (add `handoff` field)
- `src/lib/exporter.ts` (add `handoff` to the stripped-fields destructuring)

**Tests**:
- Extend `src/lib/exporter.golden.test.ts` with a new test case: session with `handoff` set → exported `session.json` identical to golden → proves schema_version unchanged and handoff is stripped.

**Rationale**: lands the type contract and pins the exporter's strip-on-export guarantee before any transport code. The type file is pure, no runtime, review is fast.

### Step 2 — `ExportTransport` port + 3 implementations (port, download, fake)

**Files**:
- `src/lib/export-transport.ts` (new — defines `ExportTransport` interface and `DownloadExportTransport` class, which lifts the existing `bytesToBase64` + `chrome.downloads.download` logic out of `service-worker.ts:672-683` verbatim)
- `src/lib/fake-export-transport.ts` (new — records `send()` calls with captured bytes + metadata)
- `src/background/service-worker.ts` (refactor `EXPORT_SESSION` to call `transport.send()` — **no behaviour change yet**, both existing download tests pass)

**Tests**:
- `src/lib/export-transport.test.ts` (new) — `FakeExportTransport` contract check + `DownloadExportTransport` unit test that mocks `chrome.downloads` and pins the data URL construction.
- Extend `tests/service-worker-setpanel.test.ts` pattern into `tests/service-worker-handoff.test.ts` (new) — load the SW with a `FakeExportTransport` injected via a module-init seam; dispatch `EXPORT_SESSION`; assert `fake.sent.length === 1` and `fake.sent[0].session.handoff == null`.

**Rationale**: this is the single highest-leverage commit. It refactors the existing export path behind a port WITHOUT adding the listener. After this commit, the code is no worse than before, and the listener path becomes a plain addition rather than a surgery on a messy conditional.

**Seam trick**: export the transport instances as `let` bindings from `service-worker.ts` with a setter seam guarded by `if (import.meta.env.MODE === "test")` — or, cleaner, factor the top-level state into a `createServiceWorker({ store, transport })` function that production calls with real deps. The tab-group test file (see `tests/service-worker-tab-group.test.ts`) shows how tests already install globals and then `await import("../src/background/service-worker")` — we follow that exact pattern with an additional per-test-module injection point.

### Step 3 — `handoff-config-store.ts` + side panel affordance

**Files**:
- `src/lib/handoff-config-store.ts` (new — `chrome.storage.local` wrapper, injectable seam like `privacy-store.ts`)
- `src/sidepanel/sidepanel.ts` (add "Connect to listener" row in `#toolbar` near PII selector — hide-not-disable structural rendering per the feature-11 pattern)
- `src/sidepanel/sidepanel.css` (minimal — one new `.listener-row` selector)
- `src/lib/sidepanel-controls.ts` (add `listenerRow` to `ControlVisibility` with exhaustive unit-test update)

**Tests**:
- `src/lib/handoff-config-store.test.ts` — round-trip save/load/clear, default-empty, injectable fake storage.
- Extend `src/lib/sidepanel-controls.test.ts` — listener row visible in idle only.
- Extend `src/sidepanel/sidepanel.test.ts` — clicking "Connect" writes to store; "Disconnect" clears.

**Rationale**: the user-facing configuration surface lands before the wire code, so the next step has a real storage key to read from. The hide-not-disable pattern is already the house style for the side panel (see `sidepanel-controls.ts`).

### Step 4 — `ListenerExportTransport` + `START_SESSION` handoff wiring

**Files**:
- `src/lib/export-transport.ts` (add `ListenerExportTransport` class — uses `fetch`, consumes `handoff-protocol.ts` constants)
- `src/background/service-worker.ts` (`START_SESSION` reads `handoff-config-store`, calls `/health`, requests a per-session token via `/tokens` endpoint, writes `session.handoff`. `EXPORT_SESSION` selects transport via `const transport = session.handoff ? listenerTransport : downloadTransport;`)
- `manifest.json` (add `"http://127.0.0.1/*"` to `host_permissions` so extension can fetch loopback)

**Tests**:
- `src/lib/export-transport.test.ts` — add `ListenerExportTransport` tests using a fake `fetch` that asserts method/URL/headers/body.
- `tests/service-worker-handoff.test.ts` — three new cases:
  1. **Opt-in guard**: no listener config in storage → `START_SESSION` → `session.handoff == null` → `EXPORT_SESSION` hits `DownloadExportTransport` → zero `fetch` calls.
  2. **Handoff path**: listener config present + `/health` mock 200 + `/tokens` mock 200 → `session.handoff` set → `EXPORT_SESSION` hits `ListenerExportTransport` → fake fetch observes `POST /handoff/v1/sessions/<id>` with the zip body.
  3. **Listener unreachable at start**: `/health` throws → `session.handoff == null` → falls through to download path → side panel warning broadcast.

**Rationale**: this is the wire-up step. By now the port exists, the config exists, the protocol types exist — all this does is connect them. The code in `EXPORT_SESSION` reads as a single ternary.

### Step 5 — CLI workspace skeleton

**Files**:
- `cli/package.json` (new — type: module, dependencies: none outside `@types/node`, dev: `vitest`, `typescript`, `tsx`)
- `cli/tsconfig.json` (new — references `src/lib/handoff-protocol.ts` via `paths`)
- `cli/src/token-registry.ts` + `cli/src/token-registry.test.ts`
- `cli/src/writer.ts` + `cli/src/writer.test.ts`
- `cli/src/upload-handler.ts` + `cli/src/upload-handler.test.ts`
- `cli/src/listener.ts` + `cli/src/listener.test.ts`
- `cli/src/index.ts` (CLI entry — arg parsing with `util.parseArgs`)

**Tests**:
- Four vitest files per above — pure modules, trivial to test.
- `listener.test.ts` spins up real `http.createServer` on port 0, makes real loopback `fetch`s, asserts:
  - Binds only to `127.0.0.1` (probe a second socket server on the same port on `0.0.0.0` and assert it doesn't conflict — or simpler, read `server.address()` and assert `address === "127.0.0.1"`).
  - A request from a non-loopback interface fails (macOS Node: `fetch("http://<lan-ip>:<port>/...")` returns ECONNREFUSED because the bind is explicit).
  - 401 on missing header.
  - 401 on bad header.
  - 200 + disk artefact on good header.
  - Single-use: second POST with same token returns 401.

**Makefile**: add `cli-build`, `cli-test`, `cli-dev` targets. `cli-dev` runs `npx tsx cli/src/index.ts listen --out ./tmp`.

**Rationale**: the CLI is mechanically straightforward; the real quality investment was on the extension side (which lives forever). The CLI's only contract is the protocol file it imports from the extension.

### Step 6 — Integration test (extension zip ↔ CLI listener, round-trip)

**Files**:
- `cli/src/roundtrip.integration.test.ts` (new)

**Approach**: pure-Node integration test. Constructs a zip with `fflate` directly (not via the extension — the extension's Chrome dependencies make it awkward to run in pure Node), POSTs it to a real listener started on port 0, asserts the written file is byte-for-byte identical. Then separately, run `exportSessionStreaming` against a `FakeSessionStore` in a vitest test, capture the zip bytes, and POST those directly to a real listener — the same byte-for-byte assertion. This satisfies DoD item "integration test: a session POSTs to a test listener and the resulting zip matches a reference download byte-for-byte" without needing a real Chrome.

**Rationale**: the integration test is the DoD's highest-value test. Keeping it pure-Node (no Playwright, no Chrome launch) keeps it fast and deterministic.

### Step 7 — Docs + privacy notice

**Files**:
- `docs/ARCHITECTURE.md` (add "CLI handoff" section under Data Flow)
- `src/lib/privacy.ts` (add one paragraph to `PRIVACY_MD_TEMPLATE` describing the 127.0.0.1 handoff path)
- `src/lib/privacy-notice.ts` + tests (one new bullet for the first-run notice if and only if the user has enabled the listener — OR flat addition for all users; decide with judge)
- Update the first-run notice (`PRIVACY_NOTICE_BULLETS`) to mention CLI handoff + the 127.0.0.1-only guarantee.

**Rationale**: the DoD explicitly lists "first-run notice and PRIVACY.md updated." The `privacy.ts` module is already the single source of truth; we add one bullet and one paragraph.

### Step 8 — Version bump + release readiness

**Files**:
- `package.json` + `manifest.json` — `make bump-minor` → 0.5.0 (new user-visible feature).

## 4. Test Level Matrix

| # | DoD item | Test level | Test file | Rationale |
|---|----------|-----------|-----------|-----------|
| 1 | CLI ships in repo | Unit (build smoke) | `cli/src/index.test.ts` | Assert `util.parseArgs` accepts `listen --out DIR`, rejects unknown flags. Fast, pure. |
| 2 | `listen --out DIR` starts server, prints bound port + ready line, writes to `DIR/<session-id>/` | Integration | `cli/src/listener.test.ts` | Real `http.createServer` on port 0, real loopback POST, real disk write via tmpdir. Pure Node, ~50ms per case. |
| 3 | Extension POSTs when metadata carries handoff | Unit | `tests/service-worker-handoff.test.ts` | Fake `fetch` + `FakeExportTransport` injected. Asserts exact POST shape. |
| 4 | Listener validates token and rejects mismatches | Unit | `cli/src/upload-handler.test.ts` | Pure handler function with fake registry + fake writer. Four cases: missing / bad / good / revoked. |
| 5 | Listener binds 127.0.0.1 only | Integration | `cli/src/listener.test.ts` | Assert `server.address().address === "127.0.0.1"`. Plus: attempt to open a second `net.Server` on `0.0.0.0:<port>` — it must succeed (proves we did NOT bind `0.0.0.0`). |
| 6 | Manual sessions continue to download with no behaviour change | Unit | `tests/service-worker-handoff.test.ts` | Opt-in guard case: no listener config in storage → SW calls `DownloadExportTransport` → `fetch` is never called. Pinned by spy on `globalThis.fetch`. |
| 7 | Integration test: POSTed zip matches reference download byte-for-byte | Integration | `cli/src/roundtrip.integration.test.ts` | `exportSessionStreaming` → bytes → POST → disk → byte-equal assertion. Pure Node. |
| 8 | Unit tests cover token generation, uniqueness, expiry, rejection | Unit | `cli/src/token-registry.test.ts` | Pure class. Four cases: issue unique per call, validate happy path, reject bad, revoke-on-use. |
| 9 | First-run notice + PRIVACY.md mention CLI handoff + 127.0.0.1-only | Unit | `src/lib/privacy.test.ts` | Extend existing string-match tests. |
| 10 | Schema version unchanged | Unit | `src/lib/exporter.golden.test.ts` | New case: session with `handoff` set → golden session.json unchanged byte-for-byte → proves schema_version + stripping. |
| 11 | No network traffic to localhost without handoff metadata (opt-in) | Unit | `tests/service-worker-handoff.test.ts` | Spy on `globalThis.fetch`; dispatch `EXPORT_SESSION` with `session.handoff == null`; assert spy uncalled. |
| 12 | Listener reachable at START_SESSION, else fall through to download | Unit | `tests/service-worker-handoff.test.ts` | Case 3 in step 4. |
| 13 | Rollback: disable listener path without touching CLI | Unit | `tests/service-worker-handoff.test.ts` | Clear `handoff-config-store`; assert next `START_SESSION` produces `session.handoff == null`. This IS the kill switch. |

**Totals**: 11 unit tests (fast, deterministic), 2 integration tests (pure Node, still fast). **Zero e2e** — Phase 1 has no user-visible side panel change that requires a Playwright spec beyond the unit test on `sidepanel-controls` + `sidepanel.test.ts` for the new row. The Chrome-launcher journey is a phase-2 concern.

**Determinism rule**: every test is deterministic. No real network beyond loopback; loopback is deterministic enough for this project. No LLM calls. No clock dependencies beyond the token-registry's "revoked on use" counter, which is logical not temporal.

## 5. Risks and tradeoffs

### What this plan deliberately pays down

- **The `chrome.downloads.download` path is unit-testable for the first time.** Today's `service-worker.ts:672-683` inlines `bytesToBase64` + `chrome.downloads.download`. Lifting it into `DownloadExportTransport` behind a port means the next engineer can test export wiring without standing up `chrome.downloads` in a fake global.
- **No new runtime dependencies.** `fflate` stays the only prod dep. The CLI uses `node:http`, `node:fs/promises`, `node:crypto`, `node:util` — all built-ins.
- **Type-shared wire contract.** The CLI cannot silently diverge from the extension because `handoff-protocol.ts` is imported by both. A field rename in the extension fails `make typecheck` in the CLI workspace.
- **Single grep-able kill switch.** `session.handoff ? listenerTransport : downloadTransport` is the entire feature toggle. Deletion = removing one line + two files + `session.handoff` → done.

### What this plan deliberately does NOT abstract

- **No "transport plugin system".** Two transports, named explicitly. Adding a third would be a new file + one switch arm. YAGNI wins.
- **No retry/backoff machinery.** Hard-fail on upload error is a one-line behaviour. If the DoD later demands retries, they land in `ListenerExportTransport` alone, no cross-cutting change.
- **No listener discovery / auto-connect.** Manual paste of URL + token is 10 seconds of friction per CLI process. Auto-discovery (mDNS, well-known port probe) is phase-2 material at earliest.
- **No multipart.** Raw `application/zip` body. Multipart would drag in a parser on the CLI side and a boundary-generator on the extension side, for zero benefit on a single-file payload.
- **No schema version bump.** The in-memory `SessionMetadata.handoff` field is stripped at export time (same mechanism as `tab_id`). Readers see zero change.
- **No CLI worker pool / concurrency.** One sequential upload per session. The listener accepts a second upload while the first is still writing (file-per-session, no contention), but we don't stress this in tests.

### Risks

1. **Bearer-token-in-chrome.storage.local visibility**. `chrome.storage.local` is readable by any extension code and by DevTools. The token grants upload to a loopback-only server with only disk-write authority — not a credential theft vector in practice, but document it in PRIVACY.md and the first-run notice. (Speed planner will likely skip this risk; Safety planner will likely over-index.)
2. **Gesture budget / async chain in `START_SESSION`**. The new `/health` + `/tokens` fetches happen inside the `START_SESSION` handler's existing async body — the feature-8 user-gesture constraint for `chrome.sidePanel.open` lives in `chrome.action.onClicked`, not `START_SESSION`, so there is no gesture conflict. Pinned by existing tests; no new regression surface.
3. **Manifest `host_permissions` addition**. Adding `http://127.0.0.1/*` widens the extension's declared permissions. Users will see a permission prompt on update. Documented in changelog.
4. **Cost of the "Connect to listener" UI**. One new row in the side panel's toolbar + one new `ControlVisibility` field. Consistent with the hide-not-disable pattern already established in `sidepanel-controls.ts`. Reversible.

### Quality investment note

> **Quality Investment**: this plan takes ~1.5x longer than a minimal "add an if/else to EXPORT_SESSION" version. Worth it because (a) the port makes the download path testable for the first time, (b) a shared protocol file between extension and CLI eliminates an entire class of schema-drift bugs, and (c) phase 2's launcher + hash-fragment detection lands as pure additions with zero refactor to phase 1. The single-line selector (`session.handoff ? listener : download`) at `EXPORT_SESSION` is the reason the feature can be deleted in one PR if it ever needs to be.

## 6. Effort estimate

Person-days for a single engineer already familiar with the codebase.

| Step | Effort | Notes |
|------|--------|-------|
| 1. Wire types + exporter strip | 0.25 d | Pure types, 1 test case extension. |
| 2. ExportTransport port + refactor existing download path | 0.75 d | Main refactor. Requires reading `service-worker.ts` carefully and adding a test seam pattern. |
| 3. `handoff-config-store` + side panel row | 0.75 d | `sidepanel-controls` + `sidepanel.ts` + CSS + 3 test files. The UI surface is minimal. |
| 4. `ListenerExportTransport` + `START_SESSION` wiring + manifest | 1.0 d | Most of the extension-side complexity. `/health` + `/tokens` round-trips + fake fetch tests + failure-mode tests. |
| 5. CLI workspace (listener, token-registry, upload-handler, writer, entry) | 1.0 d | Five small modules, all pure or thin I/O. Tests dominate. |
| 6. Integration round-trip test | 0.5 d | Pure Node, but needs careful seeding of `FakeSessionStore` + real listener + byte-equal asserts. |
| 7. Docs + privacy + first-run notice | 0.25 d | `PRIVACY.md` paragraph + 1 new bullet + architecture doc subsection. |
| 8. Version bump + PR polish | 0.25 d | `make bump-minor`, changelog. |
| **Total** | **~4.75 d** | |

A speed-optimised plan can land in ~2 d by inlining the transport, hand-writing the listener without a port, skipping `handoff-protocol.ts`, and putting the config in a hardcoded env var. That plan will cost ~1-2 d of refactor when phase 2 arrives (and in the worst case, a full rewrite of the SW branch). The 2 d spent now is cheaper than the 2 d spent later, because it is tested and shipped work.

## 7. Open questions for the judge

1. **CLI language — Node or Go?** This plan picks **Node (TypeScript)** to share `handoff-protocol.ts` types across the wire. Alternative: single-static Go binary for zero-install distribution. Judge should weigh: do we want contributors to `npm install` to hack on the CLI, or do we want end-users to `brew install`? Node aligns with the "code lives in this repo, contributors hack on it" mode; Go aligns with "ship a binary." This plan optimises for contributor clarity — judge may overrule if end-user friction matters more.
2. **Store the CLI bearer token in `chrome.storage.local` vs. `chrome.storage.session`?** `local` survives browser restart, so a developer running `deskcheck listen` once per day has one paste. `session` clears on browser restart, forcing re-paste but eliminating the persistence window. Plan defaults to `local`; judge may downgrade for safety.
3. **Hard-fail vs. fallback-to-download on upload error?** Plan chooses hard-fail + visible error + session retained. Alternative: silent fallback to download. Judge may pick the other way if discoverability beats predictability in the target workflow.
4. **Embed the CLI in the extension repo, or a sibling repo?** Plan embeds (`cli/` at repo root). Rationale: shared types. Alternative: `deskcheck-cli` separate repo with published types. Embedding is simpler for phase 1; separation is only valuable if the CLI grows an independent release cadence, which it will not in phase 1.
5. **Should `session.handoff` survive in the exported `session.json`?** Plan strips it (like `tab_id`). Alternative: keep it so downstream consumers see provenance ("this session arrived via the listener"). Stripping is the safer default — operational metadata does not belong in session content — and keeps `schema_version` trivially unchanged.
6. **Do we need an "attach to listener" button, or can the CLI print a deep-link (`chrome-extension://...`) that prefills the config?** Deep-link is phase-2 material (and requires hash-fragment plumbing the brief explicitly defers). Plan sticks with manual paste.

## Formal Verification Assessment

- **Concurrency concerns**: Low. The CLI token registry is single-process, in-memory, accessed from one Node event loop. The extension uses OPFS's existing `writeChain` pattern. No shared mutable state across processes.
- **State machine complexity**: Low. The handoff lifecycle has three states per session (not-configured / configured / sent), all determined by presence of `session.handoff`.
- **Conservation laws**: One invariant worth stating — **every zip produced for a handoff-enabled session either lands at the listener's disk path OR stays in OPFS**. Never a third outcome. Pinned by the hard-fail behaviour in `ListenerExportTransport` + not calling `store.deleteSession()` on upload failure.
- **Authorization model**: Loopback-bound listener + single-use per-session token. Threat model is a local attacker on the same machine, which DeskCheck does not defend against elsewhere either (extension data is plain-text in `chrome.storage.local`).
- **Recommendation**: Formal verification not needed. The system is simple enough that the test matrix pins all invariants.
- **If recommended, key invariants**:
  - No POST to any listener when `session.handoff == null`.
  - No disk write on the CLI side when token validation fails.
  - Tokens are single-use (second POST returns 401 even with the same token).
  - Exported `session.json` does not contain the `handoff` field.
  - `schema_version` is unchanged.

## Future extensibility

- **Phase 2 (terminal-launched `deskcheck record <url>`)**: lands as `cli/src/record.ts` + a new `POST /handoff/v1/sessions/:id/configure` endpoint. The extension side gains a hash-fragment reader that writes into the same `handoff-config-store`, then the existing `START_SESSION` → `session.handoff` flow kicks in with zero new extension-side refactor. The `ExportTransport` port, the `handoff-protocol.ts` types, and the config store are all reused.
- **Phase 3 (MCP wrapper)**: an MCP server reads from the same `DIR/<session-id>/` layout the CLI already writes. Zero protocol change; MCP is a view, not a transport.
- **Cross-platform support**: the CLI is pure Node built-ins, so it runs on Linux unchanged. Windows has path-separator concerns in `writer.ts` — one `path.join` call covers it. Not in phase 1 DoD.
- **Compression**: if session sizes grow, `ListenerExportTransport` can `gzip` the body before `fetch` and the CLI can `zlib.gunzip` on receipt. No contract change (both sides agree to `Content-Encoding: gzip`).
