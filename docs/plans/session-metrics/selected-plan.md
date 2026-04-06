---
agent: plan-judge
generated: 2026-04-06T12:00:00Z
task_id: session-metrics
selected: quality
---

# Plan Evaluation: Session Size and Duration Indicator

## Executive Summary

The **Quality plan** is selected as the foundation, with minor refinements from the Speed plan (polling-only simplicity for the first iteration) and the Safety plan (defensive input clamping and try/catch around message sends). The feature is low-risk, additive UI with pure computation at its core -- the Quality plan's clean three-layer separation (pure logic, service worker coordination, presentation) best fits this codebase's established patterns without over-engineering.

## Plans Evaluated

### Speed Plan Summary
- **Core approach**: Minimal polling model -- content script polls service worker every 2 seconds for counts/size, maintains its own 1-second duration timer. All pure helpers in a single `session-metrics.ts` module.
- **Estimated effort**: 60 minutes
- **Key tradeoff**: No push model means widget shows stale data for up to 2 seconds after an event. No throttling concerns since it is pure pull. Slightly less responsive but simpler.

### Quality Plan Summary
- **Core approach**: Clean three-layer separation (pure computation, service worker push+pull coordination, presentation). Service worker pushes metrics on a 2-second interval during recording; widget also pulls on mount. Duration timer client-side at 1 second. Pure module with `computeSessionMetrics`, `formatDuration`, `formatBytes`, `isOverSizeThreshold`.
- **Estimated effort**: 105 minutes
- **Key tradeoff**: Slightly more complex with the push model, but establishes a pattern for future service-worker-to-content communication. Metrics bar visible when minimized (useful design decision).

### Safety Plan Summary
- **Core approach**: Hybrid push+pull with incremental byte tracking (running counter instead of full re-serialization). Throttled push after each mutation. Separate `format-utils.ts` and modifications to `session-store.ts`. Detailed 8-phase rollback plan.
- **Estimated effort**: 135 minutes
- **Key tradeoff**: Incremental tracking adds complexity to `appendEvent` and `storeScreenshot` code paths (the hot path), introducing coupling between metrics and storage mutations. The extra safety apparatus (rollback plan, monitoring checklist, security review) is disproportionate for a read-only UI overlay.

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|-----------|--------|-------|---------|--------|-------|
| Time to deliver | 20% | 4.5 | 3.5 | 2.5 | Speed is fastest; Quality is reasonable; Safety's 8 phases add overhead |
| Code quality | 25% | 3.0 | 4.5 | 3.5 | Quality has cleanest separation; Safety splits files unnecessarily (format-utils.ts separate from session-metrics.ts) and mutates session-store.ts |
| Risk mitigation | 25% | 3.0 | 4.0 | 4.5 | Safety is most thorough on risks; Quality covers the important ones; Speed skips some edge cases |
| Maintainability | 15% | 3.5 | 4.5 | 3.0 | Quality's approach is most aligned with existing patterns; Safety's incremental counter adds ongoing maintenance burden to appendEvent/storeScreenshot |
| Test coverage | 15% | 3.0 | 4.0 | 4.0 | Quality and Safety both propose thorough edge case coverage; Speed covers basics |
| **Weighted Total** | 100% | **3.35** | **4.10** | **3.45** | |

## Context Analysis

| Factor | Assessment | Impact |
|--------|------------|--------|
| Urgency | Low | Planned feature, not a hotfix. Quality approach is appropriate. |
| Blast radius | Low | Read-only UI overlay during recording. No data mutation, no schema changes, no export format changes. Worst case: stale/missing metrics display. |
| Code area | Peripheral | Informational display, not core recording/export logic. However, it touches widget.ts (the main UI) and service-worker.ts (the message router), so patterns matter. |
| Technical debt | Low | Codebase is clean and well-structured. No reason to cut corners. |

## Recommendation

### Selected Plan: Quality

### Rationale

The Quality plan wins because it establishes the cleanest architecture while remaining practical. Its three-layer separation (pure computation in `src/lib/session-metrics.ts`, service worker coordination, widget presentation) directly mirrors the existing `exporter.ts` / `buildSummary` pattern. The decision to keep the duration timer client-side while polling for metrics data is sound engineering -- it avoids per-second cross-context messaging while keeping the clock smooth. The 105-minute estimate is reasonable for a well-tested, maintainable implementation.

The Safety plan's incremental byte tracking, while theoretically more efficient, is premature optimization that adds coupling to the hot path (`appendEvent`, `storeScreenshot`). The current `chrome.storage.local.get` is fast for the data volumes DeskCheck handles, and re-reading every 2 seconds is negligible overhead. The Safety plan also splits formatting helpers into a separate `format-utils.ts` file, which fragments what is logically one cohesive module.

The Speed plan is viable but leaves behind some quality: no `isOverSizeThreshold` extraction, no mention of the metrics bar being visible when minimized, and limited edge case testing. These are worth the extra 45 minutes.

### Incorporated Elements from Other Plans

- From **Speed Plan**: Use the simpler **polling model** (content script sends `GET_SESSION_METRICS` every 2 seconds) instead of the Quality plan's service-worker push model. The push model adds complexity (new `SESSION_METRICS` message type, interval management in the service worker, a new communication direction) for marginal benefit -- 2-second polling latency is imperceptible for a status display. Polling also avoids the startup race that the push model introduces (which requires pull-on-mount as a workaround anyway). One message type (`GET_SESSION_METRICS`) instead of two (`GET_SESSION_METRICS` + `SESSION_METRICS`) is simpler.
- From **Safety Plan**: Add defensive input clamping in `formatDuration` (negative values -> "0s") and `formatBytes` (NaN/negative -> "0 KB"). Wrap `chrome.runtime.sendMessage` calls in the metrics polling with try/catch to handle disconnected service worker gracefully.

## The Selected Plan

### Architecture

Three-layer separation following existing codebase patterns:

1. **Pure computation** (`src/lib/session-metrics.ts`) -- all size estimation, formatting, and threshold logic. Zero Chrome API dependencies. Fully unit-testable.
2. **Service worker handler** (`src/background/service-worker.ts`) -- responds to `GET_SESSION_METRICS` request by reading storage and computing metrics via the pure module.
3. **Presentation** (`src/content/widget.ts`) -- polls for metrics every 2 seconds, maintains its own 1-second duration timer using `startTime` from the first metrics response.

### Communication Model: Polling (not Push)

The content script polls via `GET_SESSION_METRICS` every 2 seconds. This is simpler than push because:
- Only one new message type instead of two
- No interval management needed in the service worker (the service worker already stays alive during recording due to debugger attachment)
- No startup race condition to work around
- The service worker handler is stateless and idempotent -- it reads storage and returns data
- 2-second latency for count/size updates is imperceptible in a status display

The duration timer is purely client-side (1-second `setInterval` computing `Date.now() - startTime`), so the clock is always smooth regardless of polling cadence.

### Files to Create/Modify

| File | Change Type | Est. Lines | Purpose |
|------|-------------|------------|---------|
| `src/lib/session-metrics.ts` | **Create** | ~55 | Pure functions: `computeSessionMetrics()`, `formatDuration()`, `formatBytes()`, `isOverSizeThreshold()` |
| `src/lib/session-metrics.test.ts` | **Create** | ~90 | Comprehensive unit tests for all pure functions |
| `src/types.ts` | Modify | ~10 | Add `SessionMetrics` interface and `GET_SESSION_METRICS` message variant |
| `src/constants.ts` | Modify | ~5 | Add `SIZE_WARNING_BYTES`, `METRICS_POLL_INTERVAL_MS` constants |
| `src/background/service-worker.ts` | Modify | ~20 | Add `GET_SESSION_METRICS` case to `handleMessage` |
| `src/content/widget.ts` | Modify | ~55 | Add metrics bar DOM, start/clear intervals, update display |
| `src/content/widget.css` | Modify | ~30 | Style `.dc-metrics-bar`, `.dc-metrics-warning` |

**Total**: 7 files (2 new, 5 modified), ~265 lines

### Implementation Steps

**Step 1: Types and Constants**

In `src/types.ts`, add:
```typescript
export interface SessionMetrics {
  startTime: string;
  eventCount: number;
  screenshotCount: number;
  estimatedSizeBytes: number;
}
```

Add to the `Message` union:
```typescript
| { type: "GET_SESSION_METRICS" }
```

In `src/constants.ts`, add:
```typescript
export const SIZE_WARNING_BYTES = 50 * 1024 * 1024; // 50 MB
export const METRICS_POLL_INTERVAL_MS = 2000;
```

**Step 2: Pure Computation Module**

Create `src/lib/session-metrics.ts` with:

- `computeSessionMetrics(events: TimelineEvent[], screenshots: Record<string, string>, startTime: string): SessionMetrics` -- counts events and screenshot keys, estimates size by summing `JSON.stringify(events).length` plus sum of all screenshot data URL string lengths (chrome.storage.local stores JSON-serialized data, so string length approximates byte cost for ASCII/base64 content). Returns the `SessionMetrics` object.

- `formatDuration(ms: number): string` -- Clamp negative values to 0. Format as:
  - `ms < 1000` -> "< 1s"
  - `ms < 60000` -> "Xs" (e.g., "42s")
  - `ms < 3600000` -> "Xm Ys" (e.g., "3m 42s")
  - `ms >= 3600000` -> "Xh Ym Zs" (e.g., "1h 05m 22s")

- `formatBytes(bytes: number): string` -- Clamp NaN/negative to 0. Format as:
  - `bytes < 1024` -> "0 KB" (sub-KB values are noise)
  - `bytes < 1048576` -> "X.X KB" (e.g., "850.0 KB")
  - `bytes < 1073741824` -> "X.X MB" (e.g., "12.3 MB")
  - `bytes >= 1073741824` -> "X.X GB"

- `isOverSizeThreshold(bytes: number, thresholdBytes: number): boolean` -- trivial comparison, extracted for testability and declarative widget code.

**Step 3: Unit Tests**

Create `src/lib/session-metrics.test.ts` with test cases:

`formatDuration`:
- `formatDuration(-100)` -> "< 1s" (negative clamp)
- `formatDuration(0)` -> "< 1s"
- `formatDuration(500)` -> "< 1s"
- `formatDuration(1000)` -> "1s"
- `formatDuration(5000)` -> "5s"
- `formatDuration(59000)` -> "59s"
- `formatDuration(60000)` -> "1m 00s"
- `formatDuration(62000)` -> "1m 02s"
- `formatDuration(3600000)` -> "1h 00m 00s"
- `formatDuration(3723000)` -> "1h 02m 03s"

`formatBytes`:
- `formatBytes(-1)` -> "0 KB"
- `formatBytes(NaN)` -> "0 KB"
- `formatBytes(0)` -> "0 KB"
- `formatBytes(500)` -> "0 KB"
- `formatBytes(1024)` -> "1.0 KB"
- `formatBytes(1536)` -> "1.5 KB"
- `formatBytes(1048576)` -> "1.0 MB"
- `formatBytes(52428800)` -> "50.0 MB"
- `formatBytes(1073741824)` -> "1.0 GB"

`computeSessionMetrics`:
- Empty session: 0 events, {} screenshots -> counts are 0, size is minimal (empty array serialization)
- Session with events only: verify eventCount matches array length, size reflects serialized length
- Session with screenshots only: verify screenshotCount matches keys, size reflects data URL lengths
- Mixed session: verify all fields
- Verify `startTime` is passed through

`isOverSizeThreshold`:
- Below threshold -> false
- At threshold -> false (not strictly over)
- Above threshold -> true

**Step 4: Service Worker Handler**

Add a `GET_SESSION_METRICS` case to `handleMessage` in `src/background/service-worker.ts`:

```typescript
case "GET_SESSION_METRICS": {
  const session = await getSession();
  if (!session || !recording) {
    return { startTime: "", eventCount: 0, screenshotCount: 0, estimatedSizeBytes: 0 };
  }
  const events = await getEvents();
  const screenshots = await getScreenshots();
  return computeSessionMetrics(events, screenshots, session.start_time);
}
```

Import `computeSessionMetrics` from `../lib/session-metrics`.

**Step 5: Widget UI**

Modify `src/content/widget.ts`:

- Add module-level variables for interval IDs:
  ```typescript
  let durationInterval: ReturnType<typeof setInterval> | null = null;
  let metricsInterval: ReturnType<typeof setInterval> | null = null;
  let sessionStartTime: string | null = null;
  ```

- In `showWidget()`, after creating the header and before creating the body, create a metrics bar:
  ```
  [duration] | [events] events  [screenshots] screenshots | [size]
  ```
  Using the `el()` helper, create a `.dc-metrics-bar` div containing four spans: `.dc-duration`, `.dc-event-count`, `.dc-screenshot-count`, `.dc-size`.

- Place the metrics bar between the header and body in the widget DOM structure so it remains visible when minimized (`.dc-body` is hidden on minimize, but `.dc-metrics-bar` sits outside it).

- After appending the widget to the DOM, start two intervals:
  1. A 1-second interval that updates only the duration span using `formatDuration(Date.now() - Date.parse(sessionStartTime))`. Initially shows "< 1s" until the first metrics response provides `startTime`.
  2. A 2-second interval that sends `GET_SESSION_METRICS` and updates event count, screenshot count, and size spans. If `isOverSizeThreshold` returns true, add `.dc-metrics-warning` class to the size span; otherwise remove it. Also updates `sessionStartTime` from the response.

- Fire an immediate `GET_SESSION_METRICS` request on mount (before the first interval tick) to populate initial values and get the `startTime`.

- Wrap the `chrome.runtime.sendMessage` call in the polling interval with try/catch (service worker may be momentarily unavailable).

- In `hideWidget()`, clear both intervals and reset `sessionStartTime`:
  ```typescript
  if (durationInterval) { clearInterval(durationInterval); durationInterval = null; }
  if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null; }
  sessionStartTime = null;
  ```

**Step 6: Widget Styles**

Add to `src/content/widget.css`:

```css
/* -- Metrics bar -- */

.dc-metrics-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  font-size: 11px;
  color: #6b7280;
  border-bottom: 1px solid #e5e7eb;
  font-variant-numeric: tabular-nums;
}

.dc-metrics-bar span {
  white-space: nowrap;
}

.dc-metrics-sep {
  color: #d1d5db;
}

.dc-metrics-warning {
  color: #d97706;
  font-weight: 600;
}
```

---

### Definition of Done (Final)

- [ ] Pure metric functions are implemented: `computeSessionMetrics`, `formatDuration`, `formatBytes`, `isOverSizeThreshold`
- [ ] `formatDuration` handles edge cases: negative, 0ms, sub-second, seconds, minutes, hours
- [ ] `formatBytes` handles edge cases: NaN, negative, 0 bytes, KB, MB, GB ranges
- [ ] `computeSessionMetrics` accurately estimates size from events array and screenshots map
- [ ] Size warning threshold is configurable via constant (`SIZE_WARNING_BYTES`), not hardcoded in UI
- [ ] Widget displays elapsed duration updating every second while recording
- [ ] Widget displays event count and screenshot count, refreshed every 2 seconds
- [ ] Widget displays estimated session size in human-readable format
- [ ] Widget shows a visual warning when estimated size exceeds 50 MB
- [ ] Metrics bar remains visible when widget is minimized
- [ ] Duration timer and metrics polling intervals are cleaned up in `hideWidget()` (no leaks)
- [ ] All pure helper functions have unit tests with comprehensive edge case coverage
- [ ] `make typecheck` passes with no errors
- [ ] `make test` passes (all existing + new tests)
- [ ] No new npm dependencies
- [ ] Follows existing naming conventions (`.dc-` CSS prefix, SCREAMING_SNAKE constants, camelCase functions)

### Test Level Matrix (Final)

| # | Acceptance Criterion | Test Level | Rationale |
|---|---------------------|-----------|-----------|
| 1 | `formatDuration` handles all duration ranges and edge cases | Unit | Pure function, no deps, many boundary values |
| 2 | `formatBytes` handles all size ranges and edge cases | Unit | Pure function, no deps, many boundary values |
| 3 | `computeSessionMetrics` returns accurate counts and size estimate | Unit | Pure computation over plain data structures |
| 4 | `isOverSizeThreshold` triggers correctly at boundary | Unit | Trivial pure comparison, but explicit test locks behavior |
| 5 | Size warning threshold is configurable via constant | Unit | Verify `isOverSizeThreshold` uses the passed threshold, not a hardcoded value |
| 6 | Duration timer cleanup on hide (no leaks) | Manual | Content script timer lifecycle requires real Chrome extension context; no jsdom equivalent for `chrome.runtime.sendMessage` |
| 7 | Metrics polling cleanup on hide | Manual | Same as above -- Chrome extension messaging boundary |
| 8 | Metrics bar visible when minimized | Manual | Visual/DOM structure verification in Chrome; widget uses closed Shadow DOM |
| 9 | Widget shows warning at 50 MB | Unit | Threshold logic tested via `isOverSizeThreshold`; visual presentation verified manually |
| 10 | No type errors | Build | `make typecheck` |
| 11 | All tests pass | Build | `make test` |

**Rules applied:**
- Default to **unit tests** -- all four pure functions are ideal unit test targets
- No integration tests needed -- the `GET_SESSION_METRICS` handler is a thin glue layer (read storage, call pure function, return result) following the exact same pattern as `GET_SESSION_STATE`. The project convention is "Chrome API integration: tested manually via extension load."
- No e2e tests -- no automated e2e infrastructure exists for this Chrome extension; manual verification covers the visual and lifecycle concerns
- Each criterion maps to exactly ONE level
- **All tests are deterministic** -- fixed inputs, no timers, no Chrome APIs in tests

### Testing Strategy (Final)

- **Unit** (`src/lib/session-metrics.test.ts`):
  - `formatDuration`: ~10 cases covering negative, 0, sub-second, seconds, minutes, hours, very large values
  - `formatBytes`: ~9 cases covering NaN, negative, 0, sub-KB, KB, MB, GB boundaries
  - `computeSessionMetrics`: ~4 cases covering empty session, events-only, screenshots-only, mixed session with size verification
  - `isOverSizeThreshold`: 3 cases (below, at, above)
  - Total: ~26 test cases, all deterministic with fixed inputs

- **Integration**: None automated. The service worker handler follows the identical pattern of `GET_SESSION_STATE` (read storage, compute, return). Manual verification via extension load.

- **E2E**: None automated. Manual test protocol:
  1. Load extension, start session, verify "< 1s", "0 events", "0 screenshots", "0 KB" appear
  2. Wait, verify duration ticks every second
  3. Click around, verify event count updates within 2 seconds
  4. Take screenshot, verify screenshot count updates
  5. Minimize widget, verify metrics bar remains visible
  6. Accumulate data, verify size estimate grows
  7. Stop session, verify no console errors (interval cleanup)

### Risk Mitigations (Final)

1. **Timer leak on session stop or page navigation**: Both intervals are cleared in `hideWidget()`. Content script timers are also automatically killed by the browser when the page unloads (defense in depth). The `hideWidget` function already handles cleanup for the element picker; the interval cleanup follows the same pattern.

2. **Storage read frequency (2-second polling)**: `chrome.storage.local.get` is fast for in-memory reads. The same data is already read on every `appendEvent` call, so 2-second reads add negligible overhead. If profiling shows issues in the future, a running counter optimization can be added without changing the interface.

3. **Size estimation accuracy**: `JSON.stringify(events).length` plus screenshot data URL string lengths approximates storage cost. For ASCII-heavy data (which timeline events and base64 data URLs are), this is close to actual bytes. The display uses "~X MB" framing to set user expectations. Precision is not needed.

4. **Service worker disconnected during poll**: The metrics polling wraps `chrome.runtime.sendMessage` in try/catch. If the service worker is momentarily unavailable, the widget shows the last known values. On the next successful poll, it updates.

5. **Duplicate content script injection**: The existing `__deskcheck_loaded__` guard in `index.ts` prevents double initialization, which also prevents duplicate metrics bars and duplicate intervals.

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | N | N | N | N |
| State machine | N | N | N | N |
| Conservation | N | N | N | N |
| Authorization | N | N | N | N |

**Recommendation**: SKIP
**Verification focus**: N/A
**Key invariants**: N/A -- All three planners agree: no concurrency, no state machine complexity, no conservation laws, no authorization. The feature is a read-only UI projection of existing session state.

---

## Orchestrator Handoff

This evaluation is the **final decision** -- no human checkpoint follows. The orchestrator will:
1. Commit all plans to `docs/plans/session-metrics/` for audit trail
2. Use the Test Level Matrix to generate acceptance tests at the correct levels
3. Proceed directly to implementation

**Summary for git commit**:
- Selected plan: Quality (with polling simplification from Speed plan and defensive clamping from Safety plan)
- Key rationale: Clean three-layer separation matches existing codebase patterns; pure computation module enables comprehensive unit testing; polling is simpler than push for an informational display
- Estimated effort: 90 minutes (reduced from Quality's 105 by using polling instead of push)
- Key risks: Timer leaks (mitigated by cleanup in hideWidget), storage read frequency (negligible), size estimation accuracy (acceptable approximation)
- Test levels: 4 unit (26 cases), 0 integration, 0 e2e (manual protocol documented)
