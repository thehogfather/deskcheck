---
agent: plan-judge
generated: 2026-04-07T23:30:00Z
task_id: feature-5
selected: synthesis (safety-base + quality-interface + speed-scope-trims)
---

# Plan Evaluation: Incremental persistence (OPFS)

## Executive Summary

Synthesise the safety plan (correct async-OPFS architecture, write queue,
recovery protocol, golden-file regression test) with the quality plan's narrow
`SessionStore` interface (so the exporter and the service worker depend on a
port, not on OPFS directly), and trim the safety plan's legacy-migration and
rollback-flag scope per the brief's explicit non-goals. The decisive factor is
that the safety plan's headline technical finding is **verified correct**:
`FileSystemSyncAccessHandle` is `[Exposed=DedicatedWorker]` per the WHATWG FS
spec and per MDN, so any plan that calls it from a service worker will not
work at runtime. That single fact invalidates the speed plan's append path
and the quality plan's stated implementation pattern, even though both reach
acceptable shapes overall.

## Verification of the Sync-Access-Handle Claim

This is load-bearing, so I checked it directly against two authoritative
sources before scoring:

- **MDN — `FileSystemSyncAccessHandle`**: "This feature is only available in
  Dedicated Web Workers." Plus: "This class is only accessible inside
  dedicated Web Workers ... for files within the origin private file system."
- **WHATWG FS spec**: `[Exposed=DedicatedWorker, SecureContext]` interface
  declaration for `FileSystemSyncAccessHandle`.
- **MDN — `FileSystemFileHandle.createWritable()`**: available in Window,
  Dedicated Workers, and Service Workers.

**Conclusion**: The safety planner is correct. The MV3 service worker
**cannot** call `FileSystemSyncAccessHandle`. The async
`FileSystemFileHandle.createWritable()` → `FileSystemWritableFileStream` API
is the only viable path. Any plan that says "use sync access handles for
event append in the service worker" is broken at the architecture layer, not
just the implementation layer.

This finding rules out the speed plan's stated append path verbatim ("Use
`FileSystemSyncAccessHandle` for event append (fast, works in worker)") and
weakens the quality plan's stated pattern ("`FileSystemSyncAccessHandle`-based
append path inside a background worker — the sync access handle API
serialises writes naturally, so we do not need our own mutex"). Both plans
need the same correction the safety plan already incorporates: a serialised
async write queue using `createWritable()`/`close()`.

## Plans Evaluated

### Speed Plan Summary
- **Core approach**: in-place rewrite of `session-store.ts` to OPFS, swap
  `zipSync` for fflate's streaming `Zip`, single new `opfs-store.ts` helper,
  no new abstraction layer, ~13 files touched.
- **Estimated effort**: ~3.25 hours.
- **Key tradeoff**: assumes `FileSystemSyncAccessHandle` works in the SW
  (it does not), no automated proof of the 100-screenshot DoD criterion
  (manual smoke only), no recovery test for SW wake.

### Quality Plan Summary
- **Core approach**: introduce a narrow `SessionStore` port, two impls
  (`OpfsSessionStore` + `FakeSessionStore`), JSONL helper module, contract
  test suite shared across implementations, exporter takes the store as a
  parameter.
- **Estimated effort**: ~7 hours.
- **Key tradeoff**: also assumes sync access handles in the SW; over-spec
  for a single-impl-today situation in some places (`session-store-metadata.ts`
  as its own module is borderline); does not have a golden-file regression
  test for the export schema (the codebase's "core contract").

### Safety Plan Summary
- **Core approach**: same shape as quality, plus golden-file test pinning
  `session.json` byte-for-byte, recovery protocol for SW wake, async write
  queue (correct for SW), legacy-storage migration on first run,
  compile-time `USE_OPFS_STORAGE` rollback flag with legacy store retained.
- **Estimated effort**: ~7.5 hours.
- **Key tradeoff**: legacy-migration path is not justified by the brief
  (cross-session migration is an explicit non-goal); rollback flag is
  expensive for a feature with no users yet on the OPFS path; some
  belt-and-braces beyond what the DoD requires.

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|-----------|--------|-------|---------|--------|-------|
| Time to deliver | 20% | 4.5 | 2.5 | 2.0 | Speed wins on raw hours but the unfixed sync-handle bug means it would re-enter dev loop. |
| Code quality | 25% | 2.5 | 4.5 | 4.0 | Quality's port pattern matches the user's "design for change" rule. Safety has the same pattern but buries it under more files. |
| Risk mitigation | 25% | 1.5 | 3.0 | 4.5 | Safety has the only correct architecture for the MV3 SW + the only golden-file regression guard against schema drift. |
| Maintainability | 15% | 3.0 | 4.5 | 3.5 | Quality is cleanest. Safety's parallel legacy-store path is two ways to do one thing — debt unless deleted. |
| Test coverage | 15% | 2.0 | 4.0 | 4.5 | Safety has the recovery + golden-file tests; quality has the contract suite; speed punts the DoD criterion to manual. |
| **Weighted Total** | 100% | **2.65** | **3.65** | **3.85** | |

The weighted scores are close between quality and safety. The deciding
factor is correctness under MV3 constraints (a binary, not a slider): only
the safety plan is actually runnable. Once you accept the safety plan's
architecture, the quality plan reduces to "the same architecture with a
better-named interface and fewer scope additions". The synthesis below
takes the safety plan's correctness and the quality plan's interface
discipline.

## Context Analysis

| Factor | Assessment | Impact |
|--------|------------|--------|
| Urgency | Medium | Roadmap-planned, not a hotfix; quality matters more than hours saved. |
| Blast radius | High | Storage layer underpins every recording. A regression silently loses user data. |
| Code area | Core | `session-store.ts` is the substrate for the product's whole reason to exist. |
| Technical debt | Low currently | We should not introduce new debt (parallel store impls) unless the rollback case demands it; here it does not. |
| User visibility | Medium | The export zip is the product's surface for downstream AI consumers; the schema is the contract. |
| Formal verification need | Mild | Concurrency in the write queue + state machine over wake/sleep are non-trivial but bounded; integration tests cover them. |

## Recommendation

### Selected Plan: SYNTHESIS — Safety architecture + Quality interface + Speed scope-trims

### Rationale

The safety plan's verified correction (async OPFS API in the service worker
with a serialised write queue) is non-negotiable: without it, the feature
does not work. The quality plan's `SessionStore` port is the right shape
for "design for change" and is what makes the exporter and service worker
testable without spinning up real OPFS, so we keep it. We trim two pieces
of the safety plan that the brief explicitly disclaims: the legacy
`chrome.storage.local` → OPFS migration path (the brief lists "Cross-session
migration of data written under the old storage model" as a non-goal) and
the `USE_OPFS_STORAGE` compile-time flag with a parallel legacy store
implementation (no users are on this code path yet — there is nothing to
roll back to that has shipped, and `git revert` is the rollback mechanism
for anything on `main`). What we keep from safety is what the DoD actually
requires: the async architecture, the write queue, the recovery hook on SW
wake, the golden-file regression test, and the streaming exporter with a
back-pressure loop. What we keep from quality is the narrow interface and
the contract test suite. What we keep from speed is the discipline of
"don't add files we won't need" — concretely, no separate
`session-store-metadata.ts` module (the metadata helpers live next to the
store), and no integration test file split if a unit test against the fake
store can prove the same thing.

### Incorporated Elements from Other Plans

- **From Safety**:
  - Async `FileSystemWritableFileStream` write path with serialised write
    queue (`writeChain` promise chain) — the only correct option for the SW.
  - Recovery protocol on `restoreState()`: re-derive OPFS handles from
    `session.id`, `ensureReady()` gate before any append.
  - Golden-file regression test pinning `session.json` byte-for-byte
    against a committed fixture covering every event variant.
  - Streaming exporter with explicit back-pressure (`fflate.Zip` incremental
    API, push one file then await drain).
  - "Clear OPFS only after download completes" ordering for export.
  - Stale-directory sweep on session start (last-resort cleanup for
    crash-during-export).
  - Pre-merge manual smoke checklist (the recovery and large-session
    scenarios cannot be reproduced in vitest).
  - The conservation invariants enumerated for tests (every `appendEvent`
    produces exactly one line; `seq` strictly monotonic).

- **From Quality**:
  - Narrow `SessionStore` interface as the public surface; OPFS
    implementation hidden behind it.
  - `FakeSessionStore` (in-memory) implementation that lets the exporter
    and service worker be tested without OPFS at all.
  - Single contract test suite that runs against both the fake and the
    OPFS impl.
  - JSONL helpers (`jsonl.ts`) as a separate pure module with their own
    unit tests (partial trailing line, UTF-8 split, embedded `\n`-in-string).
  - Pure `dataUrlToPngBytes` helper at the screenshot producer so base64
    decode happens once.
  - Blob URL download path (`URL.createObjectURL(new Blob([...]))`) instead
    of `data:` URL + `zipToBase64` — removes the existing OOM hazard at
    download time.
  - Streaming summary aggregation: `buildSummary` is invoked over the
    streaming events read so we make exactly one pass over `events.jsonl`
    during export.

- **From Speed**:
  - "OPFS is wiped on `createSession`" — pragmatic and within the brief's
    non-goals. No legacy migration code.
  - No `USE_OPFS_STORAGE` rollback flag and no parallel legacy store impl —
    nothing has shipped under OPFS yet, `git revert` is the rollback path.
  - No separate `session-store-metadata.ts` file — metadata helpers live
    next to the store implementation.
  - Manual smoke as the documented test for the in-Chrome behaviour we
    cannot reproduce in vitest (the safety plan's pre-merge checklist
    serves the same purpose, kept verbatim).

## The Selected Plan

### Architecture

Introduce a single `SessionStore` interface (`src/lib/session-store.ts`)
that owns all persistent state for a recording session. Two implementations:
`OpfsSessionStore` (the production path, talking to async OPFS via
`FileSystemFileHandle.createWritable()`) and `FakeSessionStore` (in-memory,
for tests). The service worker, exporter, and screenshot module depend on
the interface, not on OPFS directly.

Storage layout:
- `chrome.storage.local[deskcheck_session]` — `SessionMetadata` JSON only.
  Single key. Survives SW sleep, used by `restoreState()` to find the
  session id on wake.
- OPFS `sessions/<session.id>/events.jsonl` — append-only JSONL log of
  `TimelineEvent` records, one per line.
- OPFS `sessions/<session.id>/screenshots/<id>.png` — one PNG file per
  screenshot.

Concurrency: a module-private `writeChain: Promise<void>` inside the OPFS
implementation serialises all writes against the events file. Every public
method awaits `ensureReady()` before doing anything else. `ensureReady()`
re-acquires OPFS handles after SW wake by reading `session.id` from
`chrome.storage.local`.

Export: `exportSession(store, session)` streams events from the store and
screenshots one-at-a-time into `fflate`'s incremental `Zip`. `buildSummary`
runs as an accumulator over the streaming event read so events are scanned
exactly once. The output is collected into a `Blob` and downloaded via
`URL.createObjectURL` — no `data:` URL, no `zipToBase64`.

### Files to Create / Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/session-store.ts` | Rewrite | Defines the `SessionStore` interface and exports a factory that returns the OPFS impl by default. Keeps the same module name so call sites change minimally. |
| `src/lib/opfs-session-store.ts` | New | The only module that touches `navigator.storage.getDirectory()`. Implements `SessionStore` using `createWritable()`. Owns `writeChain`, `ensureReady`, the per-session directory handle cache, and the stale-directory sweep. |
| `src/lib/fake-session-store.ts` | New | In-memory `SessionStore` impl for tests. Tracks peak in-memory bytes for the streaming-export memory test. |
| `src/lib/jsonl.ts` | New | Pure helpers: `encodeRecord(obj)`, `decodeAll(text)`. Skips trailing partial lines. No I/O. |
| `src/lib/exporter.ts` | Rewrite | Signature changes from `(session, events, screenshots) => Uint8Array` to `async (store, session) => Uint8Array`. Uses fflate's streaming `Zip`. `buildSummary` becomes a streaming accumulator (re-uses the existing pure logic body). `getExportFilename` unchanged. |
| `src/lib/session-metrics.ts` | Modify | `computeSessionMetrics(eventCount, screenshotCount, eventsSizeBytes, screenshotsSizeBytes, startTime)` — pure numeric inputs. Formatters (`formatDuration`, `formatBytes`, `isOverSizeThreshold`) untouched. |
| `src/background/service-worker.ts` | Modify | Constructs one `OpfsSessionStore` at module init. `restoreState()` re-acquires the store. `EXPORT_SESSION` calls the streaming exporter then `URL.createObjectURL` then `clearSession()` (in that order — clear ONLY after the download promise resolves). `GET_SESSION_METRICS` reads counts/sizes from the store. Removes `zipToBase64`. |
| `src/background/screenshot.ts` | Modify | New pure `dataUrlToPngBytes()` helper. `takeScreenshot` decodes once and calls `store.appendScreenshot(id, bytes)`. The `dataUrl` is still returned to the caller for live popup preview. |
| `src/constants.ts` | Modify | Remove `STORAGE_EVENTS`, `STORAGE_SCREENSHOTS`. Keep `STORAGE_SESSION`. Add `OPFS_SESSIONS_DIR = "sessions"`, `OPFS_EVENTS_FILE = "events.jsonl"`, `OPFS_SCREENSHOTS_DIR = "screenshots"`. |
| `src/lib/session-store.test.ts` | New | Contract suite — runs against both `FakeSessionStore` and `OpfsSessionStore` (with a fake `navigator.storage`). createSession → appendEvent×N → readEventsStream round-trip; storeScreenshot → readScreenshot round-trip; computeSize sums correctly; deleteSession removes everything; concurrent appendEvent calls serialise. |
| `src/lib/opfs-session-store.test.ts` | New | OPFS-specific tests: ensureReady is gated, writeChain serialises writes, partial-line skip on read, stale-directory sweep, recovery from a simulated SW wake (clear in-memory state, call `ensureReady()` again, verify next append extends the same file). |
| `src/lib/jsonl.test.ts` | New | Pure tests: empty input, single line, multi-line, trailing partial line, UTF-8 split across decoder boundary, embedded `\n` in JSON-string field never splits a record. |
| `src/lib/exporter.test.ts` | Rewrite | Use `FakeSessionStore` populated with fixture events. Existing zip-content assertions kept verbatim (`session.json` schema, `PRIVACY.md`, `agents.md`, screenshots, summary counts, `getExportFilename`). |
| `src/lib/exporter.golden.test.ts` | New | Byte-for-byte regression guard against `src/lib/__fixtures__/golden-session.json`. Fixture covers every `TimelineEvent` discriminated-union variant. Updating the fixture requires explicit reviewer action. |
| `src/lib/exporter.streaming.test.ts` | New | Large-session memory test: `FakeSessionStore` with byte counters, 1000 events + 100 × ~100 KB fake screenshots, run streaming export, assert peak in-flight bytes never exceed 2 × one screenshot worth + summary text. Asserts the export's resulting zip round-trips through `unzipSync` and contains the expected entry list. |
| `src/lib/session-metrics.test.ts` | Modify | Adjust `computeSessionMetrics` tests to the new numeric signature; formatter tests untouched. Add one test that proves a `FakeSessionStore`-fed metrics call matches the file sizes. |
| `src/background/screenshot.test.ts` | Modify | Add a unit test for `dataUrlToPngBytes()` round-trip and one that proves `takeScreenshot` calls `store.appendScreenshot` with bytes (mocked store). |
| `src/lib/__fixtures__/golden-session.json` | New | Committed fixture for the golden-file regression test. |
| `src/lib/__fixtures__/fake-opfs.ts` | New | Test helper: in-memory implementation of `navigator.storage.getDirectory()` shape sufficient for the OPFS impl's tests. |
| `docs/ARCHITECTURE.md` | Modify | Document the OPFS layout, the metadata-only use of `chrome.storage.local`, the recovery protocol, and the deviation from the brief's sync-access-handle assumption. |
| `docs/roadmap.md` | Modify | Tick the feature #5 DoD boxes when the work lands. |

**Total**: 19 files (12 new, 7 modified). One more than the speed plan but 2
fewer than the safety plan; the difference is that we drop
`session-store-legacy.ts`, `session-store-metadata.ts`,
`session-store-contract.test.ts` (folded into `session-store.test.ts`),
`opfs-writer.ts` (folded into `opfs-session-store.ts`),
`session-metrics-integration.test.ts` (folded into `session-metrics.test.ts`),
and the legacy-migration code path entirely.

### Implementation Order

1. Define `SessionStore` interface in `src/lib/session-store.ts`. No
   implementation yet — just the shape, with JSDoc on every method.
2. Build `FakeSessionStore` against the interface. The fake is the
   executable spec; if it is awkward to write, the interface is wrong.
3. Write the contract test suite (`session-store.test.ts`) against the
   fake. Red/green proves the contract is coherent before any OPFS code
   exists.
4. Build the pure `jsonl.ts` helpers and their tests. Cover the partial
   trailing line, UTF-8 split, and embedded-newline cases.
5. Implement `OpfsSessionStore` against the interface using async
   `createWritable()`. Implement `writeChain`, `ensureReady`,
   per-session directory handle cache, and stale-directory sweep.
6. Run the contract test suite against `OpfsSessionStore` (using a fake
   `navigator.storage` injected in the test setup). Both impls must pass.
7. Add `opfs-session-store.test.ts` for OPFS-specific concerns: recovery
   from simulated SW wake, partial-line skip, stale-directory sweep.
8. Rewrite `exporter.ts` to take a `SessionStore` and stream via fflate's
   `Zip`. Fold summary aggregation into the single streaming pass over
   events.
9. Add `exporter.golden.test.ts` and commit `golden-session.json`. The
   fixture is hand-reviewed.
10. Add `exporter.streaming.test.ts` for the 1000-events + 100-screenshot
    memory test against `FakeSessionStore` byte counters.
11. Update `screenshot.ts` to decode the data URL once via
    `dataUrlToPngBytes` and call `store.appendScreenshot(id, bytes)`.
12. Update `service-worker.ts`: construct the store at init, thread it
    through every handler, swap the export download path to
    `URL.createObjectURL` on a Blob, delete `zipToBase64`. `restoreState()`
    re-acquires the store via `ensureReady()`.
13. Update `session-metrics.ts` to the numeric signature and update its
    tests.
14. Update `ARCHITECTURE.md` and `roadmap.md`.
15. Run the manual pre-merge smoke checklist below in a clean Chrome
    profile.

### Definition of Done (Final)

- [ ] Events are appended to OPFS `sessions/<id>/events.jsonl` as JSONL,
      one record per line — no events ever land in `chrome.storage.local`
- [ ] Screenshots are written as individual PNG files at
      `sessions/<id>/screenshots/<id>.png` — no base64 strings in any
      storage
- [ ] `chrome.storage.local` for an active session contains only
      `STORAGE_SESSION` (metadata); `STORAGE_EVENTS` and
      `STORAGE_SCREENSHOTS` constants are removed from the codebase
- [ ] `exportSession` streams from the store via fflate's incremental
      `Zip` API — no `zipSync` on the active export path
- [ ] Download uses `URL.createObjectURL(new Blob([zipBytes]))`, not a
      `data:` base64 URL; `zipToBase64` is deleted
- [ ] `OpfsSessionStore` and `FakeSessionStore` both pass the same
      contract test suite
- [ ] Export schema (`session.json`) is byte-identical to the committed
      golden fixture for the same input events (golden-file test green)
- [ ] Streaming exporter memory test: 1000 events + 100 × ~100 KB
      synthetic screenshots; peak in-flight bytes never exceed 2 × one
      screenshot's worth + the summary text
- [ ] Recovery test: simulate SW wake mid-session by clearing in-memory
      module state and re-calling `ensureReady()`; next append extends
      the same `events.jsonl` and `seq` is monotonic
- [ ] Partial-line tolerance: a corrupt last line in `events.jsonl` is
      skipped on read with a warning, not a parse failure
- [ ] `GET_SESSION_METRICS` returns sizes computed from OPFS file sizes
      (events file + sum of screenshot file sizes), and counts from the
      store, not from in-memory string lengths
- [ ] Existing widget metrics display (duration, event count, screenshot
      count, size) continues to work; `widget.ts` is not modified
- [ ] `ARCHITECTURE.md` updated to describe the OPFS layout, metadata-only
      `chrome.storage.local` use, recovery protocol, and the deviation
      from the brief's sync-access-handle assumption
- [ ] `make typecheck` clean
- [ ] `make test` green (every existing test plus every new test)
- [ ] Pre-merge manual smoke checklist (below) executed and recorded in
      the PR description

### Test Level Matrix (Final)

| # | DoD Item (verbatim) | Test Level | Test File | What it asserts |
|---|---------------------|-----------|-----------|-----------------|
| 1 | Events are appended to an OPFS file incrementally, not accumulated in a chrome.storage.local array | Unit | `src/lib/session-store.test.ts` (contract suite) | After `appendEvent` × N, `chrome.storage.local.set` was never called with an `STORAGE_EVENTS` key, and `store.readEventsStream()` yields the same N records in order. Runs against both Fake and OPFS impls. |
| 2 | Screenshots are written as individual PNG files to OPFS, not stored as base64 data URLs | Unit | `src/lib/session-store.test.ts` (contract suite) | After `appendScreenshot(id, bytes)` × N, the OPFS fake reports N PNG files at the expected paths and `chrome.storage.local` has no screenshot key. |
| 3 | Export reads from OPFS and streams into the zip without loading the full session into memory | Integration (in vitest) | `src/lib/exporter.streaming.test.ts` | `FakeSessionStore` instrumented with byte counters: 1000 events + 100 × ~100 KB synthetic screenshots; peak in-flight bytes recorded by the exporter's output consumer never exceed 2 × one screenshot's bytes + summary text size. The resulting zip round-trips through `unzipSync` and contains the expected entry list. |
| 4 | Session recording works for 100+ screenshots and 1000+ events without service worker OOM | Manual | Pre-merge smoke checklist (PR description) | Real Chrome load-unpacked: record 1000 events via a page-console loop, take 100 screenshots via the keyboard shortcut, stop, export, verify the zip downloads and opens. `chrome://extensions` → Errors stays empty. |
| 5 | `chrome.storage.local` is used only for lightweight session metadata (not events or screenshots) | Unit | `src/lib/session-store.test.ts` | After a full lifecycle (`createSession` → `appendEvent` × 5 → `appendScreenshot` × 2 → `endSession`), `chrome.storage.local.get(null)` returns only `{deskcheck_session: ...}` plus any pre-existing privacy/onboarding keys — no `deskcheck_events`, no `deskcheck_screenshots`. Plus a structural test that the constants `STORAGE_EVENTS` and `STORAGE_SCREENSHOTS` no longer exist in `src/constants.ts`. |
| 6 | Session metrics from feature #1 continue to work correctly with OPFS-backed storage, with size computed from actual OPFS footprint | Unit | `src/lib/session-metrics.test.ts` | New numeric `computeSessionMetrics` signature: feed known counts and byte totals, assert returned shape matches the existing `SessionMetrics` interface. Plus a small contract-suite test that proves `store.computeSize()` sums to `byteLength(events.jsonl) + sum(byteLength(each screenshot))`. |
| 7 | Existing export schema is preserved (no breaking changes to session.json) | Unit (golden-file) | `src/lib/exporter.golden.test.ts` | A committed fixture (events covering every discriminated-union variant) is fed through the streaming exporter; the resulting `session.json` is byte-identical to a hand-reviewed `__fixtures__/golden-session.json`. Any whitespace, field-order, or new-property change fails the test loudly. Plus the existing `exporter.test.ts` assertions on `schema_version`, summary counts, `PRIVACY.md`, `agents.md`, and `screenshots/<id>.png` entries — all kept verbatim. |
| 8 (supporting) | Recovery on SW wake mid-session preserves seq monotonicity | Unit (with fake OPFS) | `src/lib/opfs-session-store.test.ts` | Create session, append 5 events, clear in-memory state to simulate SW termination, re-instantiate the store and call `ensureReady()`, append a 6th event, read events back: assert all 6 are present with `seq` 1..6 in order, written to the same file. |
| 9 (supporting) | Partial-line JSONL is tolerated on read | Unit | `src/lib/jsonl.test.ts` | Decode `'{"a":1}\n{"b":2}\n{"c":3'` returns the first two records and reports one partial. Decoder never throws on a missing trailing newline. |
| 10 (supporting) | Concurrent `appendEvent` calls produce ordered, non-interleaved bytes | Unit | `src/lib/opfs-session-store.test.ts` | Issue 100 `appendEvent` calls in parallel against the OPFS impl with the fake `navigator.storage`; assert the resulting `events.jsonl` parses cleanly into 100 records and `seq` is strictly monotonic 1..100. |
| 11 (supporting) | Download path uses Blob URL not data URL | Unit | `src/background/service-worker.test.ts` (extend if exists, else add a small test) | Mock `URL.createObjectURL`; trigger the `EXPORT_SESSION` path; assert `URL.createObjectURL` was called with a `Blob` and `chrome.downloads.download` received the resulting URL (not a `data:` URL). Also assert `clearSession()` is called AFTER `chrome.downloads.download` resolves. |
| 12 (supporting) | `dataUrlToPngBytes` decodes a captured data URL once | Unit | `src/background/screenshot.test.ts` | Pure helper test: round-trip a known PNG → data URL → bytes → assert byte equality. |

**Test type counts**: 11 unit (including the golden-file unit test), 1
integration (the streaming-export memory test, which is still in vitest
but composes the exporter end-to-end with a fake store), 1 manual (the
pre-merge smoke). No new e2e — there is no Playwright suite tied to
recording today and the manual smoke is the cross-stack confidence gate.

**Determinism**: every test uses fixed inputs and either `FakeSessionStore`
or a fake `navigator.storage`. No real OPFS, no LLM calls, no network. The
golden-file test uses a hand-reviewed committed fixture that updates only
under explicit human review.

### Risks Accepted (and Why)

These are risks the safety plan defends against that we are deliberately
**not** addressing in this PR, with a justification grounded in the brief
or in the current code state:

1. **No legacy `chrome.storage.local` → OPFS migration on first run.** The
   brief explicitly lists "Cross-session migration of data written under
   the old storage model" as a non-goal. On first run after the upgrade,
   `restoreState()` notices any session present in `STORAGE_SESSION` and,
   if it has no `end_time`, calls `clearSession()` (which removes both
   the metadata key and any stale `STORAGE_EVENTS`/`STORAGE_SCREENSHOTS`
   keys) and starts fresh. Any in-progress development session at the
   moment of the upgrade is throwaway debug data — there are no real
   users on this branch yet.

2. **No `USE_OPFS_STORAGE` compile-time rollback flag and no parallel
   legacy store implementation.** The safety plan keeps `session-store-
   legacy.ts` for one release as a hotfix path. We do not, because
   nothing has shipped under OPFS yet — there is no installed user base
   to roll back **from**. If a critical bug is found post-merge, the
   rollback is `git revert` on the merge commit. Carrying a parallel
   implementation is debt that costs maintenance every PR until it is
   deleted.

3. **No formal verification (TLC) of the wake/sleep state machine.** The
   safety plan flags this as "high-value if time permits" but explicitly
   does not require it. Concurrency is bounded (single writer via
   `writeChain`), the state machine has 5 states with well-defined
   transitions, and the contract suite plus the recovery test cover the
   adversarial cases. We accept the residual risk of a missed race.

4. **No "OPFS unavailable" runtime fallback.** The safety plan suggests
   feature-detecting OPFS at startup and falling back to in-memory. We
   skip this: OPFS is in baseline Chrome since 2022, the extension is
   Chrome-only per the brief's non-goals, and an in-memory fallback
   would silently lose all data on SW termination — which is worse than
   a clear error. If `navigator.storage.getDirectory()` rejects, we
   surface a loud error to the widget and refuse to start the session.

5. **No explicit defence against `QuotaExceededError` mid-session.** OPFS
   quota on Chrome is generous (typically tens of GB). Adding a quota
   probe at session start adds complexity without a known motivating
   case. If a quota error reaches `appendEvent`, it propagates as a
   rejected promise and the next `GET_SESSION_METRICS` poll surfaces
   the error to the widget — same failure mode as any other write
   error. We do not pre-emptively reserve space.

6. **In-flight event between SW termination and write commit is lost.**
   This is structurally unavoidable in MV3. The mitigation is that
   `appendEvent` does not return a resolved promise until `close()` has
   committed the write, so the caller (the message handler) sees the
   failure rather than the failure being silent. The content script that
   sent the event sees a Chrome runtime error and may retry. Documented
   as a known limitation in the PR description.

### Pre-Merge Manual Smoke Checklist

Lifted verbatim from the safety plan because the in-Chrome scenarios
genuinely cannot be reproduced in vitest.

**Environment**
- [ ] `make clean && make build` produces `dist/` with no warnings
- [ ] Load `dist/` via `chrome://extensions` → "Load unpacked" in a
      **clean Chrome profile**
- [ ] `chrome://extensions` shows no errors

**Happy path**
- [ ] Navigate to `https://example.com`, start a session in Full mode
- [ ] Click 5 things → widget shows ~5 events
- [ ] Take 2 screenshots via the widget
- [ ] In `chrome://inspect/#service-workers` → DeskCheck → Application →
      Storage → File System: verify `sessions/<id>/events.jsonl` exists
      and has 5+ lines, `sessions/<id>/screenshots/` has 2 PNGs
- [ ] Stop and download → zip opens, `session.json` parses, has 5+
      events, `screenshots/` has 2 PNGs
- [ ] After download, re-inspect OPFS → `sessions/<id>/` is gone

**Recovery (SW wake mid-session)**
- [ ] Start a session, record 10 events, do NOT stop
- [ ] In `chrome://serviceworker-internals` find the DeskCheck worker
      and click Stop
- [ ] Wait 5 seconds, interact with the page again
- [ ] Worker wakes, badge still says REC, next event's `seq` is 11
- [ ] Stop and download → zip contains events 1–11 in order

**Feature-1 metrics regression**
- [ ] Start a session, record 50 events + 5 screenshots
- [ ] Widget shows event count 50, screenshots count 5, both sizes
      non-zero, all four values update within 2s of each new event

**Large session**
- [ ] Start a session
- [ ] In the page console: `for (let i=0;i<1000;i++) document.body.click()`
- [ ] Take 100 screenshots via the keyboard shortcut
- [ ] `chrome://extensions` Errors stays empty
- [ ] Stop and download → zip is produced and opens

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | N | Y (mild) | Y | **Y (mild)** |
| State machine | N | N | Y | N |
| Conservation | Y (weak) | Y | Y | **Y** |
| Authorization | N | N | N | N |

**Recommendation**: **SKIP**. The concurrency surface is bounded by a
single-writer queue inside one service-worker JS context. The conservation
invariants ("every `appendEvent` produces exactly one line", "`seq` is
strictly monotonic") are covered by the contract suite and the
concurrent-append test. The state machine, while non-trivial across
wake/sleep, is exercised by the recovery test against the OPFS impl. No
TLC model is required for a feature this size — but the invariants below
must remain green in CI as the test suite's load-bearing assertions.

**Key invariants** (asserted by tests, not by TLC):
- Every appended event is observable via `readEventsStream` until
  `deleteSession` is called.
- `seq` is strictly monotonic within a session.
- `computeSize` equals `byteLength(events.jsonl) + sum(byteLength(each
  screenshot))`.
- `clearSession()` is idempotent.
- Recovery on SW wake never merges data from two different sessions
  (because the OPFS directory is keyed by `session.id` from
  `chrome.storage.local`).
- `chrome.storage.local` for an active session never gains a key other
  than `STORAGE_SESSION` (and the existing privacy/onboarding keys).

---

## Orchestrator Handoff

This evaluation is the final decision. The orchestrator will:
1. Commit all plans (speed, quality, safety, this selected plan) to
   `docs/plans/feature-5/` for the audit trail.
2. Use the Test Level Matrix above to generate failing acceptance tests
   at the specified levels.
3. Proceed to implementation in the order listed under "Implementation
   Order" above.

**Summary for git commit**:
- Selected plan: **Synthesis** — Safety architecture (correct async OPFS,
  write queue, recovery, golden-file test) + Quality interface
  (`SessionStore` port, contract suite) + Speed scope-trims (no legacy
  migration, no rollback flag, no parallel legacy store impl).
- Key rationale: Safety planner's `FileSystemSyncAccessHandle` finding is
  verified correct against MDN and the WHATWG FS spec — sync access
  handles are `[Exposed=DedicatedWorker]` and cannot be used in MV3
  service workers; the speed and quality plans both assume otherwise. Async
  `createWritable()` with a serialised write queue is the only viable
  path. Trimming the safety plan's legacy migration and rollback flag is
  justified by the brief's explicit non-goals.
- Estimated effort: ~6 hours (Quality's 7h minus the trimmed safety
  scope, plus the golden-file test).
- Key risks: in-flight event between SW termination and write commit is
  lost; no runtime OPFS unavailability fallback (loud failure instead).
- Test levels: 11 unit, 1 integration, 1 manual.
