---
agent: speed-planner
generated: 2026-04-11T00:00:00Z
task_id: feature-14
perspective: speed
---

# Speed Plan: Feature #14 Phase 1 — Local handoff receiver

## 1. Executive summary

- **Ship a Node CLI (`cli/deskcheck.mjs`), not a Go binary.** The repo already runs Node (vitest node env, vite, fflate). A ~120-line zero-dep Node script using only built-ins (`http`, `fs`, `crypto`, `process`, `path`) reuses the existing vitest harness for tests and adds zero new toolchain. Go costs us a new language, a CI step, a cross-compile story, and a second test runner — all for a binary that only has to exist on the maintainer's mac for the first release.
- **Config lives in `chrome.storage.local` under a single key `dc_listener`** — `{url, token}`. A tiny "Attach to CLI" affordance is added beside the PII mode selector: paste the ready-line that `deskcheck listen` prints, click Attach, done. No new surface, no new message type beyond a trivial setter. Phase 1 explicitly has no CLI-launched session, so user configuration is unavoidable — paste-from-terminal is the dumbest thing that works.
- **Single branch at `EXPORT_SESSION` (service-worker.ts:658-683).** Read `dc_listener` from storage; if present, attempt a POST of the exact same `zipBytes` that `exportSessionStreaming` already produced; on success, `deleteSession()` + broadcast, skipping `chrome.downloads`. On any POST failure (network error, non-2xx, token mismatch), fall through to the existing download path and surface a warning. Zero refactor of `exporter.ts`; the listener consumes the existing `Uint8Array` directly as a `Blob` body.
- **Protocol is raw zip body + two headers.** `POST /upload` with `content-type: application/zip`, `x-deskcheck-token: <token>`, `x-deskcheck-session-id: <id>`. Body is the zip. 2xx = accepted, 401 = bad token. That's it — no multipart, no JSON envelope, no schema fields to design.
- **On-disk layout: `DIR/<session-id>.zip`.** One file per session. No unzip-on-receive (more code to write, break, and test). Consumers that need the contents shell out to `unzip` — the CLI's job is to land the bytes on disk, not to be a file manager.
- **Risk**: small. The opt-in constraint (no `dc_listener` key → no network traffic) is the kill switch, verified by spy test. Schema is unchanged. No manifest permission changes needed (`<all_urls>` host_permissions already covers localhost fetches).

## 2. Proposed architecture

### New files

| File | LoC | Purpose |
|------|-----|---------|
| `cli/deskcheck.mjs` | ~120 | Zero-dep Node CLI. `deskcheck listen --out DIR [--port N]`. Binds `127.0.0.1`, accepts `POST /upload` with token header, writes `DIR/<session-id>.zip`. |
| `cli/README.md` | ~30 | How to run. (Minimal — no separate docs site.) |
| `src/lib/listener-config.ts` | ~40 | Pure module: parse the ready-line the CLI prints, validate shape, `{url, token, out}` helpers. Unit-testable without any chrome/storage mock. |
| `tests/cli-listener.test.ts` | ~180 | Node integration test against a spawned `cli/deskcheck.mjs`: upload OK, token mismatch → 401, loopback-only binding check, file lands at `<out>/<id>.zip`. |
| `tests/service-worker-listener.test.ts` | ~200 | SW unit test modelled on `service-worker-tab-group.test.ts`: listener key set → POSTs via `globalThis.fetch` spy, listener key unset → no fetch + download path fires (opt-in pin), POST failure → download fallback fires. |
| `tests/listener-config.test.ts` | ~40 | Pure unit test for the ready-line parser. |

### Modified files

| File | Est. lines changed | Why |
|------|-------------------|-----|
| `src/background/service-worker.ts` | +40 / -5 | Add `maybePostToListener()` helper, branch at `EXPORT_SESSION`. |
| `src/sidepanel/sidepanel.ts` | +35 | Attach-to-listener row beside PII selector. One input + button + tiny status label. Hide-not-disable pattern already used here. |
| `src/sidepanel/sidepanel.css` | +15 | Minimal styles for the new row (reuse existing `.form-row`/`.btn` classes where possible). |
| `src/lib/privacy.ts` | +4 | One bullet in `PRIVACY_NOTICE_BULLETS` and one line in `PRIVACY_MD_TEMPLATE` mentioning CLI handoff + 127.0.0.1-only. |
| `Makefile` | +4 | `make cli-test` target wrapping `node --test cli/...` — or, preferred, just let vitest drive it via `tests/cli-listener.test.ts`. |
| `package.json` | +3 | `"bin": {"deskcheck": "cli/deskcheck.mjs"}` so `npx deskcheck listen` works locally without a global install. No new deps. |

**Total**: 6 new files, 6 modified files, ~700 lines (mostly tests).

### Protocol contract

**Session metadata field** (NOT a schema bump — stored in `chrome.storage.local` under the `dc_listener` key, NOT in `SessionMetadata`/`session.json`):

```ts
// src/lib/listener-config.ts
export interface ListenerConfig {
  url: string;     // e.g. "http://127.0.0.1:8787"
  token: string;   // opaque, 32+ hex chars
}
```

Storing this at the SW level rather than on `SessionMetadata` is deliberate: the export path is a transport concern, not a schema concern, and the brief explicitly forbids a schema bump. A listener config set once in the side panel applies to subsequent sessions until the user clears it.

**HTTP request**:
```
POST /upload HTTP/1.1
Host: 127.0.0.1:<port>
Content-Type: application/zip
Content-Length: <bytes>
X-Deskcheck-Token: <token>
X-Deskcheck-Session-Id: <uuid>

<zip bytes>
```

**Responses**:
- `201 Created` + `{"ok": true, "path": "/abs/path/<id>.zip"}` — zip written.
- `401 Unauthorized` + `{"error": "bad token"}` — no disk write.
- `400 Bad Request` — missing headers.
- `413 Payload Too Large` — configurable cap, default 256 MB.

**Ready-line format** (printed by `deskcheck listen`):
```
deskcheck listener ready url=http://127.0.0.1:8787 token=a1b2c3...f9
```

This is what the user pastes into the sidepanel "Attach to CLI" input. The sidepanel parses it with `listener-config.ts` and stores `{url, token}` in `chrome.storage.local`.

### Component responsibilities

1. **`cli/deskcheck.mjs`** — Subcommand router (only `listen` in phase 1), bind `127.0.0.1`, generate token via `crypto.randomBytes(16).toString("hex")`, accept POSTs, validate token constant-time, stream body to `fs.createWriteStream(join(out, `${id}.zip`))`, delete partial file on stream error. Prints ready-line to stdout. Ctrl-C cleanly shuts down and any held token is dropped (token lives only in-process — brief requirement "tokens expire when the CLI process exits" is met for free).
2. **`src/lib/listener-config.ts`** — Pure ready-line parser + storage-key constants. No chrome imports.
3. **`service-worker.ts`** — Single new helper:
   ```ts
   async function maybePostToListener(
     sessionId: string,
     zipBytes: Uint8Array,
   ): Promise<{ posted: boolean; error?: string }>
   ```
   Called once in the `EXPORT_SESSION` handler. Reads `dc_listener` from storage inside the helper (not at module load) so unsetting the key takes effect immediately.
4. **Sidepanel row** — Two elements: `<input id="listener-paste">` and `<button id="listener-attach">`. On click, parse via `listener-config.ts`, write to `chrome.storage.local`, replace with `"Attached: http://127.0.0.1:8787 · Detach"` label. Strictly an affordance; it does not gate recording.

## 3. Implementation sequence

Order is chosen so each step is independently testable and PR-reviewable:

1. **`src/lib/listener-config.ts` + `tests/listener-config.test.ts`** — pure, no env deps. Parse-and-validate the ready-line. ~30 min.
2. **`cli/deskcheck.mjs` + `tests/cli-listener.test.ts`** — spawn via `node:child_process` inside vitest, `node:net` connection from `0.0.0.0` asserts ECONNREFUSED, `fetch` from `127.0.0.1` asserts 201. ~4h.
3. **`service-worker.ts` branch + `tests/service-worker-listener.test.ts`** — model on `service-worker-tab-group.test.ts`, inject `globalThis.fetch = vi.fn()` before `loadServiceWorker`. Three cases: key unset (no fetch), key set + 201 (no download), key set + POST rejected (download fires). ~3h.
4. **Sidepanel attach row** — minimal UI with one test added to `src/sidepanel/sidepanel.test.ts` asserting "paste ready-line → storage.set called with parsed config". ~2h.
5. **Privacy copy update** — one bullet + one paragraph in `src/lib/privacy.ts`. Existing `privacy.test.ts` (if it pins specific bullet count) is updated in the same commit. ~15 min.
6. **Makefile + package.json bin** — make `npx deskcheck listen --out /tmp/dc` work for a local smoke test. ~10 min.
7. **Manual smoke: load unpacked + run `npx deskcheck listen --out /tmp/dc` + record a 30-second session + confirm zip lands** — ~20 min.

**Dependency graph**: 1 → 2 (CLI parses what 1 defines), 1 → 3 (SW reads same storage key), 1 → 4 (sidepanel writes same key). Steps 2 / 3 / 4 can be parallelised after 1.

## 4. Test Level Matrix

| # | DoD item | Test level | Test file | Notes |
|---|----------|-----------|-----------|-------|
| 1 | `deskcheck` CLI ships in the repo | **manual-verify** | — | File existence + `node cli/deskcheck.mjs --help` in CI check. |
| 2 | `deskcheck listen --out DIR` starts an HTTP server on 127.0.0.1, prints port + ready line, writes zips under `DIR/<session-id>/` (we're using `DIR/<id>.zip` — justified in §2) | **integration** | `tests/cli-listener.test.ts` | Spawn CLI via `child_process.spawn`, parse ready-line from stdout, POST a fixture zip, assert file on disk. |
| 3 | Extension background worker POSTs to a local listener when session metadata carries a listener URL + token | **unit** (SW) | `tests/service-worker-listener.test.ts` | Seed `chrome.storage.local` with `dc_listener`, dispatch `EXPORT_SESSION`, assert `globalThis.fetch` called with expected URL + headers + body byte-length, assert `chrome.downloads.download` NOT called. |
| 4 | Listener validates per-session token, rejects mismatches | **integration** | `tests/cli-listener.test.ts` | POST with wrong token, expect 401, assert no file under `out/`. |
| 5 | Listener binds 127.0.0.1 only — non-loopback connect fails | **integration** | `tests/cli-listener.test.ts` | `net.connect({ host: "0.0.0.0", port })` → expect ECONNREFUSED, plus `server.address().address === "127.0.0.1"` assertion. |
| 6 | Manual (non-CLI) sessions continue to download with no behaviour change | **unit** (SW) | `tests/service-worker-listener.test.ts` | Do NOT seed `dc_listener`, dispatch `EXPORT_SESSION`, assert `globalThis.fetch` was NOT called AND `chrome.downloads.download` WAS called with the existing `saveAs: true`. This is the opt-in pin + kill-switch proof. |
| 7 | Integration test: POSTed zip matches a reference download byte-for-byte | **integration** | `tests/cli-listener.test.ts` | Produce zip via `exportSessionStreaming(fakeStore, metadata)`, POST it to a spawned CLI, read file back from `out/`, `Buffer.compare(a, b) === 0`. |
| 8 | Unit tests cover token generation uniqueness, expiry, mismatch rejection | **unit** + **integration** | `tests/cli-listener.test.ts` | Uniqueness: spawn CLI twice, compare tokens ≠. Expiry: kill CLI, POST to a new instance with old token, expect 401 (tokens don't persist across CLI restarts — gives us expiry-by-process-exit for free). Mismatch: covered by DoD #4. |
| 9 | First-run notice + `PRIVACY.md` mention CLI handoff + 127.0.0.1-only | **unit** | `tests/privacy.test.ts` (existing) | Assert new bullet substring + new paragraph substring. |
| 10 | `schema_version` unchanged — verified by test | **unit** | `tests/privacy.test.ts` or dedicated `tests/schema-pin.test.ts` | `import { SCHEMA_VERSION } from agents-doc; expect(SCHEMA_VERSION).toBe("1.2.0")`. One-line pin, catches the constraint violation. |

Summary: **3 new test files, ~420 lines of test code, one existing file touched for copy assertions**. No e2e. No new playwright spec.

## 5. Risks and tradeoffs

### Deliberately NOT tested (speed call)

- **Chrome sidePanel paste-row end-to-end.** I trust a unit test on the click handler + the existing `sidepanel.test.ts` mount fixture. Not spinning up a playwright e2e for this single row — the interaction is "user pastes a string, click calls chrome.storage.local.set", which unit-tests cleanly.
- **Cross-platform listener behaviour.** Brief says macOS-only. Not testing linux/windows, not CI-matrixing. If we need linux later, the test file runs unchanged on a linux runner — but that's a future-us problem.
- **CLI CLI flag ergonomics.** `--port` and `--out` parsed with a hand-rolled 12-line flag parser. No `commander`, no `yargs`. If the UX hurts later, swap in yargs — it's a 30-line refactor.
- **Large-file upload streaming from the SW side.** The existing export path already buffers the full zip as `Uint8Array` and base64-encodes it into a data URL for `chrome.downloads`. POSTing that same `Uint8Array` as a `Blob` body is strictly smaller peak memory than the current path. No new concern.
- **Concurrent uploads.** The CLI accepts one upload at a time in phase 1. If two SWs race, the second request arrives on the listener and is processed sequentially by Node's event loop — fine for a single-user tool. Not stress-tested.
- **Per-session token rotation inside a single CLI run.** Phase 1 uses one token for the CLI lifetime. Brief says "single-use"; I'm interpreting that as "single-use per CLI run" — the token dies when the process exits. If the judge reads "single-use" literally (one successful POST per token), I'll bump the CLI to rotate tokens after each success, which is another 20 lines and one more test. Flagged in §7.
- **POST retry policy.** None. POST fails → fall through to download. No exponential backoff, no queue. Keeps the state machine trivial.

### What I'm trading away vs. quality plan

- **No dedicated CLI module structure.** Single `.mjs` file, inline route handling. Quality plan will likely propose `cli/src/server.ts` + `cli/src/cli.ts` + `cli/src/token.ts` split with TypeScript + tsx runner. For ~120 lines that's overhead.
- **No schema doc update in `docs/ARCHITECTURE.md`.** One-line changelog entry only. A standalone section for the CLI can be written in the same cycle as phase 2 when there's more to document.
- **No graceful rollback via feature flag.** The opt-in design IS the rollback: delete the `dc_listener` storage key, extension behaviour is byte-identical to pre-feature-14. If the CLI ships broken, users simply don't attach and nothing changes. This is worth spelling out to the judge — I'm not ducking the rollback question, I'm answering it with the architecture.

### Residual risks

- **Token paste UX is clunky.** Accepted — phase 2 will auto-populate via Chrome launcher. Phase 1 is a developer-only tool; a one-time paste is fine.
- **Node version drift.** CLI uses only Node 20+ built-ins (`node:http`, `node:fs/promises`, `node:crypto`). `package.json` is bumped with `"engines": {"node": ">=20"}` — single line.

## 6. Effort estimate

| Step | Person-hours |
|------|--------------|
| 1. `listener-config.ts` + test | 0.5 |
| 2. `cli/deskcheck.mjs` + integration tests | 4.0 |
| 3. SW branch + unit tests | 3.0 |
| 4. Sidepanel attach row + unit test | 2.0 |
| 5. Privacy copy update | 0.25 |
| 6. Makefile + package.json bin | 0.25 |
| 7. Manual smoke + self-dogfood | 0.5 |
| Buffer (PR feedback, unexpected tests) | 1.5 |
| **Total** | **12 hours ≈ 1.5 person-days** |

This fits comfortably inside the 2–3 day target the speed focus mandates.

## 7. Open questions for the judge

1. **"Single-use token" literal or per-process?** The brief says "tokens are single-use and expire when the session ends or the CLI process exits." Speed reading: one token per CLI process, expires on exit. Strict reading: token rotates after each successful POST. **Decision requested**: if strict, I add ~20 lines (in-memory token map keyed by session-id, regenerate after 201) and one extra test. The speed plan assumes the looser reading.
2. **On-disk layout: `DIR/<id>.zip` or `DIR/<id>/{session.json, screenshots/, ...}`?** I chose `.zip` for speed. The brief offers both as options but asks each planner to pick. If the judge prefers unzipped, that's an extra ~30 lines in the CLI (use `fflate` or `yauzl` — but `fflate` is already in the repo deps, so no new dependency needed). Still fits the 1.5-day estimate if picked.
3. **Port policy: ephemeral or fixed default?** Ephemeral (`port: 0`, let the OS pick, print in ready-line) is safer against collisions and what I assumed. If the judge wants a fixed default (e.g. `--port 8787`) for easier scripting, trivial change. No test impact either way.
4. **Listener-config storage key vs. session metadata field?** I'm storing `{url, token}` at the SW level under `dc_listener` in `chrome.storage.local`, explicitly NOT adding a field to `SessionMetadata` or `session.json`. This is how I keep `SCHEMA_VERSION` genuinely unchanged. The brief's DoD phrase "session metadata carries a listener URL + token" is ambiguous about whether it means "the in-memory session metadata the SW holds" or "the exported JSON schema". I'm interpreting the former. **Decision requested** if the judge reads it as the latter — but note that interpretation conflicts with the explicit "`schema_version` is unchanged" constraint, so I believe the former is correct.
5. **Node-only CLI vs. Go binary.** I have argued Node hard in §1. If the judge still selects Go, budget doubles (2 → 4 person-days) and we gain a new toolchain. Flagged so the judge can explicitly accept the cost.
6. **Failure behaviour — fall through to download vs. hard-fail?** I chose fall-through-with-warning so the user never loses session data. Alternative is hard-fail so silent download-instead-of-POST doesn't confuse automation. For phase 1 with a hand-pasted config, silent fallback is the safer default. Can tighten in phase 2 when the CLI launches Chrome itself.
