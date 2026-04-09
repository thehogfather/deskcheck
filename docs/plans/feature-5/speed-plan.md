---
agent: speed-planner
generated: 2026-04-07T22:30:00Z
task_id: feature-5
perspective: speed
---

# Speed Plan: Incremental persistence (OPFS)

## Architecture Impact

**Components affected:**
- `src/lib/session-store.ts`: Rewritten internals. `appendEvent`/`getEvents`/`storeScreenshot`/`getScreenshots` keep the same signatures, but now write to / read from OPFS. `chrome.storage.local` keeps only `STORAGE_SESSION` (metadata).
- `src/lib/exporter.ts`: `exportSession` gains a new streaming entry point that consumes OPFS handles instead of in-memory arrays/records. The existing pure `buildSummary`/`getExportFilename` stay untouched.
- `src/lib/session-metrics.ts`: `computeSessionMetrics` signature changes to take raw numbers (eventCount, byte totals) instead of arrays; callers in the service worker compute them from OPFS stat calls.
- `src/background/service-worker.ts`: `EXPORT_SESSION` + `GET_SESSION_METRICS` handlers rewired. `appendEvent`/`storeScreenshot` call sites are unchanged — they still go through `session-store`.
- `src/background/screenshot.ts`: `storeScreenshot` now receives a `Uint8Array` (PNG bytes) instead of a base64 data URL, so `takeScreenshot` decodes the data URL once at capture time. Popup/widget messages that expected a dataUrl in the response keep returning the dataUrl (it's still used live by the popup preview).
- `src/constants.ts`: Drop `STORAGE_EVENTS` / `STORAGE_SCREENSHOTS` (or mark them deprecated for one cycle); add OPFS path constants.

**New patterns or abstractions introduced:**
- A tiny OPFS helper module (`src/lib/opfs-store.ts`) wrapping `navigator.storage.getDirectory()`, append-to-file, read-stream, stat (size), list, and clear. This is the only new abstraction — it's the minimum we need to keep the rest of the code OPFS-agnostic and testable.

**Dependencies added or modified:**
- None. `fflate` already exposes the streaming `Zip` class (lib/index.d.ts line 1249) — we swap from `zipSync` to `new Zip()` + `.add()` + `.end()`.

**Breaking changes to existing interfaces:**
- `exportSession` signature changes (it takes OPFS handles, not arrays). Internal only — no consumers outside the service worker.
- `computeSessionMetrics` signature changes (takes precomputed numbers). Internal only.
- `storeScreenshot(id, dataUrl)` becomes `storeScreenshot(id, pngBytes: Uint8Array)`. Only caller is `takeScreenshot`, which already has the dataUrl and can decode it.
- Export schema (`session.json`) is unchanged — no user-visible breaking changes.

## Approach

Add a thin OPFS helper and reroute `session-store` writes through it, leaving function names and the service-worker call sites untouched. Events become newline-delimited JSON lines appended to `events.ndjson`; screenshots become raw PNG files under `screenshots/<id>.png`. Export uses fflate's streaming `Zip` class: pipe `session.json` (built from buffered metadata + a single pass over `events.ndjson` to compute `buildSummary`), then pipe each screenshot in chunks without ever materialising the full set. Metrics stat OPFS file sizes instead of measuring in-memory strings.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `src/lib/opfs-store.ts` | **New** | ~110 | Sole new abstraction: getDir/append/read/stat/list/clear. Kept tiny. |
| `src/lib/session-store.ts` | Rewrite internals | ~90 (from ~95) | Keep same public signatures; swap `chrome.storage.local` reads/writes for OPFS calls. Drop `STORAGE_EVENTS`/`STORAGE_SCREENSHOTS` usage. |
| `src/lib/exporter.ts` | Modify | ~70 added / ~35 removed | New `exportSession` that takes OPFS handles + metadata; uses `new Zip()` streaming API. `buildSummary`/`getExportFilename` untouched. |
| `src/lib/session-metrics.ts` | Modify | ~15 changed | `computeSessionMetrics(eventCount, screenshotCount, eventsSizeBytes, screenshotsSizeBytes, startTime)`. Formatters stay. |
| `src/background/service-worker.ts` | Modify | ~25 changed | `EXPORT_SESSION` passes OPFS handles to exporter; `GET_SESSION_METRICS` stats files; drop `getEvents()`/`getScreenshots()` full-reads in metrics/export paths. |
| `src/background/screenshot.ts` | Modify | ~10 changed | Decode data URL to `Uint8Array` once, call `storeScreenshot(id, bytes)`. |
| `src/constants.ts` | Modify | ~5 changed | Remove `STORAGE_EVENTS`, `STORAGE_SCREENSHOTS`; add `OPFS_EVENTS_FILE = "events.ndjson"`, `OPFS_SCREENSHOTS_DIR = "screenshots"`. |
| `src/lib/session-metrics.test.ts` | Update | ~20 changed | Adjust `computeSessionMetrics` tests to the new numeric signature; formatters unchanged. |
| `src/lib/exporter.test.ts` | Update | ~40 changed | Build a tiny in-memory fake OPFS for the streaming export path; keep the existing assertions (zip contents, PRIVACY.md, agents.md, session.json schema). |
| `src/lib/session-store.test.ts` | **New** | ~80 | Round-trip events + screenshots through a fake OPFS: append 1000 events, 100 screenshots, read them back, verify ordering + seq numbering + stat sizes. |
| `src/lib/opfs-store.test.ts` | **New** | ~60 | Unit test the tiny wrapper against a fake directory handle. |
| `src/background/screenshot.test.ts` | Update | ~10 added | Add a test that confirms PNG bytes are what `storeScreenshot` sees (dataUrl → Uint8Array decode). |
| `vitest.config.ts` or test setup | Possibly touch | ~5 | Register a global `navigator.storage` fake for tests that don't inject their own. |

**Total files**: 13 (3 new, 10 modified)
**Total estimated lines**: ~540 lines added, ~130 removed (net ~+410)

## Implementation Steps

1. **Write `src/lib/opfs-store.ts`** — exports `getSessionDir()`, `appendLine(name, str)`, `writeFile(name, bytes)`, `readFileStream(name)` (returns a `ReadableStream<Uint8Array>`), `statSize(name)`, `listScreenshots()`, `clearAll()`. Use `FileSystemSyncAccessHandle` for event append (fast, works in worker) and `createWritable()` for screenshots (PNGs are single-shot writes so sync-access is overkill). `readFileStream` uses `file.stream()` from `getFile()`.
2. **Rewrite `src/lib/session-store.ts`** — `createSession` still writes session metadata to `chrome.storage.local`, plus calls `opfs.clearAll()` to wipe any stale OPFS state. `appendEvent` reads the current `seq` from a small in-memory counter (seeded lazily from file line count on first call after service worker wake, then kept in memory), then appends `JSON.stringify(event) + "\n"`. `storeScreenshot(id, bytes)` writes to `screenshots/<id>.png`. `getEvents()` and `getScreenshots()` are removed or kept only for tests (speed: delete them; update callers).
3. **Rewrite `src/lib/exporter.ts` streaming path** — new signature: `exportSession(session, eventsStream, screenshotStreams: AsyncIterable<{name, stream}>): ReadableStream<Uint8Array>`. Two-pass: first pass reads the events file line-by-line to build `SessionSummary` (can't avoid this without schema change); second pass constructs the final `SessionExport` JSON, feeds it to a `ZipPassThrough`, then iterates screenshot streams feeding each chunk into its own `ZipPassThrough`. Return the assembled bytes as a Uint8Array via `Zip.ondata` collection — but *stream* it through, never materialising the full screenshot set.
4. **Update `service-worker.ts` `EXPORT_SESSION` handler** — call new exporter with OPFS streams, pipe the zip stream into a Blob, then `URL.createObjectURL(blob)` for download (avoids the base64 data URL the current code uses — which is itself an OOM risk). Fall back to the existing `zipToBase64` path if `URL.createObjectURL` isn't available (it is in MV3 workers as of Chrome 110+).
5. **Update `GET_SESSION_METRICS`** — stat `events.ndjson` size, sum stat sizes of `screenshots/*`, count lines (maintain a live counter in session-store rather than stat-scanning on every poll). Call `computeSessionMetrics(eventCount, screenshotCount, eventsBytes, screenshotsBytes, startTime)`.
6. **Update `screenshot.ts`** — after `chrome.tabs.captureVisibleTab`, decode the data URL body to `Uint8Array` once, pass to `storeScreenshot(id, bytes)`. Keep returning the dataUrl in the function return for live popup preview (the caller in service-worker.ts passes it back in the `TAKE_SCREENSHOT` response).
7. **Ship test updates** — adapt session-metrics tests (numeric signature), exporter tests (fake OPFS), add session-store + opfs-store tests.
8. **Manual smoke** — load unpacked extension, record a session with 100 screenshots + 1000 events, confirm export works and metrics update live.

## Definition of Done

- [ ] `session-store.appendEvent` writes to OPFS `events.ndjson`; no `chrome.storage.local.set({events: ...})` anywhere in the codebase.
- [ ] `session-store.storeScreenshot` writes a file to OPFS `screenshots/<id>.png`; no base64 strings in `chrome.storage.local`.
- [ ] `exportSession` uses `fflate`'s `Zip` streaming class; the whole session never sits in memory at once (verified by test that exports a session with a 10 MB screenshot and asserts no `zipSync` path is hit).
- [ ] `chrome.storage.local` for an active session contains only `STORAGE_SESSION` and whatever privacy/onboarding keys already exist — `STORAGE_EVENTS` / `STORAGE_SCREENSHOTS` constants are removed.
- [ ] `GET_SESSION_METRICS` returns sizes computed from OPFS `statSize`, not in-memory string length.
- [ ] Exported zip passes all existing `exporter.test.ts` assertions (schema_version, PRIVACY.md, agents.md, `screenshots/ss_1.png`, `buildSummary` counts, `getExportFilename`).
- [ ] `make typecheck` clean, `make test` green, `make build` green.
- [ ] Manual smoke: 1000 events + 100 screenshots recorded and exported in a real Chrome extension load, zip opens with correct contents.

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `appendEvent` writes to OPFS (not `chrome.storage.local`) | Unit | Pure wrapper; assert on fake OPFS calls and verify `chrome.storage.local.set` is not called with the events key. |
| 2 | `storeScreenshot` writes PNG file to OPFS | Unit | Fake OPFS; assert `writeFile("screenshots/ss_1.png", bytes)` was called. |
| 3 | Export streams from OPFS without full-session in memory | Unit | Feed fake OPFS streams, use fflate `Zip` API, unzip result and assert contents. We cannot literally measure memory in vitest; instead assert the exporter signature takes streams and we never call `JSON.parse` on the whole events file into an array. |
| 4 | 100 screenshots + 1000 events work end-to-end | Manual smoke | Service worker memory and real OPFS behaviour can't be validated in jsdom. Document the manual test steps in the PR. |
| 5 | `chrome.storage.local` only holds metadata | Unit | Grep-style test: after `createSession` + `appendEvent` + `storeScreenshot`, `chrome.storage.local.get(null)` returns only the session key. |
| 6 | Session metrics computed from OPFS footprint | Unit | New `computeSessionMetrics(eventCount, screenshotCount, eventsBytes, screenshotsBytes, start)` — pure function, trivial test. Plus one integration-flavoured test that feeds a real fake OPFS through session-store and asserts the metrics match file sizes. |
| 7 | Export schema unchanged | Unit | Existing `exporter.test.ts` assertions on `session.json` schema_version, summary counts, PRIVACY.md, agents.md all remain. |

**Speed planner bias**: Everything at unit level except the 100-screenshots / 1000-events load test, which is a manual smoke. No integration tests, no e2e. The fake OPFS is a ~50-line test helper.

**Determinism rule**: All tests use a deterministic fake OPFS (in-memory Map of files) — no `navigator.storage.getDirectory()` hits in vitest. No LLM calls anywhere in this feature.

## Testing Strategy

- **Unit**:
  - `opfs-store.test.ts`: fake directory handle, assert append/write/read/stat/clear behaviour.
  - `session-store.test.ts`: round-trip 1000 events and 100 screenshots through fake OPFS, verify seq ordering, verify `chrome.storage.local` stays metadata-only, verify metrics byte counts.
  - `exporter.test.ts` (updated): build the zip through the streaming path from a fake OPFS, keep existing assertions on zip contents.
  - `session-metrics.test.ts` (updated): new numeric signature.
  - `screenshot.test.ts`: add a test that passes a data URL through the capture path and asserts the stored bytes decode back to the PNG.
- **Integration**: Skip. The unit tests above compose the full pipeline.
- **E2E**: Skip. This is backend-of-extension plumbing — no user-visible flow changes.

**E2E Test Impact**:
- **Existing e2e tests affected**: None — this repo has no Playwright session-recording tests yet (`make test` is vitest only; the `@playwright/test` devDep exists but there's no suite tied to the record/export flow).
- **New e2e tests needed**: None. Manual smoke covers the load test.
- **Cost note**: N/A.

**Test files to create/modify**:
- New: `src/lib/opfs-store.ts`, `src/lib/opfs-store.test.ts`, `src/lib/session-store.test.ts`, `src/test/fake-opfs.ts` (shared test helper, ~50 lines).
- Modify: `src/lib/exporter.test.ts`, `src/lib/session-metrics.test.ts`, `src/background/screenshot.test.ts`.

## Risk Assessment

**Risk Level**: Medium (single-package rewrite of a core storage path, but with a small blast radius — no other extension surface touches these modules directly).

**Why this is reasonably safe**:
- Export schema is preserved — no user-facing contract change.
- `session-store` public API stays the same shape, so service-worker code changes are mostly at the export/metrics paths.
- OPFS is wiped on `createSession`, so there's no cross-session migration mess.
- fflate's streaming `Zip` class is already in our dependency tree — no new deps.

**Tradeoffs accepted**:
- **No migration for in-flight sessions**: If a user updates mid-session, their existing `chrome.storage.local` events/screenshots are lost. Acceptable because the feature brief says "Cross-session migration of data written under the old storage model" is a non-goal, and sessions are short-lived.
- **Two-pass export for summary**: Computing `buildSummary` requires scanning events once before streaming them into the zip. We accept this because the events file is small text (1000 events ~ a few hundred KB) even for long sessions — screenshots dominate size, and they never go through the summary pass.
- **No OPFS fallback for older Chrome**: Out of scope per brief.
- **No concurrent-write safety**: Service worker is single-threaded, so append ordering is naturally serialised. We don't add locks.
- **`FileSystemSyncAccessHandle` caveat**: It's only available inside workers — OK for the service worker, but the popup (which reads session state for display) must not touch it. Popup only calls `GET_SESSION_METRICS` through the message port, never OPFS directly, so this is fine.
- **Small rewrite of `computeSessionMetrics` signature** may ripple through callers; all of them are in this PR though.

**Speed Warning**: None. This is plumbing, not security/payments/schema. Moderate risk but well-contained.

## Estimated Effort

- Planning: Already done
- Implementation: ~120 minutes (opfs-store + session-store rewrite are the bulk; exporter rewrite is ~30 min; service-worker glue ~15 min)
- Testing: ~60 minutes (fake OPFS helper + test updates + new session-store tests)
- Manual smoke: ~15 minutes
- **Total**: ~195 minutes (~3.25 hours)

## Formal Verification Assessment

- Concurrency concerns: No — MV3 service worker is single-threaded, appends are naturally ordered.
- State machine complexity: No — session has the same start/record/stop/export states as before.
- Conservation laws: Yes, weakly — "every `appendEvent` produces exactly one line in `events.ndjson`" and "every `storeScreenshot` produces exactly one PNG file". These are covered by unit tests; don't need TLA+ for them.
- Authorization model: No — no access control changes.
- Recommendation: **Not needed**. Standard storage refactor; unit tests are sufficient.
- Key invariants (for tests, not formal verification):
  - `events.ndjson` line count equals `seq` of the last appended event.
  - `chrome.storage.local` never gains a `deskcheck_events` or `deskcheck_screenshots` key after this change.
  - Exported zip always contains `session.json` + `PRIVACY.md` + `agents.md`, plus one PNG per stored screenshot.

## What This Plan Does NOT Include

- Does NOT add migration for sessions in-flight when the extension is updated — on upgrade, any old `chrome.storage.local` events/screenshots are ignored. Add a one-time cleanup of legacy keys in `createSession` and move on.
- Does NOT add an OPFS fallback for non-Chrome browsers — extension is Chrome-only.
- Does NOT refactor the `exportSession` summary computation into a separate streaming pass that avoids the two-file-reads pattern. The events file is small; not worth the complexity.
- Does NOT introduce a general-purpose storage abstraction layer — `opfs-store.ts` is a tiny wrapper specific to our needs. If we later need IndexedDB or another backend, we can generalise then.
- Does NOT gate the change behind a feature flag — there is no previous recording format to preserve, and rollback is a `git revert`.
- Does NOT add a "repair" path for partially-written OPFS files after a crashed service worker — if the worker dies mid-session, we let the next `createSession` wipe state. Documenting this as a known limitation in the PR description.
- Does NOT change the popup's live screenshot preview path — `takeScreenshot` still returns the data URL for immediate UI use.
- Does NOT add compression for screenshots — PNGs are already compressed; `ZipPassThrough` skips re-deflating them.
