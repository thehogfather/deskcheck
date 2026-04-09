---
agent: speed-planner
generated: 2026-04-08T00:00:00Z
task_id: feature-11
perspective: speed
---

# Speed Plan: Feature #11 — Side panel session controls (lifecycle, feedback, gated UI, reset)

## Summary

Feature #11 is mostly an in-place upgrade to `src/sidepanel/sidepanel.ts`. The
panel already has Start, Pause/Resume, Stop, screenshots, annotations, and a
pre-export reminder wired against `chrome.storage.onChanged`. The minimum
viable change is: (1) extend the existing two-state machine (`idle`|`active`)
into a four-status model derived from session metadata + residual state,
(2) hide-not-disable interaction + lifecycle controls via the existing
`applyStateToControls()` function, (3) add a Discard button + native
`confirm()`-style modal, (4) add a Reset button gated on residual state,
(5) wrap three async handlers (`addNote`, `screenshotBtn`, `downloadBtn`) in
a 12-line `withLoading()` helper, (6) add a "new events ↓" chip wired to the
existing `shouldAutoScroll()` helper, and (7) bump `SCHEMA_VERSION` to
`1.2.0` while persisting `status` + emitting `session_paused`/`session_resumed`
timeline markers from the SW message handler. No new modules. ~430-500 LOC
across 8 files.

## Architecture Impact

**Components affected:**
- `src/sidepanel/sidepanel.ts`: state machine extension, control gating, loading wrappers, scroll chip, discard dialog, reset
- `src/sidepanel/sidepanel.css`: 5–6 new selectors (loading state, scroll chip, discard dialog, reset button, empty-state)
- `src/background/service-worker.ts`: PAUSE/RESUME emit timeline markers + persist `status`; new DISCARD_SESSION handler
- `src/lib/session-store.ts`: thread `status` through createSession/endSession; new `pauseSession`/`resumeSession`/`discardSession` helpers
- `src/lib/exporter.ts` + `src/lib/agents-doc.ts`: schema version bump 1.1.0 → 1.2.0; add `session_paused`/`session_resumed` to event-type lockstep lists
- `src/types.ts`: add `status` to `SessionMetadata`, two new TimelineEvent variants, new `DISCARD_SESSION` message
- `src/lib/sidepanel-render.ts`: handle two new event types in `eventToRow`/`assertExhaustiveSidePanelEvent`

**New patterns or abstractions introduced:**
- One small `withLoading(btn, label, fn)` helper inside `sidepanel.ts` (NOT a new module). Wraps an async handler in disabled+label-swap+restore-on-finally. Only used 3x; co-locating beats abstracting.

**Dependencies added or modified:**
- None.

**Breaking changes to existing interfaces:**
- `SessionMetadata.status` is a new required field. Mitigation: `getSession()` already does legacy-compat for `pii_mode` — extend that fallback to default `status: "running"` for sessions persisted without the field. Existing tests pass.
- `schema_version` in exports moves from `"1.1.0"` → `"1.2.0"`. The two new event types are additive, so existing parsers that ignore unknown types still work — minor bump per project semver rule.

## Approach

Reuse the existing `transitionToActive()` / `transitionToIdle()` /
`applyStateToControls()` skeleton. Replace the `state: "idle"|"active"` with
`status: "idle"|"running"|"paused"|"stopped"` and let `applyStateToControls`
toggle visibility of every interaction + lifecycle button via `display: none`
(the codebase already uses `style.display` toggles). Discard uses an existing
inline-modal pattern modelled on `#pre-export-reminder` (the file already has
one). Reset is computed from `events.length > 0 || screenshots non-empty`.
The auto-scroll chip is a single absolutely-positioned div added to
`#events-list`'s parent that listens to scroll + the existing append callback.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `src/sidepanel/sidepanel.ts` | Modify | ~220 | All UI gating, loading wrapper, discard modal, reset, scroll chip — co-located |
| `src/sidepanel/sidepanel.css` | Modify | ~80 | Empty state, loading spinner, scroll chip, discard dialog, reset button |
| `src/background/service-worker.ts` | Modify | ~50 | Emit pause/resume markers, persist status, DISCARD_SESSION handler |
| `src/lib/session-store.ts` | Modify | ~40 | `status` field default + 3 new helpers (pause/resume/discard) |
| `src/types.ts` | Modify | ~25 | `status` field, 2 new TimelineEvent variants, `DISCARD_SESSION` message |
| `src/lib/exporter.ts` | Modify | ~5 | `buildSummary` ignores pause/resume markers (no-op switch arms) |
| `src/lib/agents-doc.ts` | Modify | ~15 | SCHEMA_VERSION bump + 2 new entries in `AGENTS_MD_EVENT_TYPES` + body update |
| `src/lib/sidepanel-render.ts` | Modify | ~25 | `eventToRow` arms for `session_paused`/`session_resumed`; exhaustiveness guard |
| `src/sidepanel/sidepanel.test.ts` | Modify | ~250 | New test cases (see Test plan) |
| `src/lib/session-store.test.ts` | Modify | ~60 | Discard storage clear test |
| `src/lib/exporter.test.ts` | Modify | ~10 | Update SCHEMA_VERSION assertion + pause/resume marker round-trip |
| `src/lib/agents-doc.test.ts` | Modify | ~5 | New event-type set assertions |

**Total files**: 12
**Total estimated lines**: ~785 (including tests)
**Production-only LOC**: ~460

## State Machine

Single enum, derived: `status: "idle" | "running" | "paused" | "stopped"`.

| From | Trigger | To | Side effects |
|------|---------|----|--------------|
| idle | START_SESSION ack `recording: true` | running | Show interaction + lifecycle controls; hide Start, Reset; clear empty-state |
| running | PAUSE_SESSION click | paused | SW appends `{type: "session_paused", timestamp}`; SW persists `session.status = "paused"`; SP swaps Pause label → Resume; CDP capture stops (existing behaviour) |
| paused | RESUME_SESSION click | running | SW appends `{type: "session_resumed", timestamp}`; SW persists `session.status = "running"`; CDP capture re-enabled |
| running\|paused | STOP via reminder modal Download | stopped | SW finalises session, sets `end_time` + `status = "stopped"`, exports zip, then `clearSession()` (existing behaviour). After clearSession the storage.onChanged listener flips status to idle (not stopped — there's no residual state) |
| running\|paused | DISCARD via confirmation | idle | SW removes session/events/screenshots from storage; SP transitions to idle, residual state empty → no Reset button shown |
| idle (residual) | Reset click | idle (clean) | SP empties local `events`/`screenshots` and clears the rendered list; no SW round-trip needed because residual state lives only in the SP after a Stop+export already cleared SW storage |

The "stopped" enum value is computed but never visibly distinct from idle —
post-Stop the SW already calls `clearSession()`, which makes residual state
empty and Reset stays hidden. Keep "stopped" in the enum because the spec asks
for it in the export's session metadata.

Derivation rule on the side panel side:

```ts
function deriveStatus(opts: {
  session: SessionMetadata | null,
  paused: boolean,
}): SidePanelStatus {
  if (!opts.session) return "idle";
  if (opts.session.end_time != null) return "stopped";
  return opts.paused ? "paused" : "running";
}
```

## DOM/render changes

### Pre-session (status = idle)
**Visible**: `#start-btn`, `#pii-mode-fieldset`, `#empty-state` (new),
`#reset-btn` (new, only if `events.length > 0 || screenshots non-empty`),
`#metrics-row` (always visible, shows zeros), `#first-run-notice` if unseen.

**Hidden via `display:none`**:
- `#annotation-text`, `#add-note-btn`, `#screenshot-btn`, `#pick-element-btn`
- `#pause-btn`, `#stop-btn`, `#discard-btn` (new)
- `#selected-element` (already hidden when empty)

**Empty-state element** (new, replaces the hidden control block visually):
```ts
const emptyState = el("p", { id: "empty-state", class: "empty-state" },
  ["Start a session to begin capturing events."]);
```
Toggled by `applyStateToControls()`.

### Active session (running or paused)
**Visible**: all interaction + lifecycle controls. `#pause-btn` label flips
`Pause` ↔ `Resume`. `#paused-badge` already exists. `#discard-btn` shows
beside Stop with `danger` styling. Empty-state hidden. Reset hidden. Start
hidden.

### Auto-scroll "new events ↓" chip
A single absolutely-positioned div pinned to the bottom-right of the panel
above the controls region. Logic in `sidepanel.ts`:

```ts
// Existing: shouldAutoScroll(scrollTop, scrollHeight, clientHeight)
// On append:
//   if shouldAutoScroll(...) → scroll to bottom, hide chip
//   else → show chip with "↓ N new events" (counter increments per append)
// On chip click → scroll to bottom, hide chip, reset counter
// On user scroll back to bottom → hide chip, reset counter
```

The chip lives inside the existing `eventsList` (or a wrapper div) and is
positioned with CSS. Counter is local state (`newEventsSinceUserScrolledUp`).

### Discard confirmation
Reuse the inline-modal pattern from `#pre-export-reminder`. New element
`#discard-confirm-dialog` with:
- text: `Delete N events and M screenshots? This cannot be undone.`
  (text rebuilt at show-time from current `events` + `screenshots`)
- buttons: `#discard-cancel-btn` (focused first), `#discard-confirm-btn` (danger)
- Hidden by default; toggled by clicking `#discard-btn`

### Loading state on async buttons
`withLoading(btn, idleLabel, busyLabel, fn)`:

```ts
async function withLoading(
  btn: HTMLButtonElement,
  busyLabel: string,
  fn: () => Promise<void>,
): Promise<void> {
  const idleLabel = btn.textContent ?? "";
  btn.disabled = true;
  btn.textContent = busyLabel;
  btn.classList.add("loading");
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = idleLabel;
    btn.classList.remove("loading");
  }
}
```

Applied to:
- `#add-note-btn` (busy: "Saving…")
- `#screenshot-btn` (busy: "Capturing…")
- `#download-btn` (busy: "Exporting…")

Errors: if `fn()` throws, the catch path appends a status text to a small
`#async-error` span (or reuses `#empty-state` styled as error). Error stays
visible until the next successful action or the next state transition.

## Storage & schema changes

### Session metadata
Add `status: "running" | "paused" | "stopped"` to `SessionMetadata`.

`createSession()`:
- Persist `status: "running"` on creation.

`getSession()`:
- Legacy compat: default `status` to `"running"` if missing AND `end_time` is
  null, else `"stopped"`.

New helpers in `session-store.ts`:
```ts
export async function pauseSession(): Promise<void> {
  // mutate session.status = "paused", save back
  // append {type: "session_paused", timestamp, page_url} via appendEvent()
}
export async function resumeSession(): Promise<void> {
  // mutate session.status = "running", save back
  // append {type: "session_resumed", timestamp, page_url} via appendEvent()
}
export async function discardSession(): Promise<void> {
  // alias for clearSession() — kept distinct so future code can audit-log it
  await chrome.storage.local.remove([
    STORAGE_SESSION, STORAGE_EVENTS, STORAGE_SCREENSHOTS,
  ]);
}
```

`endSession()` also sets `status = "stopped"` (in addition to `end_time`).

### Schema version
Bump `SCHEMA_VERSION` in `src/lib/agents-doc.ts` from `"1.1.0"` → `"1.2.0"`.
Add to `AGENTS_MD_EVENT_TYPES`:
```ts
"session_paused",
"session_resumed",
```
Update `assertExhaustiveEventTypes` switch + the same lockstep guard in
`sidepanel-render.ts` (`assertExhaustiveSidePanelEvent`). Body of `AGENTS_MD`
gains a one-paragraph entry describing both event types as "explicit gap
markers — no events occur between session_paused and the next session_resumed
or session end".

### New TimelineEvent variants

```ts
export interface SessionPausedEvent extends BaseEvent {
  type: "session_paused";
}
export interface SessionResumedEvent extends BaseEvent {
  type: "session_resumed";
}
```

Both have only `seq`, `timestamp`, `page_url`. Added to the `TimelineEvent`
union.

### Service worker plumbing
- `PAUSE_SESSION` handler: set `paused = true`, call new
  `pauseSession()` from session-store (which appends the marker AND mutates
  `session.status`). Existing `if (paused) return;` gates in CDP callback +
  `RECORD_EVENT` already drop new events.
- `RESUME_SESSION` handler: set `paused = false`, call `resumeSession()`.
- New `DISCARD_SESSION` handler: detach debugger, call `discardSession()`,
  reset `recording`, `paused`, `activeSessionId`, `activeTabId`, `setBadge(false)`,
  notify content script with `SESSION_STOPPED`. Returns `{ discarded: true }`.

### `buildSummary()` (exporter.ts)
Add no-op switch arms for the two new types so the exhaustiveness check is
satisfied. Don't count them — they're meta markers, not real events.

## Test plan

All unit tests; jsdom for sidepanel-level tests. The existing
`src/sidepanel/sidepanel.test.ts` already runs under jsdom and has a
`makeHarness()` that mocks all SW message responses, so new tests slot in
without scaffolding. Defaults to deterministic mocks; no live LLM calls
anywhere.

### `src/sidepanel/sidepanel.test.ts` (extend)

Gated controls:
- `idle: hides annotation, screenshot, pick-element, stop, pause, discard buttons via display:none`
- `idle: shows #empty-state with the prompt copy`
- `idle with no residual state: does NOT render #reset-btn`
- `idle with initialEvents.length > 0: renders #reset-btn`
- `running: shows annotation textarea + screenshot + picker + pause + stop + discard, hides start + empty-state + reset`
- `running → stopped (storage end_time set): hides interaction + lifecycle controls; thumbnails preserved`
- `running → discard confirmed: returns to idle with empty event list and no reset (residual state empty)`

Loading feedback:
- `add-note click: button becomes disabled and shows "Saving…" until ADD_ANNOTATION resolves`
- `screenshot click: button shows "Capturing…" until TAKE_SCREENSHOT resolves`
- `download click: button shows "Exporting…" until STOP_SESSION+EXPORT_SESSION resolve`
- `add-note error path: button restores to idle and #async-error contains error text`

Auto-scroll:
- `at-bottom + new event appended → scrollTop equals scrollHeight - clientHeight`
- `scrolled-up + new event appended → scrollTop unchanged AND chip becomes visible with count=1`
- `chip click → scroll to bottom AND chip hidden AND counter reset`
- `(uses existing shouldAutoScroll() pure unit test for the threshold logic — already covered)`

Lifecycle:
- `pause click sends PAUSE_SESSION, swaps label to Resume, shows badge` (existing test stays)
- `resume click sends RESUME_SESSION, swaps label, hides badge` (existing test stays)
- `discard click opens dialog with concrete N events / M screenshots count`
- `discard cancel dismisses dialog AND does NOT send DISCARD_SESSION`
- `discard confirm sends DISCARD_SESSION AND transitions to idle AND empties local event list`

Reset:
- `reset click in idle clears event list and hides reset button`
- `reset is not rendered while session is active`

### `src/lib/session-store.test.ts` (extend)
- `pauseSession appends a session_paused marker AND sets session.status = "paused"`
- `resumeSession appends a session_resumed marker AND sets session.status = "running"`
- `discardSession removes session, events, screenshots from chrome.storage.local`
- `getSession() defaults missing status to "running" when end_time is null`
- `getSession() defaults missing status to "stopped" when end_time is set`
- `createSession persists status: "running"`
- `endSession sets status: "stopped"`

### `src/lib/exporter.test.ts` (extend)
- Update existing schema version assertion `1.1.0 → 1.2.0`
- `pause/resume markers round-trip through session.json without crashing summary builder`
- `buildSummary does NOT count session_paused/session_resumed in total_events` (or DOES — pick one and pin it; speed plan: count them as part of total_events to avoid changing summary semantics, just don't add new buckets)

### `src/lib/agents-doc.test.ts` (extend)
- `AGENTS_MD_EVENT_TYPES contains session_paused and session_resumed`
- `set equality with TimelineEvent union still holds`

### `src/lib/sidepanel-render.test.ts` (extend)
- `eventToRow handles session_paused with label "Paused"` (or similar)
- `eventToRow handles session_resumed with label "Resumed"`

### What CANNOT be tested at unit level

- The actual visual scroll snap (jsdom doesn't lay out, so scrollHeight ≠
  what a real browser computes). Unit tests verify the *call* to scrollTop,
  not the visible result.
- The Chrome `confirm()` dialog modality and focus trapping — but we're not
  using `confirm()`, we're using an inline DOM modal, so this is moot.
- Cross-window real-time sync of session.status across multiple side panel
  instances — chrome.storage.onChanged is mocked.
- The actual debugger detach during DISCARD — covered by manual extension load
  + existing debugger-client.test.ts coverage of detach().

These are deferred to manual smoke-test before merge (load extension, run a
session, pause, resume, screenshot mid-pause to confirm it's blocked, stop,
re-run, discard, reset).

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Pre-session: only Start + PII + (conditional) Reset rendered | Unit (jsdom) | DOM query in mounted side panel; existing harness |
| 2 | Pre-session: empty-state visible | Unit (jsdom) | DOM query |
| 3 | On start: interaction + lifecycle controls appear | Unit (jsdom) | DOM query after START_SESSION click |
| 4 | On stop/discard: returns to pre-session state | Unit (jsdom) | Fire storage.onChanged transition |
| 5 | Save annotation loading state | Unit (jsdom) | Spy on button.disabled + textContent during pending message |
| 6 | Capture screenshot loading state | Unit (jsdom) | Same pattern |
| 7 | Stop & Download loading state | Unit (jsdom) | Same pattern |
| 8 | Loading buttons return to idle on success/error; errors visible | Unit (jsdom) | Inject failing sendMessage stub; assert restore + error text |
| 9 | Auto-scroll when pinned to bottom | Unit (jsdom) | Set scrollTop near bottom, fire append, assert scrollTop |
| 10 | Don't yank when scrolled up; show chip | Unit (jsdom) | Set scrollTop=0, fire append, assert chip visible |
| 11 | Pause/Resume state transitions | Unit (jsdom) | Existing test pattern |
| 12 | Pause/Resume timeline markers in session.json | Unit (vitest) | session-store + exporter round-trip |
| 13 | Discard dialog shows concrete N/M counts | Unit (jsdom) | DOM textContent assertion |
| 14 | Discard cancel is no-op | Unit (jsdom) | Cancel click → no DISCARD_SESSION sent |
| 15 | Discard confirm clears storage | Unit (vitest) | session-store mocked chrome.storage |
| 16 | session.status field in metadata | Unit (vitest) | createSession/endSession assertions |
| 17 | Reset button conditional rendering | Unit (jsdom) | Mount with/without initialEvents |
| 18 | Reset clears panel state | Unit (jsdom) | Click reset, assert empty list + button gone |

**Speed planner bias**: Every criterion above is unit-testable with the
existing harnesses. No integration or e2e tests proposed.

**Determinism rule**: All tests use the existing in-memory mock chrome
storage and the existing `makeHarness()` pattern. Zero LLM calls.

## Testing Strategy
- **Unit**: Listed in detail above. Reuses existing `makeHarness()`,
  `STORAGE_*` constants, and the in-memory chrome shim from
  `session-store.test.ts`.
- **Integration**: Skip — no service boundaries change. SW pause/resume
  handler is exercised through `session-store.test.ts` indirectly.
- **E2E**: Skip. Feature #8's existing `e2e/sidepanel-debug.spec.ts` will
  flag any regression in side panel mounting; the new gating logic does not
  change panel binding or visibility behaviour.

**E2E Test Impact**:
- **Existing e2e tests affected**: none — the side panel still mounts the
  same root, and `e2e/sidepanel-debug.spec.ts` only verifies visibility/binding.
- **New e2e tests needed**: none. The new behaviour is DOM-level inside the
  panel, not Chrome-API-level.
- **Cost note**: zero new e2e cost.

**Test files to create/modify**:
- `src/sidepanel/sidepanel.test.ts` (modify)
- `src/lib/session-store.test.ts` (modify)
- `src/lib/exporter.test.ts` (modify)
- `src/lib/agents-doc.test.ts` (modify)
- `src/lib/sidepanel-render.test.ts` (modify)

## Risk Assessment

**Risk Level**: Low

**Why this is safe**:
- All changes are additive in `SessionMetadata` (with legacy compat default)
  and additive in the TimelineEvent union (existing parsers ignore unknown
  types).
- The pause/resume plumbing already exists end-to-end; we're only adding the
  marker emission + status persistence.
- Discard reuses the same `chrome.storage.local.remove([...])` call that
  `clearSession()` already performs at export time, so the storage path is
  already battle-tested.
- The `withLoading()` helper is pure DOM and uses try/finally — restore on
  error is guaranteed.
- Schema version bump is semver-minor (additive event types), matching the
  precedent from `1.0.0 → 1.1.0` (which added `agents.md`).

**Tradeoffs accepted**:
- Discard uses an inline DOM dialog instead of `confirm()` — no modal focus
  trap, no Esc handler. Consistent with the existing `#pre-export-reminder`
  pattern. (Quality plan would add focus trap + ARIA + Esc.)
- The "new events ↓" chip uses a simple counter, not a sophisticated
  intersection observer. Counter resets when user scrolls back to bottom.
- Reset is local-state-only (no SW round-trip) because by the time Reset is
  reachable, the SW has already cleared its storage. If a stale session
  somehow exists in SW storage, Reset will not catch it — but that's an
  invariant violation that should be loud, not silently masked.
- Loading errors stay in a single `#async-error` span (last-error-wins).
  No toast queue, no per-button inline error.
- Status stored as a string field, not a discriminated union. Saves
  ceremony.
- Empty-state is a single `<p>`, not an illustrated empty state component.
- Pre-session events list is also empty (no "previous session" badge or
  similar). The Reset button is the only affordance.

## Estimated Effort
- Planning: Already done
- Implementation: ~75 minutes
- Testing: ~50 minutes
- **Total**: ~125 minutes

## Formal Verification Assessment
- **Concurrency concerns**: No. The side panel is single-threaded; SW
  serialises messages.
- **State machine complexity**: Low. 4 states, 6 transitions, all
  unidirectional except pause↔resume. Easy to enumerate in tests.
- **Conservation laws**: One soft invariant — "events captured between Pause
  and Resume = 0". Already enforced by the `if (paused) return;` gate in two
  places. A unit test asserting that an injected RECORD_EVENT during paused
  state is dropped would pin it cheaply.
- **Authorization model**: None new. Discard requires user click on the
  confirm button — same trust level as Stop today.
- **Recommendation**: Formal verification not needed.

## What This Plan Does NOT Include

- **No new abstractions** for loading state (no `LoadingButton` component, no
  reactive store). Single inline helper, used 3 times.
- **No focus trap** in the discard confirmation dialog. Esc/Tab cycling is a
  quality concern, defer.
- **No per-button error inline rendering** — single shared `#async-error` span.
- **No animated empty-state** — plain text.
- **No "session paused" indicator beyond the existing badge** — the pause
  marker in the timeline + the badge in the metrics row are sufficient.
- **No history of past sessions** — Reset just empties the panel; it doesn't
  archive or export the prior run automatically.
- **No content script changes** — Pause/Resume is handled entirely in the SW
  via the existing `paused` flag gate. The content script's recorder.ts
  already routes through `RECORD_EVENT` which already returns early when
  `paused` is true in the SW.
- **No new debugger client surface** — `debuggerClient` stays attached during
  Pause; only the event callback is gated. Detach happens on Stop and Discard.
  This means the recorded tab still shows the "DevTools is debugging this tab"
  warning during a pause, which is acceptable for MVP. (Quality plan might
  detach + reattach to make pause feel like the tab is "free".)
- **No accessibility audit** — buttons get sensible labels but no ARIA
  live region for the status changes.
- **No undo for Discard** — by design.
- **No Reset confirmation** — by spec.
- **No status field exposed in `#metrics-row`** beyond the existing badge.
- **No instrumentation/analytics** for the new buttons.
- **No CSS extraction** — new styles slot into the existing
  `sidepanel.css`, not a new file.
