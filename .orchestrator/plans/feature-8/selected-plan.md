---
agent: plan-judge
generated: 2026-04-07T00:00:00Z
task_id: feature-8
selected: quality
base: quality-plan
grafts: [safety.manifest-regression, safety.append-only-invariant, safety.placeholder-thumbnails, safety.cross-window, safety.state-machine, safety.setPanelBehavior-on-wake, safety.sidepanel-no-direct-capture]
rejects: [speed.no-jsdom, safety.six-state-machine, safety.draft-persistence, safety.privacy-gate-blocking-modal]
---

# Plan Evaluation: Side Panel UX with Live Event Timeline (feature-8)

## Executive Summary

The **Quality plan** is selected as the base because it honors DeskCheck's established "pure module + thin glue" layering, mirrors the existing `assertExhaustiveEventTypes` compile-time guard pattern from `agents-doc.ts`, and uses the right test shape for this codebase (pure unit + one jsdom integration). Six targeted grafts from the Safety plan harden the privacy-sensitive paths without dragging in Safety's full 17-risk, 10-phase, 6-state overhead.

## Plans Evaluated

### Speed Plan Summary
- **Core approach**: Minimal diff — delete popup, drop a single new `src/sidepanel/` entrypoint, reuse `chrome.storage.onChanged` directly, one pure helper module.
- **Estimated effort**: ~150 min
- **Key tradeoff**: Skips the `never`-fallback exhaustive mapper (weaker compile-time safety as `TimelineEvent` evolves), inlines the render logic, and proposes no privacy hardening for the screenshot thumbnail surface.

### Quality Plan Summary
- **Core approach**: Pure modules (`sidepanel-render.ts`, `sidepanel-storage.ts`, `sidepanel-events-source.ts`) with injectable seams, plus a thin glue layer (`sidepanel.ts`). Compile-time exhaustiveness guard, scroll persistence in `chrome.storage.session`, shared pure `privacy-notice.ts` to eliminate widget/side panel copy drift.
- **Estimated effort**: ~350 min
- **Key tradeoff**: More files and ceremony; one small widget refactor (Option A) to share the first-run notice model — low-risk but non-zero surface.

### Safety Plan Summary
- **Core approach**: 17-threat model, 10 phased commits, 6-state machine, placeholder-by-default screenshot thumbnails, blocking first-run modal, append-only invariant pinning, manifest regression test, grep-based "no direct capture" test, cross-window fetch on focus change.
- **Estimated effort**: ~360 min
- **Key tradeoff**: Over-engineers the state machine (6 states where 2 suffice for this feature), proposes a hard blocking modal that duplicates a gate the SW already enforces, and introduces an annotation-draft persistence path with non-trivial UX complexity. Several of its tests re-verify things the existing codebase already covers.

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|-----------|--------|-------|---------|--------|-------|
| Correctness (covers every DoD) | — | 3.5 | 4.5 | 4.5 | All three cover DoD; Quality + Safety add exhaustive guarantees. |
| Risk management | 25% | 2.5 | 3.5 | 5.0 | Safety is paranoid. Quality fine for non-privacy risks but misses thumbnail leak on stop. |
| Test coverage | 15% | 2.5 | 4.5 | 5.0 | Speed skimps; Quality hits the pyramid; Safety has ~70 tests (some over-scoped). |
| Maintainability | 15% | 3.0 | 5.0 | 3.5 | Quality wins on abstraction hygiene. Safety's 10+ new files in `src/sidepanel/` feels heavy. |
| Speed of delivery | 20% | 5.0 | 3.0 | 2.5 | Speed is fastest; Quality and Safety similar. |
| Reversibility | — | 5.0 | 4.5 | 5.0 | All are single-revert because pre-launch. Safety explicitly phases commits. |
| **Weighted Total** (Risk 25 + Quality 25 + Tests 15 + Maint 15 + Speed 20) | 100% | **3.30** | **4.13** | **4.08** | Quality edges out Safety on maintainability and speed. |

(Correctness and Reversibility shown for transparency; they are absorbed into the other weights.)

## Context Analysis

| Factor | Assessment | Impact |
|--------|------------|--------|
| Urgency | Medium — planned roadmap work, not a hotfix. | No pressure to ship the minimal plan. |
| Blast radius | Low (pre-launch, no users) for popup removal; Medium for privacy regressions in a core product value. | Favor quality baseline with targeted safety grafts on privacy paths. |
| Code area | Core (new primary UI surface; touches manifest, SW boot, privacy surface). | Quality plan's layering matches codebase conventions. |
| Technical debt | Low today. Quality plan removes a latent "copy drift" risk between widget and side panel. | Quality's `privacy-notice.ts` refactor is a real debt reduction. |
| User visibility | Highest — side panel is the product's front door. | Quality wins on polish and compile-time future-proofing. |
| Formal verification need | None — small state space, append-only storage, no concurrency on writes. | Skip TLA+/TLC. |

## Recommendation

### Selected Plan: Quality (with targeted Safety grafts)

### Rationale
DeskCheck already has a clear architectural personality: `src/lib/*` holds pure modules, `src/content/widget.ts`, `src/popup/popup.ts`, and `src/background/service-worker.ts` are thin glue. The Quality plan is the only one of the three that fully honors that personality — its `sidepanel-render.ts` + `sidepanel-events-source.ts` + `sidepanel-storage.ts` split with injectable seams is idiomatic for this codebase, and its exhaustive-mapper-via-`never` pattern is a direct mirror of `agents-doc.ts`. Where the Quality plan is weaker is privacy posture on the screenshot thumbnail surface and manifest regression hygiene — and those are exactly the areas where the Safety plan's grafts are cheap and surgical.

### Incorporated Elements from Other Plans

**From Safety plan (grafted in):**
- **Manifest regression test** (`tests/manifest-regression.test.ts`): pins `action.default_popup` absent, `side_panel.default_path` present, `sidePanel` permission present. Cheap, high-leverage.
- **Append-only delta invariant test**: a unit test for `session-store.appendEvent` asserting `newEvents.slice(0, oldLen)` deep-equals `oldEvents`. Guards feature #5 (incremental persistence) from silently breaking the side panel's delta subscription.
- **Placeholder-by-default screenshot thumbnails with click-to-reveal**: the Safety plan's strongest privacy argument. Safety rationale accepted verbatim — "I forgot the side panel was open and started a screen-share" is a realistic scenario, and placeholder-by-default is the only behavior that survives it.
- **Unmount thumbnails on STOP_SESSION**: remove revealed screenshots from the DOM (not just hide them) on session stop.
- **`setPanelBehavior` on every SW wake** (top-level, not only `onInstalled`): critical for correctness; the SW terminates and respawns constantly. The Quality plan technically calls it both places, but pin this in its own test to prevent regression.
- **Grep test for forbidden Chrome APIs in `src/sidepanel/`** (`tests/sidepanel-no-direct-capture.test.ts`): a 20-line guard that pins the "side panel never captures directly" invariant. Zero maintenance cost.
- **Cross-window refresh on focus change**: side panel re-fetches `GET_SESSION_STATE` on `chrome.windows.onFocusChanged` so window B reflects window A's active session.
- **Explicit 2-state machine** (idle / active, not Safety's 6 states): capture the Safety plan's idea of making state transitions explicit without the startingPrivacyBlocked/starting/stopping/error state bloat. Use a small `type SidePanelState = "idle" | "active"` plus a transient `inFlight: boolean` on the glue layer.

**From Speed plan (grafted in):**
- **Recompute metrics in-memory** from the cached events/screenshots in the side panel rather than polling `GET_SESSION_METRICS` every 2s. Avoids a redundant message round-trip; the data is already in memory from the subscription. Keep the 1s duration timer for the REC clock but not the metrics poll.
- **Single inline PII fieldset** — don't extract a shared PII component; copy the markup from `popup/index.html` once (Quality plan already implies this but the Speed plan is explicit).

**Rejected from Speed plan:**
- **"No jsdom tests, just unit"** — rejected. The side panel is glue-heavy; storage→DOM update paths, scroll persistence, and first-run notice lifecycle need at least one jsdom integration test file.
- **Manifest snapshot only (no filesystem checks for popup removal)** — rejected in favor of Safety's stronger filesystem + grep pins.

**Rejected from Safety plan:**
- **6-state state machine** — over-engineered. The side panel has two real states (idle vs active). `starting`/`stopping` are sub-second loading flickers, and `error` is a toast/status-line concern, not a state. Graft the idea (explicit state type) but reject the complexity.
- **Blocking first-run privacy modal that disables Start until ack'd** — rejected as duplication. The existing widget already shows the notice on first recorded page, and Safety's own analysis notes that the flag is shared. Instead, render the notice **inline at the top of the side panel** when `getFirstRunSeen() === false` (Quality's approach), and let the existing widget gate remain the defense-in-depth. Adding a blocking modal means two independent privacy gates to maintain.
- **Annotation draft persistence** (Safety R14) — rejected. The side panel document survives tab switches within a window (platform guarantee), so draft survival is covered by the platform. Cross-window/cross-session draft survival is out of scope.
- **PII mode re-rendering rules in the side panel** (Safety R3) — rejected because the **SW already enforces PII mode at capture time** (feature #4). The side panel reading events trusts what was stored. Adding a second enforcement layer in the renderer is defense-in-depth but adds a privacy contract the side panel wasn't designed to own. Keep one source of truth.
- **Full `service-worker.test.ts` with 7 keyboard shortcut regression tests** (T44–T50) — rejected as over-scoped for this feature. Keyboard shortcuts are not part of feature #8's DoD. Keep T44/T45 (SW calls `setPanelBehavior` on wake) but defer the shortcut regression suite to its own hardening feature.

## The Selected Plan

### Architectural intent

DeskCheck's `src/lib/*` holds DOM-free, Chrome-free logic; surface layers wire these modules to Chrome. The side panel slots into this pattern: a new `src/sidepanel/` surface (glue only) mounted on top of three new pure lib modules (`sidepanel-render.ts`, `sidepanel-storage.ts`, `sidepanel-events-source.ts`) that are fully unit-testable without jsdom or Chrome. The event-type → row mapper reuses the `assertExhaustiveEventTypes` compile-time guard pattern from `agents-doc.ts`.

### Final scope — file-level changes

| File | Action | Purpose | Source |
|------|--------|---------|--------|
| `manifest.json` | modify | Add `side_panel.default_path`, `sidePanel` permission; remove `action.default_popup`. Bump version to `0.4.0`. | quality + safety |
| `package.json` | modify | Bump version to `0.4.0`. | safety |
| `src/background/service-worker.ts` | modify | Call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at top-level (every wake) with try/catch. | quality (with safety's wake-path emphasis) |
| `src/popup/index.html` | delete | Replaced by side panel. | all three |
| `src/popup/popup.ts` | delete | Replaced. | all three |
| `src/popup/popup.css` | delete | Replaced. | all three |
| `src/sidepanel/index.html` | create | Two-region skeleton: `<section id="events-list">` above `<section id="controls">`. | quality |
| `src/sidepanel/sidepanel.ts` | create | Thin glue: mount, wire callbacks, subscribe via `sidepanel-events-source`, delegate rendering to `sidepanel-render`, manage 2-state (`idle`/`active`) machine + `inFlight` flag, persist scroll, first-run notice inline, cross-window refresh on focus change. | quality + safety grafts |
| `src/sidepanel/sidepanel.css` | create | Dark theme per the Quality plan palette; `#events-list { flex: 1; overflow-y: auto }`, `#controls { flex: 0 0 auto }`. | quality |
| `src/lib/sidepanel-render.ts` | create | Pure: `eventToRow`, `eventTypeLabel`, `formatEventTimestamp(iso, now)`, `shouldAutoScroll`, `SidePanelEventRow` type, `assertExhaustiveSidePanelEvent` guard. Screenshot rows emit `{ placeholderId, dataUrl }` — glue layer decides whether to render `<img>` or placeholder based on `revealed: Set<string>`. | quality + safety graft (placeholder model) |
| `src/lib/sidepanel-storage.ts` | create | `getScrollPosition(windowId, sessionStorage?)`, `setScrollPosition(windowId, scrollY, sessionStorage?)` over `chrome.storage.session`. Rejects `windowId < 0`. | quality + safety R10 graft |
| `src/lib/sidepanel-events-source.ts` | create | `subscribeToEvents(callback, storageApi?)` wrapping `chrome.storage.onChanged`. Uses delta via cached `lastSeenLength`; non-append delta triggers full reset callback. **Never calls `getEvents()` in the change handler** — reads `change.newValue` directly (safety R4). | quality + safety R4/R5 grafts |
| `src/lib/privacy-notice.ts` | create | `buildFirstRunNoticeModel()` → `{ title, bullets, dismissLabel }`. Shared by widget and side panel. | quality (Option A) |
| `src/content/widget.ts` | modify | Small refactor: widget's existing notice renderer consumes the new `buildFirstRunNoticeModel()`. | quality |
| `src/constants.ts` | modify | Add `STORAGE_SIDE_PANEL_SCROLL_PREFIX = "deskcheck_sidepanel_scroll_"`. | quality |
| `src/lib/sidepanel-render.test.ts` | create | Pure unit tests: every event variant, exhaustive discriminator set, placeholder/reveal model, `shouldAutoScroll`, deterministic `formatEventTimestamp`. | quality |
| `src/lib/sidepanel-storage.test.ts` | create | Round trip, defaults, windowId validation (rejects `-1`), per-window key isolation, key prefix. | quality + safety R10 |
| `src/lib/sidepanel-events-source.test.ts` | create | Initial snapshot, append delta, non-append reset, key removal reset, unrelated keys ignored, unsubscribe, **"never calls `getEvents()` in change handler"** spy assertion. | quality + safety R4 |
| `src/lib/privacy-notice.test.ts` | create | View-model shape matches `PRIVACY_NOTICE_BULLETS`. | quality |
| `src/lib/session-store.test.ts` | modify (append cases) | Add the append-only invariant test: `appendEvent` preserves the prefix. | safety graft T20 |
| `src/sidepanel/sidepanel.test.ts` | create | jsdom integration: mount idle, mount active, live append, auto-scroll, scroll round-trip, first-run notice inline, PII mode → START_SESSION, session end transition, **thumbnail placeholder default + click to reveal**, **thumbnail unmount on STOP_SESSION**, **cross-window focus change refetches `GET_SESSION_STATE`**. | quality + safety grafts |
| `tests/manifest-regression.test.ts` | create | Pins manifest: no `default_popup`, `side_panel.default_path` set, `sidePanel` permission present, manifest/package versions match. | safety graft T61–T64 |
| `tests/popup-removed.test.ts` | create | Filesystem check: `src/popup/` does not exist, no file under `src/` imports from `src/popup/`. | quality + safety merged |
| `tests/sidepanel-no-direct-capture.test.ts` | create | Grep `src/sidepanel/**/*.ts` for forbidden APIs (`captureVisibleTab`, `chrome.debugger`, `chrome.scripting`) → zero matches. | safety graft T65–T67 |
| `tests/service-worker-setpanel.test.ts` | create (minimal) | Asserts SW module init calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` and tolerates rejection. **Only T44 + T45, not the full shortcut suite.** | safety graft (scoped) |
| `docs/ARCHITECTURE.md` | modify | Append Side Panel component block and updated data-flow diagram. | quality |

**Total**: 3 deletes, 14 creates, 6 modifies. Net ~1700 LOC added, ~214 removed.

### Architectural decisions (invariants)

1. **Exhaustive event-row mapper.** `eventToRow` in `sidepanel-render.ts` has a `default: const _: never = event` branch. Adding a new `TimelineEvent` variant to `src/types.ts` is a compile-time error until the side panel renderer handles it — identical discipline to `assertExhaustiveEventTypes` in `agents-doc.ts`.
2. **Append-only delta subscription.** `sidepanel-events-source.ts` uses `newValue.slice(lastSeenLength)` as the delta. Non-append deltas (shrink, undefined, reset) trigger a full re-render callback. The subscription handler **never calls `getEvents()` or any store accessor** — it reads `change.newValue` directly, pinned by a spy test (safety R4).
3. **Append-only contract pinned on the write side.** `session-store.test.ts` gains a test asserting `appendEvent` preserves the prefix. When feature #5 (incremental persistence) lands, this test must either continue to pass or the subscription helper must be updated in the same PR.
4. **Placeholder-by-default screenshot thumbnails.** The side panel never renders `<img src="data:...">` until the user explicitly clicks the placeholder. On `STOP_SESSION`, the `revealed` set is cleared and all rendered thumbnails are re-rendered as placeholders (or unmounted entirely). Pinned by the integration test.
5. **`setPanelBehavior` on every SW wake.** Top-level in `service-worker.ts`, not inside `onInstalled`. Wrapped in `.catch()` — transient API failures never crash the SW. Pinned by `tests/service-worker-setpanel.test.ts`.
6. **No direct capture from the side panel.** `src/sidepanel/**/*.ts` never imports `chrome.tabs.captureVisibleTab`, `chrome.debugger`, or `chrome.scripting`. Pinned by a grep-based test.
7. **Single privacy-notice source of truth.** `buildFirstRunNoticeModel()` in `src/lib/privacy-notice.ts` is the only source of notice copy. The widget and side panel both render from this model. `privacy-notice.test.ts` pins the bullets match `PRIVACY_NOTICE_BULLETS`.
8. **2-state machine**, not 6. `type SidePanelState = "idle" | "active"`; button disable during message round-trips uses a transient `inFlight` boolean on the glue layer. Transitions driven by `session.end_time` flipping or by `START_SESSION` ack.
9. **Inline first-run notice, not a blocking modal.** Rendered at the top of the side panel when `getFirstRunSeen() === false`; dismisses via `markFirstRunSeen()`. The existing widget-side gate remains as defense-in-depth.
10. **No PII re-enforcement in the renderer.** The SW is the single enforcement point for PII mode at capture time (feature #4). The side panel renders whatever is in storage.

### Implementation order (phased commits)

Each phase is a separate commit and independently revertable. Phases 1–5 are additive (popup still works if you load unpacked). Phase 6 is the point of no return.

| Phase | Action | Safety check | Revertable? |
|-------|--------|--------------|-------------|
| 1 | Create pure lib modules: `sidepanel-render.ts`, `sidepanel-storage.ts`, `sidepanel-events-source.ts`, `privacy-notice.ts`. Write their unit tests. Refactor widget to consume `privacy-notice.ts`. | `make typecheck && make test` — all new unit tests pass; widget tests still pass. | Yes |
| 2 | Add the append-only invariant test to `session-store.test.ts`. | Test passes against unchanged `session-store.ts`. | Yes |
| 3 | Create `src/sidepanel/` (index.html, sidepanel.ts, sidepanel.css). Wire mount, state machine, subscription, render. Do NOT touch manifest yet — side panel is unreachable but buildable. | `make build` succeeds; popup still loads. | Yes |
| 4 | Modify `manifest.json` to ADD `side_panel.default_path` + `sidePanel` permission (without removing `default_popup`). Add top-level `setPanelBehavior` call in SW. Write `tests/service-worker-setpanel.test.ts`. | Both popup and side panel accessible; toolbar click opens popup (Chrome precedence), omnibox opens panel. | Yes |
| 5 | Write `src/sidepanel/sidepanel.test.ts` jsdom integration test, including thumbnail placeholder + reveal + unmount-on-stop, cross-window focus refetch, live append, scroll persistence, first-run notice, PII mode wiring. | All integration tests pass. | Yes |
| 6 | **Popup removal.** Delete `src/popup/`. Remove `action.default_popup` from manifest. Bump version to `0.4.0` in manifest and package.json. Add `tests/manifest-regression.test.ts`, `tests/popup-removed.test.ts`, `tests/sidepanel-no-direct-capture.test.ts`. | Full regression suite passes. Manual smoke: toolbar click opens side panel. | Yes (single revert restores popup) |
| 7 | Update `docs/ARCHITECTURE.md` with the side panel component block. Final manual smoke checklist. | Docs review; manual validation. | Yes |

### Test Level Matrix

This is the authoritative matrix. The next phase generates failing acceptance tests directly from this table.

| # | DoD checkbox | Level | Test file | Test name | Notes |
|---|--------------|-------|-----------|-----------|-------|
| 1 | Side panel registered: `manifest.json` declares `side_panel.default_path = "src/sidepanel/index.html"` and `"sidePanel"` in `permissions` | **build** | `tests/manifest-regression.test.ts` | `manifest declares side_panel.default_path pointing at src/sidepanel/index.html` + `manifest permissions include sidePanel` | Parses `manifest.json` via `fs.readFileSync` + `JSON.parse`. No Chrome runtime required. |
| 2 | Service worker calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` on every wake (top-level, not `onInstalled`) | **integration** | `tests/service-worker-setpanel.test.ts` | `service worker init invokes setPanelBehavior with openPanelOnActionClick:true` + `setPanelBehavior rejection is caught and logged` | Mock `chrome.sidePanel` as `{ setPanelBehavior: vi.fn().mockResolvedValue(undefined) }`. Dynamically import `src/background/service-worker.ts` and assert the mock was called. |
| 3 | Legacy popup removed: `action.default_popup` absent from manifest; `src/popup/` directory does not exist; no file under `src/` imports from `src/popup/` | **build** | `tests/popup-removed.test.ts` + `tests/manifest-regression.test.ts` | `src/popup directory does not exist` + `no source file imports from src/popup` + `manifest does not declare action.default_popup` | `fs.existsSync("src/popup")` → false. Regex scan `src/**/*.ts` for `from ["']\.\.?/popup`. |
| 4 | Start Session button in side panel form sends `START_SESSION` with selected PII mode to the SW | **integration** | `src/sidepanel/sidepanel.test.ts` | `clicking #start-btn with pii mode "metadata" sends START_SESSION with piiMode:"metadata"` | jsdom mount. Mock `chrome.runtime.sendMessage`. Assert the first call matches `{ type: "START_SESSION", piiMode: "metadata", ... }`. |
| 5 | Two-region flex layout: `#events-list` above `#controls`, form pinned bottom | **integration** | `src/sidepanel/sidepanel.test.ts` | `side panel root has events-list and controls as sibling flex children in order` | Assert `document.querySelector("#events-list")` precedes `document.querySelector("#controls")` in DOM order and both are direct children of `#sidepanel-root`. Assert `getComputedStyle(#events-list).flex === "1 1 auto"` and `getComputedStyle(#controls).flex === "0 0 auto"`. |
| 6a | Live chronological event list: each `TimelineEvent` variant maps to a row with timestamp (HH:MM:SS format) and type label | **unit** | `src/lib/sidepanel-render.test.ts` | `eventToRow produces a row for every TimelineEvent variant` + `formatEventTimestamp renders HH:MM:SS for today's events given fixed now` | One test per discriminator (`interaction` × 4 subtypes, `viewport_resize`, `network_error`, `console_error` × 2 levels, `js_exception`, `annotation`, `screenshot`). Assert `row.label`, `row.timestamp`, `row.accent`. `formatEventTimestamp` takes injectable `now` for determinism. |
| 6b | Exhaustiveness guard: adding a new `TimelineEvent` variant fails `make typecheck` | **unit** | `src/lib/sidepanel-render.test.ts` | `eventToRow covers every TimelineEvent discriminator in EXPECTED_DISCRIMINATORS` | Mirror `agents-doc.test.ts` — define `EXPECTED_DISCRIMINATORS: Set<TimelineEvent["type"]>`, iterate, call `eventToRow` with minimal fixture for each. Combined with the `default: const _: never = event` branch in the implementation, adding a new variant fails typecheck. |
| 7 | Inline screenshot thumbnails: pure `eventToRow` produces `{ screenshotPlaceholderId, screenshotDataUrl }` for screenshot + annotation events | **unit** | `src/lib/sidepanel-render.test.ts` | `screenshot event row carries placeholder id and data url from screenshots map` + `annotation event row resolves screenshot via screenshot_id` + `missing screenshot id yields null data url (no throw)` | Pure lookup — no DOM. |
| 8 | **Privacy invariant**: screenshot thumbnails are NOT rendered as `<img>` until user explicitly clicks placeholder | **integration** | `src/sidepanel/sidepanel.test.ts` | `screenshot event row renders placeholder, not img, by default` + `clicking placeholder reveals <img src="data:...">` | After rendering a screenshot event row, `querySelector("#event-list .event-row.screenshot img")` is null; `querySelector(".screenshot-placeholder")` is non-null. Click the placeholder, assert `<img>` appears. |
| 9 | **Privacy invariant**: revealed thumbnails are removed from DOM on `STOP_SESSION` | **integration** | `src/sidepanel/sidepanel.test.ts` | `STOP_SESSION transition unmounts all revealed screenshot imgs` | Reveal a thumbnail, fire `storage.onChanged` with `session.end_time` flipped. Assert `querySelectorAll("#event-list img").length === 0`. |
| 10 | Real-time live updates: `chrome.storage.onChanged` delta triggers append of new rows without re-rendering existing rows | **integration** | `src/sidepanel/sidepanel.test.ts` | `storage.onChanged with length 3 → 4 appends one row; existing data-seq attrs unchanged` | Snapshot the first 3 `<li>` nodes (by `data-seq`), fire change, assert they're still present as the same element instances. |
| 11 | Subscription append-delta helper never calls `getEvents()` on storage change (uses `change.newValue` directly) | **unit** | `src/lib/sidepanel-events-source.test.ts` | `change handler never invokes getEvents or any store accessor` | Spy on `session-store` module exports; fire a change; assert zero calls. |
| 12 | Subscription detects non-append delta and triggers full reset | **unit** | `src/lib/sidepanel-events-source.test.ts` | `newValue.length < lastSeenLength triggers onReset` + `newValue undefined (key removed) triggers onReset` | Drive the synchronous fake listener registry. |
| 13 | `appendEvent` preserves the prefix (append-only contract) | **unit** | `src/lib/session-store.test.ts` (new test case) | `appendEvent preserves the prefix: newEvents.slice(0, oldLen) deep-equals oldEvents` | Pins the invariant the subscription depends on; guards against future incremental-persistence rewrites silently breaking. |
| 14 | Lower region controls + metrics: `#controls` contains `#start-btn`, `#stop-btn`, `#screenshot-btn`, `#annotation-text`, `#download-btn`, `#pii-mode-fieldset`, `#metrics-row` | **integration** | `src/sidepanel/sidepanel.test.ts` | `controls region contains all required interactive elements by id` | DOM querySelector assertions. |
| 15 | Annotation textarea submit sends `ADD_ANNOTATION` | **integration** | `src/sidepanel/sidepanel.test.ts` | `typing annotation + clicking add-note sends ADD_ANNOTATION with text` | Mock `sendMessage`, assert call shape. |
| 16 | Screenshot button sends `TAKE_SCREENSHOT` (and does NOT call `chrome.tabs.captureVisibleTab` directly) | **build** | `tests/sidepanel-no-direct-capture.test.ts` | `src/sidepanel/*.ts does not reference captureVisibleTab or chrome.debugger or chrome.scripting` | Grep pinning. Prevents a future implementer from taking a shortcut. |
| 17 | Scroll position persists per window in `chrome.storage.session` | **unit** | `src/lib/sidepanel-storage.test.ts` | `setScrollPosition(1, 420) + getScrollPosition(1) returns 420` + `getScrollPosition on missing key returns 0` + `setScrollPosition(-1, x) is a no-op (WINDOW_ID_NONE rejected)` + `key prefix is exactly deskcheck_sidepanel_scroll_` | Injectable `SessionStorageApi` in-memory fake. |
| 18 | Scroll position restore round-trip in jsdom | **integration** | `src/sidepanel/sidepanel.test.ts` | `scroll to 200, fire debounce timer, remount, scroll restored to 200` | Uses Vitest `vi.useFakeTimers()` for the 200ms debounce. |
| 19 | Independent scroll: scrolling `#events-list` does not move `#controls` | **integration** | `src/sidepanel/sidepanel.test.ts` | `scrolling events-list preserves controls getBoundingClientRect().bottom` | jsdom layout is limited but sibling positions are observable. |
| 20 | First-run privacy notice rendered inline when `getFirstRunSeen() === false`; dismisses via `markFirstRunSeen()` | **integration** | `src/sidepanel/sidepanel.test.ts` | `mount with firstRunSeen=false renders notice at top; click dismiss calls markFirstRunSeen and removes node` | Stub `privacy-store` module; assert DOM. |
| 21 | Notice copy (bullets) is identical between widget and side panel (single source of truth) | **unit** | `src/lib/privacy-notice.test.ts` | `buildFirstRunNoticeModel returns bullets equal to PRIVACY_NOTICE_BULLETS` + `buildFirstRunNoticeModel has stable title and dismissLabel` | Pure function test. |
| 22 | Cross-window: side panel re-fetches `GET_SESSION_STATE` on `chrome.windows.onFocusChanged` | **integration** | `src/sidepanel/sidepanel.test.ts` | `firing chrome.windows.onFocusChanged listener triggers GET_SESSION_STATE resend` | Mock the listener registry; fire it; assert `sendMessage` call count increments with a `GET_SESSION_STATE` call. |
| 23 | Session end transition: `session.end_time` flipping from null to ISO string swaps active controls for idle | **integration** | `src/sidepanel/sidepanel.test.ts` | `storage change setting session.end_time transitions side panel to idle view` | |
| 24 | No type errors | **build** | CI | `make typecheck` | Existing gate. |
| 25 | Tests pass | **build** | CI | `make test` | Existing gate. |
| 26 | Build succeeds | **build** | CI | `make build` | Existing gate. |
| 27 | Visual styling consistent with dark theme palette | **manual** | Manual smoke checklist in PR description | Open side panel, compare against Quality plan palette table (slate-900 bg, blue-500 accent, emerald/red/amber/purple row accents) | No automated test — visual fidelity is not cheaply assertable. |
| 28 | Manual toolbar + SW wake smoke | **manual** | Manual smoke checklist | 1. Load unpacked. 2. Click icon — panel opens. 3. Close Chrome, reopen, click icon — panel still opens. 4. Take a screenshot — placeholder shown. 5. Click placeholder — reveals. 6. Stop session — thumbnails gone. 7. Start session in window A, open panel in window B — window B reflects the recording. | Pins the SW wake path and cross-window behavior end-to-end. |

**Rules applied:**
- Default is **unit** — the pure `src/lib/sidepanel-*.ts` modules collect the bulk of coverage.
- **integration** is used at the DOM + Chrome-seam boundary only.
- **build** is used for static invariants (manifest shape, filesystem layout, forbidden imports).
- **manual** is enumerated explicitly with exact steps — no implicit "dev will look at it".
- Each DoD maps to at least one row; privacy invariants (8, 9, 11, 16) map to multiple layers for defense-in-depth.
- No LLM calls. Vitest fake timers drive debounce. Injectable seams replace `chrome.*` globals.

### Acceptance criteria (restated from DoD with assigned test levels)

| DoD | Criterion | Test row(s) | Level(s) |
|-----|-----------|-------------|----------|
| 1 | Side panel registered; toolbar click opens it | 1, 2 | build + integration |
| 2 | Legacy popup removed | 3 | build |
| 3 | Start Session form functional with PII mode | 4 | integration |
| 4 | Two-region flex layout | 5 | integration |
| 5 | Live chronological list with timestamp + type label | 6a, 6b, 10 | unit + integration |
| 6 | Inline screenshot thumbnails (with placeholder-by-default privacy gate) | 7, 8, 9 | unit + integration |
| 7 | Real-time updates without refresh | 10, 11, 12, 13 | unit + integration |
| 8 | Lower region controls + metrics | 14, 15, 16 | integration + build |
| 9 | Independent scroll | 19 | integration |
| 10 | State persists across tab switches | 17, 18, 22 | unit + integration |
| 11 | Visual styling consistent with theme | 27 | manual |
| 12 | First-run notice (carried over from privacy invariants) | 20, 21 | unit + integration |
| 13 | No type errors + tests pass + build succeeds | 24, 25, 26 | build |
| 14 | Manual smoke | 28 | manual |

### Risks remaining (after chosen mitigations)

1. **Visual styling regression (DoD #11).** No automated test — a developer must look at the panel. Mitigation: Quality plan's palette table + explicit manual smoke step.
2. **`chrome.storage.session` availability.** Chrome ≥ 102. DeskCheck already requires MV3 (Chrome 114+ for sidePanel). Covered by minimum-Chrome documentation.
3. **Scroll restore race with initial render.** Quality plan's mitigation is `requestAnimationFrame` after list populated. Row #18 tests this with fake timers.
4. **Thumbnail reveal UX friction.** Accepted tradeoff — the privacy guarantee outweighs the extra click. If feedback pushes back, a per-session "reveal all" toggle can be added as a follow-up without revisiting the placeholder default.
5. **Widget refactor (Option A for `privacy-notice.ts`) touches an existing tested surface.** Mitigation: existing `privacy.test.ts` plus the new `privacy-notice.test.ts` pin the copy. Refactor is small (~20 LOC added, ~15 LOC simplified in `widget.ts`).
6. **Two UI surfaces (widget + side panel) showing the first-run notice independently.** Whichever is dismissed first flips the flag for both. Documented as "by design, single source of truth". Row #21 pins this.
7. **Long-session scroll performance** (>2000 events). Not virtualized. Accepted for v1 — feature #1 already warns at 50MB. Revisit if feedback demands.

### Out of scope (explicitly NOT doing)

- **Event list virtualization.** Naive `<li>` per event is enough for realistic sessions.
- **Event filtering/search.** Row view model carries `label` and `detail`; future feature can add a pure predicate.
- **Feature #10 lifecycle controls** (pause/resume/discard). Different feature.
- **Keyboard shortcut regression suite** (Safety T46–T50). Not in feature #8 DoD; defer to a hardening feature.
- **Full 6-state state machine.** 2 states + `inFlight` is sufficient.
- **Blocking first-run privacy modal.** Inline notice + existing widget gate are the privacy surface. Blocking modal is rejected.
- **Annotation draft persistence** (Safety R14). Platform already preserves side panel document on tab switch.
- **PII re-enforcement in the renderer** (Safety R3). SW is the single PII enforcement point (feature #4).
- **Dark theme refactor of the in-page widget.** Widget keeps its current light palette; divergence documented in ARCHITECTURE.md.
- **Light theme toggle for the side panel.** Deferred.
- **Feature flag / gradual rollout.** Pre-launch; single-revert is sufficient.
- **E2E / Playwright extension harness.** No existing e2e infra; adding it is its own feature.

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | N | N | Y (R6, R7) | Y (weak) |
| State machine | N | N | Y (6 states) | N (2 states is trivial) |
| Conservation | N | N | Y (mild — append-only) | N (covered by unit test) |
| Authorization | N | N | N | N |

**Recommendation**: **SKIP**. Only the Safety planner flags signals, and all of them are covered by standard unit tests:
- Append-only invariant → DoD row #13 (`session-store.test.ts` prefix test).
- SW race conditions → awaited `START_SESSION` response before subscribing, plus manual smoke step in row #28.
- State machine → exhaustive transition coverage in 2 states is ~6 tests, not worth TLA+.

**If future features introduce multiple concurrent sessions or background prefetch, revisit.** For now, the state space is small enough that exhaustive Vitest coverage beats formal modeling on cost.

---

## Orchestrator Handoff

This evaluation is the final decision. The orchestrator will:
1. Commit all plans to `docs/plans/feature-8/` for audit trail.
2. Use the Test Level Matrix (28 rows) to generate failing acceptance tests at the correct levels.
3. Proceed directly to phased implementation per the implementation order above.

**Summary for git commit**:
- Selected plan: Quality (base) + Safety grafts (manifest regression, append-only invariant, placeholder thumbnails, setPanelBehavior on wake, grep test for forbidden APIs, cross-window focus refetch, explicit 2-state machine) + Speed grafts (in-memory metrics, inline PII fieldset copy)
- Key rationale: Quality plan matches DeskCheck's "pure module + thin glue" layering and compile-time exhaustiveness pattern; Safety grafts harden the privacy-sensitive surfaces (thumbnail leak, manifest regression, direct-capture bypass) without dragging in Safety's 6-state / 10-phase / blocking-modal overhead.
- Estimated effort: ~420 min (Quality 350 + grafts 70)
- Key risks: visual styling (manual QA), thumbnail UX friction (accepted tradeoff), widget refactor (Option A, small surface)
- Test levels: **9 unit** (rows 6a, 6b, 7, 11, 12, 13, 17, 21, + screenshot placeholder in row 7) / **12 integration** (rows 2, 4, 5, 8, 9, 10, 14, 15, 18, 19, 20, 22, 23) / **5 build** (rows 1, 3, 16, 24, 25, 26) / **2 manual** (rows 27, 28)
