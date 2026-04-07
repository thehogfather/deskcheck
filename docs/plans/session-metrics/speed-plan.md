---
agent: speed-planner
generated: 2026-04-06T00:00:00Z
task_id: feature-1-session-metrics
perspective: speed
---

# Speed Plan: Session Size and Duration Indicator

## Architecture Impact

**Components affected:**
- `src/content/widget.ts`: Add metrics status bar UI to the widget
- `src/content/widget.css`: Styles for the new metrics bar and size warning
- `src/background/service-worker.ts`: Handle new `GET_SESSION_METRICS` message
- `src/types.ts`: Add `GET_SESSION_METRICS` message type and `SessionMetrics` response type
- `src/constants.ts`: Add size warning threshold constant
- `src/lib/session-metrics.ts`: New pure helper for formatting duration and size

**New patterns or abstractions introduced:**
- `SessionMetrics` type: A simple data object returned by the service worker. This is the only new abstraction -- it mirrors the existing message-passing pattern.
- `formatDuration` / `formatSize` pure helpers: Extracted into a small module for testability.

**Dependencies added or modified:**
- None

**Breaking changes to existing interfaces:**
- None -- this change is additive only. The `Message` union gets one new variant.

## Approach

Add a compact metrics status bar between the header and body of the widget. A 1-second `setInterval` in the content script sends `GET_SESSION_METRICS` to the service worker, which computes event count, screenshot count, and estimated byte size from storage. The content script also tracks elapsed duration client-side from `session.start_time` (no message needed). Pure formatting helpers are extracted for unit testing.

The key speed insight: **duration is computed entirely client-side** (just `Date.now() - startTime`), so only the size/counts need a message to the service worker. We poll every 2 seconds for metrics (not every 1s) to keep messaging lightweight, but update the duration timer every 1 second purely in the content script.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `src/lib/session-metrics.ts` | Create | ~40 | Pure helpers: `formatDuration`, `formatSize`, `estimateStorageSize`, `SIZE_WARNING_THRESHOLD` |
| `src/types.ts` | Modify | ~8 | Add `GET_SESSION_METRICS` message + `SessionMetrics` interface |
| `src/constants.ts` | Modify | ~3 | Add `SIZE_WARNING_MB` and `METRICS_POLL_INTERVAL` constants |
| `src/background/service-worker.ts` | Modify | ~25 | Handle `GET_SESSION_METRICS`: read storage, compute byte estimate, return counts |
| `src/content/widget.ts` | Modify | ~45 | Add metrics bar DOM, start/clear interval, update display |
| `src/content/widget.css` | Modify | ~25 | Style `.dc-metrics` bar, `.dc-size-warning` highlight |
| `src/lib/session-metrics.test.ts` | Create | ~50 | Unit tests for pure formatting/estimation helpers |

**Total files**: 7 (2 new, 5 modified)
**Total estimated lines**: ~196

## Implementation Steps

1. **Add types and constants.** In `src/types.ts`, add a `SessionMetrics` interface (`eventCount: number`, `screenshotCount: number`, `estimatedSizeBytes: number`) and add `| { type: "GET_SESSION_METRICS" }` to the `Message` union. In `src/constants.ts`, add `SIZE_WARNING_MB = 50` and `METRICS_POLL_INTERVAL = 2000`.

2. **Create `src/lib/session-metrics.ts`.** Export pure functions:
   - `formatDuration(ms: number): string` -- e.g., `"3m 42s"`, handles hours too
   - `formatSize(bytes: number): string` -- e.g., `"12.3 MB"`, `"450 KB"`
   - `estimateStorageSize(events: unknown[], screenshots: Record<string, string>): number` -- uses `JSON.stringify(events).length` for events, sums `screenshot.length` (base64 chars) for screenshots, applies 0.75 factor for base64-to-bytes on screenshot data, returns total bytes

3. **Handle message in service worker.** In `src/background/service-worker.ts`, add a `case "GET_SESSION_METRICS"` that calls `getEvents()` and `getScreenshots()`, runs `estimateStorageSize()`, and returns `{ eventCount, screenshotCount, estimatedSizeBytes }`.

4. **Add metrics UI to widget.** In `src/content/widget.ts`:
   - After the header and before the body, insert a `dc-metrics` bar element containing three spans: duration, counts, size.
   - On `showWidget()`, fetch `GET_SESSION_STATE` response (already done implicitly by session start flow) -- instead, extract `start_time` from the initial `SESSION_STARTED` message or query it once via `GET_SESSION_METRICS`.
   - Start a `setInterval(1000)` that updates the duration display client-side.
   - Start a second `setInterval(METRICS_POLL_INTERVAL)` that sends `GET_SESSION_METRICS` and updates event/screenshot count and size display. If size exceeds threshold, add `.dc-size-warning` class.
   - In `hideWidget()`, clear both intervals.
   - **Implementation detail**: To get `start_time` without a new message type, the first `GET_SESSION_METRICS` response should include `startTime: string`. Add this field to `SessionMetrics`.

5. **Add styles.** In `src/content/widget.css`, add styles for `.dc-metrics` (compact bar between header and body, muted text, monospace for numbers) and `.dc-size-warning` (amber/red background tint).

6. **Write tests.** Create `src/lib/session-metrics.test.ts` with unit tests for `formatDuration`, `formatSize`, and `estimateStorageSize`.

## Definition of Done

- [ ] Widget displays elapsed duration updating every second while recording
- [ ] Widget displays event count and screenshot count, refreshed every 2 seconds
- [ ] Widget displays estimated session size in human-readable format (KB/MB)
- [ ] Widget shows a visual warning when estimated size exceeds 50 MB
- [ ] Duration timer and metrics polling are cleaned up when widget is hidden
- [ ] Pure helper functions (`formatDuration`, `formatSize`, `estimateStorageSize`) have unit tests
- [ ] `make typecheck` passes with no errors
- [ ] `make test` passes

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Duration display updates every second | Unit | Test `formatDuration` pure function with various ms values |
| 2 | Event/screenshot counts displayed | Unit | Test `estimateStorageSize` returns correct counts (the display is simple DOM text) |
| 3 | Size displayed in human-readable format | Unit | Test `formatSize` with KB/MB/GB boundaries |
| 4 | Warning when size > 50 MB | Unit | Test threshold comparison logic in pure function |
| 5 | Cleanup on hide | Manual | Interval cleanup is straightforward imperative code in `hideWidget` |
| 6 | Unit tests pass | Unit | Self-verifying |
| 7 | Type check passes | Build | `make typecheck` |
| 8 | All tests pass | Build | `make test` |

## Testing Strategy

- **Unit**: Test `formatDuration` (0ms, 1s, 59s, 1m0s, 3m42s, 1h5m, edge cases), `formatSize` (0, 500 bytes, 1KB, 1.5MB, 50MB, 100MB), `estimateStorageSize` (empty, with events, with screenshots of known base64 length). ~6-8 test cases.
- **Integration**: Skip -- the message-passing integration is covered by manual load testing the extension.
- **E2E**: Skip -- no automated e2e infrastructure for Chrome extensions.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: None -- no existing e2e test suite.
- **New e2e tests needed**: None -- no new user-facing flows that can be automated without Chrome extension test harness.
- **Cost note**: N/A

**Test files to create/modify**:
- Create: `src/lib/session-metrics.test.ts`

## Risk Assessment

**Risk Level**: Low

**Why this is safe**:
- Purely additive UI change -- no existing functionality is modified
- Metrics polling is read-only (`getEvents`, `getScreenshots`) -- no mutation
- Duration is computed client-side, no service worker overhead for the 1s timer
- 2s polling interval for storage reads is conservative; `chrome.storage.local.get` is fast
- Worst case if metrics fail: the bar shows stale data, recording continues unaffected

**Tradeoffs accepted**:
- Polling every 2s instead of push-based updates: simpler, good enough for a status display
- `JSON.stringify(events).length` is an approximation of storage size, not exact: acceptable for a "~X MB" indicator
- No persistence of metrics across service worker restarts: the content script re-polls on next interval tick

## Estimated Effort

- Planning: Already done
- Implementation: 45 minutes
- Testing: 15 minutes
- **Total**: 60 minutes

## Formal Verification Assessment

- Concurrency concerns: No -- single content script polling a single service worker, no shared mutable state beyond existing storage
- State machine complexity: No -- no new lifecycle states, just a read-only overlay
- Conservation laws: No
- Authorization model: No
- Recommendation: Not needed

## What This Plan Does NOT Include

- Does NOT implement push-based metrics (e.g., broadcasting counts on every `appendEvent`) -- polling is simpler and sufficient
- Does NOT add metrics to the popup UI -- only the content script widget
- Does NOT persist metrics or history -- ephemeral display only
- Does NOT optimize `appendEvent` read-modify-write -- that is a separate concern (feature #5 OPFS migration)
- Does NOT add progress bar or detailed breakdown by event type -- MVP is counts + size
- Does NOT add the metrics to the minimized widget state -- visible only when expanded
