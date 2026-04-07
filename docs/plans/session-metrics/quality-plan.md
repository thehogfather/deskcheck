---
agent: quality-planner
generated: 2026-04-06T00:00:00Z
task_id: session-metrics
perspective: quality
---

# Quality Plan: Session Size and Duration Indicator

## Architecture Impact

**Components affected:**
- `src/lib/` (new module): Pure metrics computation logic — `session-metrics.ts`
- `src/background/service-worker.ts`: New message type handler for `GET_SESSION_METRICS`, plus periodic push of metrics to content script
- `src/content/widget.ts`: New UI section to display duration, event/screenshot counts, estimated size, and size warning
- `src/content/widget.css`: Styles for the metrics bar
- `src/types.ts`: New `SessionMetrics` interface and new `Message` union members
- `src/constants.ts`: New constants for size warning threshold and metrics push interval

**New patterns or abstractions introduced:**
- `SessionMetrics` data type: A plain object representing a point-in-time snapshot of session metrics (event count, screenshot count, estimated size in bytes, start time). This follows the existing pattern of data interfaces in `types.ts` and keeps computation separate from transport.
- `computeSessionMetrics()` pure function: Computes metrics from raw data (events array, screenshots map). Follows the existing pattern of `buildSummary()` in `exporter.ts` — testable without Chrome APIs.
- `formatDuration()` and `formatBytes()` pure formatters: Small, testable pure functions for display strings.

**Dependencies added or modified:**
- None — no new npm dependencies. All logic is vanilla TypeScript.

**Breaking changes to existing interfaces:**
- None — this change is additive only. Two new message types are added to the `Message` union; existing message types are unchanged. The widget gains a new UI section but existing layout is preserved.

## Architectural Approach

This feature follows a clean three-layer separation already established in the codebase:

1. **Pure computation** (`src/lib/session-metrics.ts`) — all size estimation, formatting, and threshold logic lives here with zero Chrome API dependencies, enabling comprehensive unit testing.
2. **Service worker coordination** (`src/background/service-worker.ts`) — computes and pushes metrics snapshots to the content script on a periodic interval (every 2 seconds) while recording is active, and on-demand via `GET_SESSION_METRICS` request-response for the initial widget hydration.
3. **Presentation** (`src/content/widget.ts`) — receives metrics snapshots and renders them; manages its own 1-second `setInterval` for the elapsed-time clock using the `start_time` from the metrics snapshot, avoiding per-second cross-context messaging.

The key design decision is **splitting the clock from the data push**. Duration ticking every second is a pure UI concern (derived from `start_time` which rarely changes), so it belongs in the content script. Event counts and size estimates change less frequently and require storage reads, so the service worker pushes those on a 2-second cadence. This minimizes message traffic and storage reads while keeping the clock smooth.

The `computeSessionMetrics` function estimates size by measuring the JSON-serialized length of the events array plus the base64 data URL lengths of screenshots. This gives a faithful representation of the actual storage footprint (chrome.storage.local stores serialized JSON) and translates directly to the future OPFS migration since it measures data size, not quota.

## Files to Create/Modify

| File | Purpose | Quality Considerations |
|------|---------|----------------------|
| `src/lib/session-metrics.ts` | Pure functions: `computeSessionMetrics()`, `formatDuration()`, `formatBytes()`, `isOverSizeThreshold()` | No Chrome API imports. All functions are pure with explicit inputs/outputs. Follow `exporter.ts` pattern. |
| `src/lib/session-metrics.test.ts` | Unit tests for all pure functions | Cover edge cases: 0 events, 0 screenshots, exactly-at-threshold, large sizes, sub-second durations, negative durations (clock skew). |
| `src/types.ts` | Add `SessionMetrics` interface and two new `Message` variants | Additive-only change; maintain alphabetical ordering within the union. |
| `src/constants.ts` | Add `SIZE_WARNING_BYTES` (50 MB) and `METRICS_PUSH_INTERVAL` (2000ms) | Follow existing naming convention (SCREAMING_SNAKE_CASE). |
| `src/background/service-worker.ts` | Add `GET_SESSION_METRICS` handler; add periodic metrics push via `setInterval` started/stopped alongside recording lifecycle | Interval cleanup on stop/tab-close to prevent leaks. Use existing `getEvents`/`getScreenshots` from session-store. |
| `src/content/widget.ts` | Add metrics bar UI between header and body; start a 1-second `setInterval` for elapsed time display; listen for `SESSION_METRICS` push messages | Interval cleanup in `hideWidget()`. Use existing `el()` helper for DOM construction. |
| `src/content/widget.css` | Add `.dc-metrics-bar` styles (compact row with counters, muted text, warning state) | Follow existing naming convention (`.dc-` prefix). Consistent sizing with header. |

**Total files**: 7 (1 new source, 1 new test, 5 modified)

## Implementation Steps

1. **Define the data contract** — Add `SessionMetrics` interface and message types to `src/types.ts`, add constants to `src/constants.ts`. Starting with types ensures the compiler catches integration mismatches early. The interface should contain: `startTime: string`, `eventCount: number`, `screenshotCount: number`, `estimatedSizeBytes: number`.

2. **Implement pure computation module** — Create `src/lib/session-metrics.ts` with:
   - `computeSessionMetrics(events: TimelineEvent[], screenshots: Record<string, string>): SessionMetrics` — counts events, counts screenshot keys, estimates size by summing `JSON.stringify(events).length` plus sum of all screenshot data URL lengths (which are stored as-is in chrome.storage.local, so their string length is the storage cost in bytes, roughly 1 byte per char for ASCII/base64).
   - `formatDuration(ms: number): string` — e.g., "3m 42s", "1h 5m 22s", "< 1s" for sub-second.
   - `formatBytes(bytes: number): string` — e.g., "2.4 MB", "850 KB", "1.2 GB".
   - `isOverSizeThreshold(bytes: number, threshold: number): boolean` — trivial but explicit, makes the threshold check testable and the widget code declarative.

   Quality rationale: Pure functions with no side effects are the easiest code to test and reason about. Following the `buildSummary` pattern in `exporter.ts`.

3. **Write unit tests** — Create `src/lib/session-metrics.test.ts` with thorough coverage before wiring anything up. Tests use deterministic inputs only (no timers, no Chrome APIs).

4. **Wire up service worker** — Modify `src/background/service-worker.ts`:
   - Add a module-level `metricsInterval: ReturnType<typeof setInterval> | null` variable.
   - In `START_SESSION` handler, after setting `recording = true`, start a `setInterval` that: reads events and screenshots from session-store, calls `computeSessionMetrics()`, and sends a `SESSION_METRICS` message to `activeTabId` via `chrome.tabs.sendMessage`.
   - In `STOP_SESSION` handler and `tabs.onRemoved` handler, clear the interval.
   - Add `GET_SESSION_METRICS` case to `handleMessage` that does a one-shot read-compute-return.
   - The interval approach means the service worker stays awake during recording (which it already does due to the debugger attachment). The 2-second cadence balances freshness vs. storage read cost.

   Quality rationale: Cleanup is co-located with existing lifecycle code. The interval variable follows the same pattern as `activeTabId`/`activeSessionId` module-level state.

5. **Update widget UI** — Modify `src/content/widget.ts`:
   - Add a metrics bar between the header and body sections. The bar contains four items in a single row: duration, events count, screenshots count, estimated size. Use the existing `el()` helper.
   - On `showWidget()`, request initial metrics via `GET_SESSION_METRICS` message to populate the bar immediately.
   - Start a 1-second `setInterval` that updates only the duration text using `formatDuration(Date.now() - Date.parse(startTime))`. Store the `startTime` from the initial metrics response and update it if a `SESSION_METRICS` push arrives.
   - Listen for `SESSION_METRICS` push messages (via `chrome.runtime.onMessage`) to update event count, screenshot count, and size. Apply/remove a `.dc-metrics-warning` class when `isOverSizeThreshold()` returns true.
   - Clear the duration interval in `hideWidget()`.
   - When minimized, the metrics bar should remain visible (it is useful context even when the annotation form is hidden). This means it sits outside `.dc-body` in the DOM.

   Quality rationale: Separating the duration timer (content-script-local) from the data push (service-worker) keeps message traffic low. The metrics bar placement outside `.dc-body` means the existing `.dc-widget.minimized .dc-body { display: none }` rule naturally hides the form while preserving the metrics.

6. **Style the metrics bar** — Add CSS to `src/content/widget.css`:
   - `.dc-metrics-bar`: Horizontal flex row in the header area, muted `#6b7280` text, `11px` font, with subtle separators between items.
   - `.dc-metrics-warning`: Amber/orange styling for the size value when threshold is exceeded (e.g., `#d97706` text color, optional subtle background tint).
   - Ensure the bar works well with the existing minimized state.

   Quality rationale: Follow existing `.dc-` prefix convention. Use the same color palette already in the CSS (grays from Tailwind scale).

7. **Integration verification** — Manually test in Chrome extension load (no automated e2e tests needed for this iteration):
   - Start session, verify metrics bar appears with "< 1s", "0 events", "0 screenshots", "0 KB".
   - Wait, verify duration ticks. Take screenshots, add annotations, verify counts update within 2 seconds.
   - Accumulate data, verify size estimate grows.
   - Minimize widget, verify metrics bar remains visible.
   - Stop session, verify no interval leaks (no console errors after stop).

## Definition of Done

- [ ] All pure metric functions are implemented and unit-tested with >90% branch coverage
- [ ] `formatDuration` handles edge cases: 0ms, sub-second, minutes, hours, large values
- [ ] `formatBytes` handles edge cases: 0 bytes, KB, MB, GB ranges
- [ ] `computeSessionMetrics` accurately reflects events array and screenshots map sizes
- [ ] Size warning threshold is configurable via constant, not hardcoded in UI logic
- [ ] Duration timer interval is cleaned up on `hideWidget()` (no leaks)
- [ ] Service worker metrics push interval is cleaned up on session stop and tab close
- [ ] Widget metrics bar is visible when minimized
- [ ] No type errors (`make typecheck` passes)
- [ ] No linting warnings
- [ ] All existing tests continue to pass (`make test`)
- [ ] Follows existing naming conventions (`.dc-` CSS prefix, SCREAMING_SNAKE constants, camelCase functions)
- [ ] No new npm dependencies

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Pure metric functions implemented and unit-tested | Unit | Pure logic with no side effects — ideal unit test target |
| 2 | `formatDuration` edge cases | Unit | Pure string formatting, isolated |
| 3 | `formatBytes` edge cases | Unit | Pure string formatting, isolated |
| 4 | `computeSessionMetrics` accuracy | Unit | Pure computation over data structures |
| 5 | Size warning threshold configurable | Unit | Test `isOverSizeThreshold` with constant |
| 6 | Duration timer cleanup | Unit | Can verify with jsdom + fake timers — check interval cleared |
| 7 | Service worker interval cleanup | Integration | Requires mocking chrome.tabs/storage boundary; tests lifecycle coordination |
| 8 | Widget metrics bar visible when minimized | Unit (jsdom) | DOM structure test — verify element is outside `.dc-body` |
| 9 | No type errors | Unit | `make typecheck` in CI |
| 10 | Existing tests pass | Unit | `make test` regression check |

**Quality planner bias**: All testable logic is pure and belongs at the unit level. The service worker lifecycle is the only true integration boundary, and even that can be tested with mocked chrome APIs if desired — but manual verification is acceptable for this iteration given the codebase's stated approach ("Chrome API integration: tested manually via extension load").

**Determinism rule**: All proposed tests use fixed inputs. No timers, no live APIs. Duration formatting tests use explicit millisecond values. Size computation tests use known string lengths.

## Testing Strategy

- **Unit**: Comprehensive coverage of `src/lib/session-metrics.ts`:
  - `formatDuration`: 0ms -> "< 1s", 500ms -> "< 1s", 1000ms -> "0m 01s", 62000ms -> "1m 02s", 3723000ms -> "1h 02m 03s", very large values
  - `formatBytes`: 0 -> "0 KB", 512 -> "0.5 KB", 1048576 -> "1.0 MB", 52428800 -> "50.0 MB", 1073741824 -> "1.0 GB"
  - `computeSessionMetrics`: empty session (0 events, {} screenshots), session with events only, session with screenshots only, mixed session, verify screenshot size estimation from data URL string length
  - `isOverSizeThreshold`: below, at, above threshold

- **Integration**: Manual verification of service-worker-to-content-script metrics push (follows existing project convention for Chrome API integration testing).

- **E2E**: None required — this is not a critical user journey that could silently break. It is additive UI with no data mutation.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: None (no e2e tests exist in this project)
- **New e2e tests needed**: None — the metrics display is informational and does not gate any user action. Manual verification is sufficient for this iteration.
- **Cost note**: N/A

**Test files to create/modify**:
- Create: `src/lib/session-metrics.test.ts`

**Coverage target**: 95% for `src/lib/session-metrics.ts` (all branches of formatting and computation functions)

## Code Quality Checklist

- [x] Follows SOLID principles where applicable — Single Responsibility: metrics computation is separated from transport and rendering
- [x] No code duplication (DRY) — formatters are shared between widget display; `computeSessionMetrics` centralizes estimation logic rather than duplicating it in widget and service worker
- [x] Clear naming (variables, functions, files) — `SessionMetrics`, `formatDuration`, `formatBytes`, `isOverSizeThreshold`, `METRICS_PUSH_INTERVAL`, `SIZE_WARNING_BYTES`
- [x] Appropriate abstraction level — one module with four small functions, no class hierarchy, no framework
- [x] Error handling is comprehensive — `GET_SESSION_METRICS` returns sensible defaults if session is missing; metrics push silently no-ops if tab is gone
- [x] Types are properly defined (no `any`) — `SessionMetrics` interface, typed message variants
- [x] Edge cases are handled — sub-second duration, zero events, zero screenshots, enormous size values
- [x] Logging/monitoring where appropriate — no logging needed for pure formatters; service worker uses existing `console.error` pattern for send failures

## Patterns to Apply

| Pattern | Where | Why |
|---------|-------|-----|
| Pure computation module | `src/lib/session-metrics.ts` | Follows `exporter.ts` / `buildSummary` pattern — testable without mocks |
| Data interface in `types.ts` | `SessionMetrics` type | Follows existing convention for all data shapes |
| Constants in `constants.ts` | Threshold and interval values | Follows existing convention for tunable values |
| `el()` helper for DOM | Metrics bar construction in widget | Follows existing widget DOM creation pattern |
| Module-level interval state | Service worker `metricsInterval` | Follows `activeTabId` / `recording` pattern for lifecycle state |
| Message-based communication | `SESSION_METRICS` push, `GET_SESSION_METRICS` request | Follows existing `SESSION_STARTED` / `GET_SESSION_STATE` pattern |

## Impact Assessment

**Positive Impacts:**
- Users gain real-time visibility into session size, helping them manage recording scope before hitting storage limits
- Clean separation of pure computation from Chrome APIs improves testability and sets a pattern for future metrics (e.g., feature #5 OPFS migration can reuse `computeSessionMetrics` to show size on the new backend)
- Duration display provides session awareness without checking the clock externally

**Neutral** (what stays the same):
- Export schema (`session.json`) is unchanged — metrics are runtime-only, not persisted
- Storage layout is unchanged — no new storage keys
- `appendEvent` read-modify-write pattern is unchanged (metrics are read-only consumers)
- Existing message types and their handlers are unmodified

**Risks:**
- **Service worker wakefulness**: The 2-second interval could theoretically extend service worker lifetime, but this is moot because the debugger attachment already keeps it alive during recording. Mitigation: interval is always cleared on session stop.
- **Storage read frequency**: Reading the full events array and screenshots map every 2 seconds adds I/O. Mitigation: `chrome.storage.local.get` is fast for in-memory reads; the same data is already read on every `appendEvent` call, so this is not a new bottleneck. If profiling shows issues, a future optimization can maintain running counters instead of re-reading (but YAGNI for now).
- **Size estimation accuracy**: `JSON.stringify(events).length` counts UTF-16 code units, not bytes. For ASCII-heavy data (which timeline events are), this is close to the actual byte count. Base64 screenshot data URLs are pure ASCII so string length equals byte count. The estimate may slightly undercount for events containing unicode text in annotations. Mitigation: this is an estimate displayed as "~X MB"; precision to the byte is not needed.

## Estimated Effort

- Planning: Already done
- Implementation: 60 minutes
- Testing: 30 minutes
- Review prep: 15 minutes
- **Total**: 105 minutes

## Technical Debt Addressed

- **No new debt introduced.** The pure-function approach avoids the common pitfall of embedding business logic in Chrome API callbacks.
- **Minor existing debt noted but not addressed**: `appendEvent()` does a full read-modify-write of the events array on every call. A future optimization could maintain a running event count and cumulative size estimate as metadata alongside the events, eliminating the need for the metrics push to re-read the full array. This is a separate concern (feature #5 / OPFS migration) and out of scope here.

## Formal Verification Assessment

- Concurrency concerns: No — single-threaded event loop in both service worker and content script. Message passing is sequential. No shared mutable state across contexts (metrics are read-only snapshots).
- State machine complexity: No — recording lifecycle is simple (idle -> recording -> idle) and already exists. This feature adds no new states.
- Conservation laws: No — metrics are derived/computed values, not conserved quantities.
- Authorization model: No — no access control involved.
- Recommendation: Formal verification not needed.

## Future Extensibility

- **OPFS migration (feature #5)**: The `computeSessionMetrics` function takes `events` and `screenshots` as plain data inputs. When storage moves to OPFS, the service worker simply reads from the new backend and passes the same data shapes. The pure function is storage-agnostic.
- **Running counters optimization**: If storage reads become expensive with OPFS or very large sessions, the service worker can maintain in-memory counters (incrementing on each `appendEvent` / `storeScreenshot` call) and pass those to `computeSessionMetrics` as pre-computed counts, avoiding full reads. The metrics interface and widget code would not change.
- **Additional metrics**: The `SessionMetrics` interface can be extended with new fields (e.g., `errorCount`, `warningCount`) without breaking existing consumers — the widget simply adds new display elements.
- **Metrics history / sparklines**: Because metrics are pushed as snapshots, a future widget enhancement could buffer the last N snapshots to render a size-growth sparkline. The push architecture supports this without changes to the service worker.
