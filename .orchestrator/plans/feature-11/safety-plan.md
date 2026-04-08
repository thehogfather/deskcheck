---
agent: safety-planner
generated: 2026-04-08T00:00:00Z
task_id: feature-11
perspective: safety
---

# Safety Plan: Feature #11 — Side panel session controls (lifecycle, feedback, gated UI, reset)

## 1. Summary — risk posture

Feature #11 is **medium-high blast radius** for two reasons that no other piece
of this roadmap shares:

1. It introduces **Discard** — the only user-facing action in the product that
   destroys captured debugging data without exporting it first. Today the only
   path that removes session data is `EXPORT_SESSION` after a successful
   download (`clearSession()` in `src/background/service-worker.ts:440`). With
   Discard, a user can lose hours of recording with one click. The blast radius
   here is "the user's own work product, irrecoverably."
2. It changes the **export schema** by adding `status` to session metadata and
   two new event discriminators (`session_paused`, `session_resumed`). The
   export is the product's core contract — every downstream AI consumer that
   parses `session.json` reads against `schema_version`. A schema break is a
   contract break with every recipient who already has DeskCheck zips on disk.

The other three pieces of feature #11 (gated controls, loading feedback,
auto-scroll) are **low-risk UI polish**, but they share the same form surface
as the destructive action — so a bug in the gate predicate ("is the form in
idle state?") could expose Discard or Reset at the wrong time. The plan treats
the gate predicate as load-bearing and pins it with tests.

**What we are protecting, in priority order:**

1. **The user's recorded session.** Discard must be impossible to fire by
   accident; cancel must be byte-perfect.
2. **The export contract.** Existing zips must still parse against the new
   schema; new zips must explain themselves to existing consumers via
   `agents.md`.
3. **State coherence across service-worker eviction.** MV3 service workers can
   be killed at any time. `paused`, `running`, `stopped`, and "residual"
   states must all survive a restart with the panel re-syncing correctly when
   it next opens.
4. **Capture correctness across pause/resume.** No double-recording, no
   ghost events from a debugger that thinks it's still attached, no
   "phantom captures" from a screenshot already in flight when Pause fires.

**Risk classification:** High Risk overall (High Impact × Medium Likelihood).
Mitigated to Medium Risk after the controls in this plan land.

---

## 2. Threat model — the specific ways this feature can hurt the user

| # | Threat | Severity | What it costs the user |
|---|--------|----------|------------------------|
| T1 | User clicks Discard by accident (muscle memory from "Stop & download") | Critical | Entire session lost |
| T2 | Discard confirmation displays stale event count from in-memory state, user thinks "only 3 events, fine to drop", actually has 300 | High | Trust violation; data lost without informed consent |
| T3 | Cancel-discard takes a code path that mutates storage anyway (e.g., a "clear UI optimistically then refetch" pattern) | Critical | Data lost on a path the user explicitly opted out of |
| T4 | Schema bump breaks existing AI consumers that hardcoded `schema_version === "1.1.0"` or that don't tolerate unknown event `type` values | High | All downstream tooling silently misparses every new export until updated |
| T5 | Pause does not detach the debugger; CDP events keep arriving, get dropped by the in-memory `paused` flag, but the SW restarts and forgets the flag → next CDP event appended as if Pause never happened | High | Timeline contains events from a "paused" period; user-visible silence is a lie |
| T6 | Pause fires while a screenshot is mid-flight; the screenshot lands as a `screenshot` event during the "paused" gap; the gap looks dishonest in the export | Medium | Schema correctness violation; AI consumers compute wrong intervals |
| T7 | Reset is rendered when no session is active but a confirmed-discard race causes the user to click Reset on what is actually still an active session (storage hasn't yet propagated `end_time`) | Medium | Reset clears events of a live session |
| T8 | `session_paused` / `session_resumed` markers are not written transactionally with the `paused` flag flip, so a SW restart between flag flip and storage write produces a session that thinks it's paused but has no marker | Medium | Export gap is undocumented; consumers see events stop and resume with no explanation |
| T9 | Loading state on Stop & Download deadlocks if the export promise rejects silently — button stuck on "Downloading…", user clicks again, double-export | Medium | Duplicate downloads, possible storage churn |
| T10 | Auto-scroll predicate uses `eventsList.scrollHeight` which is stale during a synchronous append, causing the chip to flash on for one frame even when the user was at the bottom | Low | Cosmetic jank; not a data risk |
| T11 | Hide-not-disable removes Discard from the DOM on idle, but a stale React-style state cache leaves the click handler bound; a programmatic dispatch (e.g., from devtools or a future test seam) fires Discard against an idle session | Low | Defensive — only matters if a future contributor introduces such a seam |
| T12 | Pause/resume markers leak the debugger attach window: on Resume the CDP `Network.requestWillBeSent` for an in-flight request that started during the pause now arrives, appended after `session_resumed` with a `timestamp` that predates it | Medium | Timeline is no longer monotonic; AI consumers that sort by timestamp produce nonsense |

These are the threats this plan defends against. Threats 1-7 are critical or
high; the rest are accepted with mitigations or accepted as residual risk
(see §11).

---

## 3. Guarantees (the invariants we commit to)

These are the invariants the implementation must hold. Each one will be pinned
by a test (see §9). They are written as predicates on system state that should
always be true.

**G1 — Discard is non-destructive until confirmed.**
After clicking Discard and before clicking Confirm in the dialog,
`chrome.storage.local` for `STORAGE_SESSION`, `STORAGE_EVENTS`, and
`STORAGE_SCREENSHOTS` is byte-identical to its pre-click state. Cancel is the
default focus.

**G2 — Discard confirmation shows fresh storage counts.**
The dialog text "Delete N events and M screenshots?" sources N and M from a
fresh `getEvents()` and `getScreenshots()` call made when the dialog opens,
not from `events`/`screenshots` in panel-local memory.

**G3 — Reset is unreachable while a session is active.**
The Reset button is rendered iff `state === "idle" && hasResidualState()`.
`hasResidualState()` is computed from a fresh storage read at the same moment
the predicate is evaluated. Reset's click handler additionally re-checks
`state === "idle"` and refuses if not — defence in depth against a stale DOM.

**G4 — Pause/Resume state survives SW eviction.**
After a `paused` flag flip, the next storage write to `STORAGE_SESSION` carries
the new `status` field (`"paused"` or `"running"`). The SW's `restoreState()`
on wake reads `STORAGE_SESSION.status` and rehydrates the in-memory `paused`
flag. The CDP debugger's behaviour on wake matches the persisted `status`.

**G5 — Pause/Resume timeline markers are written before the next non-marker
event.**
A `session_paused` marker is appended via `appendEvent` BEFORE `paused = true`
flips. A `session_resumed` marker is appended BEFORE `paused = false` flips.
This means: if a CDP event races with the flag flip, it will land on the
correct side of the marker. The marker write is `await`ed; the message handler
does not return until the marker is in storage.

**G6 — Schema is forward-compatible.**
Existing exports (schema 1.1.0) still parse and render correctly when read by
the new code. The bump is to 1.2.0 (minor — additive). `agents.md` documents
the new fields and event types. The compile-time exhaustiveness guards in
`src/lib/agents-doc.ts` and `src/lib/sidepanel-render.ts` are extended to the
new event variants so a future contributor cannot add another lifecycle event
without updating both.

**G7 — Cancel-discard is a no-op against storage.**
Closing the discard dialog by Cancel, by Escape, by clicking outside, or by
losing focus must not invoke `clearSession()`, `chrome.storage.local.remove`,
or any storage write. Pinned by a spy test.

**G8 — Loading buttons resolve in finite time.**
Every async handler that toggles a loading state wraps the work in
`try { ... } finally { setLoading(false); }`. There is no code path on which
a button gets stuck in loading state. Errors are surfaced to a status line
that persists until the next user action.

**G9 — Auto-scroll respects user intent.**
After a new event append, the panel scrolls to the bottom iff
`shouldAutoScroll(scrollTop, scrollHeight, clientHeight)` returned true
BEFORE the append. (Reading `scrollHeight` after the append is too late —
the new row has already grown the document.) This is a behavioural fix to
the existing `autoScrollIfNeeded()`.

**G10 — Hide-not-disable is structural, not stylistic.**
Hidden controls are detached from the DOM (`element.remove()` or
`parent.removeChild`), not just `display: none`. Pinned by a test that
asserts `querySelector("#discard-btn")` returns `null` while idle.

---

## 4. State machine

The current implementation has a two-state machine:

```
  ┌──────┐  START_SESSION ack    ┌────────┐
  │ idle │ ────────────────────► │ active │
  └──────┘                        └────────┘
     ▲                                │
     │ STORAGE_SESSION.end_time ≠ null│
     └────────────────────────────────┘
```

Plus a transient `paused: boolean` flag inside `active`. Feature #11 expands
this into:

```
                                              ┌─ pause ──┐
                                              │          ▼
  ┌──────┐  START_SESSION ack    ┌─────────────────┐    ┌────────┐
  │ idle │ ────────────────────► │ active.running  │◄───│ active │
  └──────┘                        └─────────────────┘    │ .paused│
     ▲                                  │   ▲            └────────┘
     │                                  │   │ resume         ▲
     │  STOP / DISCARD                  ▼   │                │
     │  cleared from storage     ┌─────────────────┐         │
     │                            │   transient    │         │
     │                            │   transitions  │ pause   │
     │                            └─────────────────┘────────┘
     │                                  │   │
     │                                  │   │ STOP_SESSION (from paused)
     │                                  ▼   │
     │                            ┌─────────────────┐
     │                            │ idle (residual) │
     │                            └─────────────────┘
     │                                  │
     │                                  │ RESET
     │                                  ▼
     └──────────────────────────► (clean idle)
```

There are five high-level states for the panel:

| State | Description | Visible controls |
|-------|-------------|------------------|
| `idle.clean` | No session, no residual events/metrics | Start, PII selector, empty-state hint |
| `idle.residual` | No session, but residual events/metrics from a prior run | Start, PII selector, **Reset** |
| `active.running` | Session capturing | Annotation, Screenshot, Pick element, Pause, Stop, Discard |
| `active.paused` | Session paused, timeline preserved | Annotation, Screenshot, Pick element, **Resume**, Stop, Discard |
| `transient.discard_confirm` | Discard dialog open | Confirm, Cancel (focus default) |

**Transitions and what breaks them:**

| From | To | Trigger | Failure mode |
|------|----|---------|--------------|
| `idle.clean` | `active.running` | START_SESSION ack | If START_SESSION succeeds in SW but the response message races with a SW eviction, panel stays in idle. Mitigation: panel calls `refreshSessionState()` on focus and on storage change. |
| `active.running` | `active.paused` | PAUSE_SESSION ack | If marker write fails, paused flag must NOT flip. Mitigation: G5 — marker is awaited before flag changes. |
| `active.paused` | `active.running` | RESUME_SESSION ack | Mirror: marker write must succeed before flag flips. |
| `active.*` | `idle.residual` | STOP_SESSION ack | Existing path. Already covered by `STORAGE_SESSION.end_time` change listener. |
| `active.*` | `idle.clean` | Confirmed Discard | New path. Must atomically clear all three storage keys. Mitigation: single `chrome.storage.local.remove([SESSION, EVENTS, SCREENSHOTS])` call, not three sequential ones, to avoid partial-state races. |
| `idle.residual` | `idle.clean` | Reset click | Reset must compute residual freshly from storage and refuse if `STORAGE_SESSION.end_time === null`. |
| `transient.discard_confirm` | `active.*` (back) | Cancel | Pure UI close. Spy-asserted to make zero storage calls. |
| Any state | Any state (after SW eviction + panel re-mount) | `restoreState()` + `refreshSessionState()` | Tested by an e2e that explicitly evicts the SW. |

---

## 5. Discard path — end to end

Discard is the highest-stakes new control. Walking it from click to cleanup:

### 5.1 The Discard button click handler

```ts
discardBtn.addEventListener("click", async () => {
  // Defence in depth: refuse if not active. Should never fire on idle
  // because the button is not in the DOM, but the click handler is its
  // own line of defence.
  if (state !== "active") return;

  // Source the counts from STORAGE, not from the in-memory `events` /
  // `screenshots` that the panel has been accumulating from
  // storage.onChanged. The panel's view can lag a SW write by a tick.
  // The dialog must show ground truth or it is lying to the user.
  let snapshot;
  try {
    snapshot = await sendMessage({ type: "GET_DISCARD_SNAPSHOT" });
  } catch {
    // If the SW is asleep or unreachable, refuse to open the dialog
    // rather than open it with stale numbers.
    showStatus("Could not read session state. Try again.");
    return;
  }

  showDiscardDialog({
    eventCount: snapshot.eventCount,
    screenshotCount: snapshot.screenshotCount,
    onConfirm: async () => {
      hideDiscardDialog();
      try {
        setLoading(discardBtn, true);
        await sendMessage({ type: "DISCARD_SESSION" });
        // Storage onChange will fire, the session listener will see
        // STORAGE_SESSION go undefined, and transitionToIdle() runs.
        // We don't manually flip state here.
      } catch (err) {
        showStatus(`Discard failed: ${err}`);
      } finally {
        setLoading(discardBtn, false);
      }
    },
    onCancel: () => {
      // Pure UI close. NO storage calls. Pinned by a spy test.
      hideDiscardDialog();
    },
  });
});
```

### 5.2 The new SW message: GET_DISCARD_SNAPSHOT

```ts
case "GET_DISCARD_SNAPSHOT": {
  const session = await getSession();
  if (!session || session.end_time != null) {
    return { eventCount: 0, screenshotCount: 0, valid: false };
  }
  const events = await getEvents();
  const screenshots = await getScreenshots();
  return {
    eventCount: events.length,
    screenshotCount: Object.keys(screenshots).length,
    valid: true,
  };
}
```

### 5.3 The new SW message: DISCARD_SESSION

```ts
case "DISCARD_SESSION": {
  // Detach debugger first — same order as STOP_SESSION but without the
  // export. Detach is best-effort; failure to detach must not block
  // storage cleanup (the user is asking us to forget).
  try {
    await debuggerClient.detach();
  } catch (e) {
    console.warn("[DeskCheck] discard: detach failed (continuing):", e);
  }

  // Atomic clear: a single remove() call removes all three keys in one
  // storage transaction. This matters for the panel's storage.onChanged
  // subscriber: a sequential remove(SESSION) → remove(EVENTS) →
  // remove(SCREENSHOTS) would fire three change events and the panel
  // would briefly see "no session but events still here".
  await chrome.storage.local.remove([
    STORAGE_SESSION,
    STORAGE_EVENTS,
    STORAGE_SCREENSHOTS,
  ]);

  // Reset in-memory SW state.
  recording = false;
  paused = false;
  activeSessionId = null;
  activeTabId = null;
  setBadge(false);

  return { discarded: true };
}
```

### 5.4 The discard dialog DOM

```ts
function showDiscardDialog(opts: {
  eventCount: number;
  screenshotCount: number;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const dialog = el("div", {
    id: "discard-dialog",
    role: "alertdialog",
    "aria-labelledby": "discard-title",
    "aria-describedby": "discard-body",
  });

  // Concrete data named, plural-aware:
  const title = el("h2", { id: "discard-title" }, ["Discard this session?"]);
  const body = el("p", { id: "discard-body" }, [
    `This will permanently delete ${opts.eventCount} ${opts.eventCount === 1 ? "event" : "events"} and ${opts.screenshotCount} ${opts.screenshotCount === 1 ? "screenshot" : "screenshots"}. This cannot be undone.`,
  ]);

  const cancel = el("button", { id: "discard-cancel", class: "sp-btn" }, ["Cancel"]);
  const confirm = el("button", { id: "discard-confirm", class: "sp-btn danger" }, [
    `Delete ${opts.eventCount + opts.screenshotCount} item${opts.eventCount + opts.screenshotCount === 1 ? "" : "s"}`,
  ]);

  cancel.addEventListener("click", opts.onCancel);
  confirm.addEventListener("click", () => void opts.onConfirm());

  // Default focus on Cancel — anti-muscle-memory.
  // Same pattern the existing pre-export reminder uses for "Keep recording".
  dialog.appendChild(title);
  dialog.appendChild(body);
  dialog.appendChild(cancel);
  dialog.appendChild(confirm);
  document.body.appendChild(dialog);

  // Focus AFTER append so the focus actually lands.
  cancel.focus();

  // Escape closes via Cancel.
  const escapeHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      opts.onCancel();
    }
  };
  document.addEventListener("keydown", escapeHandler);

  // Hook returned to the cancel/confirm callbacks so they can remove
  // the listener on close.
  (dialog as any).__escapeHandler = escapeHandler;
}
```

### 5.5 What can go wrong here, and how the plan defends

| Failure | Defence |
|---------|---------|
| User clicks Confirm twice rapidly → DISCARD_SESSION fires twice | The button enters loading state on first click; the second click is dropped because the button is `disabled`. |
| User clicks Discard, dialog opens, SW evicts mid-dialog, user clicks Confirm | DISCARD_SESSION wakes the SW; if storage is already empty (e.g. the session ended via tab close), the SW returns `discarded: true` as a no-op. The panel state listener has already moved to idle. |
| User clicks Cancel but a stale `confirm` click event was already queued | The dialog removes both buttons from the DOM on Cancel, so a queued click against `confirm` no-ops. |
| onChange listener fires three times because the SW used three sequential removes | Mitigated by the single atomic `remove([SESSION, EVENTS, SCREENSHOTS])` call. |
| Panel optimistically clears its in-memory `events` array on Confirm and the SW call then fails | We do NOT optimistically clear. The panel waits for the storage.onChange event to drive the UI. This means a slow SW shows a 100ms delay between Confirm and the empty list — acceptable. |

---

## 6. Pause/Resume path — end to end

This is where the second-highest set of subtle failures live. The current
implementation is naïve: `paused` is a single boolean in the SW, the CDP
listener does an early return when paused, and there is no marker. Feature
#11 hardens this in three ways: the debugger detaches on pause, markers are
written transactionally, and the in-flight screenshot rule is explicit.

### 6.1 The debugger attach/detach decision

**Decision: detach the debugger on Pause, reattach on Resume.**

Alternatives considered:

- **Option A (status quo): keep the debugger attached, drop events in the
  callback by checking `if (paused) return`.** Cheaper (no reattach overhead)
  but: (a) the SW pays for the network and runtime listeners even when paused,
  (b) on SW eviction the in-memory `paused` flag is lost and the next event
  lands as if pause never happened, (c) the user technically still sees the
  CDP "DevTools is debugging this tab" banner during a pause, which is
  visually confusing.

- **Option B (this plan): detach on Pause, reattach on Resume.** Cleaner
  semantics: pause means **CDP is not attached**, so there is literally no
  source of CDP events to drop. Eviction is safe because there is no flag
  to lose. The CDP banner correctly disappears on pause. Cost: ~100ms
  reattach overhead on Resume; the user sees the banner reappear.
  Acceptable.

- **Option C: detach on pause but keep a "deferred screenshot" buffer.**
  Rejected — adds state without solving a problem the user has, and the
  existing `takeScreenshot` flow already handles "tab not active" gracefully.

We pick Option B. Concrete code:

```ts
case "PAUSE_SESSION": {
  if (!recording || paused) return { paused };

  // 1. Write the marker FIRST. If this fails, do not flip the flag.
  try {
    await appendEvent({
      type: "session_paused",
      timestamp: new Date().toISOString(),
      page_url: await getCurrentTabUrl(),
    });
  } catch (e) {
    console.error("[DeskCheck] PAUSE: marker write failed:", e);
    return { paused: false, error: "marker_write_failed" };
  }

  // 2. Detach the debugger. Failure here is non-fatal — we still flip
  //    the flag and update the persisted status. A stuck-attached
  //    debugger emits to a callback that checks `paused` and drops.
  try {
    await debuggerClient.detach();
  } catch (e) {
    console.warn("[DeskCheck] PAUSE: detach failed (non-fatal):", e);
  }

  // 3. Persist the status BEFORE flipping the in-memory flag, so an
  //    eviction immediately after the flag flip is recoverable.
  paused = true;
  await updateSessionStatus("paused");

  return { paused };
}

case "RESUME_SESSION": {
  if (!recording || !paused) return { paused };

  // Mirror order: marker first, then reattach, then flip flag, then
  // persist status.
  try {
    await appendEvent({
      type: "session_resumed",
      timestamp: new Date().toISOString(),
      page_url: await getCurrentTabUrl(),
    });
  } catch (e) {
    console.error("[DeskCheck] RESUME: marker write failed:", e);
    return { paused: true, error: "marker_write_failed" };
  }

  if (activeTabId) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      await debuggerClient.attach(activeTabId, tab.url ?? "", (event) => {
        if (paused) return; // belt-and-braces
        appendEvent(event);
      });
    } catch (e) {
      console.warn("[DeskCheck] RESUME: reattach failed:", e);
      // Continue — content script is still recording DOM events,
      // just no CDP.
    }
  }

  paused = false;
  await updateSessionStatus("running");
  return { paused };
}
```

Where `updateSessionStatus` is a new helper in `src/lib/session-store.ts`:

```ts
export async function updateSessionStatus(
  status: "running" | "paused" | "stopped",
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_SESSION);
  const session = result[STORAGE_SESSION] as SessionMetadata | undefined;
  if (!session) return;
  session.status = status;
  await chrome.storage.local.set({ [STORAGE_SESSION]: session });
}
```

### 6.2 The "in-flight screenshot at Pause time" question

A user clicks Screenshot, then immediately clicks Pause before the screenshot
returns. What happens?

The screenshot flow today (`src/background/screenshot.ts:35-73`):

1. `chrome.tabs.get(tabId)` — fast
2. `canCaptureRecordedTab(tab)` — pure
3. `chrome.tabs.captureVisibleTab(...)` — slow (10-100ms)
4. `storeScreenshot(id, dataUrl)` — fast write
5. `appendEvent({type: "screenshot", ...})` — fast write

If Pause fires between steps 3 and 5, the screenshot lands AFTER the
`session_paused` marker. The plan's rule:

**Manual user actions (TAKE_SCREENSHOT, ADD_ANNOTATION) bypass the pause
gate because they are explicit user intent. The current SW already does
this — the `paused` check in the message handler is only for `RECORD_EVENT`,
not for `TAKE_SCREENSHOT` or `ADD_ANNOTATION`.** We preserve this. The
screenshot lands as a normal `screenshot` event.

But the marker may now be out of order: the timeline reads
`[..., session_paused @ T0, screenshot @ T0+50ms, ...]`. To consumers this
looks like "events were captured during a paused window", which is the lie
T6 warned about.

**Mitigation:** the screenshot's `timestamp` is set at `appendEvent` time,
not at the captureVisibleTab call site. We change `takeScreenshot` to record
its `started_at` timestamp at step 1 and use THAT as the event's `timestamp`,
not the time at step 5. This means a screenshot started before Pause appears
before the `session_paused` marker even though it lands after. Code:

```ts
export async function takeScreenshot(...) {
  const startedAt = new Date().toISOString();  // ← capture upfront
  try {
    const tab = await chrome.tabs.get(activeTabId);
    if (!canCaptureRecordedTab(tab)) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(...);
    const id = `ss_${Date.now()}`;
    await storeScreenshot(id, dataUrl);
    if (emitTimelineEvent) {
      await appendEvent({
        timestamp: startedAt,  // ← not new Date().toISOString()
        type: "screenshot",
        ...
      });
    }
    return { id, dataUrl };
  }
  ...
}
```

The export is now sorted by `seq`, not `timestamp`, so an out-of-order
timestamp is fine. Documented in the agents.md update.

### 6.3 Status persistence and SW eviction

The `status` field on `SessionMetadata` is the **only** source of truth for
"is this session paused" across SW restarts. The in-memory `paused` flag is
a cache. `restoreState()` becomes:

```ts
async function restoreState() {
  const session = await getSession();
  if (session && !session.end_time) {
    recording = true;
    activeSessionId = session.id;
    activeTabId = session.tab_id;
    paused = session.status === "paused";  // ← rehydrate from storage
    setBadge(true);

    // If we restored to paused, do NOT reattach the debugger.
    // If we restored to running, the existing flow handles reattach
    // lazily on the next message that needs it.
  }
}
```

A subtlety: today the SW does NOT reattach the debugger on `restoreState`.
A SW eviction during a running session leaves the debugger detached until
the user explicitly does something. This is an existing limitation of the
codebase that feature #11 does not need to fix — but the plan must not
make it worse. The status field correctly distinguishes "paused
intentionally" from "running but debugger detached due to eviction" so a
future fix can target the right case.

---

## 7. Schema migration

### 7.1 What changes

Three additions to the export schema:

1. **`SessionMetadata.status: "running" | "paused" | "stopped"`** — written by
   the SW on every state transition. Always present in new exports. Never
   `running` in a finalised export (a stopped session always has
   `status === "stopped"`).
2. **New event type `session_paused`** — `{type: "session_paused", seq, timestamp, page_url}`.
3. **New event type `session_resumed`** — `{type: "session_resumed", seq, timestamp, page_url}`.

### 7.2 Schema version bump

`SCHEMA_VERSION` in `src/lib/agents-doc.ts` bumps from `"1.1.0"` to `"1.2.0"`.
Minor bump because the change is **additive and backward-compatible at the
parser level**:

- Existing consumers reading `1.1.0` exports parse them unchanged.
- Existing consumers reading `1.2.0` exports see new optional fields and
  unfamiliar event types. A consumer that ignores unknown event types
  (the `default` case in any switch) gets a degraded but correct view.
  A consumer that asserts on the discriminator union is broken — but those
  consumers are by definition fragile to additive change, so the semver minor
  is honest.

The `SessionExport` interface in `src/types.ts` updates its
`schema_version: "1.1.0"` literal to `"1.2.0"`. The compile-time guards in
`agents-doc.ts` and `sidepanel-render.ts` are extended to the new variants.

### 7.3 Reading old exports

Reading old exports is not done in-process today — DeskCheck only WRITES
exports — so the read-side compatibility burden is on third-party consumers.
But the panel must still tolerate **old in-flight session storage** during
the upgrade path: a user with an in-progress session in storage when they
update the extension would have a session record that lacks `status`.

`getSession()` already does a "legacy compat" defaulting for `pii_mode`
(see `src/lib/session-store.ts:55`). We add the same for `status`:

```ts
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

A pre-feature-11 in-flight session is rehydrated as `running`, which is the
honest default.

### 7.4 agents.md update

The `AGENTS_MD` constant in `src/lib/agents-doc.ts` is updated to:

1. Bump the schema version mention (already interpolated from `SCHEMA_VERSION`).
2. Add a `status` row to the session metadata table.
3. Add two new sections to the event types catalog: `session_paused` and
   `session_resumed`, with a 1-2 sentence rationale.
4. Add a "Lifecycle markers" subsection to "Writing a bug report from this
   zip" explaining that gaps between `session_paused` and `session_resumed`
   are intentional and represent user-elected silence.

A snippet of the new section:

```markdown
### type: `session_paused`

A user-initiated pause. CDP capture is detached and DOM events are
suppressed until a matching `session_resumed`. There is no payload —
the marker IS the data. Use to interpret gaps in the timeline as
intentional rather than dropped.

### type: `session_resumed`

A user-initiated resume after a pause. The CDP debugger reattaches and
DOM event capture resumes. Events between `session_paused` and
`session_resumed` are user-initiated only (manual screenshots,
annotations).
```

The compile-time guard in `agents-doc.ts:36-51` (the `assertExhaustiveEventTypes`
function) is extended:

```ts
export function assertExhaustiveEventTypes(e: TimelineEvent): void {
  switch (e.type) {
    case "interaction":
    case "viewport_resize":
    case "network_error":
    case "console_error":
    case "js_exception":
    case "annotation":
    case "screenshot":
    case "session_paused":   // ← new
    case "session_resumed":  // ← new
      return;
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}
```

Same edit to `assertExhaustiveSidePanelEvent` in `src/lib/sidepanel-render.ts`.
And `eventTypeLabel`, `eventDetail`, `eventAccent` in the same file gain
cases for the two new variants. The runtime test `agents-doc.test.ts` that
checks set-equality between `AGENTS_MD_EVENT_TYPES` and the union must be
re-run after updating the constant array.

### 7.5 Why not a major bump

A major version bump is for **schema breaks** — fields removed, types changed,
mandatory new fields. None of that is happening here. The new fields are
additive; existing fields are unchanged; the only consumer-visible difference
is "more event variants exist". Per the existing semver convention in
`agents-doc.ts:6-10` (which calls 1.1.0 a minor for adding `agents.md`),
this is a minor.

---

## 8. Service worker eviction scenarios

MV3 service workers can be evicted at any time. The panel and SW must
gracefully handle every state being interrupted by an eviction. The matrix:

| State at eviction | Storage at eviction | Wake trigger | Recovery |
|-------------------|---------------------|--------------|----------|
| `idle.clean` | All keys absent | Any message | `restoreState()` finds no session, SW stays idle. Panel re-syncs via `refreshSessionState()` on next mount or focus change. |
| `idle.residual` | Session present with `end_time != null`, events present | Panel mount | `restoreState()` sees `end_time != null`, leaves `recording = false`. Panel sees residual events via initial storage read in `sidepanel-entry.ts`. Reset button is rendered. |
| `active.running` | Session present, `end_time == null`, `status == "running"` | Panel mount or any CDP event | `restoreState()` rehydrates `recording = true, paused = false`. **CDP debugger is NOT reattached** (existing limitation). Panel sees running state and renders active controls. New CDP events will not arrive until the user takes an action that triggers reattach — preexisting behaviour. |
| `active.paused` | Session present, `end_time == null`, `status == "paused"` | Panel mount | `restoreState()` rehydrates `recording = true, paused = true`. Debugger remains detached (correct). Panel renders paused state. Resume button works because the message handler calls `attach` again. |
| `transient.discard_confirm` | Unchanged from `active.*` | User confirms | DISCARD_SESSION wakes SW; SW does the atomic remove. Panel sees the storage event and transitions to idle. The dialog itself lives in the panel document, which is independent of the SW lifecycle. |
| Mid-pause (between marker write and detach) | Session present, marker in events array, `status` not yet updated | Any message | `restoreState()` reads old `status` value (`running`), in-memory `paused = false`. **Bug:** the marker is written but the system thinks it's running. Mitigation: the marker write and the status update are NOT atomic; we accept this corner. After the next user action the discrepancy resolves (Pause re-clicked, etc). The marker existing in the export is harmless — it just signals an attempted pause. |
| Mid-resume (between marker write and reattach) | Session present, marker in events array, `status` updated to `running`, debugger detached | Any message | `restoreState()` reads `running`, in-memory `paused = false`. The debugger is detached but the system thinks it's running. Same preexisting "running but detached" limitation as the eviction-during-running case. |

**Panel re-sync on open:** `sidepanel-entry.ts` already reads `STORAGE_EVENTS`
and `STORAGE_SCREENSHOTS` upfront and passes them as `initialEvents` /
`initialScreenshots`. The panel mounts directly into the active view.
`refreshSessionState()` runs on mount and refetches `recording` and `paused`
from the SW. No additional changes needed for panel re-sync.

**Storage as ground truth:** the rule the plan enforces is "in-memory state
is a cache; storage is truth". Every place that needs a definitive answer
(discard snapshot count, reset predicate, restore on wake) reads from
storage, not from in-memory state.

---

## 9. Failure-mode test plan

Tests are organised by the threat they defend against. Each test names the
threat ID from §2 in its description so a future debugger can trace from a
red test back to the risk it pins.

### 9.1 Unit tests (Vitest, jsdom or pure)

| # | Test | File | Pins |
|---|------|------|------|
| U1 | `discard dialog: cancel makes zero storage writes` | `src/sidepanel/sidepanel.test.ts` | T1, T3, G1, G7 |
| U2 | `discard dialog: shows count from GET_DISCARD_SNAPSHOT, not in-memory events` | `src/sidepanel/sidepanel.test.ts` | T2, G2 |
| U3 | `discard dialog: default focus is Cancel button` | `src/sidepanel/sidepanel.test.ts` | T1, G1 |
| U4 | `discard dialog: Escape key triggers Cancel, not Confirm` | `src/sidepanel/sidepanel.test.ts` | T1, G1 |
| U5 | `discard confirm: dispatches DISCARD_SESSION exactly once even with rapid double-click` | `src/sidepanel/sidepanel.test.ts` | T9 |
| U6 | `discard SW: atomic remove of all three storage keys (single transaction, not three)` | `src/background/service-worker.test.ts` (new) | T3 |
| U7 | `pause SW: marker is appended BEFORE paused flag flips` | `src/background/service-worker.test.ts` | T8, G5 |
| U8 | `pause SW: status persisted to storage as "paused" after flag flip` | `src/background/service-worker.test.ts` | T5, T8, G4 |
| U9 | `restoreState: rehydrates paused=true from storage status="paused"` | `src/background/service-worker.test.ts` | T5, G4 |
| U10 | `restoreState: rehydrates paused=false from storage status="running"` | `src/background/service-worker.test.ts` | G4 |
| U11 | `getSession: legacy session without status field defaults to "running" if not ended, "stopped" if ended` | `src/lib/session-store.test.ts` | G6 |
| U12 | `updateSessionStatus: writes new status preserving all other fields` | `src/lib/session-store.test.ts` | G4 |
| U13 | `gated controls: discard button absent from DOM in idle state (querySelector returns null)` | `src/sidepanel/sidepanel.test.ts` | T11, G10 |
| U14 | `gated controls: pause/resume/stop/discard appear after START_SESSION ack` | `src/sidepanel/sidepanel.test.ts` | T11 |
| U15 | `gated controls: controls return to hidden after STOP_SESSION` | `src/sidepanel/sidepanel.test.ts` | T11 |
| U16 | `reset button: rendered iff state is idle AND residual exists` | `src/sidepanel/sidepanel.test.ts` | T7, G3 |
| U17 | `reset button: click handler refuses if state has flipped to active since render` | `src/sidepanel/sidepanel.test.ts` | T7, G3 |
| U18 | `loading state: stop & download button enters loading on click, returns to idle on reject` | `src/sidepanel/sidepanel.test.ts` | T9, G8 |
| U19 | `loading state: save annotation enters loading on click, returns to idle on reject, error visible` | `src/sidepanel/sidepanel.test.ts` | T9, G8 |
| U20 | `loading state: capture screenshot enters loading on click, returns to idle on reject` | `src/sidepanel/sidepanel.test.ts` | T9, G8 |
| U21 | `auto-scroll: predicate is evaluated BEFORE the row is appended (not after)` | `src/lib/sidepanel-render.test.ts` | T10, G9 |
| U22 | `auto-scroll: new events chip shown when user scrolled up, hidden at bottom` | `src/sidepanel/sidepanel.test.ts` | G9 |
| U23 | `agents-doc: AGENTS_MD_EVENT_TYPES set-equals TimelineEvent union (extended for new variants)` | `src/lib/agents-doc.test.ts` | T4, G6 |
| U24 | `exporter: schema_version is "1.2.0"` | `src/lib/exporter.test.ts` | G6 |
| U25 | `exporter: session_paused/session_resumed events round-trip through buildSummary` | `src/lib/exporter.test.ts` | G6 |
| U26 | `screenshot: timestamp is set at start, not at append (so a screenshot started before pause sorts before the marker)` | `src/background/screenshot.test.ts` | T6 |
| U27 | `pause then resume: timeline contains [session_paused, session_resumed] in order` | `src/background/service-worker.test.ts` | G5 |
| U28 | `discard with no in-flight session (storage already empty): SW returns discarded=true as no-op` | `src/background/service-worker.test.ts` | (eviction recovery) |

### 9.2 Integration tests

| # | Test | File | Pins |
|---|------|------|------|
| I1 | `discard end-to-end: click discard, confirm, storage cleared, panel transitions to idle.clean` | `src/sidepanel/sidepanel.test.ts` (with full mock chrome) | T1, G1 |
| I2 | `discard cancel end-to-end: click discard, click cancel, storage byte-identical, panel still active` | `src/sidepanel/sidepanel.test.ts` | T1, T3, G1, G7 |
| I3 | `pause then resume: debugger detached then reattached, status field updated both times` | `src/background/service-worker.test.ts` | T5, T12 |
| I4 | `pause-evict-resume: SW state survives via storage status field` | `src/background/service-worker.test.ts` | T5, G4 |
| I5 | `reset with stale storage: session was just stopped, panel sees both end_time set and residual events; click reset → cleared` | `src/sidepanel/sidepanel.test.ts` | G3 |

### 9.3 E2E tests (Playwright)

E2E is expensive and the codebase keeps it tight (only `e2e/session.spec.ts`
and `e2e/sidepanel-debug.spec.ts` exist today). New e2e coverage is limited
to the three flows that genuinely need a real Chrome:

| # | Test | File | Pins |
|---|------|------|------|
| E1 | `discard flow: start session, capture events, discard, confirm, verify storage empty via SW evaluate` | `e2e/session.spec.ts` (extend) | T1, G1 |
| E2 | `discard cancel flow: start session, click discard, click cancel, verify storage unchanged via SW evaluate` | `e2e/session.spec.ts` | T1, T3, G7 |
| E3 | `pause/resume markers in real export: start session, pause, resume, stop, download, verify session.json contains both markers` | `e2e/session.spec.ts` | G5, G6 |

These three e2e tests are additive to existing coverage and reuse the
existing fixture. Each does one full auth/start/stop cycle so the cost is
bounded.

### 9.4 Existing tests at risk

The following existing tests will need updates because the schema changed:

- `src/lib/exporter.test.ts` — schema_version assertion
- `src/lib/agents-doc.test.ts` — set-equality test for new event types
- `src/lib/session-store.test.ts` — getSession default status field
- `src/sidepanel/sidepanel.test.ts` — pause/resume tests must now assert
  marker writes, not just flag flips

None of these are deletions, just extensions.

---

## 10. Rollback & forward-fix plan

### 10.1 Rollback triggers

Roll back if any of the following are observed within 24h of merge:

- A user reports losing session data after clicking Cancel on a Discard
  dialog (T1/T3 fired in production despite tests).
- A user reports a stuck Stop & Download button that never recovers (T9/G8
  fired).
- An AI consumer with a known-good parser fails to parse a `1.2.0` export
  (T4 fired despite the agents.md update).
- The CDP debugger fails to reattach after a Resume in >1% of sessions in
  manual testing (T12).

Roll back if two or more of these are observed within 7 days:

- Reset button appears when a session is active (T7 fired).
- Pause marker missing from an export that the user reports they paused
  (T8 fired).

### 10.2 Rollback steps

This feature ships as a single PR. Rollback is `git revert <merge-commit>`
followed by a patch release.

```
git revert -m 1 <merge-commit-sha>
make typecheck
make test
make build
make bump-patch
git tag -a vX.Y.(Z+1) -m "vX.Y.(Z+1) — revert feature #11"
git push origin main --tags
```

The schema bump complicates this slightly: any user who exported a `1.2.0`
zip during the brief feature-11 window will have a zip whose schema does
not match the post-revert extension version. Since DeskCheck only writes
exports (never reads them), the post-revert extension is unaffected. The
user's existing zip is still valid and self-documenting via its embedded
`agents.md` — that is the entire point of the per-zip schema doc. **The
schema bump is forward-only and the embedded agents.md is the rollback
escape hatch.**

In-flight sessions in storage at revert time: a session with
`status: "paused"` lives in `chrome.storage.local`. The reverted code does
not know about `status` and ignores it. The session continues to behave as
"running" (the legacy default in old code). The user will see a slightly
weird panel state — Resume button disabled, Pause button enabled — but no
data is lost. They can Stop normally.

In-flight sessions with `session_paused` / `session_resumed` events in the
events array: the reverted code's `agents-doc.ts` set-equality test does
not have these in `AGENTS_MD_EVENT_TYPES`, but the runtime behaviour is
that they pass through `getEvents()` as opaque blobs. They appear in
`session.json` of the next export. AI consumers see unknown event types
and (per their robustness) skip them. The exporter does not crash on them
because `buildSummary` switches on type and falls through unknown types
silently — verify this in the revert PR by adding a test.

### 10.3 Forward-fix plan

If a bug is discovered post-merge that does NOT trigger rollback (e.g.,
auto-scroll jank, loading state cosmetic issue), the forward-fix path is:

1. File an issue with the threat ID (e.g., "T10 fired in production").
2. Patch the offending code, add a regression test pinning the bug.
3. Bump patch version, no schema change.

If a bug is in the schema migration itself (e.g., legacy session doesn't
default to `running` correctly), the forward-fix is:

1. Patch `getSession()` legacy compat.
2. Add a regression test loading a fixture session that lacks the new field.
3. **Do NOT bump schema_version** — the schema is unchanged, only the
   reader's tolerance changed.

If a bug is in how a marker is written (e.g., marker missing on rapid
pause/resume), the forward-fix is:

1. Patch the SW handler.
2. Add an integration test reproducing the rapid sequence.
3. Bump patch version, no schema change. Markers are still 1.2.0; the bug
   was that they weren't being written.

### 10.4 Telemetry / debugging hooks

DeskCheck has no telemetry pipeline today and the plan does not add one.
The debugging surface for feature #11 issues is:

- **The export itself.** The new `status` field and `session_paused` /
  `session_resumed` markers are debug aids for any future bug report. A
  user can send their session zip and the markers will tell us exactly
  what state they were in.
- **`console.warn` / `console.error` logs in the SW.** Existing pattern.
  `[DeskCheck] PAUSE: marker write failed`, etc. The user can paste from
  the SW console (`chrome://extensions` → DeskCheck → service worker
  inspector).
- **The visibility report buffer in the SW**
  (`__deskcheckVisibilityReports` on globalThis, `service-worker.ts:36-39`).
  Already used by e2e tests; can be inspected via the SW DevTools for
  manual debugging.

No new telemetry. The debugging hooks are passive and self-documenting.

---

## 11. Risks retained

These are risks the plan does not eliminate, with rationale.

| # | Risk | Why retained | Compensating control |
|---|------|--------------|----------------------|
| R1 | After SW eviction during a `running` session, the CDP debugger does not reattach until the next user action. CDP events between eviction and reattach are lost. | Pre-existing limitation, not introduced by feature #11. Fixing it is its own feature (call it "lazy CDP reattach on wake"). | The status field correctly distinguishes intentional pause from eviction-detached, so a future fix can target the right case. |
| R2 | Mid-pause SW eviction (between marker write and `updateSessionStatus`) leaves a marker in the events array but `status` still `running`. The export is mildly inconsistent. | Atomic write across two storage keys is not provided by chrome.storage.local. We could batch via a single set() with a wrapper object, but that's a bigger refactor than feature #11 should take on. | The marker existing is harmless — it represents an intent to pause that succeeded structurally. The export is interpretable. |
| R3 | A user on a Chrome version without `chrome.sidePanel` (pre-114) cannot use feature #11 at all. | Existing requirement of feature #8. | Documented in README. |
| R4 | A malicious or buggy page-side script that fires synthetic clicks on the panel buttons via the runtime message channel. | Sidepanel buttons live in extension-privileged context; page scripts cannot reach them via DOM. They CAN send messages to the SW via `chrome.runtime.sendMessage` only if the extension is `externally_connectable`, which it is not. | Verified by manifest inspection — no `externally_connectable` field. |
| R5 | A power user clicks Discard, the Confirm button, and the storage clear succeeds but the panel's `transitionToIdle()` is delayed by 200ms. During that window the user sees an empty events list but the controls still show "active" state. | Acceptable cosmetic glitch. The storage IS empty; no action they take is destructive. | The window is bounded by the storage onChange roundtrip, typically <50ms. |
| R6 | A future contributor adds a new TimelineEvent variant without updating the lifecycle marker handling. | Compile-time guards in `agents-doc.ts` and `sidepanel-render.ts` will fail typecheck. | Pinned by U23 (set equality) and the existing exhaustive switch guards. |
| R7 | The discard confirmation count is computed from a fresh storage read, but the user is racing the SW: a CDP event lands between the snapshot fetch and the user clicking Confirm. The discarded data has one more event than the dialog said. | Acceptable. The dialog says "approximately N events"; off-by-one in a race is well within human tolerance for a destructive action that the user has already opted into. We could lock event capture during the dialog but that's heavier than the risk warrants. | (Optional, not required) — change dialog text from "Delete N events" to "Delete N+ events". Decided NOT to because the precise number is more useful than honest fuzziness. |

---

## Architecture Impact

**Components affected:**

- `src/sidepanel/sidepanel.ts` — adds discard dialog, gated control rendering,
  reset button, loading-state machinery, auto-scroll fix
- `src/sidepanel/sidepanel.css` — discard dialog styles, loading spinner,
  new-events chip
- `src/sidepanel/index.html` — no change (existing root container)
- `src/background/service-worker.ts` — new DISCARD_SESSION and
  GET_DISCARD_SNAPSHOT message handlers; PAUSE/RESUME extended with marker
  writes, debugger detach/reattach, status persistence; restoreState
  rehydrates paused from status
- `src/lib/session-store.ts` — `updateSessionStatus()` helper; `getSession()`
  legacy compat for missing status
- `src/lib/exporter.ts` — schema_version literal updated (via re-export from
  agents-doc)
- `src/lib/agents-doc.ts` — SCHEMA_VERSION bump, AGENTS_MD body updated,
  exhaustive guard extended
- `src/lib/sidepanel-render.ts` — exhaustive guard extended, new event labels
- `src/types.ts` — `SessionMetadata.status` field, `SessionPausedEvent` and
  `SessionResumedEvent` interfaces, new entries in `Message` union for
  DISCARD_SESSION and GET_DISCARD_SNAPSHOT, schema_version literal updated
- `src/background/screenshot.ts` — timestamp is set at call site, not
  append site

**New patterns or abstractions introduced:**

- "Storage as ground truth" rule for state queries that drive destructive
  actions. Pinned by tests.
- Pre-flip marker write order: marker → flag → status. Pinned by U7, U8.

**Dependencies added or modified:**

- None — no new npm packages.

**Breaking changes to existing interfaces:**

- `schema_version` literal type updated from `"1.1.0"` to `"1.2.0"` — this is
  a TypeScript-level break for any consumer that imported the literal type
  but no users currently do (only in-tree).
- `SessionMetadata` gains a required `status` field; existing storage
  data without it is accommodated by the legacy compat in `getSession()`.

**Risk points in architecture this task touches:**

- The discard path (new) — see §5
- The schema (bumped) — see §7
- The pause/resume state machine (extended) — see §6
- The SW restoreState path (extended) — see §8

---

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 1 | Add `status` field to SessionMetadata + getSession legacy compat + updateSessionStatus helper | U11, U12 pass; existing tests still pass | Single commit; revert reverts type + helper only |
| 2 | Bump SCHEMA_VERSION to 1.2.0; add session_paused/session_resumed event types and exhaustive guards | U23, U24 pass; typecheck passes | Single commit; revert restores 1.1.0 |
| 3 | Update agents.md body with new fields and event types | Manual inspection; agents-doc.test passes | Single commit |
| 4 | Extend PAUSE_SESSION / RESUME_SESSION SW handlers with marker writes, debugger detach/reattach, status persistence | U7, U8, U27, I3 pass | Single commit; revert restores naïve flag-only behaviour |
| 5 | Extend restoreState to rehydrate paused from storage status | U9, U10, I4 pass | Single commit |
| 6 | Update takeScreenshot to set timestamp at call start | U26 passes | Single commit |
| 7 | Add DISCARD_SESSION + GET_DISCARD_SNAPSHOT SW handlers | U6, U28 pass | Single commit |
| 8 | Add discard dialog DOM + click handler in sidepanel.ts (controls hidden behind a flag) | U1-U5 pass | Single commit |
| 9 | Switch sidepanel to hide-not-disable model for all gated controls | U13-U15 pass | Single commit; large but contained to sidepanel.ts |
| 10 | Add Reset button + storage-fresh predicate | U16, U17, I5 pass | Single commit |
| 11 | Add loading state machinery to Save/Screenshot/Stop | U18-U20 pass | Single commit |
| 12 | Fix auto-scroll predicate ordering + add new-events chip | U21, U22 pass | Single commit |
| 13 | Add e2e tests E1-E3 | E2E green | Single commit |
| 14 | Manual smoke test in dist build: full pause/resume/stop, discard cancel, discard confirm, reset | Manual checklist | None — verification step |

Each phase is committable in isolation. If a phase fails its safety check,
back up to the previous commit before proceeding.

---

## Files to Create/Modify

| File | Purpose | Risk Notes |
|------|---------|------------|
| `src/types.ts` | Add `status` to SessionMetadata, add SessionPausedEvent/SessionResumedEvent, extend Message union, bump schema_version literal | Type-level break; controlled by exhaustive guards |
| `src/lib/session-store.ts` | Add `updateSessionStatus()`, extend `getSession()` legacy compat | Legacy compat must default `status` correctly for pre-feature-11 storage |
| `src/lib/agents-doc.ts` | Bump SCHEMA_VERSION to 1.2.0, extend AGENTS_MD_EVENT_TYPES, extend assertExhaustiveEventTypes, update AGENTS_MD body | Schema is the product contract — review carefully |
| `src/lib/exporter.ts` | No code change; picks up SCHEMA_VERSION via existing import | None |
| `src/lib/sidepanel-render.ts` | Extend assertExhaustiveSidePanelEvent, eventTypeLabel, eventDetail, eventAccent | Compile-time guard prevents drift |
| `src/background/service-worker.ts` | Extend PAUSE/RESUME handlers; add DISCARD/GET_DISCARD_SNAPSHOT; rehydrate paused in restoreState | Most code added in this feature lives here; bug surface is largest here |
| `src/background/screenshot.ts` | Move timestamp capture to start of takeScreenshot | Tiny diff but pinned by U26 |
| `src/sidepanel/sidepanel.ts` | Discard dialog, gated controls, reset, loading states, auto-scroll fix | Largest UI surface change; covered by ~20 unit tests |
| `src/sidepanel/sidepanel.css` | Dialog and chip styles | Cosmetic |
| `src/sidepanel/sidepanel.test.ts` | Add tests U1-U5, U13-U22, I1-I2, I5 | Test debt |
| `src/lib/session-store.test.ts` | Add U11, U12 | Test debt |
| `src/lib/agents-doc.test.ts` | Update set-equality fixture for new event types | Pinned guard |
| `src/lib/exporter.test.ts` | Add U24, U25 | Pinned guard |
| `src/lib/sidepanel-render.test.ts` | Add U21 | Auto-scroll fix |
| `src/background/screenshot.test.ts` | Add U26 | Timestamp ordering |
| `src/background/service-worker.test.ts` | NEW FILE — adds U6, U7, U8, U9, U10, U27, U28; I3, I4 | First service-worker unit test file |
| `e2e/session.spec.ts` | Add E1, E2, E3 | E2E cost |
| `docs/roadmap.md` | Tick boxes for feature #11 DoD items | Documentation |

---

## Definition of Done

- [ ] All threats T1-T12 have at least one test pinning the mitigation
- [ ] All guarantees G1-G10 are tested
- [ ] schema_version bumped to 1.2.0 in `agents-doc.ts` and `types.ts`
- [ ] `agents.md` body documents `status` field and both new event types
- [ ] Discard dialog default-focuses Cancel
- [ ] Discard cancel makes ZERO storage writes (spy-pinned)
- [ ] Discard confirm count sourced from storage, not from in-memory state
- [ ] Pause writes a marker BEFORE flipping the flag (await-ordered)
- [ ] Pause detaches the debugger; Resume reattaches it
- [ ] `restoreState()` rehydrates `paused` from `STORAGE_SESSION.status`
- [ ] Reset button is unreachable while a session is active
- [ ] Reset button click handler defensively re-checks state
- [ ] Hide-not-disable: idle-state DOM contains zero lifecycle controls
- [ ] Loading buttons resolve in finite time on both success and error
- [ ] Errors from async handlers persist in a status line until next action
- [ ] Auto-scroll predicate evaluates BEFORE the new row is appended
- [ ] New tests pass: U1-U28, I1-I5, E1-E3
- [ ] Existing tests still pass after schema bump
- [ ] `make typecheck` passes
- [ ] `make test` passes
- [ ] Manual smoke test in `make build` artifact: pause-resume-stop cycle,
      discard cancel, discard confirm, reset, all loading states
- [ ] Manifest version bumped via `make bump-minor` (this is a minor feature
      release; schema also goes minor)
- [ ] `package.json` and `manifest.json` versions match

---

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Discard cancel writes nothing | Unit (jsdom) | Pure spy assertion on chrome.storage.local mock; no need for real Chrome |
| 2 | Discard count sourced from storage | Unit | Spy on sendMessage, verify GET_DISCARD_SNAPSHOT is called and its return drives the dialog text |
| 3 | Discard atomic remove (single transaction) | Unit | Spy on chrome.storage.local.remove; assert called exactly once with all three keys |
| 4 | Discard end-to-end with real Chrome | E2E | The atomic-storage guarantee is a Chrome API contract; worth one e2e to confirm it actually behaves atomically in production Chrome |
| 5 | Pause writes marker before flag flip | Unit | Order-of-operations check via spies on appendEvent and a getter on `paused` |
| 6 | Pause detaches debugger | Unit | Spy on debuggerClient.detach |
| 7 | Pause persists status to storage | Unit | Mock chrome.storage.local, assert set called with status: "paused" |
| 8 | restoreState rehydrates paused from status | Unit | Pre-populate fake storage, call restoreState, assert global `paused` is true |
| 9 | Pause-evict-resume cycle | Integration (Vitest with mock chrome) | Spans SW lifecycle simulation; integration is the right size |
| 10 | Real pause/resume markers in actual export zip | E2E | Verifies the schema change ships through the full pipeline including fflate; one e2e is correct |
| 11 | Reset hidden during active session | Unit | DOM presence check |
| 12 | Reset click handler refuses if state changed | Unit | Race simulation via direct call manipulation |
| 13 | Hide-not-disable: idle DOM has no discard button | Unit | querySelector returns null |
| 14 | Loading button resolves on error | Unit | Reject the mocked sendMessage; assert button class transitions back |
| 15 | Auto-scroll predicate evaluated before append | Unit | Pure function test on `shouldAutoScroll` plus a jsdom test on the order of operations |
| 16 | agents.md set-equality with TimelineEvent union | Unit | Existing pattern in agents-doc.test.ts |
| 17 | schema_version is 1.2.0 in exported zip | Unit | Existing exporter.test.ts pattern |
| 18 | Legacy session without status field defaults correctly | Unit | Pure function test on getSession's compat path |

**Determinism rule:** all tests above are deterministic. None call live LLM
APIs (DeskCheck has no LLM integration). The only Chrome boundary is mocked
at the chrome.* API level via the existing harness in `sidepanel.test.ts`
and the new in-memory fake in the proposed `service-worker.test.ts`. The
three e2e tests are deterministic against a real Chromium fixture and use
the existing Playwright harness in `e2e/fixtures.ts`.

---

## Testing Strategy (Comprehensive)

### Unit tests
See §9.1 — 28 tests.

**Edge cases:**
- Session with zero events at discard time ("Delete 0 events and 0 screenshots?" — must read naturally)
- Session with one event vs many ("event" vs "events" pluralisation)
- Pause then immediately Stop — marker written, then end_time set, marker is preserved in export
- Resume after a pause that was followed by SW eviction — debugger reattaches successfully
- Discard while a screenshot is mid-flight — the screenshot's append races with the storage clear; the storage clear wins because remove() is atomic
- Reset clicked while Discard dialog is open — should not be possible because Reset is hidden during active state and the dialog is only opened from active state, but defensive: dialog blocks pointer events on the rest of the panel via z-index

### Integration tests
See §9.2 — 5 tests.

### E2E tests
See §9.3 — 3 tests.

**E2E Test Impact:**
- **Existing e2e tests affected:** `e2e/session.spec.ts` — exporting tests
  must be updated to expect schema_version 1.2.0 in the resulting zip
- **New e2e tests needed:** E1, E2, E3 (discard confirm, discard cancel,
  pause/resume markers in real export)
- **Cost note:** Each e2e does a full session start/stop cycle. Three new
  tests is acceptable. We avoid e2e for: gated control DOM presence (jsdom
  unit is enough), loading states (jsdom unit is enough), auto-scroll
  (pure function), schema migration (unit on the literal).

### Regression tests
- All existing pause/resume tests in `sidepanel.test.ts` still pass after
  the marker addition (they assert on the badge, not on the marker count;
  they will need extension to also assert markers)
- `e2e/session.spec.ts` existing flows still work after the schema bump
- `tests/sidepanel-no-direct-capture.test.ts` still passes (the privacy
  invariant — sidepanel does not import privileged Chrome APIs)
- `tests/popup-removed.test.ts` still passes
- `e2e/sidepanel-debug.spec.ts` still passes (the bind-on-open invariant)

### Load/stress tests
- Not applicable for this feature. Pause/resume cycles are user-initiated
  and cap at human click rates. The discard atomic clear is bounded by the
  storage size, which feature #1 already monitors.

**Test files to create/modify:**
- NEW: `src/background/service-worker.test.ts`
- MODIFY: `src/sidepanel/sidepanel.test.ts`, `src/lib/session-store.test.ts`,
  `src/lib/agents-doc.test.ts`, `src/lib/exporter.test.ts`,
  `src/lib/sidepanel-render.test.ts`, `src/background/screenshot.test.ts`,
  `e2e/session.spec.ts`

---

## Rollback Strategy

See §10.1 and §10.2 above.

### Trigger Conditions
When to rollback:
- User reports session data lost after Cancel-discard (T1/T3)
- Stop & Download stuck-loading (T9/G8)
- AI consumer cannot parse 1.2.0 export (T4)
- Reset visible during active session (T7) + one other anomaly within 7d

### Rollback Steps
1. `git revert -m 1 <merge-commit-sha>`
2. `make typecheck && make test && make build`
3. `make bump-patch`
4. Tag and push
5. Manual verification: load reverted dist, confirm in-flight session with
   `status: "paused"` in storage degrades to "running" and still works

### Verification After Rollback
- [ ] Existing 1.1.0 exports parse
- [ ] In-flight pre-revert sessions still work (legacy compat goes the
      other way: NEW session with status field, OLD code that ignores it)
- [ ] No data lost in any in-flight session

### Rollback Tested?
- [ ] No, but the revert plan is documented and the schema bump is forward-only
      so the worst case is "stale schema field in user storage that the
      reverted code ignores". To test before merge: load the dist build,
      start a session, pause it, copy `chrome.storage.local` to a backup,
      load the previous dist build, verify the session continues from
      `running` state.

---

## Monitoring & Alerting

DeskCheck has no production monitoring. The only signals are:

| Signal | Source | Threshold |
|--------|--------|-----------|
| User bug reports | GitHub issues, the developer's own use | Any report mentioning "lost session" or "discard" → investigate immediately |
| Manual smoke test post-merge | The developer using the extension on real bugs | Any unexpected state → investigate |

No automated alerting is configured. None is added by this feature.

---

## Deployment Recommendations

- [ ] **Feature flag**: Not needed. The feature is a coherent UI ship; gating
      half of it would create more risk (mismatched state machines) than it
      reduces.
- [ ] **Gradual rollout**: Not applicable — Chrome web store extension. Users
      either have the version or they don't.
- [ ] **Staging verification**: Required. Manual smoke test against the
      `make build` artifact loaded into Chrome before tagging.
- [ ] **Off-hours deployment**: Not applicable for an unlisted local extension.
      For a future Web Store publish: not required.

---

## Estimated Effort

- Planning: Already done (this document).
- Implementation: ~280 minutes
  - Phase 1-3 (schema): 30 min
  - Phase 4-6 (pause/resume + screenshot): 60 min
  - Phase 7-8 (discard SW + dialog): 60 min
  - Phase 9 (gated controls hide-not-disable): 50 min
  - Phase 10 (reset): 20 min
  - Phase 11 (loading states): 30 min
  - Phase 12 (auto-scroll): 30 min
- Safety verification (writing the new tests): ~180 minutes
  - 28 unit tests × ~4 min average = 112 min
  - 5 integration tests × ~8 min = 40 min
  - 3 e2e tests × ~10 min = 30 min
- Manual smoke test + rollback rehearsal: ~20 minutes
- **Total**: ~480 minutes (8 hours of focused work)

This is heavier than the speed plan would estimate. The overhead is the
test count and the marker-write order discipline. It is not over-
engineering: T1, T2, T3, T4 are all credible and the cost of any one of
them firing in production is "user loses recorded debugging work", which
exceeds the test cost by a large margin.

---

## Formal Verification Assessment

- **Concurrency concerns**: Yes, mild. The SW message handlers run sequentially
  (chrome.runtime.onMessage is single-threaded per message), but the
  panel-SW round-trip plus storage onChanged events create the appearance
  of concurrency. The discard race ("user clicks Discard, CDP event lands,
  user confirms") is the most credible concurrent scenario.
- **State machine complexity**: Yes. Five panel states (idle.clean,
  idle.residual, active.running, active.paused, transient.discard_confirm)
  plus the SW's persisted status. 5 states × ~7 transitions ≈ 35
  state-transition pairs. Below the threshold where TLC pays for itself.
- **Conservation laws**: Yes — "every event captured before Stop or
  Discard is either exported or discarded with user consent". This is the
  invariant that motivates the entire safety plan.
- **Authorization model**: No — single-user local extension, no roles.
- **Recommendation**: Formal verification NOT recommended. The state space
  is small enough to test exhaustively at the unit level (28 tests cover
  the 5×7 state-transition matrix with room to spare). The conservation
  law is enforced structurally by "storage as ground truth" plus the
  atomic remove. Investing in TLA+ here would buy 2-3% more confidence at
  10x the effort.
- **Key invariants** (informal, in business language):
  1. No event capture from a paused session unless the user explicitly
     triggered it (manual screenshot, manual annotation).
  2. Cancel-discard preserves storage byte-perfectly.
  3. Confirmed discard removes session, events, and screenshots in a
     single storage transaction.
  4. Pause/resume markers are present in every export that experienced
     a pause.
  5. Reset is unreachable while a session is active.

---

## Security Considerations

- [x] No secrets in code — none added
- [x] Input validation complete — discard dialog has no user-typed input
- [x] Output encoding where needed — dialog uses textContent, not innerHTML
      (the existing pattern in sidepanel.ts is no-innerHTML; preserved)
- [x] Authentication/authorization verified — single-user local extension
- [x] OWASP top 10 considered — A03 (Injection): no string concatenation
      into HTML; A05 (Security misconfiguration): manifest unchanged;
      A08 (Software and data integrity failures): the schema bump and the
      storage remove are the relevant surfaces, both pinned by tests
- [x] Discard does not expose data via clipboard, network, or filesystem —
      it only removes from chrome.storage.local
- [x] Pause/resume markers do not leak sensitive data — the marker is just
      `{type, seq, timestamp, page_url}`, no payload
- [x] Schema documentation in agents.md does not embed any session data
      (existing structural invariant in agents-doc.ts:55-61)
