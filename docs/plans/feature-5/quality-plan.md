---
agent: quality-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-5
perspective: quality
---

# Quality Plan: Incremental persistence (OPFS)

## Architecture Impact

**Components affected:**
- `src/lib/session-store.ts` — completely rewritten from a free-function module talking to `chrome.storage.local` into a typed `SessionStore` interface plus an `OpfsSessionStore` implementation. Lightweight session metadata still lives in `chrome.storage.local` (single key), events move to OPFS as JSONL, screenshots move to OPFS as individual PNGs.
- `src/lib/exporter.ts` — signature changes from `exportSession(session, events, screenshots)` returning a `Uint8Array` to a streaming variant that takes a `SessionStore` (or a narrow read-side projection) and yields a `Uint8Array` without materialising the full events array or the full screenshot set in one object.
- `src/lib/session-metrics.ts` — `computeSessionMetrics` stays a pure function on its current inputs, but a new adapter `readSessionMetrics(store)` is added for callers that have a `SessionStore`. Size is computed from OPFS file sizes (via `getFile().size`) plus the metadata JSON size rather than `JSON.stringify(events).length` + base64 lengths.
- `src/background/service-worker.ts` — constructs a single `SessionStore` instance at startup and threads it through every handler. No more direct `chrome.storage.local.get/set` for events or screenshots. The zip-to-base64 download path becomes a Blob URL created via `URL.createObjectURL` so we do not hold a megabyte-scale base64 string in memory.
- `src/background/screenshot.ts` — `storeScreenshot(id, dataUrl)` is replaced with `store.appendScreenshot(id, bytes)`. The base64 decode of the captured data URL happens once here, at the producer, and the raw PNG bytes are written directly. No base64 lives in storage.
- `src/content/widget.ts` — unchanged. It calls `GET_SESSION_METRICS` over the message bus and the shape of `SessionMetrics` is preserved.
- `src/constants.ts` — `STORAGE_EVENTS` and `STORAGE_SCREENSHOTS` keys are removed. `STORAGE_SESSION` stays. A new `OPFS_SESSIONS_ROOT = "sessions"` constant is added.

**New patterns or abstractions introduced:**
- `SessionStore` interface — a narrow, backend-agnostic port over the session's persistent state. This is the only new abstraction; everything else is a concrete implementation of it or a caller of it. Justified because (a) the project's own design principle is "abstract vendor choices behind interfaces", (b) it is the only way to test the exporter and the service worker deterministically without spinning up OPFS, and (c) it is the only way to keep the door open to IndexedDB fallback later without another rewrite.
- JSONL (newline-delimited JSON) event log format — each append is one line: `JSON.stringify(event) + "\n"`. Standard, boring, streamable. No framing length prefixes, no binary container — debuggability wins over cleverness here.
- `FileSystemSyncAccessHandle`-based append path inside a background worker — the sync access handle API serialises writes naturally, so we do not need our own mutex around `appendEvent`. The single instance of the store held by the service worker also serialises at the JS level.

**Dependencies added or modified:**
- None. `fflate` already supports streaming zip construction via its `Zip` class with `ZipPassThrough` members — we were just not using it. The OPFS APIs are built into the worker runtime.

**Breaking changes to existing interfaces:**
- `session-store.ts` module: all of `createSession`, `endSession`, `getSession`, `appendEvent`, `getEvents`, `storeScreenshot`, `getScreenshots`, `clearSession` are replaced by methods on a `SessionStore` instance. Internal callers (service worker, screenshot) are updated in the same PR. No public/exported API outside `src/` is affected.
- `exporter.exportSession` signature changes from `(session, events, screenshots) => Uint8Array` to `async (store, session) => Uint8Array`. The exported zip contents (`session.json`, `agents.md`, `PRIVACY.md`, `screenshots/*.png`) and the `SessionExport` schema are unchanged. Export tests are rewritten to use an in-memory fake store.
- Storage keys `deskcheck_events` and `deskcheck_screenshots` disappear from `chrome.storage.local`. The new code does not read them at all. See migration story — no live sessions exist under the old format yet, so we do not need a reader.

## Architectural Approach

Introduce a single `SessionStore` port that owns all persistent session state. The service worker, exporter, and screenshot module depend on the port, not on `chrome.storage.local` or OPFS directly. The OPFS implementation (`OpfsSessionStore`) is the only module that touches `navigator.storage.getDirectory()` and sync access handles; everything else is backend-agnostic. Events stream to a single JSONL file per session, screenshots stream to individual PNGs under a per-session directory, and session metadata stays in `chrome.storage.local` as a single small JSON object so the service worker can restore state on wake without touching OPFS. This mirrors the project's existing "pure function plus thin adapter" split and leaves room to swap OPFS for IndexedDB (or Cache API, or anything else) behind the same interface without rewriting the exporter or the service worker.

## Files to Create/Modify

| File | Purpose | Quality Considerations |
|------|---------|----------------------|
| `src/lib/session-store.ts` (rewrite) | Define the `SessionStore` interface and export a factory for the OPFS impl | Narrow interface (< 10 methods). No leaky OPFS types in the public surface — return `Uint8Array`, `AsyncIterable<TimelineEvent>`, `number`, not `FileSystemFileHandle`. |
| `src/lib/opfs-session-store.ts` (new) | `OpfsSessionStore` — the only module that imports OPFS APIs | Single-responsibility. Pure encode/decode helpers split out so they can be unit-tested without OPFS. Every method is idempotent or documented otherwise. |
| `src/lib/fake-session-store.ts` (new) | In-memory `FakeSessionStore` for tests and for a local dev fallback if OPFS is unavailable | Implements the same interface. Tracks peak simultaneous in-memory byte footprint for the large-session test. No Chrome APIs. |
| `src/lib/session-store-metadata.ts` (new, small) | Pure helpers: read/write `SessionMetadata` from/to `chrome.storage.local` under a single key, plus `pii_mode` back-fill | Isolates the one remaining `chrome.storage.local` touch-point. Easy to test with the existing chrome-mock pattern. |
| `src/lib/jsonl.ts` (new, small) | Pure encode/decode for JSONL: `encodeLine(event)`, `decodeLines(chunk, leftover)` streaming parser | Pure functions, no I/O. Handles the "last chunk had a half-line" case explicitly. Property-tested against round-trips. |
| `src/lib/exporter.ts` (rewrite) | Accept a `SessionStore`, stream events and screenshots through `fflate`'s `Zip` class | Keeps `buildSummary` pure and folds summary aggregation into a single streaming pass over events so we do not read the events file twice. |
| `src/lib/session-metrics.ts` (minor edit) | Add `readSessionMetrics(store, startTime)` adapter that calls `store.computeSize()`. `computeSessionMetrics` stays pure for the unit tests. | Backward-compatible addition — old pure function stays, new adapter is a one-liner. |
| `src/background/service-worker.ts` (edit) | Construct one `SessionStore` at module init, thread it through every handler. Replace `zipToBase64` + `data:` URL download with `URL.createObjectURL(new Blob([...]))` | Remove dead helpers (`zipToBase64`). Export flow becomes `await exportSession(store, session)` then blob URL download then `store.deleteSession(id)`. |
| `src/background/screenshot.ts` (edit) | Decode the captured data URL to bytes once, call `store.appendScreenshot(id, bytes)` | Single encode/decode boundary at the producer. Add a pure `dataUrlToPngBytes()` helper so it can be unit-tested without Chrome. |
| `src/constants.ts` (edit) | Remove `STORAGE_EVENTS`, `STORAGE_SCREENSHOTS`. Add `OPFS_SESSIONS_ROOT`. Keep `STORAGE_SESSION`. | Dead-code removal keeps the module honest. |
| `src/lib/session-store.test.ts` (new) | Contract tests that any `SessionStore` impl must pass. Runs against `FakeSessionStore` and, where jsdom permits, against a mocked OPFS. | One test suite, two implementations — proves the fake and the real impl behave identically on the contract. |
| `src/lib/opfs-session-store.test.ts` (new) | OPFS-specific edge cases: path layout, sync access handle close-on-error, read stream chunk boundaries | Mocks `navigator.storage.getDirectory()` with a jsdom-compatible fake. Focus is on the encode/decode glue, not re-testing the contract. |
| `src/lib/jsonl.test.ts` (new) | Unit tests for the JSONL parser: empty, one-line, multi-line, partial trailing line, UTF-8 boundaries | Pure function, fully deterministic. Small and fast. |
| `src/lib/exporter.test.ts` (rewrite) | Use `FakeSessionStore` populated with test fixtures. Assertions on zip contents stay the same. | Tests stop caring about the in-memory shape of events/screenshots and now care about the streaming contract. |
| `src/lib/session-store-metadata.test.ts` (new) | Round-trip metadata through a chrome.storage.local mock, including pii_mode back-fill | Mirrors current `session-store.ts` test coverage for the metadata half. |
| `src/lib/session-metrics.test.ts` (edit) | Add one test that verifies `readSessionMetrics` reads size from `store.computeSize()` and passes through counts | Minimal addition — the pure function tests stay untouched. |
| `src/background/screenshot.test.ts` (edit) | Add a unit test for the new `dataUrlToPngBytes()` helper | Pure function, no Chrome mocks needed. |
| `docs/ARCHITECTURE.md` (edit) | Update the "Shared Libraries" section to describe `SessionStore`, OPFS layout, and the metadata-only use of `chrome.storage.local`. Add a changelog row. | Docs drift is a real bug — fix it in the same PR. |
| `docs/roadmap.md` (edit) | Tick the DoD boxes for feature #5 when the work lands | Part of the project's convention. |

**Total files**: 18 (9 new, 9 edited)

## Implementation Steps

1. **Define the interface first** (`src/lib/session-store.ts`). No implementation, just the shape. This unblocks parallel work on tests, fakes, and the exporter rewrite. Quality rationale: typed contracts reviewed and agreed before any implementation prevents "the OPFS impl leaked a FileSystemFileHandle into my public API" late-stage rework.

2. **Build the fake** (`src/lib/fake-session-store.ts`) against the interface. Quality rationale: the fake is the executable spec for the interface. If the fake is awkward to write, the interface is wrong and we fix it now rather than after OPFS exists.

3. **Write the contract test suite** (`src/lib/session-store.test.ts`) against the fake. Red/green against the fake proves the contract is coherent. Quality rationale: tests before the hard-to-debug implementation. Every behaviour the OPFS impl must satisfy is pinned here.

4. **Extract pure JSONL helpers** (`src/lib/jsonl.ts`) and their tests. Quality rationale: streaming parsers are where OPFS-backed code usually breaks (partial chunks, UTF-8 splits). Isolating the pure logic means we can exhaustively test it without any storage layer.

5. **Implement `OpfsSessionStore`** against the interface. Run the same contract test suite against it (where jsdom's OPFS mock allows). Quality rationale: reusing the suite proves behavioural equivalence between fake and real.

6. **Implement `SessionStoreMetadata`** helpers and tests. Quality rationale: the one remaining `chrome.storage.local` touch-point deserves its own module boundary so migration later is cheap.

7. **Rewrite `exporter.ts`** to take a `SessionStore` and stream via `fflate`'s `Zip` class. Fold summary aggregation into the single streaming pass over events (`buildSummary` stays pure and can be called on an array if needed, but the exporter uses a streaming accumulator). Update `exporter.test.ts` to use the fake. Quality rationale: one read pass over events is both faster and simpler to reason about than two.

8. **Update `screenshot.ts`** to decode the captured data URL once (via a new pure `dataUrlToPngBytes` helper) and call `store.appendScreenshot(id, bytes)`. Quality rationale: the base64-to-bytes boundary should live at the producer, not at the exporter, so no code path ever stores base64.

9. **Update `service-worker.ts`** to construct one store, thread it through, and swap the download path to `URL.createObjectURL(new Blob([zipBytes]))`. Delete `zipToBase64`. Quality rationale: `data:` URLs for the zip are themselves a scaling cliff at ~100MB because they force a base64 copy; the blob URL path is O(1) memory on top of what `fflate` already uses.

10. **Update `session-metrics.ts`** with a `readSessionMetrics(store, startTime)` adapter and keep the pure `computeSessionMetrics` for existing tests. Update the service worker's `GET_SESSION_METRICS` handler to call the adapter. Quality rationale: backward-compatible evolution — existing tests for the pure function stay untouched, new code uses the new adapter.

11. **Large-session integration test** with `FakeSessionStore` configured to track peak in-memory byte count: append 1000 events and 100 fake PNGs (each ~2 MB), then run `exportSession`, assert the peak never exceeded a threshold (e.g., 10 MB). Quality rationale: this is the headline DoD criterion; we need an automated test for it, not just a manual load test.

12. **Update `ARCHITECTURE.md` and `roadmap.md`**. Quality rationale: docs-drift catches itself when docs updates are part of the same commit.

13. **Manual verification** on a loaded extension: record 100 screenshots + 1000 events, confirm metrics update, confirm export downloads, confirm OPFS is cleaned up after export. Quality rationale: OPFS behaviour inside an actual MV3 service worker is the one thing the test suite cannot prove.

## Definition of Done

- [ ] `SessionStore` interface defined and documented with JSDoc on every method
- [ ] `OpfsSessionStore` passes the full contract test suite
- [ ] `FakeSessionStore` passes the full contract test suite (proves the spec is consistent)
- [ ] Events are appended as JSONL to OPFS at `/sessions/{id}/events.jsonl`
- [ ] Screenshots are written as individual PNGs at `/sessions/{id}/screenshots/{id}.png`
- [ ] `chrome.storage.local` contains only `deskcheck_session` (metadata); `deskcheck_events` and `deskcheck_screenshots` keys are gone from the codebase
- [ ] `exportSession` streams events and screenshots without materialising either whole; proven by the large-session test
- [ ] The 1000-events / 100-screenshots large-session test passes with tracked peak memory below the threshold
- [ ] `computeSize()` returns the sum of the events file size and all screenshot file sizes, and `GET_SESSION_METRICS` surfaces the same number to the widget
- [ ] Existing widget metrics display (duration, event count, screenshot count, size) works unchanged — `widget.ts` not modified
- [ ] Export zip schema (`session.json`, `agents.md`, `PRIVACY.md`, `screenshots/*.png`) is unchanged — the existing exporter tests (updated to use the fake) still pass
- [ ] Download path uses `URL.createObjectURL` on a Blob, not a base64 `data:` URL
- [ ] `ARCHITECTURE.md` updated with the new storage layer description and a changelog row
- [ ] `make typecheck` passes with zero errors
- [ ] `make test` passes with zero failures
- [ ] No linting warnings
- [ ] No `any` types in the new modules
- [ ] Code coverage for new modules is > 80% (contract suite + pure helper tests should reach this easily)
- [ ] Manual smoke test recorded in PR description: 100 screenshots + 1000 events + export without OOM

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `SessionStore` interface documented | Unit | Type-level check plus contract-suite compilation is sufficient |
| 2 | `OpfsSessionStore` passes contract suite | Unit (with OPFS mocked) | OPFS is mockable in jsdom; we do not need a real browser for the contract |
| 3 | `FakeSessionStore` passes contract suite | Unit | Pure in-memory, no external dependencies |
| 4 | Events are JSONL at the right path | Unit | Assertion on OpfsSessionStore's file-path choices; pure structural test |
| 5 | Screenshots are individual PNGs at the right path | Unit | Same — structural test against the mocked OPFS |
| 6 | `chrome.storage.local` contains only metadata | Unit | Grep-style test that no new code touches the removed keys, plus a runtime assertion in `session-store-metadata.test.ts` |
| 7 | `exportSession` streams without materialising | Integration | Test the exporter with the fake store end-to-end against a zip reader; proves the streaming contract, not just method calls |
| 8 | Large-session test (1000 events / 100 screenshots) passes | Integration | Uses the fake store with peak-memory tracking to assert the streaming contract at scale |
| 9 | `computeSize` matches on-disk footprint | Unit | Pure assertion against a fake store that reports known byte counts |
| 10 | Widget metrics display unchanged | Unit | Shape-only test against the `SessionMetrics` type; widget tests already cover the rendering path |
| 11 | Export zip schema unchanged | Unit | Existing `exporter.test.ts` assertions — tests already cover the zip contents, only the input changes |
| 12 | Download uses Blob URL not data URL | Unit | Assertion against a mocked `URL.createObjectURL` in the service worker message handler test |
| 13 | `make typecheck` passes | Unit | `tsc --noEmit` in CI |
| 14 | `make test` passes | Unit | `vitest run` in CI |
| 15 | No `any` in new modules | Unit | `tsc --noEmit` with `--strict` + an ESLint rule if present; otherwise a grep test |
| 16 | Coverage > 80% for new modules | Unit | `vitest --coverage` gate |
| 17 | Manual smoke test of 100/1000 in a loaded extension | Manual | MV3 service worker memory behaviour cannot be reproduced in jsdom; requires Chrome. Documented in PR description. |

**Quality planner bias**: most criteria map to unit or integration tests backed by the `FakeSessionStore`. Exactly one criterion is manual (the in-Chrome smoke test), because MV3 service worker memory pressure does not reproduce in jsdom. No e2e tests are proposed — the feature has no new user-visible UI.

**Determinism rule**: no LLM calls, no network, no flakiness. The large-session test uses a fake store that deterministically reports byte counts.

## Testing Strategy

- **Unit**:
  - `SessionStore` contract tests (one suite, runs against Fake and OPFS mock): createSession → appendEvent → readEventsStream round-trip; appendScreenshot → readScreenshot round-trip; computeSize sums events + screenshots; deleteSession removes everything; updateMetadata is idempotent; concurrent appendEvent calls serialise correctly
  - JSONL helpers: empty input, single line, multi-line, partial trailing line, UTF-8 split across chunk boundary
  - `dataUrlToPngBytes`: valid data URL, missing comma, non-base64 body, empty payload
  - Session metadata helpers: write → read round-trip, pii_mode back-fill for legacy sessions, clear metadata
  - Exporter with fake store: produces session.json with expected events, produces screenshots/*.png, includes agents.md and PRIVACY.md, strips tab_id, round-trips pii_mode (existing assertions kept verbatim)
  - `readSessionMetrics` adapter: sums `store.computeSize()` with counts
  - Blob URL download path in service worker handler (mocked `URL.createObjectURL`)

- **Integration** (still Vitest, no browser):
  - Large session: fake store with peak-memory tracking, 1000 events + 100 x 2MB fake PNGs, call `exportSession`, assert peak in-memory bytes held simultaneously is below 10 MB and the resulting zip round-trips correctly through `unzipSync`
  - Service worker `START_SESSION` → `RECORD_EVENT` x N → `TAKE_SCREENSHOT` → `EXPORT_SESSION` → `clearSession` happy path, with the fake store and mocked Chrome APIs

- **Manual (recorded in PR description)**:
  - Load the extension, start a session, record 1000+ events and 100+ screenshots in a real Chrome, export, confirm download and zip integrity, confirm OPFS is empty after export (via DevTools → Application → Storage)
  - Sanity check that the size indicator in the widget updates and matches the exported zip size within ~5%

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: None — the project has no Playwright e2e suite wired into `make test` today (Playwright is a devDep but no e2e suite is present for the session flow)
- **New e2e tests needed**: None. The feature has no user-visible UI change; the contract is "existing flows work with a new backend". The manual smoke test covers the cross-stack verification.
- **Cost note**: N/A — no new e2e tests.

**Test files to create/modify**:
- Create: `src/lib/session-store.test.ts`, `src/lib/opfs-session-store.test.ts`, `src/lib/jsonl.test.ts`, `src/lib/session-store-metadata.test.ts`, `src/lib/large-session.test.ts` (integration)
- Modify: `src/lib/exporter.test.ts`, `src/lib/session-metrics.test.ts`, `src/background/screenshot.test.ts`

**Coverage target**: > 80% for all new modules (`session-store.ts`, `opfs-session-store.ts`, `fake-session-store.ts`, `jsonl.ts`, `session-store-metadata.ts`). The pure helpers should hit 100%.

## Code Quality Checklist

- [ ] Follows SOLID principles: the `SessionStore` interface is the explicit port (Dependency Inversion), `OpfsSessionStore` has a single reason to change (Single Responsibility), callers depend on the interface not the impl
- [ ] No code duplication: summary aggregation happens once in the streaming pass over events; base64 decode happens once at the screenshot producer
- [ ] Clear naming: `appendEvent`, `appendScreenshot`, `readEventsStream`, `readScreenshot`, `computeSize`, `deleteSession`, `updateMetadata` — every method name reads like a sentence
- [ ] Appropriate abstraction level: one interface, two implementations (OPFS and Fake). No provider registry, no runtime strategy selection — just plain constructor injection
- [ ] Error handling: every OPFS call wrapped in try/finally that closes the sync access handle; failed screenshot decode logs and skips (preserves existing behaviour); failed append surfaces as an error to the caller rather than silently dropping
- [ ] Types properly defined: interface return types are `Promise<Uint8Array>`, `AsyncIterable<TimelineEvent>`, `number`, `void` — no `any`, no `FileSystemFileHandle` leaking out
- [ ] Edge cases handled: empty session export, partial JSONL line at end of file, screenshot id collisions, OPFS quota exhaustion, session deletion while a read stream is in flight
- [ ] Logging: same `[DeskCheck]` prefix convention as the rest of the codebase

## Patterns to Apply

| Pattern | Where | Why |
|---------|-------|-----|
| Ports and Adapters (hexagonal) | `SessionStore` interface + `OpfsSessionStore`/`FakeSessionStore` impls | Isolates the vendor choice so callers never import OPFS APIs; matches the user's stated "design for change" principle |
| Streaming pipeline | Exporter reads events as `AsyncIterable<TimelineEvent>` and screenshots one-at-a-time via `readScreenshot(id)` | Hard cap on peak memory regardless of session size |
| Pure core, imperative shell | `jsonl.ts`, `dataUrlToPngBytes`, `computeSessionMetrics`, `buildSummary` are pure; `OpfsSessionStore` is the thin imperative shell | Matches the existing codebase idiom (see `privacy.ts`, `pii-modes.ts`, `dom-utils.ts`) |
| Contract test suite | One Vitest describe block run against multiple implementations | Proves fake and real behave identically on the interface, catches drift before it reaches production |
| Constructor injection | Service worker instantiates `OpfsSessionStore` once and passes it down | Tests substitute `FakeSessionStore` without a DI framework |

## Impact Assessment

**Positive Impacts**:
- Eliminates the OOM ceiling for long sessions — the headline DoD goal
- Opens the door to swapping storage backends (IndexedDB, Cache API) without rewriting the exporter or the service worker
- Makes the exporter testable without a full in-memory session fixture — tests just feed events through the fake store
- Forces the exporter to stream, which also improves export speed for large sessions
- Removes the `zipToBase64` helper (hand-rolled, error-prone) and replaces it with a standard Blob URL path

**Neutral** (what stays the same):
- `session.json` schema, `agents.md`, `PRIVACY.md` content, and the zip layout
- `SessionMetrics` shape and the `GET_SESSION_METRICS` message contract
- Widget, content script, popup, debugger client, PII handling, privacy notice
- Semver version of the export schema (`1.1.0` — this is a backend change, not a schema change)

**Risks**:
- *OPFS API availability in the MV3 service worker*. Mitigation: feature-detect at startup (`navigator.storage?.getDirectory`), log clearly on failure, fall back to the in-memory `FakeSessionStore` for the duration of the session so the extension still functions even if OPFS is unavailable (rare in Chrome, but possible in incognito or enterprise policy configurations).
- *Sync access handle exceptions corrupting the events file*. Mitigation: every sync access handle is held inside a try/finally that calls `close()` even on throw; tests cover the throw-then-close case with the mocked OPFS.
- *Cleanup after export*. Mitigation: `deleteSession(id)` is called as the last step of the export handler inside a try/finally around the download call; a missed cleanup leaves orphan data in OPFS, which is recoverable on next session start (a `listSessions()` sweep can be added if this becomes a real problem, but is out of scope for MVP).
- *The `Blob` constructor copies its input*. Mitigation: the zip bytes are already the irreducible output size of the session; the Blob copy is one-time at export and dwarfed by the size we just avoided copying twice. Acceptable tradeoff.
- *Large-session test might be slow*. Mitigation: use small fake PNGs (128 bytes of `Uint8Array`) and configure the peak-memory threshold in proportion; the test asserts streaming behaviour, not physical memory pressure.

## Estimated Effort

- Planning: Already done
- Implementation: 180 minutes (interface + fake + OPFS impl + exporter rewrite + service worker edits + screenshot edits + metrics adapter + constants cleanup)
- Testing: 150 minutes (contract suite, JSONL tests, OPFS mock tests, exporter test rewrite, large-session integration test, metadata helper tests, dataUrlToPngBytes tests)
- Docs: 30 minutes (ARCHITECTURE.md + roadmap.md)
- Review prep: 30 minutes (self-review, PR description with manual smoke test results)
- Manual verification in Chrome: 30 minutes
- **Total**: ~420 minutes (7 hours)

> ⚠️ **Quality Investment**: This is ~2.5x the "minimal viable" approach that would replace `chrome.storage.local` calls with direct OPFS calls in place. Worth it because (a) the user's stated design principle explicitly asks for vendor abstraction, (b) the exporter is impossible to test deterministically without an in-memory fake, and (c) storage backend swaps have happened before in this codebase (see the privacy-store split) and will happen again. The interface is the thing that makes future changes cheap.

## Technical Debt Addressed

- Removes the hand-rolled `zipToBase64` chunked base64 encoder — one less O(n) memory hazard
- Removes the read-modify-write `appendEvent` pattern that is quadratic in session length
- Removes the `chrome.storage.local`-per-event write amplification
- Introduces the missing seam that feature #10 (session discard) will need: `store.deleteSession(id)` is already the contract
- Makes the exporter deterministic under test without fabricating an entire in-memory session fixture

Debt **not** taken on:
- No OPFS cleanup sweep for orphaned sessions (explicitly out of scope; `deleteSession` at end of export is sufficient for the single-session-at-a-time model)
- No IndexedDB fallback implementation (the interface supports it, but we do not write a second backend today)
- No session resume across service worker death (existing `restoreState` behaviour is preserved — the in-progress events file is appended to, not rewritten)

## Formal Verification Assessment

- Concurrency concerns: **Mild**. The service worker is single-threaded JS, but CDP events and message-handler events interleave. The OPFS sync access handle serialises writes naturally, and we hold exactly one store instance. No shared mutable state outside the store.
- State machine complexity: **Low**. Session lifecycle is `idle → recording → exported → idle`, unchanged by this feature.
- Conservation laws: **One**. Event count and screenshot count observed during recording must equal event count and screenshot count in the exported zip. This is asserted by the existing exporter tests and reinforced by the large-session integration test.
- Authorization model: **Unchanged**. The tab-scoped capture gate (`canCaptureRecordedTab`) is not touched.
- Recommendation: **Formal verification not needed**. The feature is a backend swap behind a narrow interface; contract tests cover the invariants that matter (append then read returns what was appended; delete is total; size equals sum of parts).
- If we did want invariants in plain language: "every appended event is observable via readEventsStream until deleteSession", "computeSize equals the sum of the events file and all screenshots", "deleteSession leaves no observable state".

## Migration Story

**No existing users are on this code path yet.** The feature brief and `.orchestrator/current-task.md` explicitly note that cross-session migration from the old model is a non-goal. Feature #5 is on the roadmap as "Next"; the OPFS branch has not shipped. Any in-progress session in `chrome.storage.local` on a developer's machine at the moment of the upgrade is throwaway debug data.

Concretely:
- On first run after the upgrade, the service worker reads `chrome.storage.local[deskcheck_session]`. If present and `end_time` is null, we log one line (`[DeskCheck] Abandoning pre-OPFS in-flight session on upgrade`), call `chrome.storage.local.remove` for the stale keys (`deskcheck_session`, `deskcheck_events`, `deskcheck_screenshots`), and start fresh. No attempt is made to reconstitute the old events array into OPFS.
- This is the cheapest and safest choice: the old format is broken enough (OOM on large sessions) that there is no user value in preserving it.
- A one-time cleanup helper `clearLegacyStorageKeys()` lives in `session-store-metadata.ts` and is called once at service worker startup. It is covered by a unit test that asserts the legacy keys are removed if present and a no-op if absent.

## How This Design Is "Designed for Change"

Swapping OPFS for IndexedDB (or any other backend) later requires exactly these steps:

1. Create `src/lib/indexeddb-session-store.ts` that implements `SessionStore`.
2. Run the existing contract test suite against it (zero new tests needed to prove the behaviour).
3. Change one line in `src/background/service-worker.ts` — the `new OpfsSessionStore()` constructor call becomes `new IndexedDbSessionStore()`.

Nothing else changes. The exporter, the screenshot module, the metrics adapter, the message handlers, and the widget do not see the swap. This is the definition of vendor abstraction done right: the new impl is drop-in, the old impl can be deleted, the interface is the contract.

Other future changes the interface makes cheap:
- **Feature #10 (session discard)**: already has `store.deleteSession(id)`. No new storage APIs needed.
- **Multiple concurrent sessions**: requires the store to be multi-session-aware. The interface already takes session IDs on every method, so this is a rename-and-extend rather than a rewrite.
- **Cross-device session sync**: a `RemoteSessionStore` that backs OPFS by default and syncs to a blob store on export is straight drop-in.
- **In-memory fallback for incognito or restricted environments**: `FakeSessionStore` is already the in-memory implementation. A production use of the fake is a three-line feature flag.

## Future Extensibility

The narrow interface also accommodates:
- **Encryption at rest**: wrap `OpfsSessionStore` in an `EncryptedSessionStore` decorator that encrypts bytes on the way in and decrypts on the way out. Interface unchanged.
- **Per-event compression**: `appendEvent` could apply zstd/gzip per record. Interface unchanged.
- **Retention policy**: a background sweep that calls `deleteSession(id)` on old sessions is a new cron-like module, not a change to the interface.
- **Export in formats other than zip**: the exporter already takes a store; a JSON-only or NDJSON-only exporter is a parallel module next to `exporter.ts`.

The ratchet here is: every capability above is a new file, not a change to an existing one. That is what "designed for change" buys us, and it is worth the ~2.5x implementation cost versus the quick-and-dirty in-place OPFS replacement.
