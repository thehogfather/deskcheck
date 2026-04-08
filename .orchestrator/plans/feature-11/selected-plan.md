---
agent: plan-judge
generated: 2026-04-08T00:00:00Z
task_id: feature-11
selected: quality
synthesised_from:
  - quality (backbone)
  - safety (discard atomicity, marker-before-flag ordering, hide-not-disable structural removal, focus-on-cancel, fresh-storage-snapshot for discard counts)
  - speed (reuse existing pause plumbing, single inline helper for loading rather than dedicated module, single sidepanel.css edit)
---

# Plan Evaluation: Feature #11 — Side panel session controls (lifecycle, feedback, gated UI, reset)

## 1. Decision summary

**Selected: Quality plan as backbone, with surgical grafts from Safety and Speed.**

The Quality plan wins because the side panel is the primary product surface,
all "Priority: Now" follow-ups (#5 OPFS, #7 tab switching) depend on a
coherent lifecycle, and the existing two-state machine + parallel `paused`
boolean is already brittle. Adding two more transitions on top of the speed
plan's "extend `applyStateToControls()` and add a few ifs" approach would
calcify a state model that the next two features will both need to reason
about. The Quality plan extracts a typed `SessionStatus`, a pure
controls-model helper, and a session-store facade for discard — all of
which are read-once-cheap, test-once-cheap, and survive into the OPFS swap
without a rewrite.

**Grafted from Safety:**
- Atomic single-call `chrome.storage.local.remove([SESSION, EVENTS, SCREENSHOTS])` for Discard so the panel does not see a torn intermediate state.
- **Marker-before-flag** write ordering for Pause/Resume so an SW eviction between marker write and flag flip leaves the export interpretable, never the other way around.
- **Hide-not-disable as structural removal** (`element.remove()` / never-appended), not `display: none` — pinned by `querySelector(...) === null` tests, matching the DoD's literal phrasing.
- **Focus-on-Cancel** + Escape-handling on the discard dialog (anti-muscle-memory, mirrors the existing pre-export reminder).
- **Discard count sourced from a fresh storage read at dialog-open time**, not panel-local memory, so the user is never lied to.
- **Fresh `hasResidualState()` check inside the Reset click handler** as defence-in-depth against a stale DOM.
- Schema version bump to **1.2.0** with `agents.md` updated in the same commit.

**Grafted from Speed:**
- **Reuse the existing `paused` flag plumbing** in the SW (the CDP callback's `if (paused) return` gate stays). We do NOT detach the debugger on Pause — the visual cost (CDP banner stays up) is honest signal, the ~100ms reattach cost on Resume is unnecessary friction, and detach/reattach is the most likely place to introduce a regression. (Quality plan was neutral; Safety plan's "always detach" recommendation is **rejected** — see §5.)
- **Single inline `withLoadingState(btn, busyLabel, fn)` helper inside `sidepanel.ts`**, not a separate `loading-state.ts` module with an adapter interface. Used 3 times. The Quality plan's adapter pattern is correct in principle but the maintainer has explicitly pushed back on premature abstraction for one-use helpers and there is no second consumer in flight.
- **No new `discard-confirm.ts` module** — the count-formatting helper is a private function inside `sidepanel.ts` (or beside `buildControlsModel`). Pluralisation logic is six lines.
- **Single `sidepanel.css` edit**, not new files. Additions only — empty-state hint, discard dialog (mirror `.pre-export-reminder`), new-events chip, `aria-busy` button styles.
- **No `service-worker.test.ts` refactor** to make `handleMessage` testable. Cover the SW handlers indirectly via `session-store.test.ts` for storage assertions plus the existing sidepanel jsdom tests for end-to-end flow assertions. The Quality plan flagged this as optional; we make the call to defer it.

**Rejected outright:**
- Safety's debugger-detach-on-pause (Option B in safety §6.1). High cost, low benefit, and changes the most fragile part of the codebase.
- Quality's separate `loading-state.ts`, `discard-confirm.ts`, and `scroll-anchor.ts` modules. Two of these (loading and discard-confirm) are one-use and would be over-abstracted. Scroll-anchor is borderline — see §3.5 for the call.
- Quality's content-script `recorder.ts` gate via `SESSION_PAUSED`/`SESSION_RESUMED` round-trip. The existing SW gate at `RECORD_EVENT` already drops events. The recorder-side gate is "defence in depth" but the racing-debounced-input scenario the plan worries about is not observed in practice and the cost of maintaining a second gate is real.
- Safety's `GET_DISCARD_SNAPSHOT` as a new SW message. We achieve the same property by having the panel call `getEvents()` / `getScreenshots()` directly via the existing storage API at dialog-open time — these are reads, not privileged operations, and the panel already reads storage for `initialEvents`. **Note**: this means the panel's discard handler reads storage directly (not via SW round-trip), which is consistent with how `sidepanel-entry.ts` already reads `STORAGE_EVENTS` upfront.

---

## 2. Scoring matrix (compact)

| Plan | Correctness | Risk | Effort | Architecture | Tests | Weighted (25/25/15/20/15) |
|---|---|---|---|---|---|---|
| **Speed** | 4.0 — covers every DoD bullet but the `display:none` gating is technically a literal-DoD violation ("absent from DOM"). | 3.5 — single-writer storage, additive schema, but the speed plan's reset relies on "SW already cleared storage" which couples panel logic to SW timing. | 5.0 — ~125 min, smallest diff. | 2.5 — leaves the parallel state machines (`state` + `paused`) intact; #5 OPFS will need to reason about both. | 3.5 — every DoD criterion is unit/jsdom-testable but the new state isn't typed, so coverage is "what the test happens to exercise" rather than "every legal transition". | **3.71** |
| **Quality** | 5.0 — typed state machine + pure decision modules + structural DOM removal map every DoD bullet to a specific test. | 4.5 — single writer, one source of truth, exhaustiveness guards force consistency, schema bump in lockstep with `agents.md`. | 2.5 — ~5.5 hours, 5 new modules. | 5.0 — `SessionStatus` is reusable by #5/#7/#9; storage facade absorbs the OPFS swap cleanly. | 4.5 — pure helpers hit ~100% coverage cheaply; jsdom layer focused on integration. | **4.43** |
| **Safety** | 5.0 — every DoD bullet pinned to a numbered guarantee G1-G10 and a numbered test U1-U28. | 5.0 — atomic remove, marker-before-flag ordering, fresh-storage-snapshot for discard counts, defensive re-checks. | 1.5 — ~8 hours, 28 unit + 5 integration + 3 e2e tests, plus debugger detach/reattach + screenshot timestamp refactor. | 4.0 — extends existing modules without the principled `SessionStatus` extraction; some debt left. The extra SW work (debugger detach, GET_DISCARD_SNAPSHOT message) creates more surface to maintain. | 5.0 — exhaustive failure-mode coverage, e2e for discard atomicity. | **4.06** |

**Selected**: Quality (4.43) wins on weighted score, but the project context further pushes toward synthesis: solo maintainer with no prod incident risk doesn't need Safety's e2e + debugger-detach overhead, and the existing test harness makes Quality's extra unit tests cheap rather than expensive.

---

## 3. Selected approach

### 3.1 State machine (from Quality, with Speed's pragmatism)

A single typed `SessionStatus` is the source of truth, written by the SW
to `chrome.storage.local`, read by the panel via `chrome.storage.onChanged`.

```typescript
// src/lib/session-status.ts (NEW, ~60 LOC)
export type SessionStatus = "idle" | "running" | "paused" | "stopped";

export type SessionAction =
  | "start" | "pause" | "resume" | "stop" | "discard" | "reset" | "export_complete";

export type TransitionResult =
  | { ok: true; next: SessionStatus }
  | { ok: false; reason: string };

export function nextStatus(current: SessionStatus, action: SessionAction): TransitionResult;
export function isCaptureActive(s: SessionStatus): boolean;       // === "running"
export function isLifecycleControlVisible(s: SessionStatus): boolean; // running || paused
export function isResetEligible(s: SessionStatus): boolean;       // === "stopped" || "idle"
export function assertExhaustiveStatus(s: SessionStatus): void;   // never guard
```

**Transition table** (consult this for the implementation):

| from / action | start | pause | resume | stop | discard | reset | export_complete |
|---|---|---|---|---|---|---|---|
| **idle** | running | × | × | × | × | × (no-op) | × |
| **running** | × | paused | × | stopped | idle | × | × |
| **paused** | × | × | running | stopped | idle | × | × |
| **stopped** | running | × | × | × | × | idle | idle |

`stopped → idle` on `export_complete` is the existing post-export
`clearSession()` flow (renamed `clearResidual()` — see §3.3).

**Why "stopped" exists in the enum even though the speed plan called it
"computed but never visibly distinct from idle"**: because Reset is only
meaningful from `stopped → idle`, and because feature #5 (OPFS) will need to
distinguish "never started a session" (idle) from "just stopped, residue
still present in storage" (stopped) when computing whether to flush
checkpoints. Two states are cheap; collapsing them now means feature #5
re-introduces them.

`"idle"` never appears in `chrome.storage.local`. When the metadata key is
absent, the SW and panel both interpret it as `"idle"`. This avoids two
representations of idle.

### 3.2 Module map

| File | Status | Approximate LOC | Purpose |
|---|---|---|---|
| `src/lib/session-status.ts` | **NEW** | ~80 | Pure state machine. Zero deps. |
| `src/lib/sidepanel-controls.ts` | **NEW** | ~70 | Pure: `buildControlsModel({status, hasResidualState})` returns a `ControlVisibility` shape. Tested without DOM. |
| `src/lib/scroll-anchor.ts` | **NEW** | ~60 | Pure: `ScrollAnchorState` + `onUserScroll` / `onAppend` / `onJumpToBottom`. Wraps the existing `shouldAutoScroll`. |
| `src/lib/session-store.ts` | **MODIFY** | +60 | Add `pauseSession()`, `resumeSession()`, `discardSession()`, `clearResidual()`. Extend `getSession()` legacy compat. Extend `createSession()` and `endSession()` to write `status`. |
| `src/lib/agents-doc.ts` | **MODIFY** | +30 | Bump `SCHEMA_VERSION` to `"1.2.0"`. Extend `AGENTS_MD_EVENT_TYPES`. Update `assertExhaustiveEventTypes`. Extend `AGENTS_MD` body with `status` field row + two new event-type sections. |
| `src/lib/sidepanel-render.ts` | **MODIFY** | +25 | Extend `eventToRow` for `session_paused`/`session_resumed` (label "Paused"/"Resumed", `accent: "info"`). Extend exhaustiveness guard. |
| `src/lib/exporter.ts` | **MODIFY** | +5 | `buildSummary` no-op switch arms for the two new types so the exhaustiveness check is satisfied. Markers are not counted in any bucket. |
| `src/types.ts` | **MODIFY** | +25 | Add `status: SessionStatus` (required) to `SessionMetadata`. Add `SessionLifecycleEvent`. Extend `TimelineEvent` union. Add `DISCARD_SESSION` and `RESET_SESSION` to `Message` union. Update `SessionExport.schema_version` literal to `"1.2.0"`. |
| `src/background/service-worker.ts` | **MODIFY** | +90 | New `DISCARD_SESSION`, `RESET_SESSION` handlers. Extend `PAUSE_SESSION` / `RESUME_SESSION` handlers with **marker-before-flag-flip** order. `restoreState()` rehydrates `paused` from `session.status`. |
| `src/sidepanel/sidepanel.ts` | **MODIFY** | +180 | Replace `state: "idle"\|"active"` with `let status: SessionStatus`. Replace `applyStateToControls()` with `applyControlsModel()` that mounts/removes children based on `buildControlsModel()`. Wire Discard dialog, Reset button, `withLoadingState` (inline helper), new-events chip. |
| `src/sidepanel/sidepanel.css` | **MODIFY** | +80 | Empty-state hint, discard dialog (mirror `.pre-export-reminder`), new-events chip, `[aria-busy="true"]` button style. |
| `src/lib/session-status.test.ts` | **NEW** | ~80 | All transitions in the table; invariants. |
| `src/lib/sidepanel-controls.test.ts` | **NEW** | ~80 | 4 status × 2 residual = 8 combinations + DoD-mapped assertions. |
| `src/lib/scroll-anchor.test.ts` | **NEW** | ~70 | Pinning logic, append-while-pinned, append-while-unpinned, jump-to-bottom. |
| `src/lib/session-store.test.ts` | **MODIFY** | +120 | New cases for `pauseSession`, `resumeSession`, `discardSession`, `clearResidual`, legacy `status` shim, `createSession`/`endSession` set status. |
| `src/sidepanel/sidepanel.test.ts` | **MODIFY** | +280 | New acceptance suites: gated visibility (idle / running / paused / stopped), loading feedback, auto-scroll + chip, lifecycle controls (incl. discard cancel/confirm), reset, status field. |
| `src/lib/agents-doc.test.ts` | **MODIFY** | +20 | Set-equality with new event types; `SCHEMA_VERSION === "1.2.0"`; new event-type sections present. |
| `src/lib/exporter.test.ts` | **MODIFY** | +20 | Schema version assertion update; pause/resume markers round-trip through `buildSummary` without crashing; markers not counted in `total_events`. |
| `src/lib/sidepanel-render.test.ts` | **MODIFY** | +20 | `eventToRow` cases for `session_paused`/`session_resumed`. |

**Total**: 13 files modified, 6 new files. ~1,000 LOC including tests, ~520
production LOC.

### 3.3 Storage facade additions (`src/lib/session-store.ts`)

```typescript
// (1) extend SessionMetadata to write `status` on every transition
export async function createSession(...): Promise<SessionMetadata> {
  const session: SessionMetadata = {
    // ...existing fields,
    status: "running",
  };
  await chrome.storage.local.set({ [STORAGE_SESSION]: session, ... });
  return session;
}

export async function endSession(): Promise<SessionMetadata | null> {
  // ...existing logic,
  session.end_time = ...;
  session.duration_ms = ...;
  session.status = "stopped";
  await chrome.storage.local.set({ [STORAGE_SESSION]: session });
  return session;
}

// (2) new: pause/resume — write the marker BEFORE flipping the status field
export async function pauseSession(): Promise<SessionMetadata | null> {
  const session = await getSession();
  if (!session || session.end_time || session.status === "paused") return null;

  // SAFETY: marker first. If this fails the status field stays "running"
  // and the panel UI does not flip. Eviction between marker write and
  // status write leaves the export interpretable (a marker exists, the
  // session looks "running" — at worst the next pause click is a no-op).
  await appendEvent({
    type: "session_paused",
    timestamp: new Date().toISOString(),
    page_url: session.initial_url, // best available; SW patches with current tab url if needed
  });

  session.status = "paused";
  await chrome.storage.local.set({ [STORAGE_SESSION]: session });
  return session;
}

export async function resumeSession(): Promise<SessionMetadata | null> {
  // mirror: marker first, then status
}

// (3) new: atomic discard
export async function discardSession(): Promise<void> {
  // SAFETY: single remove() call so the panel's storage.onChanged
  // listener fires once with all three keys cleared, not three sequential
  // events that would briefly show "no session but events still here".
  await chrome.storage.local.remove([
    STORAGE_SESSION,
    STORAGE_EVENTS,
    STORAGE_SCREENSHOTS,
  ]);
}

// (4) new: reset (alias for the post-export cleanup but distinct in name)
export async function clearResidual(): Promise<void> {
  // Identical implementation to discardSession() today, but kept distinct
  // so future audit logging or feature #5 OPFS can specialise (Reset
  // happens in stopped state, Discard happens in running/paused state).
  await chrome.storage.local.remove([
    STORAGE_SESSION,
    STORAGE_EVENTS,
    STORAGE_SCREENSHOTS,
  ]);
}

// (5) extend legacy compat
export async function getSession(): Promise<SessionMetadata | null> {
  const result = await chrome.storage.local.get(STORAGE_SESSION);
  const session = result[STORAGE_SESSION] as SessionMetadata | undefined;
  if (!session) return null;
  return {
    ...session,
    pii_mode: parsePiiMode(session.pii_mode),
    status: session.status ?? (session.end_time ? "stopped" : "running"),
  };
}
```

### 3.4 Service worker changes

The SW becomes thinner because the storage facade owns the marker/status
write. Replace the parallel `recording`/`paused` booleans with a single
`currentStatus: SessionStatus` cache that derives from `getSession()` at
boot and is updated locally on every successful transition.

```typescript
let currentStatus: SessionStatus = "idle";
let activeTabId: number | null = null;
let activeSessionId: string | null = null;

async function restoreState() {
  const session = await getSession();
  if (session && !session.end_time) {
    currentStatus = session.status; // "running" or "paused"
    activeSessionId = session.id;
    activeTabId = session.tab_id;
    setBadge(true);
    // Existing limitation: do NOT reattach the debugger here. Documented
    // as deferred in §6.
  } else if (session && session.end_time) {
    currentStatus = "stopped";
  } else {
    currentStatus = "idle";
  }
}

// PAUSE_SESSION handler
case "PAUSE_SESSION": {
  const transition = nextStatus(currentStatus, "pause");
  if (!transition.ok) {
    console.warn("[DeskCheck] PAUSE rejected:", transition.reason);
    return { status: currentStatus };
  }
  // Storage facade writes the marker AND flips status atomically (well —
  // two awaited writes in order; eviction between them leaves the system
  // in a recoverable state because the marker is harmless on its own).
  await pauseSession();
  currentStatus = "paused";
  return { status: currentStatus };
}

// RESUME_SESSION mirrors with resumeSession()

// DISCARD_SESSION
case "DISCARD_SESSION": {
  const transition = nextStatus(currentStatus, "discard");
  if (!transition.ok) return { status: currentStatus };
  const tabToNotify = activeTabId;
  try {
    await debuggerClient.detach();
  } catch (e) {
    console.warn("[DeskCheck] discard: detach failed (continuing):", e);
  }
  await discardSession();
  currentStatus = "idle";
  activeSessionId = null;
  activeTabId = null;
  setBadge(false);
  if (tabToNotify != null) {
    await chrome.tabs.sendMessage(tabToNotify, { type: "SESSION_STOPPED" }).catch(() => {});
  }
  return { status: currentStatus, discarded: true };
}

// RESET_SESSION (only valid from stopped)
case "RESET_SESSION": {
  const transition = nextStatus(currentStatus, "reset");
  if (!transition.ok) return { status: currentStatus };
  await clearResidual();
  currentStatus = "idle";
  return { status: currentStatus };
}
```

Existing `RECORD_EVENT` handler keeps its `if (paused) return` gate — but
the gate is now `if (currentStatus !== "running") return`. CDP callback
gate inside `START_SESSION`'s `debuggerClient.attach` callback uses the
same predicate. The recorder content script is **not** modified.

### 3.5 Side panel changes (`src/sidepanel/sidepanel.ts`)

The `mountSidePanel()` body changes in five focused ways:

1. **Replace `state: "idle"|"active"` and `paused: boolean` with
   `let status: SessionStatus = "idle"`.** Rename `transitionToActive` →
   transition is implicit in `applyControlsModel(status)`.

2. **Replace `applyStateToControls()` with `applyControlsModel()`** that
   takes `status` and `hasResidualState` (computed from `events.length +
   Object.keys(screenshots).length > 0`) and mounts or removes children
   of `controls` based on `buildControlsModel(...)`.

   Critical implementation detail (from Safety G10): nodes that should
   not be visible are **removed from the DOM** via `node.remove()` or
   never appended in the first place — not `display: none`. The DoD
   phrase "absent from the DOM, not merely disabled" is verified by
   `expect(controls.querySelector("#discard-btn")).toBeNull()`.

3. **Add the Discard dialog** (mirror `#pre-export-reminder` styling and
   behaviour). Initial focus on Cancel; Escape closes via Cancel.
   Counts come from a fresh storage read at dialog-open time:

   ```typescript
   discardBtn.addEventListener("click", async () => {
     if (status !== "running" && status !== "paused") return;
     const [freshEvents, freshScreenshots] = await Promise.all([
       getEventsFromStorage(),  // direct chrome.storage.local.get(STORAGE_EVENTS)
       getScreenshotsFromStorage(),
     ]);
     showDiscardDialog({
       eventCount: freshEvents.length,
       screenshotCount: Object.keys(freshScreenshots).length,
       onConfirm: () => sendMessage({ type: "DISCARD_SESSION" }),
       onCancel: () => hideDiscardDialog(), // PURE ui close, ZERO storage writes
     });
   });
   ```

4. **Add the Reset button** rendered only when `status === "stopped"` (or
   `idle` with residual — see below). Reset's click handler defensively
   re-checks `status === "stopped" || status === "idle"` and refuses
   otherwise. Sends `RESET_SESSION` to the SW.

5. **Add the auto-scroll chip** + the `withLoadingState` wrapper (inline
   helper, NOT a separate module).

Inline helper (12 lines, used 3 times):

```typescript
async function withLoadingState(
  btn: HTMLButtonElement,
  busyLabel: string,
  fn: () => Promise<void>,
): Promise<void> {
  const idleLabel = btn.textContent ?? "";
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = busyLabel;
  try {
    await fn();
    asyncErrorLine.textContent = "";
  } catch (err) {
    asyncErrorLine.textContent = String(err);
    throw err;
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.textContent = idleLabel;
  }
}
```

Applied to: `addNoteBtn` ("Saving…"), `screenshotBtn` ("Capturing…"),
`downloadBtn` ("Exporting…"). Errors land in a single shared
`#async-error` span styled as muted-red, persists until the next
successful action.

**Scroll anchor**: extracted to `src/lib/scroll-anchor.ts` because it has
two consumers (`autoScrollIfNeeded` AND the chip-visibility logic) and
because the existing `shouldAutoScroll` is already a tested pure helper
in `sidepanel-render.ts` — wrapping it in a stateful helper costs ~60 LOC
and pays for itself in the chip's correctness tests. **Keep `shouldAutoScroll`
in `sidepanel-render.ts`** as the underlying primitive; `scroll-anchor.ts`
imports and wraps it.

### 3.6 DOM structure

**Pre-session (`status === "idle"`)** — only these children of `#controls`:

```
#pii-mode-fieldset
#metrics-row
.empty-state-hint  ("Start a session to begin capturing.")
.sp-row
  └── #start-btn
  └── #reset-btn  (only if hasResidualState — used in idle-with-residual)
```

**Active session (`status === "running"` or `"paused"`)** — `#controls` contains:

```
#pii-mode-fieldset
#metrics-row
  └── ...metrics spans...
  └── #paused-badge  (visible iff status === "paused")
#selected-element  (existing, hidden when no element picked)
#annotation-text
.sp-row
  └── #add-note-btn
  └── #pick-element-btn
  └── #screenshot-btn
.sp-row
  └── #pause-btn  (label = "Pause" or "Resume")
  └── #stop-btn
  └── #discard-btn
#pre-export-reminder  (existing)
#discard-confirm-dialog  (NEW)
#async-error  (NEW, empty by default)
#new-events-chip  (NEW, hidden by default)
```

**Stopped (`status === "stopped"`)**: same as idle, plus `#reset-btn`
visible if residual present.

### 3.7 Schema bump

`SCHEMA_VERSION` ticks `"1.1.0"` → `"1.2.0"`. Additive change:

1. New optional-on-read, required-on-write field
   `SessionMetadata.status: "running" | "paused" | "stopped"`. Legacy
   sessions written before the bump default to `"running"` if `end_time`
   is null, `"stopped"` otherwise (legacy compat in `getSession()`).

2. New `TimelineEvent` discriminators `session_paused` and `session_resumed`.
   Both are `BaseEvent` only — `seq`, `timestamp`, `page_url`, no payload.

3. `agents.md` body updated to document both. Two new event-type
   sections in the body, one new row in the metadata table.

4. The compile-time `assertExhaustiveEventTypes` and the
   `assertExhaustiveSidePanelEvent` guards both update to handle the new
   variants — they will fail typecheck until updated, which is the
   point.

5. `buildSummary` in `exporter.ts` adds no-op switch arms for the two new
   types. Markers are NOT counted in `total_events`. (Speed plan
   suggested counting them; we explicitly choose NOT to because export
   consumers reading "12 events" should not include lifecycle markers in
   that count.) Document this in `agents.md`.

### 3.8 What we explicitly do NOT do

- **Do not detach the debugger on Pause.** The CDP banner stays visible
  during pause — that's honest signal. The CDP callback's gate
  (`if (currentStatus !== "running") return`) drops events, which is
  what was already happening. Reattach on Resume is unnecessary friction
  and the most likely place to introduce a regression.
- **Do not modify the content-script `recorder.ts`.** The SW gate is
  sufficient. No `SESSION_PAUSED`/`SESSION_RESUMED` round-trip to the
  recorder.
- **Do not refactor the SW into a testable `handleMessage(deps)` shape.**
  Defer to a future feature. SW behaviour is covered indirectly by
  `session-store.test.ts` (storage assertions) and `sidepanel.test.ts`
  (end-to-end via mocked `sendMessage`).
- **Do not introduce a `loading-state.ts` module.** Inline helper.
- **Do not introduce a `discard-confirm.ts` module.** Inline string
  formatter (~6 lines, pure function).
- **Do not introduce a `GET_DISCARD_SNAPSHOT` SW message.** Panel reads
  `chrome.storage.local` directly for the dialog count.
- **Do not move the screenshot timestamp to call-start.** The Safety
  plan's worry about "screenshot started before pause sorts after the
  marker" is real but small; the export is sorted by `seq`, not by
  `timestamp`, so consumers that respect `seq` see the right order.
  Document this in `agents.md`.
- **Do not add e2e tests.** Existing `e2e/sidepanel-debug.spec.ts`
  covers the bind-on-open invariant. Feature #11 lives entirely inside
  the panel form and the SW message handlers — neither path is changed
  in a way that affects e2e coverage. Adding e2e for discard/pause
  would push the suite over the "slow tests at every PR" threshold.

---

## 4. Test Level Matrix

**One test level per DoD checkbox.** "Unit (pure)" = no jsdom, no Chrome
mock. "Unit (jsdom)" = vitest with `// @vitest-environment jsdom` and the
existing `makeHarness()` pattern. "Unit (Chrome mock)" = vitest with the
in-memory chrome storage shim from `session-store.test.ts`.

| # | DoD checkbox | Test level | Target file | Rationale |
|---|---|---|---|---|
| 1 | Pre-session: only Start, PII selector, (conditionally) Reset rendered; annotation/screenshot/picker/lifecycle controls **absent from DOM** | Unit (jsdom) | `sidepanel.test.ts` | DoD says "absent from the DOM" — only jsdom can verify `querySelector(...) === null` |
| 2 | Pre-session: empty-state hint visible | Unit (jsdom) | `sidepanel.test.ts` | DOM presence assertion |
| 3 | On start, interaction + lifecycle controls appear | Unit (jsdom) | `sidepanel.test.ts` | Click Start in mounted panel, assert children present |
| 4 | On stop/discard, form returns to pre-session state | Unit (jsdom) | `sidepanel.test.ts` | Fire storage onChange, assert children removed |
| 5 | Save annotation shows loading state | Unit (jsdom) | `sidepanel.test.ts` | Slow mocked sendMessage, assert `disabled` + `aria-busy` + label "Saving…" |
| 6 | Capture screenshot shows loading state | Unit (jsdom) | `sidepanel.test.ts` | Same pattern |
| 7 | Stop & Download shows loading state | Unit (jsdom) | `sidepanel.test.ts` | Loading state on the reminder's Download button (not Stop itself) |
| 8 | Loading buttons return to idle on success/error; errors visible | Unit (jsdom) | `sidepanel.test.ts` | Inject failing sendMessage stub; assert restore + `#async-error` text persists |
| 9 | Auto-scroll when pinned | Unit (pure) | `scroll-anchor.test.ts` | `onAppend` while pinned → next state still pinned, count = 0 |
| 9b | (verify the wiring) | Unit (jsdom) | `sidepanel.test.ts` | Mount with overflowing events, append via storage onChange, assert `eventsList.scrollTop` ends at `scrollHeight - clientHeight` |
| 10 | No yank when scrolled up; chip lets user jump | Unit (pure) | `scroll-anchor.test.ts` | `onAppend` while unpinned → count grows |
| 10b | (verify the chip) | Unit (jsdom) | `sidepanel.test.ts` | Set `scrollTop = 0`, dispatch scroll, append event, assert chip visible with count |
| 11 | Pause/Resume/Stop/Discard exposed during active session | Unit (pure) | `sidepanel-controls.test.ts` | `buildControlsModel({status: "running", ...})` returns lifecycleControls = true |
| 12 | Pause stops new capture (SW gate at `RECORD_EVENT` and CDP callback) | Unit (Chrome mock) | `session-store.test.ts` | Indirect via `pauseSession()` writes status; SW gate is "trust the type system + the existing test pattern". The single-line CDP gate is verified by inspection. |
| 13 | Resume re-enables capture | Unit (Chrome mock) | `session-store.test.ts` | `resumeSession()` writes status |
| 14 | Pause/Resume markers in `session.json` | Unit (Chrome mock) | `session-store.test.ts` | `pauseSession()` appends marker BEFORE flipping status; assert event order |
| 15 | Stop = today's Stop & Download | Regression | (existing tests pass) | No code change to the stop-then-export path |
| 16 | Discard shows confirmation naming concrete data | Unit (jsdom) | `sidepanel.test.ts` | Click Discard, assert dialog `textContent` includes the actual N/M from storage |
| 16b | Count sourced from storage, not in-memory | Unit (jsdom) | `sidepanel.test.ts` | Pre-populate storage with different counts than in-memory `events`, click Discard, assert dialog shows storage counts |
| 17 | Confirmed discard removes events/screenshots/metadata | Unit (Chrome mock) | `session-store.test.ts` | `discardSession()` removes all three keys in a single `remove([...])` call (spy assertion) |
| 18 | Cancel leaves session untouched | Unit (jsdom) | `sidepanel.test.ts` | Spy on `chrome.storage.local.set/remove`, click Cancel, assert zero calls |
| 18b | Default focus is Cancel; Escape triggers Cancel | Unit (jsdom) | `sidepanel.test.ts` | `document.activeElement === cancelBtn` after dialog open; dispatch Escape, assert dialog closed without `DISCARD_SESSION` sent |
| 19 | Session metadata includes `status` field | Unit (Chrome mock) | `session-store.test.ts` | `createSession()` writes status `"running"`; `endSession()` writes `"stopped"`; legacy compat defaults work |
| 20 | Reset rendered only when no active session AND residual remains | Unit (pure) | `sidepanel-controls.test.ts` | `buildControlsModel({status: "stopped", hasResidualState: true})` → resetButton: true; `{status: "running", ...}` → false |
| 21 | Reset clears residual, no confirm | Unit (jsdom) | `sidepanel.test.ts` | Click Reset, assert `RESET_SESSION` sent immediately, no dialog opened |
| 21b | Reset SW handler clears storage | Unit (Chrome mock) | `session-store.test.ts` | `clearResidual()` removes all keys |
| 22 | Reset hidden during active session | Unit (pure) | `sidepanel-controls.test.ts` | Already covered by row 20 |
| 23 | Reset click handler defensively re-checks state (race protection) | Unit (jsdom) | `sidepanel.test.ts` | Mount in stopped state with Reset visible; programmatically set status to "running"; click Reset; assert no `RESET_SESSION` sent |
| 24 | Schema version bumped to 1.2.0 | Unit (pure) | `agents-doc.test.ts` | `expect(SCHEMA_VERSION).toBe("1.2.0")` |
| 25 | `agents.md` documents both new event types | Unit (pure) | `agents-doc.test.ts` | `AGENTS_MD_EVENT_TYPES` set-equals `TimelineEvent` discriminators |
| 26 | New event types render in the side panel | Unit (pure) | `sidepanel-render.test.ts` | `eventToRow({type: "session_paused", ...})` returns row with label "Paused" |
| 27 | All transitions in the state machine table are exhaustive | Unit (pure) | `session-status.test.ts` | Table-driven test of every (state, action) pair |

**Total**: 30 test cases (some DoD criteria split into 27a/27b for layered
verification). 0 e2e. 16 jsdom (in `sidepanel.test.ts`). 9 pure unit
(`session-status`, `sidepanel-controls`, `scroll-anchor`, `agents-doc`,
`exporter`, `sidepanel-render`). 5 Chrome-mock unit (`session-store`).

**Determinism**: every test uses the in-memory chrome storage mock or the
existing `makeHarness()`. Zero LLM calls. No timer-based flakiness — fake
timers replace `setTimeout` where the code under test uses `setTimeout`
(scroll debounce, loading-state restoration if any).

---

## 5. Risk mitigations (final)

| # | Risk | Mitigation |
|---|---|---|
| R1 | User clicks Discard by accident, loses entire session | Confirmation dialog with default focus on Cancel; Escape closes via Cancel; concrete N/M counts from fresh storage read; danger styling on confirm button |
| R2 | Cancel-discard takes a path that mutates storage | Spy-pinned test asserts zero storage writes on Cancel |
| R3 | Pause marker missing or out-of-order with status flip after SW eviction | Marker is `await`ed before status flip in `pauseSession()`; the worst case (eviction between the two writes) leaves a marker in the export and the system reads as "running" — interpretable, not destructive |
| R4 | Schema break: existing zips no longer parse | Additive schema only (`status` field optional on read; new event types are additive). Minor bump per project semver. `agents.md` documents both. Legacy compat in `getSession()` |
| R5 | The destructive Discard path collides with the pre-export reminder modal pattern | Same DOM structure (`role="alertdialog"`, hidden by class), different IDs. Implementation reuses the styling but does not share state |
| R6 | `display: none` gating accidentally satisfies the literal-DoD "absent from DOM" check | `applyControlsModel` mounts/removes via `appendChild`/`removeChild`, never `display: none`. Pinned by `querySelector === null` test |
| R7 | Reset is rendered/clicked while a session is somehow still active | Pure `buildControlsModel` returns `resetButton: false` for any non-stopped state; click handler defensively re-checks `status` |
| R8 | The new `status` field collides with feature #4's `pii_mode` legacy compat pattern | Both use the same `getSession()` shim; the shim is now responsible for two defaulting fields. Test for both is added |
| R9 | A future contributor adds a new lifecycle event without updating `agents.md` | `assertExhaustiveEventTypes` (`never` guard) fails typecheck; `AGENTS_MD_EVENT_TYPES` set-equality test fails at runtime |
| R10 | `chrome.storage.local.remove([...])` is not actually atomic | Per Chrome docs, `remove(string[])` is processed as a single storage transaction. The `onChanged` listener fires once with all keys in the changes object. (If Chrome ever changes this — verified manually during smoke test — the implementer adds an integration test.) |

---

## 6. Formal verification recommendation

| Signal | Speed | Quality | Safety | Consensus |
|---|---|---|---|---|
| Concurrency | No | Yes (mild) | Yes (mild) | Mild — single-threaded SW message handler, but panel↔SW round-trips create the appearance of races |
| State machine | No | Yes | Yes | Yes — 4 states × 7 actions ≈ 12 legal transitions |
| Conservation | No (one soft) | Yes (append-only events; pause→resume markers paired) | Yes (events captured before stop are exported or discarded with consent) | Yes |
| Authorization | No | No | No | No |

**Recommendation**: **SKIP formal verification.** The state space is small
enough (4 states × 7 actions) to enumerate exhaustively in the
`session-status.test.ts` table-driven test. The conservation laws are
enforced structurally:

- **"Storage as ground truth"** — every destructive action reads counts
  from storage at the moment of the action, not from in-memory state.
- **Marker-before-flag** — if the marker write fails, the flag does not
  flip; the worst case is a no-op.
- **Atomic discard** — single `remove([...])` call.
- **Compile-time exhaustiveness guards** — adding a new event type or
  status forces every consumer to handle it.

TLA+ would buy <5% additional confidence at 10x the effort. The Quality
plan's `nextStatus()` table-driven tests are the right shape for this
size of state space. **The 27-row test in `session-status.test.ts` IS
the formal model**, encoded as runnable Vitest cases.

**Key invariants in business language** (documented in `session-status.ts`
JSDoc and pinned by tests):

1. "When the session is paused, no new captured events appear in the
   timeline until the user clicks Resume." (Enforced by the SW
   `RECORD_EVENT` gate + the CDP callback gate.)
2. "When the user clicks Cancel on the discard dialog, no storage
   write occurs." (Pinned by the spy test on `sidepanel.test.ts`.)
3. "When the user clicks Discard and confirms, all events,
   screenshots, and session metadata are gone from storage in a
   single transaction before the panel returns to idle."
4. "The `status` field in `session.json` is one of `running`,
   `paused`, or `stopped`. The export never contains `idle`."
5. "Reset is unreachable while a session is active."
6. "Every `session_paused` event in the timeline is followed by either a
   `session_resumed` event or the end of the session." (This is
   informally true but not enforced — `paused → stopped` is a legal
   transition. Documented as a non-invariant.)

---

## 7. Implementation phasing

The implementer commits in this order. Each phase has its own commit so a
red phase can be `git revert`-ed cleanly. Order chosen so the
type system fails compilation early on the missing pieces — there is no
"add the type, add the consumers later" gap.

| Phase | Description | Commit message hint | Tests that gate the next phase |
|---|---|---|---|
| 1 | Add `SessionStatus` + `nextStatus` + invariants in `src/lib/session-status.ts`. Add `session-status.test.ts` with the full transition table | `feat(feature-11): add SessionStatus state machine` | `session-status.test.ts` green |
| 2 | Extend `src/types.ts`: add `status` to `SessionMetadata`, add `SessionLifecycleEvent`, extend `TimelineEvent` and `Message` unions, bump `SessionExport.schema_version` literal to `"1.2.0"` | `feat(feature-11): extend types for lifecycle status and markers` | `make typecheck` should now FAIL — every consumer of `TimelineEvent` (agents-doc, sidepanel-render) is missing arms. This is the intent. |
| 3 | Update `src/lib/agents-doc.ts`: bump `SCHEMA_VERSION`, extend `AGENTS_MD_EVENT_TYPES`, extend `assertExhaustiveEventTypes`, add `status` row + two new event-type sections to `AGENTS_MD` body. Update `agents-doc.test.ts` | `feat(feature-11): bump schema to 1.2.0 and document lifecycle markers in agents.md` | `agents-doc.test.ts` green; `make typecheck` partially clears |
| 4 | Update `src/lib/sidepanel-render.ts`: extend `eventToRow` for `session_paused`/`session_resumed`, extend exhaustiveness guard. Update `sidepanel-render.test.ts` | `feat(feature-11): render session_paused/session_resumed rows` | `sidepanel-render.test.ts` green; `make typecheck` clears |
| 5 | Update `src/lib/exporter.ts`: no-op switch arms for the two new event types in `buildSummary`. Update `exporter.test.ts` (schema version + markers don't crash + markers not counted) | `feat(feature-11): exporter handles lifecycle markers` | `exporter.test.ts` green |
| 6 | Extend `src/lib/session-store.ts`: `createSession`/`endSession` write `status`; new `pauseSession`, `resumeSession`, `discardSession`, `clearResidual`; legacy compat for `status` in `getSession`. Update `session-store.test.ts` with the marker-before-flag, atomic-remove, and legacy-compat tests | `feat(feature-11): session-store lifecycle facade with marker-before-flag ordering` | `session-store.test.ts` green |
| 7 | Update `src/background/service-worker.ts`: replace `recording`/`paused` with `currentStatus: SessionStatus`; update `restoreState`; extend `PAUSE_SESSION`/`RESUME_SESSION` handlers to use `pauseSession()`/`resumeSession()`; new `DISCARD_SESSION` and `RESET_SESSION` handlers. No new test file (covered indirectly) | `feat(feature-11): SW lifecycle handlers and discard/reset` | Existing tests still green; manual smoke test the SW |
| 8 | Add `src/lib/sidepanel-controls.ts` (pure decision module) + `sidepanel-controls.test.ts` with all 8 status × residual combinations | `feat(feature-11): pure controls model for side panel gating` | `sidepanel-controls.test.ts` green |
| 9 | Add `src/lib/scroll-anchor.ts` + `scroll-anchor.test.ts` | `feat(feature-11): scroll anchor helper for new-events chip` | `scroll-anchor.test.ts` green |
| 10 | Refactor `src/sidepanel/sidepanel.ts`: replace `state`/`paused` with `status`, replace `applyStateToControls` with `applyControlsModel`, add Discard dialog, add Reset button, add `withLoadingState` inline helper, add new-events chip. Update `sidepanel.css` with empty-state hint, discard dialog, chip, and `aria-busy` styles | `feat(feature-11): sidepanel session controls refactor` | `make typecheck` green |
| 11 | Extend `src/sidepanel/sidepanel.test.ts` with new acceptance suites (gated visibility × 4 states; loading × 3 buttons; auto-scroll + chip; lifecycle controls including discard cancel/confirm; reset). Includes the spy-on-storage test for cancel-discard | `test(feature-11): acceptance suites for gated controls, lifecycle, discard, reset` | `make test` green |
| 12 | Manual smoke test against `make build` artifact: full pause/resume/stop cycle, discard cancel, discard confirm, reset, all loading states, auto-scroll chip behaviour. Tick the DoD checkboxes in `docs/roadmap.md` | `docs(feature-11): mark DoD complete` | Manual checklist passes |
| 13 | (optional) `make bump-minor` if the maintainer wants to release | `chore(feature-11): bump to 0.x.0 for lifecycle controls` | — |

**Stop conditions** (any of these → halt and reassess):
- Phase 2 leaves typecheck broken in a way phases 3-4 don't fix.
- Phase 7 SW refactor breaks an existing test that wasn't in the modified
  set.
- Phase 10 sidepanel refactor pushes `sidepanel.ts` over ~900 LOC — at
  that point reconsider whether `discard-confirm.ts` should be
  extracted after all.

---

## 8. Final Definition of Done

Consolidated from `docs/roadmap.md` feature #11 with additions from the
test layer:

**Gated controls (hide, not disable):**
- [ ] Pre-session: side panel renders only Start, PII selector, and (conditionally) Reset; the annotation textarea, screenshot button, element-picker trigger, and lifecycle controls are absent from the DOM (`querySelector === null`)
- [ ] Pre-session: empty-state hint visible
- [ ] On session start: interaction + lifecycle controls (Pause, Resume, Stop, Discard) appear
- [ ] On session stop or after Discard: form returns to pre-session state

**Loading feedback:**
- [ ] Save annotation shows loading state (`disabled` + `aria-busy="true"` + label "Saving…")
- [ ] Capture screenshot shows loading state ("Capturing…")
- [ ] Stop & Download (the Download button in the reminder) shows loading state ("Exporting…")
- [ ] Loading buttons return to idle on success and on error
- [ ] Errors persist in `#async-error` until next successful action

**Auto-scroll:**
- [ ] Event list auto-scrolls when user is pinned to the bottom
- [ ] No yank when user has scrolled up
- [ ] "N new events ↓" chip appears when scrolled away; click jumps to bottom

**Lifecycle controls:**
- [ ] Pause stops new capture (SW gate verified by `currentStatus !== "running"` in CDP callback and `RECORD_EVENT` handler)
- [ ] Resume re-enables capture
- [ ] Pause/Resume markers in `session.json` (event types `session_paused`, `session_resumed`)
- [ ] Stop behaves as today's Stop & Download
- [ ] Discard shows confirmation naming the concrete N events and M screenshots from a fresh storage read
- [ ] Confirmed discard removes session, events, screenshots in a single `chrome.storage.local.remove([...])` call
- [ ] Cancelling Discard makes ZERO storage writes (spy-pinned)
- [ ] Discard dialog default-focuses Cancel; Escape closes via Cancel
- [ ] `SessionMetadata.status` field is one of `running` / `paused` / `stopped`

**Reset:**
- [ ] Reset rendered only when no session is active AND residual exists
- [ ] Reset click clears residual and returns to idle without confirmation
- [ ] Reset hidden during active session
- [ ] Reset click handler defensively re-checks state

**Schema:**
- [ ] `SCHEMA_VERSION === "1.2.0"` in `src/lib/agents-doc.ts`
- [ ] `agents.md` body documents the `status` field and both new event types
- [ ] `assertExhaustiveEventTypes` and `assertExhaustiveSidePanelEvent` updated
- [ ] `SessionExport.schema_version` literal in `src/types.ts` is `"1.2.0"`
- [ ] Legacy sessions without `status` default to `"running"` if not ended, `"stopped"` if ended

**Tests:**
- [ ] All new tests in §4 pass (30 cases)
- [ ] `make typecheck` passes
- [ ] `make test` passes
- [ ] Existing tests still pass (sidepanel-debug e2e, popup-removed, no-direct-capture)
- [ ] Manual smoke test against `make build` artifact: full pause/resume/stop, discard cancel, discard confirm, reset, all loading states

**Documentation:**
- [ ] DoD checkboxes in `docs/roadmap.md` ticked

---

## Orchestrator handoff

This evaluation is the **final decision** — no human checkpoint follows.
The orchestrator will:

1. Commit all four plans to `docs/plans/feature-11/` for git audit trail.
2. Use the Test Level Matrix to scaffold the new test files and stub
   acceptance test cases.
3. Proceed directly to implementation following the phasing in §7.

**Summary for git commit**:
- Selected plan: **Quality** (with synthesised Safety + Speed elements)
- Key rationale: Quality's typed `SessionStatus` and pure decision modules
  pay forward into features #5 and #7; Safety's discard atomicity and
  marker-before-flag ordering are non-negotiable for the destructive
  Discard path; Speed's "no premature abstraction" pruning keeps the diff
  honest (loading helper inline, no `discard-confirm.ts`, no SW handler
  refactor, no debugger detach on pause).
- Estimated effort: ~5.5 hours (Quality estimate, slightly reduced by the
  Speed prunings, slightly increased by the Safety additions — net wash)
- Key risks: discard cancel leaking storage writes (mitigated by spy
  test), schema break (mitigated by additive-only + legacy compat),
  hide-not-disable interpretation drift (mitigated by `querySelector ===
  null` test), pause marker out-of-order with status flip on SW eviction
  (accepted residual: marker harmless on its own)
- Test levels: 25 unit (16 jsdom + 9 pure + 5 Chrome-mock — note one row
  has both pure and jsdom), 0 integration, 0 e2e
- Files touched: 13 modified, 6 new (3 new lib modules + 3 new test files)
