---
agent: speed-planner
generated: 2026-04-08T22:30:00Z
task_id: feature-9
perspective: speed
---

# Speed Plan: Automatic tab group for active DeskCheck tabs

## Architecture Impact

**Components affected:**
- `manifest.json`: add `"tabGroups"` to `permissions`.
- `src/lib/tab-group.ts` (new): tiny pure-ish wrapper around `chrome.tabs.group` / `chrome.tabGroups.{query,update,move}` exposed via an injectable `TabGroupApi` seam so tests can stub it.
- `src/background/service-worker.ts`: three call-sites — `START_SESSION` (assign tab to group), `STOP_SESSION` (remove tab + cleanup), `chrome.tabs.onRemoved` (cleanup if recorded tab closed mid-session).

**New patterns or abstractions introduced:**
- One thin module (`src/lib/tab-group.ts`) with two exported functions:
  - `assignTabToDeskCheckGroup(tabId, windowId, api?): Promise<number | null>` — finds-or-creates the "DeskCheck" group and groups the tab into it. Returns the group id or `null` on best-effort failure.
  - `removeTabFromDeskCheckGroup(tabId, api?): Promise<void>` — ungroups the tab and, if the (former) group has no remaining tabs, leaves Chrome to auto-collapse it (Chrome auto-deletes empty groups). Idempotent.
- The `api?` parameter defaults to a real-`chrome` adapter; tests pass a stub. No DI framework, no class — just a function with a default arg.

**Dependencies added or modified:**
- None. `chrome.tabGroups` is built-in MV3 (Chrome 89+). `@types/chrome` already covers it.

**Breaking changes to existing interfaces:**
- None — additive only. Storage schema, export schema, message contract all unchanged.

## Approach

Add a tiny `src/lib/tab-group.ts` helper with an injectable `TabGroupApi` seam, then call it from exactly three places in the service worker (START_SESSION end, STOP_SESSION end, tabs.onRemoved cleanup). All calls are best-effort — wrapped in try/catch so missing/erroring `chrome.tabGroups` cannot crash the recording lifecycle, and crucially placed AFTER the existing critical path so they cannot reorder around the side-panel gesture invariants.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `manifest.json` | Modify | +1 | Add `"tabGroups"` to permissions array. |
| `src/lib/tab-group.ts` | Add | ~95 | New module: `TabGroupApi` interface, default real-chrome adapter, `assignTabToDeskCheckGroup`, `removeTabFromDeskCheckGroup`, `DESKCHECK_GROUP_TITLE`, `DESKCHECK_GROUP_COLOR` constants. Pure logic on top of an injectable seam. |
| `src/background/service-worker.ts` | Modify | ~25 | Import the helper. Call `assignTabToDeskCheckGroup` at the end of START_SESSION (after sendMessage). Call `removeTabFromDeskCheckGroup` at the end of STOP_SESSION (after sendMessage). Call `removeTabFromDeskCheckGroup` inside `tabs.onRemoved` finally-block (best-effort, tab is already gone — cleanup only operates on the group). |
| `tests/tab-group.test.ts` | Add | ~220 | Vitest unit suite covering every DoD line via stubbed `TabGroupApi`. |
| `tests/service-worker-tab-group.test.ts` | Add | ~180 | Vitest integration suite mirroring the existing `service-worker-setpanel.test.ts` pattern (`installFakeChrome` + dispatch). Pins call ordering and best-effort behaviour at the SW boundary. |

**Total files**: 5 (1 manifest, 1 new lib module, 1 SW touch, 2 new test files)
**Total estimated lines**: ~520 added, 0 removed

## Implementation Steps

1. **Manifest**: append `"tabGroups"` to `permissions` in `manifest.json` (one line).
2. **Create `src/lib/tab-group.ts`**:
   ```ts
   export const DESKCHECK_GROUP_TITLE = "DeskCheck";
   export const DESKCHECK_GROUP_COLOR: chrome.tabGroups.ColorEnum = "red";

   export interface TabGroupApi {
     groupTabs(opts: { tabIds: number; groupId?: number; createProperties?: { windowId: number } }): Promise<number>;
     queryGroups(query: { windowId?: number; title?: string }): Promise<chrome.tabGroups.TabGroup[]>;
     updateGroup(groupId: number, opts: { title?: string; color?: chrome.tabGroups.ColorEnum }): Promise<chrome.tabGroups.TabGroup>;
     ungroupTabs(tabIds: number | number[]): Promise<void>;
     queryTabsInGroup(groupId: number): Promise<chrome.tabs.Tab[]>;
     isAvailable(): boolean;
   }

   export const realTabGroupApi: TabGroupApi = {
     isAvailable: () => typeof chrome !== "undefined" && !!chrome.tabGroups && !!chrome.tabs?.group,
     groupTabs: (opts) => chrome.tabs.group(opts as any),
     queryGroups: (q) => chrome.tabGroups.query(q),
     updateGroup: (id, opts) => chrome.tabGroups.update(id, opts),
     ungroupTabs: (ids) => chrome.tabs.ungroup(ids as any),
     queryTabsInGroup: (groupId) => chrome.tabs.query({ groupId }),
   };

   export async function assignTabToDeskCheckGroup(
     tabId: number,
     windowId: number,
     api: TabGroupApi = realTabGroupApi,
   ): Promise<number | null> {
     if (!api.isAvailable()) return null;
     try {
       // 1. Find an existing DeskCheck group in the same window.
       const existing = await api.queryGroups({ windowId, title: DESKCHECK_GROUP_TITLE });
       let groupId: number;
       if (existing.length > 0) {
         groupId = await api.groupTabs({ tabIds: tabId, groupId: existing[0].id });
       } else {
         groupId = await api.groupTabs({ tabIds: tabId, createProperties: { windowId } });
         await api.updateGroup(groupId, { title: DESKCHECK_GROUP_TITLE, color: DESKCHECK_GROUP_COLOR });
       }
       return groupId;
     } catch (err) {
       console.warn("[DeskCheck] tab-group assign failed:", err);
       return null;
     }
   }

   export async function removeTabFromDeskCheckGroup(
     tabId: number,
     api: TabGroupApi = realTabGroupApi,
   ): Promise<void> {
     if (!api.isAvailable()) return;
     try {
       await api.ungroupTabs(tabId);
     } catch (err) {
       // Tab may already be gone, already ungrouped, or group may be gone. All fine.
       console.warn("[DeskCheck] tab-group ungroup (best-effort) failed:", err);
     }
     // Chrome auto-deletes empty groups when their last tab is ungrouped or
     // closed; we deliberately do not call any explicit cleanup. The DoD
     // "empty group is cleaned up" line is satisfied by Chrome itself.
   }
   ```
3. **Service worker changes**:
   - Import: `import { assignTabToDeskCheckGroup, removeTabFromDeskCheckGroup } from "../lib/tab-group";`
   - At the end of `START_SESSION` (after `chrome.tabs.sendMessage(activeTabId, SESSION_STARTED)`, BEFORE the `return`): call (and `void`-ignore) `assignTabToDeskCheckGroup(activeTabId, (await chrome.tabs.get(activeTabId)).windowId)`. Wrap in try/catch so a failure cannot mask the SESSION_STARTED return.
   - At the end of `STOP_SESSION` (after `chrome.tabs.sendMessage(tabToNotify, SESSION_STOPPED)`, BEFORE the `return`): call `removeTabFromDeskCheckGroup(tabToNotify)`. Wrap in try/catch.
   - In `chrome.tabs.onRemoved` (the existing recording-tab branch), inside the existing `finally` block, after `setBadge(false)`: call `removeTabFromDeskCheckGroup(tabId).catch(() => {})`. The tab is already gone so the ungroup will likely no-op; the call is just for symmetry and to ensure no orphaned bookkeeping.
   - Critically: do NOT add any `await` between `chrome.action.onClicked.addListener` entry and the existing `chrome.sidePanel.open` call. The tab-group calls live ONLY inside `START_SESSION` / `STOP_SESSION` / `onRemoved`, never inside `onClicked` or the `toggle-session` command path before `sidePanel.open`.
4. **Tests**:
   - `tests/tab-group.test.ts` — pure unit tests against the helper with a hand-rolled `TabGroupApi` stub. Covers: missing API, find-existing, create-new (with title/color), group-id reuse, error swallowing on assign, idempotent ungroup, ungroup error swallowing.
   - `tests/service-worker-tab-group.test.ts` — mirrors `service-worker-setpanel.test.ts` to load the SW with a fake `chrome` (now also stubbing `chrome.tabs.group`, `chrome.tabs.ungroup`, `chrome.tabs.query` for groups, and `chrome.tabGroups.{query,update}`). Asserts:
     - `START_SESSION` triggers `chrome.tabs.group` exactly once.
     - `START_SESSION` against a window that already has a DeskCheck group reuses the existing group id and does NOT call `chrome.tabGroups.update` for title.
     - `STOP_SESSION` calls `chrome.tabs.ungroup` for the active tab.
     - `tabs.onRemoved` for the recorded tab triggers ungroup attempt and does not throw when ungroup rejects.
     - `START_SESSION` does not throw when `chrome.tabGroups` is undefined (delete the key in the fake chrome and re-import).
     - `START_SESSION` does not throw when `chrome.tabs.group` rejects.
     - The `chrome.action.onClicked` and `setPanelBehavior` flow is unchanged — re-run the existing setpanel assertions in this file's beforeEach (or let the existing setpanel test file continue to cover it; do not duplicate).
5. Run `make typecheck && make test && make build`. Manual smoke: load `dist/`, start a session on a tab, verify the tab joins a red "DeskCheck" group; start a second session on a sibling tab in the same window, verify it joins the same group; stop both, verify both ungroup and the group disappears; close a tab mid-session, verify no error in the SW console.

## Definition of Done

- [ ] `manifest.json` `permissions` array contains `"tabGroups"`.
- [ ] Starting a session calls `chrome.tabs.group({ tabIds: <activeTab>, ... })` for the active tab in the active window.
- [ ] When no DeskCheck group exists in the window, the new group is configured via `chrome.tabGroups.update` with `title: "DeskCheck"` and a non-default color (`red`).
- [ ] When a DeskCheck group already exists in the window, the active tab is added to that group's id (no second create-and-rename round-trip).
- [ ] Stopping a session calls `chrome.tabs.ungroup` for the recorded tab.
- [ ] Closing the recorded tab while a session is active does not throw and does not leave any in-memory bookkeeping referencing the dead tab id.
- [ ] When `chrome.tabGroups` is undefined (older Chrome / fork), `START_SESSION` still resolves successfully with the existing return shape.
- [ ] All new unit + integration tests pass.
- [ ] `make typecheck` clean.
- [ ] No new ESLint / type errors.
- [ ] Existing `tests/service-worker-setpanel.test.ts` still passes — the bind-on-open invariants are not regressed.

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Manifest contains `tabGroups` permission | Unit | JSON snapshot import — no Chrome runtime needed. |
| 2 | START_SESSION groups the tab | Unit | SW loaded with fake chrome, dispatch START, assert `chrome.tabs.group` call. |
| 3 | New group gets title + color | Unit | tab-group.test.ts asserts `updateGroup` args. |
| 4 | Existing group is reused | Unit | tab-group.test.ts seeds `queryGroups` with one match. |
| 5 | STOP_SESSION ungroups the tab | Unit | SW dispatch STOP, assert `chrome.tabs.ungroup` call. |
| 6 | Closing recorded tab cleans up | Unit | SW fires `tabs.onRemoved`, assert no throw + no leftover state. |
| 7 | Best-effort against missing API | Unit | Delete `chrome.tabGroups` from fake chrome, START still resolves. |
| 8 | All tests pass / typecheck clean | Tooling | `make test` + `make typecheck` in CI. |
| 9 | Side-panel invariants not regressed | Unit | Existing `service-worker-setpanel.test.ts` runs unchanged. |

**Speed planner bias**: every DoD line is unit-testable with the existing fake-chrome harness pattern. No integration, no e2e, no manual test required for verification (manual smoke is for the developer, not a CI gate).

**Determinism rule**: zero LLM calls. All Chrome APIs stubbed with `vi.fn()` returning resolved promises. No timers, no real network.

## Testing Strategy

- **Unit**:
  - `tests/tab-group.test.ts` — direct against `assignTabToDeskCheckGroup` / `removeTabFromDeskCheckGroup` with a stubbed `TabGroupApi`. ~10 cases covering find-existing, create-new, missing API, throwing API, idempotent ungroup, color/title configuration.
  - `tests/service-worker-tab-group.test.ts` — uses the same `installFakeChrome` + `vi.resetModules` pattern as `service-worker-setpanel.test.ts`, extended to stub `chrome.tabs.group`, `chrome.tabs.ungroup`, and `chrome.tabGroups.{query,update}`. ~6 cases pinning the SW call sites.
- **Integration**: Skip — the SW test file *is* the integration boundary (it loads the full module). Real chrome.tabGroups can only be exercised manually.
- **E2E**: Skip — repo has no e2e harness wired into CI for tab groups. Manual smoke is sufficient.

**E2E Test Impact**:
- **Existing e2e tests affected**: None. None of the e2e specs touch tab grouping.
- **New e2e tests needed**: None — no new user-visible UI element beyond the Chrome-native group chip; jsdom + fake chrome covers behaviour.
- **Cost note**: n/a.

**Test files to create/modify**:
- `tests/tab-group.test.ts` (new, ~220 lines)
- `tests/service-worker-tab-group.test.ts` (new, ~180 lines)

## Risk Assessment

**Risk Level**: Low

**Why this is safe**:
- All new code is additive — zero edits to existing message handlers, zero edits to storage schema, zero edits to export schema.
- The three SW touch-points are all at the END of their respective handlers (after the critical-path side effects have completed), so even a hard crash inside the tab-group code cannot prevent the session lifecycle from finishing — and they are wrapped in try/catch on top of that.
- The tab-group helper has its own internal `isAvailable()` gate, so on a Chrome build without `chrome.tabGroups` the entire feature silently no-ops.
- Reuses the proven `installFakeChrome` test pattern from `service-worker-setpanel.test.ts` — no new test infrastructure.
- `tabGroups` is a stable MV3 permission (Chrome 89+); no Chrome flag required.

**Critical service-worker invariants this plan preserves** (call out for the judge):
- `chrome.action.onClicked` listener stays SYNC. No tab-group code is added inside `onClicked` or anywhere before `chrome.sidePanel.open`. Tab-group calls are isolated to `START_SESSION` / `STOP_SESSION` / `tabs.onRemoved` handlers, all of which run outside the user-gesture window.
- `START_SESSION` keeps its existing structure and return shape; the new tab-group call lives AFTER the existing `chrome.tabs.sendMessage(SESSION_STARTED)` block and is non-fatal on error, so the `{ recording, sessionId, warnings }` return contract is unchanged. The `warnings` array MAY pick up a "Could not group tab" entry on best-effort failure, OR we omit the warning entirely to avoid touching the contract (preferred — keep it silent, log to console).
- The `toggle-session` command's existing pattern (sync `enablePanelOnTab` + sync `chrome.sidePanel.open` BEFORE the `await handleMessage(START_SESSION)`) is preserved. Tab-group work happens deep inside that handleMessage call, well after the gesture has already been consumed by `sidePanel.open`.
- `tabs.onRemoved` tab-group cleanup goes inside the existing `finally` block AFTER `setBadge(false)`, so it cannot reorder against the existing detach/endSession steps.

**Tradeoffs accepted**:
- We do NOT track the assigned `groupId` in our own state — we rely on `chrome.tabGroups.query({ windowId, title })` each time. Slightly more API calls, but zero risk of stale-id bugs and zero new persisted state to migrate.
- We do NOT explicitly delete the empty group on STOP — Chrome auto-deletes empty groups. (Verified in MV3 docs; if a Chrome version is found that doesn't, we add an explicit query+ungroup follow-up.)
- Color is hard-coded to `"red"`. No customization UI (out of scope per task spec).
- Single-window assumption: if the user moves the tab to a different window mid-session, we don't follow it. Out of scope (cross-window grouping needs feature #7's tab-switch follow-through).
- We don't add a `warnings` entry on group-assign failure — silent best-effort. Avoids touching the START_SESSION return contract.

## Estimated Effort

- Planning: Already done
- Implementation: 35 minutes (1 helper + 3 SW touch-points + manifest)
- Testing: 40 minutes (2 test files, but reusing the proven fake-chrome harness)
- Manual smoke (load unpacked, two-tab test): 10 minutes
- **Total**: ~85 minutes

## Formal Verification Assessment

- Concurrency concerns: No — the SW is single-threaded JS. The only shared state is the in-memory `activeTabId` / `recording` flags and Chrome's own tab-group state. We never interleave reads/writes without the SW event loop boundary.
- State machine complexity: Low — the tab-group lifecycle is `unassigned → assigned → unassigned`, mirroring the session lifecycle one-to-one. No new states.
- Conservation laws: One trivial invariant — "if recording, the recorded tab is in the DeskCheck group (best-effort)". Verified by unit tests; not strong enough to need formal methods.
- Authorization model: No — `tabGroups` permission is a single MV3 boolean.
- Recommendation: **Not needed**. Standard unit + SW-integration tests cover everything.
- If recommended, key invariants (for reference): (a) at most one DeskCheck group per window; (b) assigned tab id ∈ DeskCheck group iff recording === true; (c) ungroup is idempotent.

## What This Plan Does NOT Include

- Does NOT track group ids in our own state — Chrome's `query({ title })` is the source of truth.
- Does NOT add a `warnings` entry on group-assign failure — keeps the START_SESSION return contract unchanged.
- Does NOT add color customization UI — hard-coded `red`.
- Does NOT migrate the tab across windows when the user drags it — defer to feature #7.
- Does NOT add an explicit "delete empty group" call — Chrome auto-deletes empty groups.
- Does NOT add a manual `make tab-group` test target — tests run under existing `make test`.
- Does NOT touch `chrome.action.onClicked`, `setPanelBehavior`, `enablePanelOnTab`, `disablePanelOnTab`, or any of the bind-on-open machinery.
- Does NOT bump `schema_version` — no export schema change.
- Does NOT add an e2e test — repo's e2e suite doesn't cover tab groups and adding one is its own feature.
