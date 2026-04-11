---
agent: safety-planner
generated: 2026-04-11T00:00:00Z
task_id: feature-14
perspective: safety
---

# Safety Plan: Feature 14 — Phase 1 `deskcheck listen` handoff

## 1. Executive summary

- **Ship the smallest opt-in handoff we can defend.** A new Node CLI (`cli/` package) exposes `deskcheck listen --out DIR`, binding *only* `127.0.0.1` on a kernel-chosen port. The extension POSTs the finished zip from the existing streaming export, gated by a per-session handoff record that lives in its **own** chrome.storage.local key, never in `SessionMetadata` (so it cannot leak into `session.json`).
- **Opt-in at four independent layers.** (1) The `deskcheck_handoff` storage key must exist; (2) its `session_id` must equal the active `SessionMetadata.id`; (3) the listener URL must parse as `http://127.0.0.1:<port>` or `http://localhost:<port>` with no path, query, or fragment; (4) the per-session token must be present and survive a constant-time string comparison both in the extension (before POST) and in the listener (before the bytes touch disk). Remove any one and the flow falls back to the download path silently.
- **Failures prefer the download path, not a half-shipped POST.** Any POST error, timeout, non-200, 401, connection refused, wrong-host redirect, or schema mismatch from the handshake rolls back to `chrome.downloads.download` on the same bytes. The user never loses the session to a broken listener. A single retry-with-backoff is allowed only on transport-level errors (`ECONNRESET`, `fetch` throws) — never on 4xx/5xx, which we treat as a misconfigured or hostile listener.
- **Key failure modes blocked.** (a) exfiltration via a rogue localhost listener squatting a guessed port — blocked by handshake + constant-time token check + `GET /healthz` ownership probe; (b) partial uploads on listener crash — blocked by atomic temp-dir + rename on the listener and single-use token burn on success; (c) token leakage — the token is never logged, never printed to stdout except the CLI's initial pairing instructions, never written into `session.json`, never rendered in the side panel, and is scrubbed from error messages by a central `redactToken()` helper; (d) privacy notice drift — `PRIVACY.md` and the first-run notice are updated in the same PR with a pinning test.
- **Rollback is trivial.** The feature is off unless the `deskcheck_handoff` key is present. Reverting the feature = deleting the key (or reverting the small service-worker branch). No schema bump, no migration, no data shape change.

## 2. Architecture Impact

**Components affected:**
- `src/background/service-worker.ts`: the `EXPORT_SESSION` case (line 658–683) grows a new branch that reads a `deskcheck_handoff` chrome.storage.local key, validates it, runs the handoff, and falls back to the existing download path on any failure. No other cases change.
- `src/lib/exporter.ts`: unchanged. `exportSessionStreaming` still returns `Uint8Array`. We consume its output twice only on fallback (POST failed → download), never both.
- New `src/lib/handoff.ts` (pure module): URL validation, token constant-time compare, handoff record shape + runtime type guard, `redactToken` helper. Zero Chrome imports; unit-testable without mocks.
- New `src/lib/handoff-store.ts`: thin chrome.storage.local wrapper around the `deskcheck_handoff` key (get / set / clear), following the `privacy-store.ts` pattern.
- New `src/background/handoff-post.ts`: the actual POST. Takes `(handoff, zipBytes, session)` and returns a discriminated result union (`ok` | `transport_error` | `rejected` | `schema_mismatch`). Isolated so the service worker can unit-test it with a `fetch` stub.
- `src/lib/privacy.ts`: `PRIVACY_NOTICE_BULLETS` and `PRIVACY_MD_TEMPLATE` gain a new bullet about CLI handoff and 127.0.0.1-only. The existing sentence "DeskCheck never transmits session data over the network" is rewritten to reflect reality.
- `manifest.json`: **no** new permissions. MV3 extensions can `fetch` loopback from an extension service worker without a host permission entry because extension-origin fetch is exempt from `host_permissions` for `127.0.0.1`/`localhost` — **we must verify this empirically during implementation** (see Open Question 1). If a permission is required, `http://127.0.0.1/*` only, never `<all_urls>`.
- **New `cli/` workspace package**: Node + TypeScript, shares types with the extension via a relative import from `../src/types`. Adds `cli/package.json`, `cli/src/listen.ts`, `cli/src/server.ts`, `cli/src/writer.ts`, `cli/bin/deskcheck`. Wired through a new `make cli` target and a new `npm run cli`.

**New patterns or abstractions introduced:**
- **Handoff record** (pure data, lives in chrome.storage.local under `deskcheck_handoff`, never in `SessionMetadata`). Shape: `{ session_id: string; listener_url: string; token: string; created_at: string; }`. Never exported, never serialized to `session.json`, never surfaced in the UI. Justification: keeping it out of `SessionMetadata` makes it structurally impossible to leak into the exported zip — there is no code path that reads chrome.storage-level handoff data and writes it into `SessionExport`.
- **Handshake protocol**: before POSTing the zip, the extension sends `GET /healthz` to the listener URL and expects a JSON body `{ product: "deskcheck", version: "1", accepted_schema: "1.2.0" }` with HTTP 200. A mismatch on `product`, `version`, or `accepted_schema` falls through to download. This is the defence against "some other process is squatting the port". Justification below in the risks section.

**Dependencies added or modified:**
- `cli/package.json` adds a dev dependency on `tsx` (or `@types/node`) and nothing else runtime — the listener uses only Node `http`, `fs/promises`, `crypto`. **No Express, no Fastify, no `multer`.** Every dependency is a new attack surface; we want zero.
- `package.json` root: no new dependencies for the extension side. `fetch` is globally available in MV3 service workers.

**Breaking changes to existing interfaces:**
- None. `SessionMetadata` shape is unchanged (pinned by `exporter.golden.test.ts`), `SCHEMA_VERSION` is unchanged, the existing download path is unchanged for sessions without a handoff record.

**Risk points in architecture this task touches:**
- The `EXPORT_SESSION` handler is the only place that touches user-visible file output. Every bug here is visible to the user immediately (missing file, duplicate file, wrong file). Blast radius is 100% of users who click Stop & Download.
- Adding a network transport to a product whose `PRIVACY.md` currently says "DeskCheck never transmits session data over the network" is a privacy contract change. Every planner must treat the privacy notice update as load-bearing, not cosmetic.

## 3. Protocol contract

**Storage (set by the user, by hand, in Phase 1 — see Open Question 3):**
- Key: `deskcheck_handoff` in `chrome.storage.local`.
- Value: `{ session_id, listener_url, token, created_at }`.
- Lifecycle: set **before** the user clicks Start; cleared by the service worker after a successful POST or after the session ends without a POST. Stale records older than 24 hours are discarded by `handoff-store.get()`.

**Handshake (GET `listener_url + "/healthz"`):**
- No body. No token in this request.
- Listener must respond `200 OK` within 500 ms with `Content-Type: application/json` and body `{ product: "deskcheck", version: "1", accepted_schema: "1.2.0" }`.
- Any other status, any other body, any timeout → fallback to download.

**Upload (POST `listener_url + "/upload"`):**
- `Authorization: Bearer <token>` header. Token is **not** in the query string (keeps it out of server access logs).
- `Content-Type: application/zip`, raw zip body — no multipart. Multipart would need a parser and parsers are an attack surface.
- `X-DeskCheck-Session-Id: <session_id>` header.
- `X-DeskCheck-Schema-Version: 1.2.0` header (must match the constant from `agents-doc.ts`).
- Listener responds `200 OK` with `{ ok: true, path: "<abs-path-on-disk>" }` on success, `401` on token mismatch, `409` if a session-id dir already exists, `413` if the body exceeds a configurable max (default 200 MB), `415` if `Content-Type` is not `application/zip`.

**On-disk layout after a successful upload:**
- `DIR/<session_id>/session.zip` — the zip bytes exactly as posted, written atomically via `DIR/<session_id>.tmp-<pid>-<random>/` and renamed on success.
- **The zip is not unpacked.** Keeping it as a zip means the listener never has to understand the schema; the shell caller runs `unzip` itself if it wants the files. Keeps the attack surface tiny — the listener is a byte sink, not a parser.
- **Rationale for not unpacking**: the alternative (unpacked `session.json + screenshots/*.png`) means the listener must sanitize filenames, traverse the zip, reject path-traversal entries, and understand the schema. Every one of those is a bug waiting to happen. Phase 2 can revisit if a user asks for it.

## 4. Implementation Sequence

| # | Step | Files touched | Safety check | Rollback point |
|---|------|---------------|--------------|----------------|
| 1 | Land `src/lib/handoff.ts` with URL validator, handoff record shape, type guard, `redactToken`, constant-time compare. No Chrome imports. | `src/lib/handoff.ts` (new), `src/lib/handoff.test.ts` (new) | Unit tests prove only `http://127.0.0.1:PORT` and `http://localhost:PORT` with no path/query/fragment are accepted; IPv6 `::1` is accepted only in literal form `[::1]`; `http://127.0.0.1.evil.com` is rejected. | Revert single commit. |
| 2 | Land `src/lib/handoff-store.ts` (chrome.storage.local wrapper for `deskcheck_handoff`). Follows `privacy-store.ts`. | `src/lib/handoff-store.ts` (new), `src/lib/handoff-store.test.ts` (new) | Fake storage; tests prove read failure biases to "no handoff" so the default is always the download path. | Revert single commit. |
| 3 | Land `src/background/handoff-post.ts`. Pure function `performHandoff(handoff, zipBytes, schemaVersion, fetchImpl)` returning a discriminated result. No side effects except network. | `src/background/handoff-post.ts` (new), `src/background/handoff-post.test.ts` (new) | Unit tests stub `fetchImpl` and pin: handshake mismatch → `schema_mismatch`; 401 → `rejected`; network throw → `transport_error`; 200 → `ok`. **Deterministic — no live network.** | Revert single commit; `EXPORT_SESSION` not yet modified, so main code path unaffected. |
| 4 | Wire the `EXPORT_SESSION` case to check for a handoff record, call `performHandoff`, and fall back to the existing `chrome.downloads.download` call on any non-`ok` result. Clear the handoff record only on `ok`. | `src/background/service-worker.ts` lines 658–683 | Integration test in `tests/service-worker-handoff.test.ts` stubs `fetch` and `chrome.downloads.download`; pins that no handoff record → download is called, fetch is NOT called; handoff record → fetch is called, download is only called on non-`ok`. | Revert single commit. Recorded sessions continue to download. |
| 5 | Update `src/lib/privacy.ts` bullets and `PRIVACY_MD_TEMPLATE`. Add the new test rows in `privacy.test.ts` pinning the mention of CLI handoff and 127.0.0.1-only. Existing "never transmits" phrasing is rewritten. | `src/lib/privacy.ts`, `src/lib/privacy.test.ts` | `make test` runs privacy regression. | Revert single commit. |
| 6 | Land the CLI in a new `cli/` directory: `cli/src/listen.ts`, `cli/src/server.ts`, `cli/src/writer.ts`, `cli/bin/deskcheck`, `cli/package.json`, `cli/tsconfig.json`. Listener uses Node `http.createServer({host:'127.0.0.1'})` — never `0.0.0.0`. | New `cli/` directory | CLI unit tests use Node's test harness via vitest to assert: only 127.0.0.1 bind; non-loopback connect fails; token mismatch → 401 + no disk write; token match → zip written to atomic temp-dir then renamed. | Revert the `cli/` directory; extension no longer has anyone to POST to, but the handoff record will be absent on developer machines and the fallback will trigger. |
| 7 | Land the `make cli-build` / `make cli-test` targets and document them in `CLAUDE.md` and `docs/ARCHITECTURE.md`. | `Makefile`, `CLAUDE.md`, `docs/ARCHITECTURE.md` | `make test` and `make cli-test` both green in CI. | Revert single commit. |
| 8 | Land the end-to-end integration test: spawn the CLI on a random port, run `exportSessionStreaming` against a `FakeSessionStore`, POST the bytes, read the written zip back off disk, assert byte equality. | `cli/tests/e2e-handoff.test.ts` (new) | Assertions: byte equality; 401 on bad token; `exportSessionStreaming` output is unchanged. | Revert single commit; all earlier commits remain safe and independently revertable. |

## 5. Files to Create/Modify

| File | Purpose | Risk Notes |
|------|---------|------------|
| `src/lib/handoff.ts` (new) | URL validation, constant-time token compare, type guard, `redactToken`. | URL parsing is notoriously misused — tests must cover `http://127.0.0.1.evil.com`, `http://[::1]:9999`, `http://127.0.0.1:9999/../upload`, `http://127.0.0.1:9999#fragment`, `http://127.0.0.1:9999?x=1`. Accept only hostname == `127.0.0.1` or `localhost` or `[::1]`, pathname == `/`, empty search, empty hash. |
| `src/lib/handoff.test.ts` (new) | Unit tests for `handoff.ts`. | Pin every rejected URL shape above. Property-style tests are fine but the hostile cases are what matters. |
| `src/lib/handoff-store.ts` (new) | `chrome.storage.local` wrapper for `deskcheck_handoff`. Read failure biases to "no handoff". | Must never throw — a broken handoff store must fall through to the download path, never block export. |
| `src/lib/handoff-store.test.ts` (new) | Unit tests for `handoff-store.ts`. | Pin: read failure returns null. Write failure is logged but not thrown. |
| `src/background/handoff-post.ts` (new) | Handshake + POST, returns discriminated result. Takes `fetchImpl` for testability. | Must enforce a total timeout (5 s handshake, 60 s POST for a ~200MB zip). Must not follow redirects (`redirect: 'error'`). Must not send cookies. Must not follow cross-origin responses (set `mode: 'cors'`; any redirect off loopback is a rejection). |
| `src/background/handoff-post.test.ts` (new) | Unit tests for `handoff-post.ts`. | Stub `fetchImpl`; pin handshake mismatch, 401, 409, 200, network throw, redirect rejection, timeout rejection. **No live HTTP.** |
| `src/background/service-worker.ts` (modified) | Wire `EXPORT_SESSION` to call the handoff, fall back to download, clear the record on success. | Must keep the existing `store.deleteSession()` call and the `SESSION_CLEARED` broadcast regardless of which transport succeeded — the OPFS cleanup semantics are unchanged. Must NOT clear the OPFS session if both handoff AND download failed. |
| `src/lib/privacy.ts` (modified) | Update bullets and `PRIVACY_MD_TEMPLATE` to mention CLI handoff, 127.0.0.1-only, token-gated. | The existing "never transmits over the network" sentence is a lie after this feature ships. Rewrite, do not delete — the rewrite is load-bearing for user trust. |
| `src/lib/privacy.test.ts` (modified) | Add matrix rows pinning the CLI handoff mention. | |
| `tests/service-worker-handoff.test.ts` (new) | Integration test for the new branch. | Stubs `chrome`, `fetch`, `chrome.downloads.download`. Pins "no handoff record → zero fetch calls to any localhost address" (the non-regression test the brief requires). |
| `cli/package.json` (new) | Node workspace package for the CLI. | Zero runtime deps beyond Node stdlib. |
| `cli/src/server.ts` (new) | HTTP server factory. `http.createServer()` bound to `127.0.0.1`, per-connection 5 MB/s write buffer cap to defend against slowloris-style attacks. | Must call `server.listen({host: '127.0.0.1', port: 0})` only — `port: 0` means kernel-assigned. Must NOT accept `--host` as a flag. Must NOT listen on `0.0.0.0`. |
| `cli/src/writer.ts` (new) | Atomic zip writer: `DIR/<session_id>.tmp-<pid>-<rand>/session.zip` → `fsync` → rename. Validates session_id against `/^[A-Za-z0-9._-]{1,128}$/` to defeat path traversal. | A malicious or buggy extension could POST `session_id = "../../../etc/passwd"`. The regex is the last line of defence; `path.join(DIR, session_id)` followed by `path.resolve` comparison against `DIR` is the first. |
| `cli/src/listen.ts` (new) | Entry point: parses `--out`, mints token, starts server, prints ready line. | Token is only printed **inside a copy-paste block** labelled clearly, so the user can paste it into the extension. Never logged to stdout on every upload. |
| `cli/bin/deskcheck` (new) | Shebang script, delegates to `cli/src/listen.ts`. | |
| `cli/tests/server.test.ts` (new) | Server unit tests: 127.0.0.1 bind, 401, 409, 413, 415, path-traversal rejection. | See Test Level Matrix. |
| `cli/tests/e2e-handoff.test.ts` (new) | End-to-end: start server, export real zip, POST, assert byte equality on disk. | See Test Level Matrix. |
| `Makefile` (modified) | Add `make cli` and `make cli-test`. | |
| `docs/ARCHITECTURE.md` (modified) | Document the new handoff flow under Data Flow and Security. | |

## 6. Risk Assessment

### Threat model and mitigations

| Threat | Severity | Likelihood | Mitigation | Where it's blocked |
|--------|----------|------------|------------|---------------------|
| **Rogue local process squats the expected port and receives session data** | Critical | Medium | (a) Handshake GET `/healthz` with `{ product: "deskcheck", version: "1" }`; mismatch → fallback to download. (b) Per-session token that the squatter cannot guess. (c) The listener URL is set by the user, not auto-discovered — Phase 1 has no port-scanning. | `handoff-post.ts` handshake, `handoff.ts` URL validator |
| **Malicious website manipulates DOM / page URL to inject a listener URL into session metadata** | Critical | Medium | Handoff record lives in `chrome.storage.local`, which content scripts cannot write to. The content script path has **zero** code that can set `deskcheck_handoff`. Pinned by a grep test. | `handoff-store.ts` + new grep test (`tests/content-no-handoff-write.test.ts`) |
| **Exfiltration via non-loopback interface** | Critical | Low | CLI calls `server.listen({host:'127.0.0.1', port:0})`. No `--host` flag exists. An integration test attempts a non-loopback connect and asserts failure. | `cli/src/server.ts`, `cli/tests/server.test.ts` |
| **Token leakage via screenshots, logs, or session.json** | High | Medium | (a) Token is never written to `SessionMetadata` (lives in its own chrome.storage key). (b) `redactToken()` is used in every `console.warn` path in `service-worker.ts` and `handoff-post.ts`. (c) A grep test asserts no raw handoff-store code is reachable from exporter or sidepanel. (d) The CLI prints the token once at startup inside a clearly-marked pairing block and never on subsequent uploads. | `handoff.ts` redactor + grep test |
| **Partial upload on listener crash mid-POST** | High | Medium | Atomic temp-dir + rename on the listener. The CLI's `writer.ts` writes to `DIR/<id>.tmp-<pid>-<rand>/session.zip`, fsyncs, then renames. If the CLI crashes mid-write, the tmp dir is left behind and the final `<id>/` dir never appears — the extension's POST will return a transport error, and the extension falls back to the download path. The user always ends up with a zip somewhere. | `cli/src/writer.ts` |
| **Stale listener after CLI exits** | Medium | High | On `ECONNREFUSED` (CLI died), the extension falls back to download and clears the `deskcheck_handoff` record. On next session, the record is already cleared so the download path is used. | `service-worker.ts` export branch |
| **User confusion: they expected a download but got a silent POST** | High | Low (handoff must be explicitly set) | Phase 1 ships with an **explicit storage key**. The user has to set it on purpose (Open Question 3 resolves how). There is no zero-config discovery, no automatic port probe, no manifest field. Defence-in-depth: adding a side panel badge is Phase 2, but even in Phase 1 we add a `console.info` line to the SW on handoff success so chrome://extensions debug users can see it. | architectural (no auto-discovery) |
| **Unbounded zip body DoS's the listener** | Medium | Low | `413 Payload Too Large` at 200 MB default (configurable via `--max-size`). The listener counts bytes written to the temp file and aborts the request on threshold. | `cli/src/server.ts` |
| **Path traversal via malicious session_id** | High | Low | `session_id` validated against `/^[A-Za-z0-9._-]{1,128}$/` in `cli/src/writer.ts`; `path.resolve(DIR, session_id)` then compared against `path.resolve(DIR)` as a prefix check. | `cli/src/writer.ts` |
| **Replay attack: attacker replays a captured POST** | Medium | Low | Token is single-use: listener burns it on first successful upload (in-memory set). A second POST with the same token returns 401. The CLI mints a new token on restart. | `cli/src/server.ts` |
| **Privacy notice drift** | High | Medium | Step 5 updates `privacy.ts` and `privacy.test.ts` in the same PR. A new matrix row ("mentions CLI handoff") fails `make test` if the bullet is removed. | `privacy.test.ts` |
| **POST after session end: race between `STOP_SESSION` and `EXPORT_SESSION`** | Low | Medium | Export runs synchronously after Stop in the sidepanel's own handler. The handoff uses the handoff record that was set before Start. No race because the SW owns the handoff clear on success. | `service-worker.ts` |
| **Schema bump accidentally breaks the listener** | Medium | Low | `handoff-post.ts` sends `X-DeskCheck-Schema-Version` and the listener echoes it back in `/healthz`. A mismatch fails the handshake → download fallback. An integration test bumps the extension's constant and asserts the handshake rejects. | `handoff-post.ts` handshake |

### Failure Modes Analysis (load-bearing ones)

1. **Listener returns 200 but does not actually write the file.** A buggy or malicious listener could ack success and silently drop the data. Detection: after the POST, the extension has no way to verify (it can't `fs.stat` the caller's disk). Mitigation: log a SW `console.info` with the returned `path` so the user can see where it was supposed to land; the CLI is the only trusted listener, and its own integration test pins that a 200 always corresponds to a renamed file on disk. Recovery: the OPFS session is cleared on handoff success, so there's no way back — this is why the `ok` status is load-bearing. **Accepted residual risk.**

2. **fetch() on MV3 SW silently drops the body on very large zips.** Possible; needs empirical check during implementation. Detection: the `Content-Length` of the response gives us a heuristic. Recovery: if the POST throws or returns non-200, fall back to download. The OPFS session is NOT cleared until one transport succeeds.

3. **CLI crashes between `fsync` and `rename`.** The temp dir is left behind. Recovery: the next `deskcheck listen` run does NOT auto-clean temp dirs (that would be a rm-rf footgun); instead it logs a warning listing stale temp dirs so the user can delete them by hand.

4. **User has two `deskcheck listen` processes running on different ports with different `--out` dirs.** Only one is in the `deskcheck_handoff` key. The other never sees traffic. This is fine — it's the user's choice.

5. **Extension clears the handoff record, then the download fails.** OPFS session is still intact (step 4 in the sequence above keeps cleanup tied to ANY-transport success). The user can retry the export from the stopped state. Note this requires a small refactor to `EXPORT_SESSION` so `store.deleteSession()` only runs after a successful transport.

### Blast Radius
- **Affected users**: Users who click Stop & Download. In practice: only users who have set `deskcheck_handoff`. Non-CLI users are entirely unaffected (they never touch the new branch).
- **Affected systems**: The extension's OPFS store and the developer's local disk (via the CLI). No remote systems. No cloud.
- **Data at risk**: A single session's events + screenshots + annotations. Loss risk is a fresh session; corruption risk is nil because the transport is all-or-nothing (200 with bytes written OR fallback to download).

## 7. Definition of Done
- [ ] `deskcheck listen --out DIR` binds only `127.0.0.1`, prints the bound port and a token pairing block, and writes received zips under `DIR/<session-id>/session.zip` atomically.
- [ ] Listener rejects non-loopback connects (test pinned).
- [ ] Listener rejects mismatched tokens with 401 and writes nothing to disk (test pinned).
- [ ] Listener rejects path-traversal session ids with 400 (test pinned).
- [ ] Listener responds to `/healthz` with `{ product, version, accepted_schema }`.
- [ ] Extension POSTs to listener only when `deskcheck_handoff` chrome.storage key is present, the URL validator accepts the URL, the session_id matches, and the handshake passes (all four independent checks pinned).
- [ ] Manual sessions without a handoff record download via the existing path with zero behaviour change (test pinned: zero `fetch` calls to localhost).
- [ ] POST failure falls back to download (test pinned).
- [ ] Token is never logged, never written to `session.json`, never surfaced in the side panel (grep test + manual audit).
- [ ] `redactToken()` covers every `console.warn` in the new code.
- [ ] `PRIVACY.md` and the first-run notice mention CLI handoff and the 127.0.0.1-only guarantee (test pinned).
- [ ] `schema_version` is unchanged, verified by the existing `exporter.golden.test.ts`.
- [ ] Rollback procedure: reverting the service-worker edit alone disables the feature for everyone.
- [ ] All tests pass; `make typecheck` green; `make cli-test` green.

## 8. Suggested Test Levels

| # | DoD Criterion | Level | File | Rationale |
|---|---------------|-------|------|-----------|
| 1 | URL validator accepts only loopback, no path/query/fragment, rejects `127.0.0.1.evil.com` | Unit | `src/lib/handoff.test.ts` | Pure logic, adversarial string cases are the whole point |
| 2 | Handoff record type guard rejects malformed inputs | Unit | `src/lib/handoff.test.ts` | Pure logic |
| 3 | Constant-time token compare returns correct result under length mismatch | Unit | `src/lib/handoff.test.ts` | Pure logic; the mitigation for timing-based token guessing |
| 4 | `handoff-store.get()` returns `null` on storage read failure (never throws) | Unit | `src/lib/handoff-store.test.ts` | Safe default: missing → download path |
| 5 | `handoff-store.get()` discards records older than 24h | Unit | `src/lib/handoff-store.test.ts` | Stale record defence |
| 6 | `performHandoff` → `ok` on handshake + 200 | Unit | `src/background/handoff-post.test.ts` | Fetch stubbed; deterministic |
| 7 | `performHandoff` → `schema_mismatch` on `/healthz` product mismatch | Unit | `src/background/handoff-post.test.ts` | Squatter defence |
| 8 | `performHandoff` → `rejected` on 401 | Unit | `src/background/handoff-post.test.ts` | Token mismatch defence |
| 9 | `performHandoff` → `transport_error` on fetch throw | Unit | `src/background/handoff-post.test.ts` | Dead-listener fallback |
| 10 | `performHandoff` rejects on cross-origin redirect | Unit | `src/background/handoff-post.test.ts` | `redirect: 'error'` |
| 11 | `performHandoff` enforces total timeout | Unit | `src/background/handoff-post.test.ts` | Dead-listener fallback; uses `AbortController` |
| 12 | `EXPORT_SESSION` with no handoff record: zero fetch calls, download called once | Integration | `tests/service-worker-handoff.test.ts` | **The non-regression test the brief requires** |
| 13 | `EXPORT_SESSION` with handoff record and `ok`: fetch called, download NOT called, OPFS cleared | Integration | `tests/service-worker-handoff.test.ts` | Happy path |
| 14 | `EXPORT_SESSION` with handoff record and `rejected`: fetch called, download called as fallback, OPFS cleared | Integration | `tests/service-worker-handoff.test.ts` | Fallback |
| 15 | `EXPORT_SESSION` with handoff record and all transports failing: OPFS NOT cleared | Integration | `tests/service-worker-handoff.test.ts` | Data retention on total failure |
| 16 | `EXPORT_SESSION` with handoff record whose session_id mismatches active session: fetch NOT called, download called, record cleared | Integration | `tests/service-worker-handoff.test.ts` | Opt-in layer #2 |
| 17 | Content script source does not import `handoff-store` | Grep | `tests/content-no-handoff-write.test.ts` | Opt-in layer defence (content script cannot forge a handoff) |
| 18 | Sidepanel source does not import `handoff-store` | Grep | `tests/sidepanel-no-handoff-write.test.ts` | Defence-in-depth, complements `sidepanel-no-direct-capture.test.ts` |
| 19 | Exporter does not reference `deskcheck_handoff` key | Grep | `tests/exporter-no-handoff-read.test.ts` | Token never appears in exported JSON |
| 20 | `PRIVACY.md` mentions CLI handoff and 127.0.0.1-only | Unit | `src/lib/privacy.test.ts` | Notice drift defence |
| 21 | First-run notice bullets mention CLI handoff | Unit | `src/lib/privacy.test.ts` | Notice drift defence |
| 22 | CLI binds only 127.0.0.1 — attempting to connect from 0.0.0.0/local-IP fails | Integration | `cli/tests/server.test.ts` | **The security test the brief requires** |
| 23 | CLI rejects POST with wrong token with 401 and writes nothing | Integration | `cli/tests/server.test.ts` | Token auth |
| 24 | CLI rejects POST with used token (replay) with 401 | Integration | `cli/tests/server.test.ts` | Single-use token |
| 25 | CLI rejects POST with path-traversal session_id with 400 | Integration | `cli/tests/server.test.ts` | Filesystem defence |
| 26 | CLI rejects POST exceeding `--max-size` with 413 | Integration | `cli/tests/server.test.ts` | DoS defence |
| 27 | CLI rejects POST with wrong Content-Type with 415 | Integration | `cli/tests/server.test.ts` | Parser-surface defence |
| 28 | CLI `/healthz` returns `{ product: "deskcheck", version: "1", accepted_schema: "1.2.0" }` | Integration | `cli/tests/server.test.ts` | Handshake contract |
| 29 | CLI writes to atomic temp-dir and renames on success | Integration | `cli/tests/server.test.ts` | Partial-upload defence |
| 30 | End-to-end: export a real session, POST it, read zip from disk, assert byte equality | Integration | `cli/tests/e2e-handoff.test.ts` | **The byte-for-byte DoD test** |
| 31 | `schema_version` is unchanged | Unit (existing) | `src/lib/exporter.golden.test.ts` | Already pinned |

**Safety planner bias**: Lean hard on integration for anything that touches the boundary between extension and CLI. Lean on grep tests for anti-regression guarantees (content script can't forge a handoff, sidepanel can't read a token). Unit tests for pure logic. **No e2e Playwright tests in Phase 1** — the CLI is Node, the extension is Chrome, stitching them across a real browser is expensive and the integration tests on each side already give 90% of the confidence.

**Determinism rule**: All tests are deterministic. The CLI tests use Node's `http.createServer({port: 0})` so the port is kernel-assigned. The extension tests stub `fetch`. No tests call live LLMs or live networks. No tests depend on wall-clock time except the 24h-stale-record test, which uses an injectable `now()`.

## 9. Testing Strategy (Comprehensive)

### Unit tests
- `handoff.ts`: URL validator positive + negative cases; `redactToken` strips token from arbitrary strings; constant-time compare works on equal, shorter, longer, and different-char inputs.
- `handoff-store.ts`: get / set / clear / stale-discard; biases to null on failure.
- `handoff-post.ts`: full discriminated-result coverage as listed in the matrix.
- `privacy.ts`: new bullet regression.

### Integration tests
- `tests/service-worker-handoff.test.ts`: the service-worker branch with a stubbed `chrome` and stubbed `fetch`. Covers all four opt-in layers and the fallback path.
- `cli/tests/server.test.ts`: real `http.createServer`, real POSTs from the test process, real `fs` writes into a temp dir. Covers every status code, 127.0.0.1 bind check, atomic rename, token auth, replay defence, DoS defence, path-traversal defence.
- `cli/tests/e2e-handoff.test.ts`: boots the server, invokes the real `exportSessionStreaming` against a `FakeSessionStore`, POSTs the bytes via the extension's actual `handoff-post.ts` module (Node's fetch is compatible), reads the written zip back, compares bytes.

### E2E tests
- **None in Phase 1.** Justification: the existing e2e suite lives in Playwright against a real Chrome. Stitching a spawned CLI process into Playwright is a high-cost, low-value addition when the boundary is already pinned by integration tests on both sides. Phase 2 will add a single e2e when the CLI-launched Chrome flow lands (since that flow needs a real browser anyway).
- **Existing e2e tests affected**: None. The EXPORT_SESSION change is fall-through (no handoff record → zero behaviour change) and existing e2e tests never set `deskcheck_handoff`.

### Regression tests
- `src/lib/exporter.golden.test.ts`: unchanged, still pins the schema.
- `tests/sidepanel-no-direct-capture.test.ts`: unchanged, still pins that the sidepanel can't call privileged APIs.
- New: `tests/sidepanel-no-handoff-write.test.ts` and `tests/content-no-handoff-write.test.ts`: grep-style pins.

### Load/stress tests
- `cli/tests/server.test.ts` includes a single 200MB POST to exercise the streaming receiver and the 413 threshold. Not a comprehensive load test — this is a phase 1 receiver and expected usage is one POST per session.

**Test files to create/modify**: listed in the "Files to Create/Modify" table above.

## 10. Rollback Strategy

### Trigger conditions
- Reports of unexpected data loss on Stop & Download.
- Reports of unexpected network traffic to localhost from users who did not opt in.
- Any CVE-class issue in the listener (path traversal, port binding, etc.).
- POST failure rate exceeds ~5% in the CLI users' logs.

### Rollback steps
1. Revert the `service-worker.ts` diff (single commit) — this disables the handoff branch for all users immediately on next extension reload.
2. Alternatively, users can unilaterally disable the feature by deleting the `deskcheck_handoff` key via chrome://extensions → Service Worker → DevTools → `chrome.storage.local.remove('deskcheck_handoff')`.
3. For a zero-code rollback, the CLI can simply be stopped — the extension's `ECONNREFUSED` fallback kicks in and every session downloads as before.
4. Publish a new extension version with the revert if the issue is severe.

### Verification after rollback
- [ ] `tests/service-worker-handoff.test.ts` — the "no handoff record → zero fetch" row still green.
- [ ] Users who previously set a handoff record no longer see POSTs.
- [ ] Downloads resume.
- [ ] No OPFS data loss (the session should have been cleared on the successful transport before the rollback).

### Rollback tested?
- [x] The rollback path is equivalent to "never having set the handoff record", which is exactly what integration test #12 pins. This means the rollback is **continuously tested** via CI.

## 11. Monitoring & Alerting

Phase 1 does not add telemetry — DeskCheck ships with zero analytics. Monitoring is manual via:
- Chrome DevTools Network tab on the service worker (for the extension side).
- CLI stdout (for the listener side).
- `chrome://extensions` → Errors for the service worker.

The CLI logs every successful upload to stdout with session_id, byte count, and destination path. **It does NOT log the token** (enforced by `redactToken`). The CLI logs every rejected upload with reason + source IP (always 127.0.0.1).

## 12. Deployment Recommendations

- [x] **Feature flag**: Implicit — the `deskcheck_handoff` storage key IS the flag. No global toggle, no manifest field. This is the safest possible rollout because the default for all existing users is "feature off". Rationale: **opt-in is structurally better than opt-out** for any feature that changes where user data flows.
- [x] **Gradual rollout**: Not required because the feature is off-by-default. A user who does not manually set the handoff key sees zero change.
- [x] **Staging verification**: Manual verification on a clean Chrome profile before merge: (1) Run CLI; (2) Set handoff key in chrome://extensions DevTools; (3) Record a session; (4) Stop & Download; (5) Confirm zip lands at the CLI path; (6) Clear the handoff key; (7) Stop & Download again; (8) Confirm zip downloads normally.
- [ ] **Off-hours deployment**: Not required (opt-in).

## 13. Estimated Effort

- Step 1 — `handoff.ts` + tests: 0.5 day
- Step 2 — `handoff-store.ts` + tests: 0.25 day
- Step 3 — `handoff-post.ts` + tests: 0.75 day
- Step 4 — `service-worker.ts` branch + integration test: 0.75 day
- Step 5 — privacy notice updates + tests: 0.25 day
- Step 6 — CLI (`cli/` package) + unit tests: 1.5 days
- Step 7 — Makefile, docs: 0.25 day
- Step 8 — end-to-end integration test: 0.5 day
- Privacy audit + grep tests + manual verification: 0.5 day
- **Total: ~5.25 person-days**

This is notably larger than a speed plan would estimate (~2 days) — the difference is the four-layer opt-in, the handshake protocol, the atomic listener writer, the grep tests, and the byte-level integration test. I am **not hiding** the overhead: every hour of this 5.25-day estimate is spent on a specific mitigation that the threat model demands.

## 14. Formal Verification Assessment
- **Concurrency concerns**: Yes — the `EXPORT_SESSION` branch interacts with the OPFS cleanup, the handoff clear, and the fallback download. A SW restart mid-handoff could theoretically leave state inconsistent, though the current design makes the OPFS session the source of truth until transport success.
- **State machine complexity**: Low — handoff has two outcomes per transport (`ok`, `not-ok`) and the fallback is a linear list. Not worth TLC.
- **Conservation laws**: The zip bytes are the conserved quantity. Either one transport consumes them (POST or download) or both fail and the OPFS session remains intact. The invariant to prove: `session_cleared ⇒ at_least_one_transport_succeeded`. This is a one-line assertion in the integration test; TLC overkill.
- **Authorization model**: Token-based, per-session, single-use. Straightforward.
- **Recommendation**: **Not needed.** The integration test matrix covers the entire state space (4 handoff-record states × 3 transport results = 12 cases, of which 5 are interesting and all are in the matrix above). TLC would be ceremony.
- **Key invariants** (encoded as integration test assertions, not TLC):
  1. No handoff record → no `fetch` call to loopback.
  2. Handoff record with mismatched session_id → no `fetch` call.
  3. Successful POST → OPFS cleared, download NOT called.
  4. Failed POST → OPFS NOT cleared UNTIL download succeeds.
  5. Failed POST AND failed download → OPFS NOT cleared; session remains recoverable.

## 15. Security Considerations
- [x] No secrets in code (token is generated at runtime by the CLI).
- [x] Input validation complete (URL validator, session_id regex, Content-Type check, Content-Length check).
- [x] Output encoding: zip bytes are opaque, no string interpolation into HTML or shell.
- [x] Authentication: per-session Bearer token, constant-time compare.
- [x] OWASP top 10: (A01 Broken Access Control — mitigated by token + loopback bind; A03 Injection — mitigated by session_id regex; A05 Security Misconfiguration — mitigated by explicit `{host: '127.0.0.1'}` and no `--host` flag; A08 Software and Data Integrity — mitigated by single-use token + atomic rename).
- [x] **Non-OWASP but critical**: the `PRIVACY.md` and first-run notice updates are treated as a shipping blocker.

## 16. Risks and tradeoffs — what I'm hardening and what I'm accepting

### Hardened
- Every opt-in layer is independent: storage key → URL shape → session_id match → handshake → token. Defeating one does not defeat the others.
- The CLI is a byte sink with zero schema knowledge. It cannot be exploited via a malformed zip.
- The listener writer is atomic.
- The token never leaves the two processes that need it.
- Failure modes prefer fallback-to-download over "successful but wrong POST".
- Privacy notice drift is pinned by tests that fail CI if the bullet is removed.

### Accepted residual risk
- **A malicious user who has local shell access to the machine can read the `deskcheck_handoff` record via chrome.storage.local and exfiltrate sessions to their own listener.** Phase 1 cannot defend against a compromised local shell — that is outside the threat model. Phase 2's hash-fragment handoff makes this slightly better (the token only exists for the duration of the launched session), but even there a local attacker wins. Local code execution is always game over.
- **The user is trusted to keep the `--out DIR` safe.** If the user points the CLI at `/tmp/public-share/`, that is a user configuration error, not a listener bug.
- **The extension cannot verify that the zip actually landed on disk.** The 200 OK from the listener is the proof. We mitigate by shipping the CLI in the same repo as the extension, so the trust boundary is one team, not two.
- **No telemetry on handoff success/failure rates.** This is a DeskCheck project constraint (zero analytics), not a plan decision. Users have to tell us when it breaks.

### Tradeoffs vs. the other planners
- **vs. Speed plan**: I am spending ~3 extra person-days on the handshake, grep tests, and atomic writer. The speed plan will likely skip the `/healthz` handshake and the byte-level integration test. If the judge picks speed, the product ships faster but the port-squatting attack is unblocked.
- **vs. Quality plan**: I am not proposing a session-state formal model (quality plan might), not introducing a new abstraction for "transport strategy" (could be over-engineered), not adding integration tests for rare SW-eviction scenarios. My plan is narrower than quality but wider than speed.
- **What I'm not testing**: The interaction between the handoff and the `tab-group.ts` flow (assumed independent and already pinned). The interaction between handoff and `chrome.commands` shortcuts (assumed the keyboard Stop still flows through the same `EXPORT_SESSION` message handler). Both could be added in a second pass.

## 17. Open Questions for the Judge

1. **MV3 host permission for loopback fetch.** Does the extension need `http://127.0.0.1/*` in `host_permissions` to POST to the listener from a service worker? Empirical check required during implementation; if yes, add it — `127.0.0.1/*` is still the minimum viable permission and does not touch `<all_urls>`. The speed planner should share the answer here.

2. **Node CLI vs. Go binary.** I picked Node to (a) share `src/types.ts` directly via relative import, (b) keep one toolchain for both extension and CLI, (c) use the existing Vitest test harness for CLI tests, and (d) avoid cross-compiling Go binaries for distribution. **Safety consideration**: Node has a larger attack surface than a single static Go binary because of its ecosystem, but in Phase 1 we use **zero** runtime dependencies (only Node stdlib: `http`, `fs/promises`, `crypto`, `path`), which reduces the delta. I recommend Node; the judge may override if distribution is a higher priority than type-sharing.

3. **How does the user configure the handoff in Phase 1?** Three options:
   - **(a) chrome.storage.local DevTools paste.** User opens chrome://extensions, opens the SW DevTools, and runs `chrome.storage.local.set({deskcheck_handoff: {...}})`. Zero new UI; zero attack surface; ugly UX.
   - **(b) A tiny "Attach to listener" affordance in the side panel.** A textarea where the user pastes `listener_url` and `token` printed by `deskcheck listen`. Adds UI surface and a new input sink.
   - **(c) A fixed well-known port with a `deskcheck listen --port 9876 --token $(cat ~/.deskcheck-token)` ceremony.** Predictable port is a port-squatting target.
   - **Safety recommendation**: (a) for Phase 1. Phase 2's hash-fragment handoff will give us (b) for free without the textarea. (c) is the worst of all three.

4. **Byte-level comparison of POSTed zip vs. downloaded zip.** The DoD says "byte-for-byte". Due to fflate's zip layout being deterministic given the same inputs, this is testable. But the test requires running `exportSessionStreaming` twice on the same `FakeSessionStore` — once for each transport — and the streaming API may generate timestamps. **I assume fflate's `ZipPassThrough` with no compression produces deterministic output modulo timestamps** and propose checking this during implementation. If timestamps drift, the test compares `unzipSync(posted)` vs `unzipSync(downloaded)` byte-wise per entry instead, which is still a meaningful guarantee.

5. **Should the CLI auto-delete stale temp dirs on startup?** Safer to require manual cleanup (accept staleness) rather than auto-delete on startup (rm -rf footgun). I chose manual. The judge may disagree — if so, add a `--cleanup-stale` flag rather than auto-enabling.

6. **Should `deskcheck listen` print the token on the first line of stdout, or hide it behind `--print-token`?** I propose a clearly-marked pairing block on startup, but the token is still stdout-visible. Alternative: write to a file mode-0600 and print the file path. I lean toward the pairing block because "copy-paste-once" is the actual UX, but the file approach is safer on multi-user machines.
