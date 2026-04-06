---
agent: safety-planner
generated: 2026-04-06T00:00:00Z
task_id: session-metrics
perspective: safety
---

# Safety Plan: Session Size and Duration Indicator

## Architecture Impact

**Components affected:**
- `src/content/widget.ts`: Add metrics display row (elapsed time, event count, screenshot count, estimated size, size warning). Must manage a `setInterval` timer for elapsed time and a message listener for push-updated counts/size.
- `src/content/index.ts`: Wire up the metrics update listener and timer lifecycle (start on session begin, stop on session end).
- `src/background/service-worker.ts`: Compute session metrics (event count, screenshot count, estimated byte size) after each mutation, then push updates to the content script tab via `chrome.tabs.sendMessage`.
- `src/lib/session-store.ts`: Add a pure function `estimateSessionBytes()` that calculates approximate byte size from events array length and screenshots map. Also add `getSessionMetrics()` to return counts + size in one call.
- `src/types.ts`: Add new `SESSION_METRICS` message type to the `Message` union for push updates, and a `SessionMetrics` interface.
- `src/constants.ts`: Add `SIZE_WARNING_BYTES` threshold constant (50 MB) and `METRICS_PUSH_THROTTLE` interval.

**New patterns or abstractions introduced:**
- **Service-worker-to-content push messaging**: The widget currently has no mechanism to receive push updates. This feature introduces a pattern where the service worker proactively sends `SESSION_METRICS` messages to the active tab after each `appendEvent` or `storeScreenshot`. This is a new communication direction for the extension.
- **Timer-managed UI in widget**: The elapsed duration ticker introduces a `setInterval` inside the content script widget. This is a new lifecycle concern -- the timer must be cleaned up on session stop or widget hide to avoid leaks.
- **Pure size estimation function**: A testable pure function that estimates byte sizes from data structures without touching Chrome APIs.

**Dependencies added or modified:**
- None -- this change is additive and uses only existing Chrome extension APIs (`chrome.tabs.sendMessage`, `setInterval`).

**Breaking changes to existing interfaces:**
- None -- this change is additive only. The `Message` union gets new variants, which is a non-breaking union extension in TypeScript.

**Risk points in architecture this task touches:**
- **`appendEvent()` read-modify-write**: Currently reads the full events array, appends, and writes back. Adding a size estimation step here means more computation per event. If size estimation is expensive (e.g., `JSON.stringify` on every append), it could slow down high-frequency event recording.
- **Service worker lifecycle**: Manifest V3 service workers can be killed by Chrome after ~30 seconds of inactivity. The metrics push relies on the service worker being alive when events arrive -- but this is already the case since events only arrive during active recording.
- **Content script message listener**: Adding a listener in the content script for `SESSION_METRICS` messages. If the content script gets injected multiple times (duplicate injection guard exists but is worth verifying), we could get duplicate UI updates.
- **Widget closed Shadow DOM**: The metrics display is inside a closed Shadow DOM, so there is no risk of host page CSS interference, but we need to manage references carefully since there is no `querySelector` escape hatch.

## Risk Assessment

### Identified Risks
| Risk | Severity | Likelihood | Impact | Mitigation |
|------|----------|------------|--------|------------|
| Timer leak on session stop | Medium | Medium | Memory leak, stale UI updates on orphaned pages | Clear interval in `hideWidget()` and in `stopSession()` path. Store interval ID in module scope so it is always reachable for cleanup. |
| Size estimation performance on large sessions | Medium | Medium | Sluggish recording if JSON.stringify runs on every event append | Use incremental byte tracking: accumulate a running total instead of recomputing from scratch. Only JSON.stringify new events, add their length to a counter. |
| Service worker killed mid-push | Low | Low | Missed metrics update; widget shows stale data | Widget already shows elapsed time from its own timer. Counts/size being slightly stale is acceptable. On next event, SW wakes and pushes again. |
| Duplicate content script injection | Low | Low | Multiple timers, doubled metrics rows in UI | Existing `__deskcheck_loaded__` guard prevents this. Verify guard covers the new metrics listener registration. |
| Size estimate diverges from actual storage | Medium | Medium | User sees misleading size, either false alarm or missed warning | Document that estimate is approximate. Use `new Blob([JSON.stringify(x)]).size` for accurate UTF-8 byte count in the estimation function, but only on the delta, not the full payload each time. |
| Message sending to closed/navigated tab fails | Low | Medium | Uncaught error in service worker | Wrap `chrome.tabs.sendMessage` in try/catch (pattern already used in codebase). |
| Widget UI overflow with metrics row | Low | Low | Layout breaks on narrow viewports | Keep metrics row compact, test at minimum widget width (320px). |
| Future OPFS migration breaks size estimate | Medium | Low | Feature #5 changes storage backend; size estimation tied to chrome.storage.local | Design `estimateSessionBytes()` as a pure function that takes event count + screenshot data lengths as inputs, not coupled to any storage backend. |

### Failure Modes Analysis
1. **Timer not cleared on navigation/tab close**
   - Cause: Page navigates away while widget is showing; `hideWidget()` not called
   - Detection: Memory profiling; console logs from orphaned intervals
   - Recovery: Use `beforeunload` listener as a safety net to clear the interval. Also, `setInterval` in a content script is automatically killed when the page unloads, so this is a defense-in-depth measure.

2. **Size estimation returns NaN or negative**
   - Cause: Corrupted storage data, unexpected input types
   - Detection: Unit tests with edge cases (empty arrays, undefined values, non-string screenshot data)
   - Recovery: Clamp to 0, display "~0 MB" rather than broken text. Pure function makes this fully testable.

3. **Metrics push message arrives before widget is ready**
   - Cause: Race between service worker sending SESSION_METRICS and content script mounting the widget
   - Detection: Widget shows 0 counts initially despite events existing
   - Recovery: Widget requests initial metrics via a `GET_SESSION_METRICS` message on mount (pull model as supplement to push). This covers the startup race.

4. **High-frequency events overwhelm message channel**
   - Cause: Scroll events (throttled to 1s) or rapid CDP events trigger metrics push on every append
   - Detection: Chrome task manager shows high CPU in content script
   - Recovery: Throttle metrics push to at most once per second (METRICS_PUSH_THROTTLE constant). Batch updates.

### Blast Radius
- **Affected users**: All users during active recording sessions. When not recording, zero impact -- no timers, no listeners active.
- **Affected systems**: Widget overlay only. No changes to export format, session storage schema, or any external contracts. The popup is unaffected.
- **Data at risk**: None. This feature is read-only with respect to session data. It estimates size but does not modify, truncate, or delete anything. The warning is purely informational.

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 1 | Add `SessionMetrics` type and new message variants to `types.ts`, add constants to `constants.ts` | `make typecheck` passes. Existing tests pass. | Revert types.ts and constants.ts changes (union extension is safe to remove). |
| 2 | Implement pure `estimateSessionBytes()` and `getSessionMetrics()` in `session-store.ts`. Write unit tests for the pure estimation function. | Unit tests pass for all edge cases (0 events, 0 screenshots, large payloads, malformed input). | Revert session-store.ts changes; pure functions have no side effects. |
| 3 | Add `formatDuration()` and `formatBytes()` pure formatting helpers (new file `src/lib/format-utils.ts`). Write unit tests. | Unit tests pass. `make typecheck`. | Delete new file. |
| 4 | Modify service worker to compute and push `SESSION_METRICS` to the active tab after `appendEvent` and `storeScreenshot`. Throttle to 1 push/second. | `make typecheck`. Manual test: verify messages appear in content script console. Verify no errors when tab is closed. | Revert service-worker.ts changes. Push is fire-and-forget; removing it has no data impact. |
| 5 | Add metrics display row to widget UI (`widget.ts`) and styles (`widget.css`). Add elapsed time timer. Wire up `SESSION_METRICS` listener. | `make typecheck`. Manual test: verify metrics appear, timer ticks, layout is correct, minimize still works. | Revert widget.ts and widget.css changes. Widget returns to previous state. |
| 6 | Add size warning visual (amber/red text when exceeding threshold). | Manual test: simulate large session, verify warning appears at threshold. | Remove warning CSS class and conditional. |
| 7 | Add `GET_SESSION_METRICS` request/response handler for pull-on-mount. | Manual test: reload page mid-session, verify metrics populate immediately. | Revert; widget starts with zeroes and updates on next event. Graceful degradation. |
| 8 | Full integration test: start session, take screenshots, add annotations, verify metrics update live and warning triggers. | End-to-end manual test in Chrome. | Full revert to pre-feature state via git. |

## Files to Create/Modify
| File | Purpose | Risk Notes |
|------|---------|------------|
| `src/types.ts` | Add `SessionMetrics` interface and `SESSION_METRICS` / `GET_SESSION_METRICS` message variants | Low risk: additive union extension. No existing code breaks. |
| `src/constants.ts` | Add `SIZE_WARNING_BYTES` (50 * 1024 * 1024) and `METRICS_PUSH_THROTTLE` (1000) | Low risk: new constants only. |
| `src/lib/format-utils.ts` (NEW) | Pure `formatDuration(ms)` and `formatBytes(bytes)` helpers | No risk: new file, pure functions, fully testable. |
| `src/lib/format-utils.test.ts` (NEW) | Unit tests for formatting helpers | No risk: test file. |
| `src/lib/session-store.ts` | Add `estimateSessionBytes()` pure function and `getSessionMetrics()` async function | Medium risk: must not break existing `appendEvent`, `storeScreenshot`, etc. Phase 2 safety gate: run all existing tests. |
| `src/lib/session-store.test.ts` (NEW) | Unit tests for `estimateSessionBytes()` | No risk: test file. |
| `src/background/service-worker.ts` | Add metrics computation after `appendEvent`/`storeScreenshot`; throttled push via `chrome.tabs.sendMessage`; handle `GET_SESSION_METRICS` | Medium risk: touches the hot path (event recording). Throttle mitigates performance impact. Wrap send in try/catch. |
| `src/content/widget.ts` | Add metrics display row, elapsed timer, `SESSION_METRICS` listener, size warning | Medium risk: modifies the only user-facing UI. Must not break existing annotation/screenshot/stop flows. |
| `src/content/widget.css` | Add styles for metrics row, size warning states | Low risk: additive CSS. Scoped to Shadow DOM, no leakage. |
| `src/content/index.ts` | Register `SESSION_METRICS` message listener; lifecycle cleanup | Low risk: additive listener in existing message handler switch. |

## Definition of Done
- [ ] All identified risks have mitigations in place
- [ ] Elapsed duration updates every second with "Xm Ys" format
- [ ] Event count and screenshot count display and update on each new event
- [ ] Estimated session size displays in human-readable format (KB/MB)
- [ ] Warning appears when size exceeds 50 MB threshold
- [ ] Timer is cleaned up on session stop and widget hide (no leaks)
- [ ] Metrics push is throttled (no performance regression on high-frequency events)
- [ ] Widget layout is intact: minimize, annotation, screenshot, stop all still work
- [ ] `GET_SESSION_METRICS` pull-on-mount populates metrics immediately after page reload mid-session
- [ ] Error handling verified for all failure modes (closed tab, missing data, NaN)
- [ ] Edge cases explicitly tested (0 events, huge sessions, rapid events)
- [ ] Tests pass (`make test`)
- [ ] No type errors (`make typecheck`)

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `formatDuration(ms)` returns correct "Xm Ys" strings | Unit | Pure function, isolated, many edge cases (0s, 59s, 60s, 3661s) |
| 2 | `formatBytes(bytes)` returns correct "X.X MB" / "X KB" strings | Unit | Pure function, isolated |
| 3 | `estimateSessionBytes()` returns accurate byte estimates | Unit | Pure function taking counts + lengths, testable without Chrome APIs |
| 4 | Size warning triggers at exactly 50 MB threshold | Unit | Threshold comparison is pure logic |
| 5 | Timer cleanup on widget hide | Unit (jsdom) | DOM lifecycle, can verify with jsdom that clearInterval is called |
| 6 | Metrics push throttling | Unit | Throttle logic is testable with fake timers |
| 7 | `GET_SESSION_METRICS` handler returns correct shape | Integration | Tests message handler boundary in service worker |
| 8 | Metrics update end-to-end during recording | Manual/E2E | Full Chrome extension flow, cannot be automated without Chrome extension test harness |
| 9 | Widget layout integrity (minimize, buttons, metrics row) | Manual | Visual verification in Chrome |
| 10 | Error handling for closed tab / missing data | Unit | Edge cases in pure functions + try/catch verification |

**Safety planner bias**: The size estimation and formatting are pure functions that carry most of the testable logic -- unit tests give high confidence cheaply. The message-passing boundary (service worker to content script) is where integration risk lives, but Chrome extension messaging cannot be realistically integration-tested without a Chrome test harness. Manual testing covers this gap.

**Determinism rule**: All proposed tests use fixed inputs and deterministic assertions. No live API calls. Timer tests use `vi.useFakeTimers()`.

## Testing Strategy (Comprehensive)

### Unit Tests
- `formatDuration(0)` returns "0s"
- `formatDuration(5000)` returns "5s"
- `formatDuration(65000)` returns "1m 5s"
- `formatDuration(3600000)` returns "60m 0s" (no hour display for sessions)
- `formatBytes(0)` returns "0 KB"
- `formatBytes(1024)` returns "1.0 KB"
- `formatBytes(1048576)` returns "1.0 MB"
- `formatBytes(52428800)` returns "50.0 MB"
- `estimateSessionBytes([], {})` returns 0 (or minimal baseline)
- `estimateSessionBytes(events, screenshots)` returns reasonable estimate
- `estimateSessionBytes` with large screenshot data URLs returns proportional size
- **Edge cases**:
  - `formatDuration(-1)` clamps to "0s"
  - `formatBytes(NaN)` returns "0 KB"
  - `estimateSessionBytes` with undefined/null inputs does not throw
  - `estimateSessionBytes` with non-string values in screenshots map

### Integration Tests
- Service worker `handleMessage` with `GET_SESSION_METRICS` returns `SessionMetrics` shape with correct counts after events are appended (requires mocking `chrome.storage.local`)
- Metrics push is throttled: multiple rapid `appendEvent` calls result in at most 1 push per second

### E2E Tests
- **Manual test protocol** (documented, not automated):
  1. Load extension, start session
  2. Verify "0s" and "0 events" appear in widget
  3. Click around, verify event count increments
  4. Take screenshot, verify screenshot count increments
  5. Wait 10 seconds, verify elapsed time shows "10s"
  6. Reload page, verify metrics repopulate (pull-on-mount)
  7. Stop session, verify timer stops and widget hides cleanly

**E2E Test Impact**:
- **Existing e2e tests affected**: None -- no automated e2e tests exist currently.
- **New e2e tests needed**: None automated. Manual test protocol documented above.
- **Cost note**: Chrome extension e2e testing requires Puppeteer with extension loading, which is not set up. Manual testing is the pragmatic choice.

### Regression Tests
- All existing tests in `src/lib/exporter.test.ts` pass (export format unchanged)
- All existing tests in `src/lib/debugger-client.test.ts` pass (CDP handling unchanged)
- All existing tests in `src/lib/dom-utils.test.ts` pass (DOM utilities unchanged)
- `appendEvent` behavior unchanged (verify existing session-store contract)

### Load/Stress Tests (if applicable)
- Not applicable for unit/integration tests, but manual stress test: generate 500+ events rapidly (scroll spam) and verify widget remains responsive and metrics push does not cause jank. Threshold: widget UI should not lag more than 100ms behind actual event count.

**Test files to create/modify**:
- `src/lib/format-utils.test.ts` (NEW)
- `src/lib/session-store.test.ts` (NEW -- for `estimateSessionBytes` pure function only)

## Rollback Strategy

### Trigger Conditions
When to rollback:
- Widget UI becomes unresponsive or layout is broken during recording
- Timer leak detected (CPU usage stays elevated after session stops)
- Event recording throughput drops noticeably (user reports sluggish recording)
- Chrome console shows uncaught errors from metrics push path

### Rollback Steps
1. `git revert <commit>` -- all changes are in a single feature branch / commit set
2. `make build` and reload extension from `dist/`
3. Verify existing recording/annotation/export flow works

### Verification After Rollback
- [ ] Start session, record events, add annotation, take screenshot, stop & download -- all work
- [ ] No console errors from DeskCheck
- [ ] Widget shows original layout without metrics row
- [ ] No lingering timers or listeners (check Chrome task manager)

### Rollback Tested?
- [ ] No, but rollback is trivial: `git revert` + `make build`. The feature is purely additive with no schema changes, no data migrations, and no external API contracts.

## Monitoring & Alerting

### Metrics to Watch
| Metric | Normal Range | Alert Threshold |
|--------|--------------|-----------------|
| Content script CPU (Chrome task manager) | < 1% idle, < 5% during recording | > 10% sustained during recording |
| Service worker wake frequency | Per-event during recording | N/A (no change expected) |
| Widget render time | < 16ms per frame | > 50ms per frame (jank visible) |

### Alerts to Configure
- Not applicable for a Chrome extension with no server-side component. Monitoring is manual via Chrome DevTools and task manager.

## Deployment Recommendations

- [ ] **Feature flag**: Not needed -- Chrome extensions do not have runtime feature flags. The feature is purely additive UI and can be rolled back by reverting the commit and rebuilding.
- [ ] **Gradual rollout**: Not needed -- this is a developer tool with manual installation, not a store-distributed extension.
- [x] **Staging verification**: Required -- manual testing with the extension loaded unpacked before any distribution.
- [ ] **Off-hours deployment**: Not needed -- developer tool, no production users at risk.

## Estimated Effort
- Planning: Already done
- Implementation: 90 minutes
  - Phase 1 (types + constants): 10 min
  - Phase 2 (size estimation + tests): 20 min
  - Phase 3 (format utils + tests): 15 min
  - Phase 4 (service worker push): 15 min
  - Phase 5-6 (widget UI + warning): 20 min
  - Phase 7 (pull-on-mount): 10 min
- Safety verification: 15 minutes (manual testing protocol)
- Testing: 30 minutes (unit tests + manual regression)
- **Total**: 135 minutes

## Formal Verification Assessment
- Concurrency concerns: No -- single-threaded JS in both service worker and content script. No shared mutable state between concurrent actors. The only "race" is message ordering, which is benign (stale metrics are acceptable).
- State machine complexity: No -- the session lifecycle (idle -> recording -> stopped) is already managed elsewhere and unchanged. The metrics display is a pure projection of state, not a state machine itself.
- Conservation laws: No -- the size estimate is informational, not a balance or invariant that must be conserved.
- Authorization model: No -- no access control changes.
- Recommendation: Formal verification not needed. The feature is a read-only UI projection of existing session state with no concurrency, no state transitions, and no conservation invariants.

## Security Considerations
- [x] No secrets in code -- feature only reads event counts and screenshot sizes
- [x] Input validation complete -- `formatDuration` and `formatBytes` clamp invalid inputs; `estimateSessionBytes` handles missing/undefined gracefully
- [x] Output encoding where needed -- all text is inserted via `textContent` (not `innerHTML`), no XSS risk
- [x] Authentication/authorization verified -- N/A, local extension with no auth
- [x] OWASP top 10 considered -- no network endpoints, no user input processed, no injection vectors. The size estimate reads data already in `chrome.storage.local` which is same-origin isolated.

## Implementation Notes

### Key Design Decision: Incremental vs. Full Recomputation for Size

The safest approach for size estimation is **incremental tracking with a running byte counter** rather than re-serializing the full events array on every append. Here is why:

1. `appendEvent()` already does a read-modify-write of the full events array. Adding `JSON.stringify(events).length` on top would double the serialization cost, which is O(n) in event count.
2. Instead, maintain a running `estimatedBytes` counter in the service worker's in-memory state. On each `appendEvent`, add `JSON.stringify(newEvent).length`. On each `storeScreenshot`, add `dataUrl.length`. This is O(1) per operation.
3. The counter resets on session start and can be bootstrapped from storage on service worker wake (by reading current events + screenshots once).
4. This design is also OPFS-friendly (Feature #5): the estimation function takes numeric inputs (count, total bytes) rather than being coupled to `chrome.storage.local` data shapes.

### Key Design Decision: Pull + Push Model

The widget uses a hybrid approach:
- **Push**: Service worker sends `SESSION_METRICS` after each mutation (throttled). This keeps the display live during active recording.
- **Pull**: Widget sends `GET_SESSION_METRICS` on mount. This covers the startup race (widget mounts before any push arrives) and the page-reload-mid-session scenario.

This is more resilient than push-only (which misses the startup race) or pull-only (which would require polling and waste resources).

### Key Design Decision: Timer Ownership

The elapsed duration timer lives in the **content script widget**, not the service worker. The widget knows the session start time (received via pull-on-mount) and computes elapsed time locally with `setInterval(fn, 1000)`. This avoids:
- Service worker sending 1 message/second (wasteful, would keep SW alive unnecessarily)
- Timer drift between SW clock and content script clock
- Additional message handling complexity

The content script timer is a simple `Date.now() - startTime` computation, immune to clock drift within a single page lifecycle.
