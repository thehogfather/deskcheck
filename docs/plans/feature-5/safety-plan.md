---
agent: safety-planner
generated: 2026-04-07T22:30:00Z
task_id: feature-5
perspective: safety
---

# Safety Plan: Incremental Persistence (OPFS)

## Executive Summary

This feature replaces the storage substrate that recording depends on. If it
breaks, every recording made on affected installs is lost. That makes this a
**high-stakes change with permanent data-loss risk** — the safety bar must be
higher than any previous feature.

The current `src/lib/session-store.ts` is a read-modify-write ledger against
`chrome.storage.local`: every `appendEvent()` reads the whole events array,
pushes one element, and writes it back. At 1000 events that is ~1000 full
rewrites of a growing buffer, and worse, every screenshot data URL (typically
~100 KB each as base64 PNG) is held in the same serialized object. This plan
trades that model for an append-only OPFS-backed log plus per-file screenshots,
with `chrome.storage.local` retained only as the durable pointer to the live
session.

## Critical Finding: The Brief's Sync-Handle Assumption Is Wrong

> The brief says: "`FileSystemSyncAccessHandle` gives synchronous byte-level
> writes ... Use sync access handles and `flush()` to ensure durability."

**This is not safe to rely on in an MV3 service worker.** Per MDN and the WHATWG
FS spec, `FileSystemSyncAccessHandle` is available **only in Dedicated Web
Workers**, not in Service Workers. Service workers must use the async
`FileSystemFileHandle.createWritable()` → `FileSystemWritableFileStream` API.
Building this feature around sync access handles would either (a) not compile
at runtime, or (b) force us to route every event through an Offscreen Document
that owns a dedicated worker — a large architectural detour that also has to
survive service worker wake/sleep.

**Mitigation**: the plan below uses the **async OPFS write API** in the service
worker directly. Durability is achieved by awaiting `writable.close()` (which
fflushes and commits the atomic replace) at well-defined checkpoints, and by a
small in-memory write queue that serialises appends and never returns to the
caller before the write has been acknowledged.

See "Risk R0" below for the full treatment. This is the single most important
thing for the judge to evaluate — if the reviewer disagrees, the architectural
shape of the feature has to change before implementation starts.

## Architecture Impact

**Components affected:**
- `src/lib/session-store.ts` — complete rewrite. The only module whose public
  API contract must be preserved, because service-worker.ts and screenshot.ts
  both import from it. The signatures of `createSession`, `endSession`,
  `getSession`, `appendEvent`, `getEvents`, `storeScreenshot`, `getScreenshots`,
  and `clearSession` stay identical; the bodies change.
- `src/lib/session-metrics.ts` — `computeSessionMetrics(events, screenshots,
  startTime)` currently assumes in-memory arrays. Needs a thin adapter: either
  (a) an async variant `computeSessionMetricsFromStore()` that reads byte sizes
  directly from OPFS file handles, or (b) keep the pure function and feed it
  precomputed `{eventCount, eventsSizeBytes, screenshotCount,
  screenshotsSizeBytes}` from the store. Option (b) is preferred — it keeps
  `session-metrics.ts` pure and testable.
- `src/lib/exporter.ts` — `exportSession()` currently takes `(session, events,
  screenshots)` as in-memory values and returns `Uint8Array`. Needs a streaming
  variant that takes a source interface and writes into an `fflate.Zip` async
  stream, yielding the final zip bytes. The existing pure `buildSummary()`
  function stays unchanged and is re-used.
- `src/background/service-worker.ts` — every call site of the store is async
  already, so signatures are mostly preserved. Main changes are in
  `EXPORT_SESSION` (streaming) and `GET_SESSION_METRICS` (reads from the new
  store adapter). `restoreState()` needs a wake-up recovery hook.
- `src/background/screenshot.ts` — `takeScreenshot()` currently passes a base64
  data URL to `storeScreenshot`. This becomes "decode once, write bytes to
  OPFS, discard the decoded buffer". The `dataUrl` is still returned to the
  caller because `ADD_ANNOTATION` in service-worker.ts forwards it to the
  annotation screenshot path.

**New patterns or abstractions introduced:**
- **JSONL append log for events**: one JSON object per line, newline-delimited.
  Chosen over a JSON array because (a) append is trivial — just write
  `JSON.stringify(event) + "\n"` at file size; (b) a truncated trailing line
  is recoverable — the reader skips it; (c) streaming read is straightforward.
  A JSON array would require every write to seek back over the trailing `]`,
  write a `,`, write the new element, write `]` — both slower and more fragile.
- **Serialised write queue**: a module-private promise chain inside
  `session-store.ts` so concurrent `appendEvent()` calls (e.g. a CDP network
  error arriving while a click is being recorded) are ordered and each await
  resolves only after its own write has committed. This is what replaces the
  brief's sync-access-handle-based ordering guarantee.
- **Session handle cache**: one `FileSystemDirectoryHandle` per session, kept
  in module-level state. On wake, repopulated from the `STORAGE_SESSION` entry
  in `chrome.storage.local` — OPFS directory names are derived from
  `session.id` so there is no ambiguity about which directory to re-open.
- **Streaming exporter**: `fflate.Zip` (not `zipSync`) — lets us stream one
  file at a time without ever holding the full session in memory.

**Dependencies added or modified:**
- `fflate` already present at ^0.8.2 — it ships both `zipSync` (used today) and
  a streaming `Zip` class. No new dependency required. This is a lucky break
  for the safety case: if fflate's streaming API had a different semver we
  would have needed to upgrade, and any fflate upgrade would touch the export
  path, which is the product's "core contract".

**Breaking changes to existing interfaces:**
- None to the public product contract (session.json schema is unchanged).
- Internal TypeScript type change: `getScreenshots()` currently returns
  `Record<string, string>` (id → data URL). This signature is awkward once
  screenshots are files on disk — loading them all back into memory defeats
  the point. Rather than silently change the shape, I propose keeping a
  back-compat `getScreenshots(): Promise<Record<string, string>>` for the
  transition (reads each file, base64-encodes) but marking it deprecated in
  favour of a new `listScreenshots(): Promise<string[]>` and
  `readScreenshotBytes(id): Promise<Uint8Array>`. The exporter and metrics are
  migrated to the new API in this same PR; the old one stays for one release
  as a safety net, then is removed.
- **Migration from old sessions**: per the task's non-goals section,
  cross-session migration is not in scope. But we still need to handle the
  case gracefully: on first run after the update, `chrome.storage.local` may
  still contain `STORAGE_EVENTS` and `STORAGE_SCREENSHOTS` from a session
  started under the old code. The plan **must not silently lose** that data.
  `restoreState()` detects legacy-shaped storage, logs a warning to the
  service worker console, and either (a) best-effort migrates it into an OPFS
  directory then clears the legacy keys, or (b) leaves it alone and exposes a
  one-shot "export legacy session" code path. Option (a) is safer — it avoids
  a permanent bimodal state machine — but we must test it.

**Risk points in architecture this task touches:**
- The storage layer underpins every recording. A regression is permanent data
  loss for the user.
- The export layer is the "core contract" per CLAUDE.md. Any schema drift
  corrupts every downstream AI consumer.
- The service worker wake/sleep cycle already has a subtle state machine
  (`restoreState()` in service-worker.ts lines 26–38). We are adding new
  non-storage-backed state (the OPFS directory handle) that must be
  re-acquired on wake.

## Risk Assessment

### Risk Register

| ID | Risk | Severity | Likelihood | Impact | Mitigation |
|----|------|----------|------------|--------|------------|
| R0 | `FileSystemSyncAccessHandle` unusable in MV3 SW — brief's approach won't work | Critical | Certain | Whole feature mis-shaped | Use async `FileSystemWritableFileStream` + serialised write queue. Document this deviation in the implementation README section and in `docs/ARCHITECTURE.md`. |
| R1 | Data loss mid-session when SW dies with unwritten event in memory | High | Medium | Lost user events (partial session on export) | Write queue awaits each write before resolving `appendEvent()`. Caller never sees a resolved promise until the write is committed. No in-memory buffering of unwritten events ever. |
| R2 | Partial write corrupts JSONL file (process killed mid-line) | High | Medium | Reader gets parse error on the last line | Reader tolerates and skips a trailing partial line (no newline terminator ⇒ ignore). Writer always calls `close()` on the writable, which triggers the atomic replace in OPFS — partial content never becomes the committed file state. |
| R3 | Orphaned OPFS state on SW wake with no handle in memory | High | High (happens every SW sleep) | Next append writes to a different file or throws | `restoreState()` re-derives the OPFS directory from `session.id` stored in `chrome.storage.local`, re-opens the events file and the screenshots sub-directory, and re-populates the module-level handle cache before any append can be processed. Every public store function awaits an `ensureReady()` promise. |
| R4 | Export corruption — streaming zip fails mid-write | High | Low | Broken zip downloaded, source session already cleared from storage | **Clear session only AFTER download completes**, not after `zipSync`/streaming produces bytes. Detect streaming errors explicitly and surface via the popup/widget with a "retry export" affordance. Never clear OPFS state on an incomplete export. |
| R5 | Schema drift — JSONL → session.json reassembly differs from old format | High | Medium | Breaks every downstream AI consumer (the "core contract") | Golden-file regression test: fixture input events (covering every discriminated-union variant) plus the resulting `session.json` are committed to the repo; test fails on any byte-level diff. Build summary via the same pure `buildSummary()` used today. |
| R6 | Feature-1 metrics regression — stale, wrong, or zero sizes | Medium | Medium | User loses trust in "is my recording growing?" feedback | `GET_SESSION_METRICS` reads byte counts from file handle sizes (not by slurping the file), and calls `flush`/`close` on pending writes before reporting. Dedicated vitest that computes metrics after a sequence of appends and asserts the reported size matches the on-disk size within 1 byte. |
| R7 | Stale OPFS files from a previous session leak into the next session | Medium | High | Export includes events/screenshots from the wrong session | Explicit `deleteSession(sessionId)` that removes the entire `sessions/{id}/` directory. Called by `clearSession()` at the end of `EXPORT_SESSION`, by `STOP_SESSION` when the user discards, and by a startup sweep that removes any `sessions/*` directory whose id does not match the current `STORAGE_SESSION`. The sweep is the last-resort cleanup for crash-during-export scenarios. |
| R8 | OPFS unavailable or quota exceeded | Medium | Low | Session cannot start, or dies mid-recording | `createSession()` does a smoke-test write of a 1-byte probe file before returning the session. On quota-exceeded mid-session, surface a clear error to the widget via the metrics channel ("Storage full — stop and export now") rather than silently dropping events. |
| R9 | Concurrent appends race on the same file handle | Medium | Low (single worker) | Interleaved bytes — JSONL becomes garbage | Module-level `writeChain` promise chain: `writeChain = writeChain.then(() => doWrite(bytes))`. Every caller awaits the chain. In MV3 there is only ever one SW instance, so this is sufficient. |
| R10 | Legacy session in `chrome.storage.local` from pre-update install | Medium | Certain on first run | Old unexported session becomes inaccessible | `restoreState()` detects legacy `STORAGE_EVENTS`/`STORAGE_SCREENSHOTS` and either migrates to OPFS or surfaces a one-shot "export legacy session" option in the popup. Tested against a fixture that simulates the pre-update shape. |
| R11 | Silent schema drift in the legacy migration path | Medium | Low | Migrated sessions export with different shape | Run the same golden-file test through the migration path: fixture of old-shaped storage → migrate → export → assert identical to the native-OPFS golden. |
| R12 | Streaming export uses more memory than it saves (back-pressure absent) | Medium | Medium | 1000-event OOM test fails even though the *design* is streaming | Use `fflate.Zip` incremental API with an explicit back-pressure loop: push one file, wait for it to drain, push the next. Memory test asserts peak heap below a threshold (e.g. 20 MB for 100 × 100 KB screenshots = 10 MB content). |
| R13 | `clearSession()` partial failure leaves half the state | Medium | Low | Next `START_SESSION` inherits stale OPFS files | `clearSession()` deletes OPFS first, then `chrome.storage.local`. If OPFS fails, the storage key is left pointing at a known-but-corrupt directory so the next `restoreState()` can sweep it. Never leave `chrome.storage.local` cleared while OPFS has orphaned bytes. |
| R14 | `navigator.storage.getDirectory()` returns a handle but the returned Promise is never settled (long-running SW wake) | Low | Low | `appendEvent()` hangs indefinitely | `ensureReady()` has a 5-second timeout; on timeout, set an error flag, drop new events into an in-memory ring buffer (bounded), and surface a widget warning. On recovery, flush the ring buffer. |
| R15 | Service worker is terminated between the JSON serialise and the write | Low | Medium | Event lost | Unavoidable for the in-flight event. Mitigated by: (a) serialise inside the writeChain promise, so the event is "in flight" for the shortest possible window; (b) log the in-flight event to `console.debug` so a power user running with DevTools open can recover it. Document the residual risk. |
| R16 | JSONL reader chokes on embedded newlines in string fields | Low | Medium | Reader splits one event into two | JSON.stringify of any TimelineEvent produces `\n`-escaped newlines inside strings, so the on-disk bytes never contain a raw newline inside a record. Verified by a property test: `JSON.stringify({x: "a\nb\nc"})` contains zero `0x0A` bytes. Asserted on every event type. |
| R17 | OPFS directory quota grows unbounded if user repeatedly force-quits mid-session | Low | Medium | "Where did my disk go?" support issue | Startup sweep removes any `sessions/*` directory whose id does not equal the current active session id. Only the active session and at most one in-progress export can exist simultaneously. |
| R18 | Popup's `hasExportableSession` check misses OPFS-only state | Low | Low | User can't find their session in the UI | `hasExportableSession` = "`STORAGE_SESSION` exists AND has `end_time` set". OPFS is a side effect; the canonical signal stays in storage.local. No change needed if `endSession()` continues to write `end_time` to storage.local. |

### Failure Modes Analysis (top 6, expanded)

1. **Service worker dies mid-append**
   - Cause: MV3 sleep timeout, OOM, or forced reload.
   - Detection: On the next wake, `restoreState()` reads the events file and
     sees `n` committed records. The caller of `appendEvent()` that was in
     flight at termination never received a resolved promise, so the content
     script's message is in a pending state and is retried by
     `chrome.runtime.sendMessage`'s natural failure propagation (the script
     sees an error and either retries or drops). There is no specific
     "was this event committed?" check — by design, we do not attempt partial
     replay.
   - Recovery: Accept that the in-flight event is lost. Guarantee that *no
     partial byte* from that event is on disk (because `createWritable()` only
     becomes visible after `close()` succeeds, the OPFS file is either at its
     previous committed state or at a clean post-write state).

2. **Partial JSONL line on next read**
   - Cause: Writer implementation bug — for example, writing bytes without a
     trailing newline. Should not happen with `createWritable()` because a
     failed `close()` rolls the file back, but we treat it as defence in depth.
   - Detection: The reader splits on `\n` and attempts to `JSON.parse()` each
     line. A line that fails to parse is logged and skipped; the seq field of
     the next line is preserved.
   - Recovery: Log a warning with the byte offset and the first 200 chars of
     the bad line. Include in the export's `session.json.summary` a
     `partial_records_skipped: n` count — purely additive, no schema break.

3. **Export streaming abort**
   - Cause: Disk full, `fflate.Zip` internal error, user closes the browser
     mid-download.
   - Detection: The streaming pipeline surfaces an error event; we capture it
     and reject the `EXPORT_SESSION` promise with a structured `{error}`.
   - Recovery: **Do not clear the session**. The user retries by pressing
     download again. If the underlying cause is disk full, the retry also
     fails, but the recording is preserved and can be exported elsewhere.

4. **Orphaned directory after crash-during-export**
   - Cause: Service worker dies after zipSync begins but before
     `clearSession()` runs.
   - Detection: On next wake, `restoreState()` reads `STORAGE_SESSION`, sees
     it has `end_time` set (export was possible), and exposes the session as
     "exportable" in the popup. The user re-downloads.
   - Recovery: `clearSession()` remains the only gate that deletes OPFS files.
     Export flow is "export, await download, clear". If the SW dies before
     clear, next wake re-exposes the session. Safer to leak one directory
     than to lose one session.

5. **Migration of legacy storage.local session**
   - Cause: User updates the extension mid-session. Old `STORAGE_EVENTS` array
     and `STORAGE_SCREENSHOTS` dict still exist.
   - Detection: `restoreState()` checks for `STORAGE_EVENTS` presence as a
     signal. If present, run one-shot migration.
   - Recovery: Read old events array, write to OPFS JSONL, read old screenshots
     dict, decode and write each PNG to OPFS, then delete the old storage keys.
     Migration is idempotent (no-op if `STORAGE_EVENTS` not present).

6. **Chrome / OPFS version bug**
   - Cause: A Chrome update changes OPFS semantics (unlikely but not
     impossible; OPFS has shipped but still evolves).
   - Detection: Hard to detect pre-merge. Mitigation is runtime.
   - Recovery: Rollback flag (see Rollback section) flips to legacy
     storage.local path.

### Blast Radius
- **Affected users**: 100% of DeskCheck users on the next release. Every
  recording made on an affected build uses the new storage path.
- **Affected systems**: Recording (DOM events, CDP events, screenshots),
  export (session.json, PNGs, zip), metrics widget (feature-1), service
  worker state restore, popup download flow.
- **Data at risk**: Live sessions (those being recorded while the update
  rolls out) and in-progress sessions with `end_time` set but not yet
  exported.

## Recovery Protocol (Service Worker Wake Mid-Session)

This is the single highest-risk flow. Sequence of operations on wake:

1. SW wakes, module-level state is reset (`recording = false`, `activeSessionId
   = null`, `sessionDirHandle = null`).
2. `restoreState()` runs at module init, awaited via a top-level promise.
3. Reads `STORAGE_SESSION` from `chrome.storage.local`.
4. If no session or session has `end_time`: nothing to recover; may still
   offer "export previous session" via the popup.
5. If active session (`end_time` is null):
   a. Call `openSessionDirectory(session.id)` which does
      `navigator.storage.getDirectory()` → `getDirectoryHandle("sessions",
      {create: true})` → `getDirectoryHandle(session.id, {create: false})`.
   b. If the directory does not exist (OPFS was wiped, e.g. user cleared
      site data), treat this as a catastrophic recovery failure: mark the
      session as ended with a `recovery_failure: true` flag in storage, stop
      badge, notify content script. Do NOT attempt to continue recording into
      a fresh directory with a stale session.id — that would produce two
      mismatched records.
   c. Otherwise, open `events.jsonl` with `getFileHandle("events.jsonl",
      {create: false})` and validate by reading its size.
   d. Initialise the write queue at `writeChain = Promise.resolve()`.
   e. Set `sessionDirHandle`, `eventsFileHandle`, `recording = true`,
      `activeSessionId = session.id`, `setBadge(true)`.
   f. Until step (e) completes, every call to `appendEvent()` etc. must
      `await restoreState`. Implemented by having every public store function
      start with `await ensureReady()`.
6. Legacy sweep: if `STORAGE_EVENTS` or `STORAGE_SCREENSHOTS` keys exist,
   run the one-shot migration (see R10) before returning from `restoreState`.
7. Stale directory sweep: list `sessions/*`, delete any whose id does not
   equal the active session id (if any).

Invariants enforced:
- No append proceeds until `ensureReady()` resolves.
- If `ensureReady()` rejects, `recording` is set to false and the widget is
  notified — we fail loudly, not silently.

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 0 | Add compile-time constant `USE_OPFS_STORAGE = true` in `src/constants.ts`; `session-store.ts` branches on it | Existing tests still pass with flag off | Flip constant to false |
| 1 | Implement new OPFS-backed store as `src/lib/session-store-opfs.ts`; keep old store as `session-store-legacy.ts`; `session-store.ts` is a thin re-export | Both stores pass identical contract tests | Remove opfs import |
| 2 | Write golden-file test `src/lib/exporter.golden.test.ts` that pins current `session.json` output against a fixture | Test passes against OLD store (captures the "before" state) | N/A — test only |
| 3 | Implement OPFS store: createSession + appendEvent + ensureReady + writeChain | Contract tests from phase 1 pass | Flip flag |
| 4 | Implement screenshots (write as raw PNG files, not base64) | Screenshot tests pass | Flip flag |
| 5 | Implement `getEvents()` streaming reader with partial-line skip | Reader skips the last-line-no-newline fixture | Flip flag |
| 6 | Implement `clearSession()` + startup sweep + migration from legacy | Migration test passes; idempotency test passes | Flip flag |
| 7 | Update `session-metrics` integration — size computed from file handle sizes | Metrics regression test passes (feature-1) | N/A — metrics read-only |
| 8 | Implement streaming exporter using `fflate.Zip` | Golden-file test from phase 2 STILL passes (now reading from OPFS) | Flip flag — old exporter still present |
| 9 | Wire up service worker: `restoreState` recovery path | Recovery test (simulated wake mid-session) passes | Flip flag |
| 10 | Large-session memory test: 100 screenshots × 100 KB + 1000 events | Peak heap below threshold | N/A — measurement only |
| 11 | Manual smoke test in `dist/` Chrome load-unpacked | Pre-merge checklist below | Ship with flag off, hotfix flip |
| 12 | Flip `USE_OPFS_STORAGE = true` (already true in phase 0, but this is the "remove the legacy branch" step) | All tests green; manual smoke green | Separate PR to restore legacy code if needed |

## Files to Create/Modify

| File | Purpose | Risk Notes |
|------|---------|------------|
| `src/lib/session-store.ts` | Thin facade re-exporting the active store | Keep identical public API |
| `src/lib/session-store-opfs.ts` | **NEW** — the OPFS-backed implementation | The core of this feature; most of the risk lives here |
| `src/lib/session-store-legacy.ts` | **NEW** — extracted from current `session-store.ts` | Kept one release as rollback; delete in next PR |
| `src/lib/session-store-contract.test.ts` | **NEW** — shared test suite both stores must pass | Identical-behaviour harness is our primary regression guard |
| `src/lib/opfs-writer.ts` | **NEW** — low-level write queue wrapper around `FileSystemWritableFileStream` | Isolated so it can be unit-tested without the rest of the session store |
| `src/lib/opfs-writer.test.ts` | **NEW** — unit tests for serialisation and error handling | Tests crash-mid-write via aborted writable |
| `src/lib/jsonl.ts` | **NEW** — encode/decode helpers with partial-line tolerance | Pure — unit-testable with no Chrome/OPFS mocks |
| `src/lib/jsonl.test.ts` | **NEW** — unit tests | Include "last line missing newline" fixture |
| `src/lib/exporter.ts` | Add streaming variant; keep old `exportSession` as `exportSessionSync` for rollback | Golden-file test pins the output |
| `src/lib/exporter.golden.test.ts` | **NEW** — regression guard against schema drift | **Critical** — this is the product contract test |
| `src/lib/exporter.streaming.test.ts` | **NEW** — streaming export memory + error tests | Assert `exportSession` can stream |
| `src/lib/session-metrics.ts` | Unchanged — stays pure | N/A |
| `src/lib/session-metrics-integration.test.ts` | **NEW** — end-to-end metrics test against OPFS store | Feature-1 regression guard |
| `src/background/service-worker.ts` | `restoreState()` recovery path; `EXPORT_SESSION` streaming; legacy-storage sweep | Integration point — many touchpoints |
| `src/background/screenshot.ts` | Write raw PNG bytes instead of data URL; `ADD_ANNOTATION` path also updated | Content-script-originated `elementScreenshotData` is base64 data URL — decode at the boundary |
| `src/constants.ts` | Add `USE_OPFS_STORAGE`, `OPFS_SESSIONS_DIR = "sessions"`, `OPFS_EVENTS_FILE = "events.jsonl"`, `OPFS_SCREENSHOTS_DIR = "screenshots"` | Centralise paths so tests can mock |
| `docs/ARCHITECTURE.md` | Document the OPFS shape, the async-API deviation from the brief, the recovery protocol | Must be updated in the same PR |
| `docs/roadmap.md` | Check the Feature #5 boxes | Last commit only |

## Definition of Done
- [ ] All risks R0–R18 have named mitigations verified by tests
- [ ] Contract test suite passes against both legacy and OPFS stores
- [ ] Golden-file test pins `session.json` byte-for-byte (per event type)
- [ ] Partial-line skip test passes
- [ ] Recovery test (simulated SW wake mid-session) passes
- [ ] Legacy-storage migration test passes
- [ ] Large-session memory test: 100 screenshots × ~100 KB + 1000 events, peak heap under 30 MB
- [ ] Feature-1 metrics regression test passes
- [ ] Manual smoke test against loaded `dist/` passes (see pre-merge checklist)
- [ ] `make typecheck` and `make test` both green
- [ ] `docs/ARCHITECTURE.md` updated
- [ ] `USE_OPFS_STORAGE` flag is present and tested in both states
- [ ] No new dependencies added
- [ ] Existing export schema byte-identical to pre-PR for identical input events

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Golden-file test pins `session.json` byte-for-byte | Unit | Pure function over a fixed fixture; byte-diff is deterministic |
| 2 | Contract test suite (legacy + OPFS) | Unit | Pure I/O boundaries with mocked OPFS (via a fake in-memory implementation); both stores use the same harness |
| 3 | Partial-line JSONL skip | Unit | Pure parser over a fixed byte string |
| 4 | Recovery from simulated SW wake | Integration | Touches the storage boundary (chrome.storage.local) AND the OPFS boundary — must exercise both |
| 5 | Legacy-storage migration | Integration | Reads legacy `chrome.storage.local` shape, writes OPFS, verifies round-trip |
| 6 | Large-session memory test | Integration | Needs a fake OPFS that reports sizes and a heap measurement — browser-like, not pure |
| 7 | Feature-1 metrics regression | Integration | End-to-end from the store to the widget's display format |
| 8 | Streaming export memory test | Integration | Measures peak heap during the zip pipeline |
| 9 | Concurrent-append race | Unit | Write queue ordering is isolated in `opfs-writer.ts` |
| 10 | OPFS quota exceeded | Integration | Requires a fake OPFS that throws `QuotaExceededError` |
| 11 | Schema version still `1.1.0` | Unit | Assertion on `SCHEMA_VERSION` constant |
| 12 | Manual smoke test (pre-merge checklist) | E2E (manual) | Final confidence gate for something this risky |

**Safety planner bias**: I'm placing more tests at the integration level than
is typical because the value of this feature is specifically that data survives
adversarial conditions — SW wake, process death, quota limits. Unit tests over
a pure fake can't prove that. The golden-file test is the exception: it must
be a unit test so it runs fast and fails loud.

**Determinism rule**: All tests are deterministic. There are no LLM calls in
this feature. The OPFS fake uses fixed byte-array backing so read-back is
byte-identical. The memory measurement uses a synthetic marker approach (count
bytes held in closed-over references, not `process.memoryUsage()`) so it runs
identically on every machine.

## Testing Strategy (Comprehensive)

### Unit Tests

**`src/lib/jsonl.test.ts`**
- Encode: `encodeRecord({a:1})` returns `{"a":1}\n` as UTF-8 bytes.
- Encode: no embedded raw newlines for strings containing `\n`.
- Encode: every discriminated union variant of `TimelineEvent` round-trips.
- Decode: `decodeAll("a\nb\nc\n")` returns `["a","b","c"]`.
- Decode: `decodeAll("a\nb\nc")` returns `["a","b"]` and reports 1 partial.
- Decode: `decodeAll("")` returns `[]`.
- Decode: `decodeAll("bad{json}\n")` skips the bad line and reports 1 error.
- Decode: interleaved valid and invalid lines — valid ones preserved in order.

**`src/lib/opfs-writer.test.ts`** (with an in-memory OPFS fake)
- `append()` resolves only after `close()` on the writable.
- Two concurrent `append()` calls result in ordered bytes on disk.
- `append()` propagates errors from the writable.
- `append()` never returns a resolved promise while the writable is still
  open.
- Write queue survives a rejection — subsequent appends still work.

**`src/lib/session-store-contract.test.ts`** (shared between legacy + OPFS)
- `createSession()` → `getSession()` round-trip.
- `appendEvent()` × N → `getEvents()` returns all N with monotonic `seq`.
- `storeScreenshot()` → can be read back.
- `clearSession()` removes session, events, screenshots.
- `endSession()` sets `end_time` and `duration_ms`.
- Every event type can be appended (discriminated union coverage).
- **Edge case**: `appendEvent()` with a value containing `"\n"` and `"\""`.
- **Edge case**: `storeScreenshot()` with empty data URL returns gracefully.
- **Edge case**: `getEvents()` on a freshly-created-but-never-appended session.
- **Edge case**: `clearSession()` called twice is idempotent.

**`src/lib/session-metrics.test.ts`** (existing tests remain green)
- No changes to the pure function signatures.

**`src/lib/exporter.golden.test.ts`** (**NEW — the contract test**)
- Fixture: A `SessionMetadata` + array of events covering every event type.
- Assertion: the generated `session.json` string is byte-identical to a
  committed fixture file at `src/lib/__fixtures__/golden-session.json`.
- Rationale: this catches any accidental field reorder, whitespace change, or
  added property introduced by the streaming reassembly.
- **How to update**: documented in a comment at the top of the test.
  Updating requires explicit review — this is the product contract guard.

### Integration Tests

**`src/lib/session-store-opfs.integration.test.ts`** (uses the OPFS fake)
- Full session lifecycle: create → append × 1000 → end → export.
- `restoreState()` simulation: create a session, wipe in-memory state,
  re-initialise the store, verify further appends extend the same file.
- Partial-write recovery: inject a failing `close()` on one write, verify
  the file is at its pre-write state on the next read.
- Legacy-storage migration: pre-populate the `chrome.storage.local` fake with
  old-shape data, run `restoreState()`, verify OPFS now has the data and the
  storage keys are cleared.
- Stale-directory sweep: pre-populate OPFS with `sessions/old-id/...`, create
  a new session with `new-id`, verify `sessions/old-id/` is removed on init.
- Quota exceeded: inject `QuotaExceededError` on the 500th append, verify the
  error propagates to the caller and `recording` is set to false.

**`src/background/service-worker.integration.test.ts`**
- `EXPORT_SESSION` failure path: streaming error → `clearSession` NOT called
  → session still exportable on retry.
- `STOP_SESSION` → `EXPORT_SESSION` → `clearSession` happy path.
- `START_SESSION` after a failed export leaves no stale data.

**`src/lib/session-metrics-integration.test.ts`** (feature-1 regression guard)
- Create session, append events, compute metrics; assert
  `eventsSizeBytes == sum(byteLength(JSON.stringify(ev)+"\n"))`.
- Create session, add 3 screenshots of known byte size, assert
  `screenshotsSizeBytes == sum(byteLength(each png))`.
- Metrics remain stable under concurrent appends (call
  `GET_SESSION_METRICS` and `appendEvent` interleaved, assert no NaN/undef).
- Metrics update monotonically (each poll shows >= previous values while
  recording).

### E2E Tests

**Existing e2e tests affected**: Check `e2e/` folder for any Playwright
tests touching recording/export. If the feature has a browser-launched e2e
harness, add **one** flow only: start → record 10 events + 2 screenshots →
stop → export → open zip → verify `session.json` parses and contains the 10
events plus 2 screenshot files. Cost-conscious — one flow, grouped assertions.

**New e2e tests needed**:
- **`recording-and-export-opfs.e2e.ts`** (if e2e harness exists): start
  session on a test page, perform a few clicks, stop, download, extract the
  zip, assert schema.

**E2E Test Impact**:
- Existing e2e tests affected: unknown — must grep `e2e/` before merging.
  Each test that exercises recording will indirectly test OPFS because the
  store substrate is global.
- New e2e tests needed: 1.
- Cost note: grouped into a single flow.

### Regression Tests
- **Every existing exporter.test.ts test** must still pass. These are the
  baseline for "did we break the export?".
- **Every existing session-metrics.test.ts test** must still pass.
- **Every existing screenshot.test.ts test** must still pass.

### Load / Stress Tests (required for this feature)
- **Large-session memory test** (`src/lib/session-store-opfs.memory.test.ts`):
  append 1000 synthetic events + 100 screenshots of 100 KB each. Peak
  retained bytes in the OPFS fake's backing map + the store's in-memory
  state combined must not exceed 2× the content size (i.e. no full-session
  buffering). Measured by wrapping the fake's `put` calls in a counter, not
  by real heap measurement.
- **Streaming export memory test**: same fixture, run the streaming export,
  assert that at no point does the exporter hold a buffer larger than 1
  screenshot's worth of bytes (~100 KB) plus the session.json text (~1 MB
  for 1000 events). The test asserts a high-water-mark captured by the
  exporter's output consumer.

**Test files to create/modify**:
- `src/lib/jsonl.ts` + `.test.ts` — NEW
- `src/lib/opfs-writer.ts` + `.test.ts` — NEW
- `src/lib/session-store-opfs.ts` + `.integration.test.ts` + `.memory.test.ts` — NEW
- `src/lib/session-store-contract.test.ts` — NEW, shared
- `src/lib/exporter.golden.test.ts` — NEW
- `src/lib/exporter.streaming.test.ts` — NEW
- `src/lib/session-metrics-integration.test.ts` — NEW
- `src/lib/__fixtures__/golden-session.json` — NEW committed fixture
- `src/lib/__fixtures__/opfs-fake.ts` — NEW test helper
- `src/background/service-worker.integration.test.ts` — NEW
- `src/lib/exporter.test.ts` — UPDATE to include streaming variant
- `src/background/screenshot.test.ts` — UPDATE for raw PNG path

## Rollback Strategy

### Trigger Conditions
Rollback is triggered if any of these are reported post-release:
- Recordings silently lose events (user reports count mismatch).
- Export produces a zip that fails to open or lacks `session.json`.
- Session metrics stop updating.
- Service worker crashes on wake from sleep.
- Any OPFS-related error appears in `chrome://extensions` > "Errors".

### Rollback Mechanism
A compile-time constant `USE_OPFS_STORAGE` in `src/constants.ts`. Default is
`true`. Hotfix process:

1. Flip `USE_OPFS_STORAGE = false`.
2. `make build`.
3. Bump patch version (`make bump-patch`).
4. Tag, publish to Chrome Web Store.
5. Users auto-update; next recording uses the legacy store.

Because the legacy store code is retained as `session-store-legacy.ts` for
one release, the rollback is a 1-line change + a build, not a code rewrite.

### Rollback Steps (Detailed)
1. `git revert` is NOT the rollback — the feature lives behind a flag.
2. Edit `src/constants.ts`: `export const USE_OPFS_STORAGE = false;`.
3. `make test` — verify legacy store tests still pass (they should; they
   never changed).
4. `make build`.
5. Load `dist/` into `chrome://extensions` → verify session start/stop/
   export works on the legacy path.
6. `make bump-patch`, tag, publish.
7. Communicate to users via release notes: "reverts to pre-0.x.x storage
   model; recordings already made under OPFS remain exportable via a
   one-shot 'export previous session' button — see issue #NNN."
8. **Post-rollback cleanup**: Users who recorded under OPFS still have data
   in OPFS. The legacy store should include an "export legacy OPFS session"
   code path that reads OPFS and produces the same zip. This is a small
   piece of belt-and-braces code that ships in the legacy variant.

### Verification After Rollback
- [ ] Session start/stop works
- [ ] Export produces a valid zip
- [ ] Session metrics widget updates
- [ ] Service worker restarts do not lose state
- [ ] Old OPFS-recorded sessions can still be exported via the escape hatch
- [ ] No console errors during a 5-minute recording

### Rollback Tested?
- [ ] **Yes** — the contract test suite runs against both stores in CI, so
  the rollback path is continuously verified.
- [ ] Manual rollback drill executed once before merging: flip flag, run
  `make test && make build`, load extension, record, export, verify.

## Monitoring & Alerting

The extension has no telemetry (`docs/ARCHITECTURE.md`: "No external network
requests; all data stays local"), so monitoring is local-first:

### Metrics to Watch (Local, Dev-facing)
| Metric | Normal Range | Alert Threshold |
|--------|--------------|-----------------|
| Service worker console errors (`chrome://extensions`) | 0 | Any |
| Storage.local quota used | < 1 KB (metadata only) | > 10 KB (indicates events leaking back into storage.local) |
| OPFS directory size after `clearSession()` | 0 bytes | > 0 bytes (cleanup bug) |
| Widget metrics "events size" | Monotonic increase during recording | NaN, 0 after first event, or decrease |
| Time from `appendEvent()` call to promise resolve | < 10 ms | > 100 ms sustained |

### Alerts to Configure
Extensions have no alerting infrastructure; instead:
- **Dev-time**: add a `console.warn` in `session-store-opfs.ts` whenever
  `appendEvent()` takes >100 ms, so a developer running with devtools open
  sees the signal.
- **User-facing**: widget shows a "Storage slow — consider stopping and
  exporting" warning if the metrics poll returns the same size twice in a
  row while `recording === true` (suggests writes are hanging).
- **Release**: post-release, ask beta users to leave Chrome devtools open on
  the service worker for the first 24h and report any red errors.

## Deployment Recommendations

- [x] **Feature flag**: Required. `USE_OPFS_STORAGE` compile-time constant.
  Rationale: storage layer changes carry permanent data loss risk; a flag is
  the difference between a 5-minute hotfix and a 2-hour emergency revert.
- [x] **Gradual rollout**: Chrome Web Store supports percentage rollouts.
  Recommend 10% → 50% → 100% over 1 week. Rationale: new storage code has
  possible timing- or Chrome-version-specific bugs that only show up under
  load.
- [x] **Staging verification**: Required. Manual smoke test below must pass
  in a clean Chrome profile before publishing.
- [ ] **Off-hours deployment**: Not applicable (users install on their own
  schedule, not on a server deploy window).

## Estimated Effort
- Planning: Already done (this document + judge review)
- Implementation: ~240 minutes
  - OPFS writer + jsonl helpers: 45 min
  - Session store rewrite: 60 min
  - Streaming exporter: 60 min
  - Service worker integration + recovery: 30 min
  - Legacy migration: 30 min
  - Screenshot path update: 15 min
- Safety verification: ~60 minutes
  - Manual recovery drill: 15 min
  - Rollback drill (flip flag, rebuild): 10 min
  - Chrome load-unpacked smoke test: 20 min
  - Chrome DevTools OPFS inspection (`chrome://inspect/#service-workers`,
    then Application → Storage): 15 min
- Testing: ~150 minutes
  - Contract test suite: 30 min
  - Golden-file test + fixtures: 20 min
  - Integration tests: 45 min
  - Memory/streaming tests: 30 min
  - Metrics regression test: 15 min
  - Test debugging + coverage review: 10 min
- **Total**: ~450 minutes (7.5 hours)

This is significantly more than a speed plan would estimate — the overhead is
dominated by (a) the contract test suite that runs against both stores, (b)
the golden-file fixture, and (c) the recovery/legacy-migration tests. I am
being honest about this: safety costs time.

## Formal Verification Assessment

- **Concurrency concerns**: Yes — the write queue serialises concurrent
  `appendEvent()` calls from multiple sources (content script DOM events,
  CDP network errors, CDP console errors) all hitting the same file handle.
  The ordering invariant ("seq is monotonic") must hold even under
  interleaving.
- **State machine complexity**: Yes — the store has at least 5 states:
  { no session, session created but no events, session recording, session
  ended but not exported, session exported }. Transitions involve both
  `chrome.storage.local` and OPFS, and wake-from-sleep can occur in any
  state. That is combinatorially non-trivial.
- **Conservation laws**: Yes — every `appendEvent()` must produce exactly
  one record in `events.jsonl` (not zero, not two). Every `storeScreenshot`
  must produce exactly one PNG file. These are conservation invariants.
- **Authorization model**: No — no access control in scope.
- **Recommendation**: **Formal verification (TLA+/TLC) not strictly
  required, but a lightweight model check of the wake/sleep state machine
  would be high-value if time permits.** The concurrency is bounded
  (single-writer via the write queue) and the state machine is small enough
  that a thorough integration test suite with adversarial timing injection
  is probably sufficient. But I would not complain if the judge escalated
  this: the cost of a missed race condition in storage is permanent data
  loss, and users cannot recover.
- **Key invariants (in business language)**:
  1. Every event the content script sends and that the service worker
     acknowledges must appear in the exported zip.
  2. `seq` is strictly monotonic within a session.
  3. If `end_time` is set in `chrome.storage.local`, the OPFS files for
     that session are either intact (export possible) or cleared (export
     not possible and UI reflects that) — never half.
  4. No two sessions can share an OPFS directory.
  5. `clearSession()` is idempotent.
  6. Recovery on wake never merges data from two different sessions.

## Security Considerations
- [x] No secrets in code
- [x] Input validation complete — the store is a byte sink, not a trust
  boundary; validation stays in `recorder.ts` and `pii-modes.ts`
- [x] Output encoding — JSON.stringify for events, raw bytes for PNGs
- [x] Authentication / authorization — N/A (local extension)
- [x] OWASP top 10 considered:
  - **A01 Broken Access Control**: OPFS is origin-scoped; only this
    extension origin can read its own directory. No change from today.
  - **A02 Cryptographic Failures**: no crypto in this feature.
  - **A03 Injection**: JSONL writes use `JSON.stringify`, so no injection
    risk (escaped `\n` inside strings cannot break records).
  - **A04 Insecure Design**: the legacy `session-store.ts` was vulnerable
    to OOM; this feature fixes that. Net improvement.
  - **A05 Security Misconfiguration**: the feature flag is compile-time,
    not runtime — cannot be tampered with at the Chrome storage layer.
  - **A08 Software and Data Integrity**: the golden-file test is the
    integrity guard for the exported product contract.
  - **A09 Logging**: service worker `console.warn` is appropriate for
    this feature. No external log shipping.
- [x] **Privacy**: OPFS content lives in `~/Library/Application
  Support/Google/Chrome/Default/File System` on macOS. On extension
  uninstall, Chrome wipes this. On "Clear browsing data" with "Site
  settings" selected, Chrome wipes this. This is documented in
  `PRIVACY.md` — update required to mention OPFS as a local storage
  location alongside `chrome.storage.local`.

## Pre-Merge Checklist (Manual Smoke Tests)

These MUST all pass before the PR merges. I'm writing them as executable
steps so the implementer can copy-paste into a checklist.

### Environment Setup
- [ ] `make clean && make build` produces a `dist/` with no warnings
- [ ] Load `dist/` via `chrome://extensions` → "Load unpacked" in a **clean
      Chrome profile** (critical — avoids legacy-storage artifacts)
- [ ] Verify `chrome://extensions` shows no errors

### Happy Path
- [ ] Navigate to `https://example.com`, click the extension icon, select
      "Start session", mode = Full
- [ ] Click 5 things on the page → widget shows ~5 events
- [ ] Take 2 screenshots via the widget
- [ ] Open `chrome://inspect/#service-workers`, inspect the service worker,
      Application tab → Storage → File System → verify `sessions/<id>/
      events.jsonl` exists and contains 5+ lines, and `sessions/<id>/
      screenshots/` contains 2 PNG files
- [ ] Stop and download → zip opens, `session.json` parses, has 5+ events,
      `screenshots/` has 2 PNGs, file bytes match what you'd expect
- [ ] After download, re-inspect OPFS → `sessions/<id>/` is gone

### Recovery Path (SW wake mid-session)
- [ ] Start a session, record 10 events, DO NOT stop
- [ ] Open `chrome://serviceworker-internals` → find DeskCheck worker → Stop
- [ ] Wait 5 seconds, then interact with the page again
- [ ] The worker wakes, continues recording (badge still says REC), next
      event's `seq` is 11 (not 1)
- [ ] Stop and download → zip contains events 1–11 in order

### Crash-Mid-Write (approximation)
- [ ] Start a session, record 5 events
- [ ] From the service worker console, run `await
      navigator.storage.getDirectory().then(d => d.getDirectoryHandle(
      'sessions', {create:false}).then(s => s.removeEntry('<id>',
      {recursive:true})))`
- [ ] Next `appendEvent()` should fail loudly — widget should show a
      warning, NOT silently swallow the event

### Export Failure Recovery
- [ ] Fill up disk to ~0 bytes free (or use a throttled profile) — if too
      awkward, simulate by manually throwing in the streaming exporter
- [ ] Stop and download → download fails with clear error
- [ ] Session is still listed as "exportable" in the popup
- [ ] Retry the download once disk space recovered → succeeds

### Legacy Migration
- [ ] Before building the new version: install the current (old) extension,
      start a session, record 3 events, take 1 screenshot, DO NOT stop
- [ ] Build the new version, reload the extension (forces update; does not
      clear storage)
- [ ] Service worker console should log a migration message
- [ ] Verify OPFS now contains `sessions/<id>/events.jsonl` with 3 lines
      and `sessions/<id>/screenshots/` with 1 PNG
- [ ] `chrome.storage.local` no longer contains `deskcheck_events` or
      `deskcheck_screenshots` keys (verify via DevTools)
- [ ] Stop and download → zip contains all 3 events + 1 screenshot

### Feature-1 Metrics Regression
- [ ] Start a session, record 50 events + 5 screenshots
- [ ] Widget metrics line shows: events count 50, screenshots count 5,
      events size non-zero, screenshots size non-zero
- [ ] All four values update within 2s of each new event/screenshot

### Large Session
- [ ] Start a session, use a script in the page console to generate 1000
      synthetic clicks: `for (let i=0; i<1000; i++) document.body.click()`
- [ ] Record 100 screenshots (spam the keyboard shortcut)
- [ ] Service worker does NOT crash (check `chrome://extensions` errors)
- [ ] Stop and download → zip is produced and opens; memory during
      download is visually reasonable (watch `chrome://memory-internals`)

### Rollback Drill
- [ ] Edit `src/constants.ts`: `USE_OPFS_STORAGE = false`
- [ ] `make build`, reload extension
- [ ] Start and record a session — verify it works via the legacy store
- [ ] Reset: `USE_OPFS_STORAGE = true`, `make build`, reload

### Final
- [ ] `make typecheck` passes
- [ ] `make test` passes (all old + all new)
- [ ] `docs/ARCHITECTURE.md` mentions OPFS, the recovery protocol, and the
      async-API deviation from the original brief
- [ ] `docs/roadmap.md` feature #5 DOD boxes checked
- [ ] `PRIVACY.md` updated to mention OPFS as a local storage location
- [ ] Branch is rebased cleanly on main, commits are logically grouped

## Notes for the Judge

- The **single largest deviation from the brief** is rejecting
  `FileSystemSyncAccessHandle`. If the judge disagrees with this call, the
  implementation shape changes significantly (Offscreen Document + Dedicated
  Worker). I believe the async API is correct, but the judge should
  explicitly validate this before implementation starts.
- The contract test suite that runs against both legacy and OPFS stores is
  the load-bearing regression guard. Without it, the rollback flag is
  theatre.
- I am intentionally keeping the legacy store code in the same PR (not as a
  follow-up) because shipping a rollback flag without the rollback
  destination existing is worse than not shipping a flag at all.
- The golden-file test must be committed with a deliberate human-reviewed
  fixture. A machine-generated fixture defeats the purpose.
- I have **not** planned for cross-session migration (user on Chrome N
  wants a session recorded on Chrome N−5) — per the task's non-goals, this
  is out of scope. But I've planned for the single-update migration (the
  user who updates mid-session).
- The large-session memory test uses a synthetic marker approach (count
  bytes in closures) rather than `process.memoryUsage()` because Vitest's
  Node heap is not a faithful model of Chrome's service worker heap. The
  manual smoke test above is where real memory behaviour gets verified.
