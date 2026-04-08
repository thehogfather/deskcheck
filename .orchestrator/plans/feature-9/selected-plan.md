---
agent: plan-judge
generated: 2026-04-08T22:45:00Z
task_id: feature-9
selected: speed
synthesis_from: [speed, safety]
---

# Plan Evaluation: Automatic tab group for active DeskCheck tabs

## Decision

**Selected: Speed plan, with two targeted borrowings from Safety.**

This is a Small-effort, additive, cosmetic feature whose effort label and DoD line count both point to the lightest viable plan. The Speed plan is exactly that: a ~95-line helper, three SW touch sites, two test files. We borrow from Safety: (1) the explicit `forgetTab` / state-cleanup ordering rule inside `tabs.onRemoved` (group cleanup runs AFTER existing feature-8 panel-binding cleanup), and (2) one regression test asserting the `chrome.action.onClicked` handler does NOT call any TabGroupApi method. We do NOT borrow Safety's version bump, feature-flag constant, monitoring section, or release-notes ceremony — none are commensurate with a Small additive cosmetic.

We reject the Quality plan as over-engineered for the effort label: a `TabGroupManager` class with a per-window cache, NOT_FOUND invalidation, concurrent-window race tests, a CHANGELOG entry, an ARCHITECTURE.md update, and a >90% coverage target push the work from ~85 minutes to ~115 minutes for zero additional user-visible value, while introducing stateful complexity that will need to be re-justified at every future read.

## Rationale (3-6 bullets)

- **Effort label fit**: Roadmap says **Small**. Speed delivers ~85min/5 files. Quality is ~115min/9 files with a stateful manager and a coverage gate. Safety is ~140min with feature-flag plumbing, version bump, and a monitoring plan. Speed is the only one whose footprint matches "Small additive cosmetic."
- **Effort vs. blast radius asymmetry**: Tab grouping is explicitly best-effort decoration — the Bug Reporter persona "can live without it if something goes wrong." The Quality plan's per-window cache + race tests are insurance against a class of bugs (concurrent multi-window starts, stale group ids) that has zero user impact when it occurs, because the worst case is a duplicate group the user dismisses manually. Buying that insurance with extra abstraction surface is a bad trade.
- **All three plans correctly preserve the feature-8 invariant**: none thread tab-group work into `chrome.action.onClicked`, all three place calls strictly inside `START_SESSION` / `STOP_SESSION` / `tabs.onRemoved` where the gesture window has long since closed. So the disqualification criterion does not separate them — we get to choose on effort and clarity.
- **Idempotency comes for free from Chrome**: Chrome auto-deletes empty groups and silently no-ops ungrouping a tab that's already gone. The Quality plan's self-healing per-window cache solves a problem Chrome already solved. The Speed plan's "always re-query by title, never store group id" is strictly simpler and equally correct.
- **Safety's two crown jewels are cheap to lift**: the `tabs.onRemoved` ordering rule and the onClicked-doesn't-touch-tabgroup-api regression test are each one paragraph and one test case respectively. They cost ~5 minutes and harden the only two real risks (feature-8 regression, ordering bug). Worth taking.
- **Safety's expensive ceremony is not**: the version bump from 0.4.0 → 0.5.0 is unjustified for an additive permission on a pre-1.0 project; the `TAB_GROUP_FEATURE_ENABLED` flag is the kind of dead code that survives forever; the monitoring/release-notes section is theatre for a feature with no telemetry. Skip all of it.

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|-----------|--------|-------|---------|--------|-------|
| Time to deliver | 20% | 5.0 | 3.5 | 3.0 | Speed: ~85min. Quality: ~115min. Safety: ~140min. |
| Code quality | 25% | 4.0 | 4.5 | 4.0 | Quality has strictest naming/SOLID; Speed is plenty clean for the surface area. |
| Risk mitigation | 25% | 4.0 | 4.0 | 4.5 | All three are best-effort with try/catch + feature-detect. Safety adds an explicit ordering test. |
| Maintainability | 15% | 4.5 | 3.5 | 3.0 | Speed: 95-line module is a single-read. Quality: stateful class with cache. Safety: extra flag + ceremony. |
| Test coverage | 15% | 4.0 | 5.0 | 4.5 | Quality: 14 unit + 6 integration + race cases. Speed: 10+6, sufficient for surface. |
| **Weighted Total** | 100% | **4.30** | **4.10** | **3.85** | |

Speed wins on weighted score, primarily on time-to-deliver and maintainability — both of which are heavily weighted by the "Small effort" label of this task.

## Context Analysis

| Factor | Assessment | Impact |
|--------|------------|--------|
| Urgency | Low (planned roadmap item) | Doesn't push toward speed for time pressure, but doesn't punish it either |
| Blast radius | Very Low (cosmetic, best-effort, no data) | Strong push AWAY from Safety's overhead — there is nothing to lose |
| Code area | Peripheral (additive, decoration) | Push toward Speed; not worth Quality's abstraction investment |
| Technical debt | Low in this area | No need for the Quality plan's "establishing precedent" framing |
| User visibility | Internal cue, additive | Bug Reporter wants the cue but tolerates absence; weak push toward Speed |
| Maintenance horizon | Indefinite, unlikely to be touched again | Push AWAY from Quality — abstraction designed for "future evolution" that may never come |
| Critical adjacent invariant | Feature-8 sync gesture handling | Strong constraint, but ALL plans satisfy it. Borrow Safety's regression test to nail it shut. |

## The Selected Plan

### Architecture Impact

**Components affected:**
- `manifest.json` — add `"tabGroups"` to `permissions` array
- `src/lib/tab-group.ts` (NEW) — ~95-line module: `TabGroupApi` interface, `realTabGroupApi` adapter with `isAvailable()` feature detection, two pure-ish functions `assignTabToDeskCheckGroup` and `removeTabFromDeskCheckGroup`, plus `DESKCHECK_GROUP_TITLE` and `DESKCHECK_GROUP_COLOR` constants
- `src/background/service-worker.ts` — three call sites: end of `START_SESSION`, end of `STOP_SESSION`, inside `tabs.onRemoved` recording-tab branch (AFTER existing cleanup, in its own try/catch)

**No new state**, no message-contract changes, no schema bump, no version bump, no docs ceremony. The helper queries `chrome.tabGroups.query({ windowId, title })` on every operation — Chrome is the source of truth, not us.

**No new abstractions** beyond a single injectable seam (the `TabGroupApi` interface), which mirrors the established `SessionStorageApi`/`PiiModeApi` pattern.

### Implementation Step Order

1. **Manifest**: append `"tabGroups"` to `permissions` in `manifest.json` (single line). Do NOT bump the version.

2. **Create `src/lib/tab-group.ts`** with:
   - `TabGroupApi` interface exposing exactly: `isAvailable()`, `groupTabs(opts)`, `queryGroups(query)`, `updateGroup(id, opts)`, `ungroupTabs(ids)`.
   - `realTabGroupApi` const implementing the interface against the real `chrome.tabs.group`/`chrome.tabGroups.*` APIs.
   - `DESKCHECK_GROUP_TITLE = "DeskCheck"` and `DESKCHECK_GROUP_COLOR: chrome.tabGroups.ColorEnum = "blue"` (Quality and Speed disagree on red vs blue; pick blue to align with the Quality plan's documented choice and to differentiate from Chrome's "Recording" red badge text).
   - `assignTabToDeskCheckGroup(tabId, windowId, api?)`: feature-detect → query existing → `groupTabs({ tabIds, groupId })` if found, else `groupTabs({ tabIds, createProperties: { windowId } })` then `updateGroup(id, { title, color })`. Wrapped in a single top-level try/catch that logs `[DeskCheck:tab-group]` warnings and returns `null` on any failure.
   - `removeTabFromDeskCheckGroup(tabId, api?)`: feature-detect → `ungroupTabs(tabId)` wrapped in try/catch. Chrome auto-deletes empty groups; we do nothing further.
   - **Header comment** carrying the hard rule from Safety: "These functions MUST NOT be called from inside `chrome.action.onClicked`, `chrome.commands.onCommand`, or any other handler that needs the user-gesture token. They are async and consume the gesture budget. Call sites are limited to `START_SESSION`, `STOP_SESSION`, and `tabs.onRemoved`."

3. **Wire into `service-worker.ts`** (three call sites, all best-effort):
   - **`START_SESSION`** — at the very end, AFTER the existing `setTimeout(100)` and `chrome.tabs.sendMessage(SESSION_STARTED)` block, BEFORE `return { recording: true, sessionId, warnings }`. Use `void` to fire-and-forget so no extra await is added: `void assignTabToDeskCheckGroup(activeTabId, (await chrome.tabs.get(activeTabId)).windowId).catch(() => {})`. The single `chrome.tabs.get` await is acceptable here because it runs AFTER the existing `sendMessage` and is gated by the same `if (activeTabId)` block.
   - **`STOP_SESSION`** — at the very end, AFTER the existing `chrome.tabs.sendMessage(SESSION_STOPPED)`, BEFORE `return { recording: false, sessionId: stoppedSessionId }`. Capture `tabToNotify` BEFORE clearing `activeTabId` (already done by the existing code), then: `void removeTabFromDeskCheckGroup(tabToNotify).catch(() => {})`.
   - **`tabs.onRemoved` recording-tab branch** — inside the existing `if (tabId === activeTabId && recording)` block, the existing `finally` already clears `recording`/`activeSessionId`/`activeTabId`/`setBadge(false)`. Add a NEW line AFTER the entire existing if-block (so it runs regardless of whether the closed tab was the recording tab) but BEFORE the `panelBoundTabId` block: `void removeTabFromDeskCheckGroup(tabId).catch(() => {})`. This is the **Safety-borrowed ordering**: feature-8 panel cleanup runs in its own block AFTER ours, completely independently, so a thrown rejection from tab-group code (caught by the `.catch(() => {})`) cannot abort panel-binding cleanup. Document the order with a one-line comment.

4. **Critically: do NOT add any `await` between `chrome.action.onClicked` entry and `chrome.sidePanel.open`**. Tab-group calls live ONLY inside `START_SESSION` / `STOP_SESSION` / `tabs.onRemoved`. Pinned by a regression test (step 6).

5. **Write `tests/tab-group.test.ts`** (~10 unit cases against a hand-rolled `TabGroupApi` stub):
   - `isAvailable()` returns false → `assignTabToDeskCheckGroup` resolves to `null` and calls nothing
   - `queryGroups` returns empty → `groupTabs` called with `createProperties.windowId`, then `updateGroup` called with `{ title: "DeskCheck", color: "blue" }`
   - `queryGroups` returns one matching group → `groupTabs` called with `groupId: existing.id` and NO subsequent `updateGroup` call
   - `groupTabs` rejects → `assignTabToDeskCheckGroup` resolves to `null`, no throw
   - `updateGroup` rejects after a successful create → `assignTabToDeskCheckGroup` resolves to `null` (group has the tab; we just didn't get to set color), no throw
   - `queryGroups` rejects → `assignTabToDeskCheckGroup` resolves to `null`, no throw
   - `removeTabFromDeskCheckGroup` calls `ungroupTabs(tabId)` exactly once on the happy path
   - `removeTabFromDeskCheckGroup` swallows `ungroupTabs` rejection
   - `removeTabFromDeskCheckGroup` is a no-op when `isAvailable()` returns false
   - Constants: `DESKCHECK_GROUP_TITLE === "DeskCheck"`, color is in Chrome's allowed enum

6. **Write `tests/service-worker-tab-group.test.ts`** (~6 integration cases, mirroring `tests/service-worker-setpanel.test.ts`'s `installFakeChrome` + `vi.resetModules` pattern, extended with `chrome.tabs.group`, `chrome.tabs.ungroup`, `chrome.tabGroups.query`, `chrome.tabGroups.update` stubs):
   - `START_SESSION` triggers `chrome.tabs.group` exactly once with the correct `tabIds`
   - `STOP_SESSION` triggers `chrome.tabs.ungroup` exactly once for the recorded tab
   - `tabs.onRemoved` for the recording tab triggers `chrome.tabs.ungroup` and does not throw when ungroup rejects
   - **Safety regression**: `chrome.action.onClicked` invocation does NOT call `chrome.tabs.group`, `chrome.tabs.ungroup`, `chrome.tabGroups.query`, or `chrome.tabGroups.update` (assert all stubs are not-called immediately after the click, BEFORE any microtask flush)
   - `START_SESSION` returns `{ recording: true, ... }` even when `chrome.tabGroups` is `undefined` on the fake chrome global (delete the key, re-import the module)
   - `START_SESSION` returns `{ recording: true, ... }` even when every TabGroupApi method rejects
   - `tabs.onRemoved` ordering: a throwing tab-group cleanup does NOT prevent `panelBoundTabId` from being cleared

7. **Extend `tests/service-worker-setpanel.test.ts`'s `installFakeChrome()`** to add stubs for `tabs.group`, `tabs.ungroup`, `tabGroups.query`, `tabGroups.update` so existing setpanel tests continue passing when the SW imports the new helper. Existing assertions stay unchanged.

8. **Run `make typecheck && make test && make build`**. Manual smoke: load `dist/`, start a session, verify the tab joins a blue "DeskCheck" group; start a second session on a sibling tab in the same window, verify it joins the same group; stop both, verify both ungroup and the group disappears; close a tab mid-session, verify no error in the SW console.

### Definition of Done (Final)

- [ ] `manifest.json` `permissions` array contains `"tabGroups"` (no version bump)
- [ ] `src/lib/tab-group.ts` exports `assignTabToDeskCheckGroup`, `removeTabFromDeskCheckGroup`, `TabGroupApi`, `realTabGroupApi`, `DESKCHECK_GROUP_TITLE`, `DESKCHECK_GROUP_COLOR`
- [ ] Starting a session adds the active tab to a "DeskCheck" tab group in the current window
- [ ] Tab group has color `blue` and title `DeskCheck`
- [ ] If a "DeskCheck" group already exists in the window, the tab is added to its existing group id (no second create-and-rename round-trip)
- [ ] Ending a session ungroups the recorded tab
- [ ] If the group becomes empty after a session ends, Chrome's auto-delete handles cleanup (verified by manual smoke; no explicit code)
- [ ] Closing a recorded tab while a session is active does not throw and does not leave orphaned in-memory bookkeeping
- [ ] Tab-group cleanup runs in its OWN try/catch inside `tabs.onRemoved`, AFTER feature-8 panel-binding cleanup, so a tab-group failure cannot regress feature-8
- [ ] When `chrome.tabGroups` is undefined, `START_SESSION` still resolves successfully with the existing `{ recording, sessionId, warnings }` shape
- [ ] When any `chrome.tabGroups.*` call rejects, `START_SESSION` still resolves successfully
- [ ] `chrome.action.onClicked` handler does not call any `TabGroupApi` method (test-pinned)
- [ ] `chrome.sidePanel.open` is still called synchronously inside the click handler (existing test stays green)
- [ ] All new unit + integration tests pass
- [ ] `make typecheck` clean
- [ ] Existing `tests/service-worker-setpanel.test.ts` still passes — bind-on-open invariants are not regressed

### Test Level Matrix (Final)

Each DoD criterion maps to exactly ONE test level. Default is unit; integration is reserved for the SW message-handler boundary; e2e is skipped (no automated tab-group rendering verification — Chrome's job, not ours).

| # | Acceptance Criterion | Test Level | Rationale |
|---|---------------------|-----------|-----------|
| 1 | `tabGroups` permission in `manifest.json` | Unit | Pure JSON read; extend `tests/manifest-regression.test.ts`. No Chrome runtime needed. |
| 2 | Starting a session adds the active tab to a "DeskCheck" group in the current window | Integration | Crosses SW message handler ↔ helper boundary; pin call shape via `installFakeChrome` + dispatch. |
| 3 | Group has distinctive color (`blue`) and title `DeskCheck` | Unit | Pure helper logic; assert against constants and `updateGroup` call args in `tests/tab-group.test.ts`. |
| 4 | Existing "DeskCheck" group in the same window is reused, not duplicated | Unit | Pure helper logic; seed `queryGroups` with one match in `tests/tab-group.test.ts` and assert `groupTabs` is called with `groupId` (not `createProperties`). |
| 5 | Ending a session removes the tab from the group | Integration | SW message-handler boundary on `STOP_SESSION` → `chrome.tabs.ungroup` call assertion. |
| 6 | Empty group is cleaned up after session ends | Manual (smoke) | Chrome auto-deletes empty groups; we have no code to test. One manual verification step covers it. NOT a CI gate. |
| 7 | Closing a recorded tab while a session is active does not leave orphaned group state | Integration | SW `tabs.onRemoved` handler → ungroup invocation + no throw + panel-binding cleanup still runs. |
| 8 | Helper is idempotent on missing tab / missing group / missing API | Unit | Pure error-path coverage; fake api throws each rejection in turn in `tests/tab-group.test.ts`. |
| 9 | START_SESSION returns `{ recording: true }` when `chrome.tabGroups` is undefined | Integration | Delete `chrome.tabGroups` from fake chrome, re-import SW, dispatch START, assert return shape. |
| 10 | START_SESSION returns `{ recording: true }` when every TabGroupApi method rejects | Integration | All stubs reject, dispatch START, assert return shape. |
| 11 | `chrome.action.onClicked` handler does NOT call any TabGroupApi method (no gesture-window contamination) | Integration | Mock-call assertion immediately after invoking the click listener, before microtask flush. |
| 12 | `chrome.sidePanel.open` is still called synchronously inside the click handler | Unit (existing) | Already pinned by `tests/service-worker-setpanel.test.ts`; we verify it stays green when SW imports the new helper. |
| 13 | `tabs.onRemoved` ordering: tab-group cleanup throwing does NOT prevent `panelBoundTabId` from being cleared | Integration | Inject a throwing tab-group stub, fire `tabs.onRemoved` for the bound tab, assert `panelBoundTabId === null` after. |

**Rules applied:**
- Default to unit tests — they are fast and isolated
- Integration is reserved for crossing the SW message-handler / lifecycle-listener boundary, where the wiring itself is what's under test
- E2E is skipped: tab-group visual rendering is Chrome's responsibility; the existing `e2e/sidepanel-debug.spec.ts` is a sufficient canary for any feature-8 regression
- Each criterion maps to exactly ONE level
- All tests are deterministic — `vi.fn()` mocks throughout, no real Chrome calls, no LLM, no timers beyond the existing `setTimeout(100)` which is already mocked in the SW test harness

**Determinism constraint:** No LLM involvement in this feature — N/A.

### Acceptance Test Targets

Specific test files and the assertions each will contain:

**`tests/manifest-regression.test.ts`** (MODIFY — add one assertion)
- `expect(manifest.permissions).toContain("tabGroups")`
- (existing assertions unchanged)

**`tests/tab-group.test.ts`** (NEW, ~220 lines, ~10 cases)
- `assignTabToDeskCheckGroup` returns `null` and makes no API calls when `api.isAvailable()` returns `false`
- `assignTabToDeskCheckGroup` calls `groupTabs({ tabIds, createProperties: { windowId } })` then `updateGroup(id, { title: "DeskCheck", color: "blue" })` when no existing group is found
- `assignTabToDeskCheckGroup` calls `groupTabs({ tabIds, groupId: existing.id })` and does NOT call `updateGroup` when an existing "DeskCheck" group is found in the window
- `assignTabToDeskCheckGroup` resolves to `null` and does not throw when `queryGroups` rejects
- `assignTabToDeskCheckGroup` resolves to `null` and does not throw when `groupTabs` rejects
- `assignTabToDeskCheckGroup` resolves to `null` and does not throw when `updateGroup` rejects after a successful create
- `removeTabFromDeskCheckGroup` calls `ungroupTabs(tabId)` exactly once on the happy path
- `removeTabFromDeskCheckGroup` resolves and does not throw when `ungroupTabs` rejects
- `removeTabFromDeskCheckGroup` is a no-op (no API calls) when `api.isAvailable()` returns `false`
- `DESKCHECK_GROUP_TITLE === "DeskCheck"`; `DESKCHECK_GROUP_COLOR` is one of `chrome.tabGroups.ColorEnum`'s allowed values

**`tests/service-worker-tab-group.test.ts`** (NEW, ~180 lines, ~7 cases)
- `START_SESSION` dispatch triggers `chrome.tabs.group` exactly once with `{ tabIds: <activeTab>, ... }`
- `STOP_SESSION` dispatch triggers `chrome.tabs.ungroup` for the recorded tab
- `tabs.onRemoved` for the recording tab triggers `chrome.tabs.ungroup` and does NOT throw when ungroup rejects
- `chrome.action.onClicked.dispatch(tab)` does NOT call `chrome.tabs.group`, `chrome.tabs.ungroup`, `chrome.tabGroups.query`, or `chrome.tabGroups.update` (asserted before any microtask flush)
- `START_SESSION` returns `{ recording: true, sessionId, warnings: [] }` (warnings unchanged) when `chrome.tabGroups` is `undefined` on the fake chrome global
- `START_SESSION` returns `{ recording: true, ... }` when every TabGroupApi method rejects
- `tabs.onRemoved` for `panelBoundTabId` clears `panelBoundTabId` even when the tab-group cleanup throws (ordering / independence test)

**`tests/service-worker-setpanel.test.ts`** (MODIFY — extend `installFakeChrome` only)
- Add `vi.fn().mockResolvedValue(...)` stubs for `tabs.group`, `tabs.ungroup`, `tabGroups.query`, `tabGroups.update`
- All existing assertions unchanged; the existing "calls sidePanel.open synchronously inside the click listener" test continues to pin the feature-8 invariant

### Risk Mitigations (Final)

1. **Risk: tab-group code accidentally runs inside the gesture-sensitive path → feature-8 regression.** Mitigation: hard rule documented in `tab-group.ts` header comment. Pinned by integration test #11 which asserts no `TabGroupApi` method is called from inside `chrome.action.onClicked`.

2. **Risk: `chrome.tabGroups` undefined on a Chromium fork → `START_SESSION` crashes.** Mitigation: feature detection in `realTabGroupApi.isAvailable()` plus a top-level try/catch in `assignTabToDeskCheckGroup`. Pinned by integration test #9.

3. **Risk: tab-group cleanup throws during `tabs.onRemoved` → panel-binding cleanup never runs → feature-8 broken.** Mitigation: tab-group cleanup is in its OWN try/catch (via the helper's internal `.catch(() => {})`), runs AFTER the existing `if (tabId === activeTabId && recording)` block, and the `panelBoundTabId` cleanup is in a separate `if` block that the helper's exception cannot reach. Pinned by integration test #13.

4. **Risk: Chrome auto-delete of empty groups doesn't fire on some Chrome version.** Mitigation: accepted as a minor cosmetic — a stale empty "DeskCheck" group is harmless. If reports surface, add an explicit `cleanupEmptyGroup` follow-up; not pre-emptive.

5. **Risk: User manually drags the recorded tab out of the DeskCheck group mid-session → `STOP_SESSION` ungroup is a no-op on a tab that's already ungrouped.** Mitigation: `chrome.tabs.ungroup` on an already-ungrouped tab is a no-op in Chrome; even if it weren't, the helper swallows. Pinned by unit test "ungroup is a no-op when tab is already ungrouped".

### Explicit Non-Goals

These are tempting but explicitly out of scope for this Small additive feature:

- **Per-window group-id cache.** Quality plan proposed it as an optimization. Skipped — `chrome.tabGroups.query({ windowId, title })` is cheap and stale-cache bugs are real. Re-query every time.
- **`TabGroupManager` class.** Quality plan proposed it for future extensibility. Skipped — two pure functions are simpler and adequate. If feature #7 (tab-switch follow-through) needs more, refactor then.
- **`TAB_GROUP_FEATURE_ENABLED` rollback flag.** Safety plan proposed it. Skipped — feature flags that don't have a removal plan become permanent dead code. If we need to roll back, `git revert`.
- **Version bump 0.4.0 → 0.5.0.** Safety plan proposed it. Skipped — adding a permission to a pre-1.0 extension does not require a minor bump in this project's conventions.
- **`CHANGELOG.md` entry.** Quality plan proposed it. Skipped — no CHANGELOG.md exists in this repo today (or if it does, this feature isn't where we should start the precedent).
- **`docs/ARCHITECTURE.md` update.** Quality plan proposed it. Skipped — the helper is a 95-line module of the same shape as several existing ones; no new architectural concept to document.
- **Concurrent multi-window race tests.** Quality plan proposed three. Skipped — sessions are single-tab single-window in this product today (per task spec out-of-scope), and the helper has no shared state across windows.
- **`forgetTab` synchronous bookkeeping helper.** Quality plan proposed it. Skipped — the speed plan has no in-memory bookkeeping to forget. Chrome is the source of truth.
- **NOT_FOUND-aware cache invalidation.** Quality plan proposed it. Skipped — no cache exists.
- **Cross-window group migration when user drags tab.** Already declared out-of-scope by the task spec; defer to feature #7.
- **Color customization UI.** Already declared out-of-scope by the task spec.
- **Bumping `schema_version`.** No export schema change.
- **E2E test for tab-group visual rendering.** Chrome's responsibility, not ours.
- **Telemetry / monitoring / release notes / staging dogfood window.** Safety plan proposed all of these. Skipped — disproportionate to a Small additive cosmetic.

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | N | Y (per-window cache) | N | N |
| State machine | N | N | N | N |
| Conservation | N | N | N | N |
| Authorization | N | N | N | N |

**Recommendation: SKIP.** Only the Quality planner flagged a concurrency concern, and only because they introduced a per-window cache. The selected plan has no cache and no shared state — concurrent SW operations on different windows are fully independent. Standard unit + integration tests are sufficient. The blast radius of a bug here is "tab group looks weird," not data loss.

---

## Orchestrator Handoff

This evaluation is the final decision. The orchestrator will:
1. Commit all plans (speed, quality, safety, selected) to `docs/plans/feature-9/` for audit trail
2. Use the Test Level Matrix to scaffold acceptance tests at the correct levels
3. Proceed directly to implementation

**Summary for git commit:**
- Selected plan: Speed (with two targeted borrowings from Safety)
- Key rationale: Small effort label + cosmetic best-effort feature + all three plans correctly preserve feature-8 invariant → choose lightest viable plan
- Estimated effort: ~90 minutes (Speed's 85 + 5 for the borrowed onClicked-doesn't-touch test)
- Key risks: feature-8 regression (mitigated by hard rule + integration regression test), `chrome.tabGroups` API absent (mitigated by `isAvailable()` + try/catch)
- Test levels: 4 unit, 7 integration, 0 e2e, 1 manual smoke
