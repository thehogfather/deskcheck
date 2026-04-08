---
agent: quality-planner
generated: 2026-04-08T22:30:00Z
task_id: feature-9
perspective: quality
---

# Quality Plan: Automatic tab group for active DeskCheck tabs

## Architecture Impact

**Components affected:**
- `manifest.json`: add `tabGroups` permission (additive; no host or capability expansion)
- `src/background/service-worker.ts`: thin wiring at three call sites (`START_SESSION`, `STOP_SESSION`, `chrome.tabs.onRemoved`). No new top-level state, no new public message types.
- `src/lib/tab-group.ts` (NEW): pure module hosting `TabGroupManager` and the `TabGroupApi` seam
- `src/lib/tab-group.test.ts` (NEW): exhaustive unit tests over `TabGroupManager` with a fake `TabGroupApi`
- `tests/service-worker-tab-group.test.ts` (NEW): integration tests pinning the SW wiring (a sibling of `tests/service-worker-setpanel.test.ts`)
- `docs/ARCHITECTURE.md`: one-paragraph addition under "Service Worker" describing the bind point and why the manager owns its own seam
- `CHANGELOG.md`: `Added` entry under an unreleased section

**New patterns or abstractions introduced:**
- `TabGroupApi` injectable seam — same shape as the `SessionStorageApi` seam in `src/lib/sidepanel-storage.ts`. This is the project's established "wrap a Chrome namespace behind an interface so unit tests can fake it" pattern; we're reusing it, not introducing a new one.
- `TabGroupManager` class — a small stateful coordinator that owns the per-window "DeskCheck group id" cache and exposes `joinSessionGroup(tabId)` / `leaveSessionGroup(tabId)`. Stateful because the caller (service worker) is also stateful, and threading the cache through every call would expand the SW's surface for no benefit.

**Dependencies added or modified:**
- `@types/chrome` already ships `chrome.tabGroups` types — confirm via typecheck. No package.json changes expected.
- Runtime: `chrome.tabGroups` requires Chrome ≥ 89; DeskCheck already requires ≥ 114 (sidePanel), so no version floor change.

**Breaking changes to existing interfaces:**
- None. The change is additive: a new permission, a new shared module, and three new call sites in the SW that wrap their bodies in try/catch so failure is best-effort.

## Architectural Approach

The `chrome.tabs.group` / `chrome.tabGroups.*` surface is a textbook fit for the project's "pure module behind an injectable seam" pattern (see `pii-modes.ts`, `sidepanel-storage.ts`, `sidepanel-events-source.ts`). All Chrome calls funnel through a narrow `TabGroupApi` interface; production wires the real Chrome namespace; tests wire a fake. The service worker only knows about three high-level operations (`joinSessionGroup`, `leaveSessionGroup`, `forgetTab`) and never touches `chrome.tabGroups` directly. This keeps `service-worker.ts` close to its current size and concentrates the gnarly idempotency / race / feature-detection logic in one tested place.

## Files to Create/Modify

| File | Purpose | Quality Considerations |
|------|---------|----------------------|
| `manifest.json` | Add `tabGroups` to `permissions` | Single-line additive change. Pin via existing `tests/manifest-regression.test.ts` (extend it). |
| `src/lib/tab-group.ts` | NEW. `TabGroupApi` interface, `defaultTabGroupApi()` (returns a no-op when feature is absent), `TabGroupManager` class with `joinSessionGroup`/`leaveSessionGroup`/`forgetTab`, plus pure `TAB_GROUP_TITLE` and `TAB_GROUP_COLOR` constants | One-purpose module. No imports from `service-worker.ts` (no cycles). All methods documented with idempotency contract. Constants exported so tests assert on them rather than magic strings. |
| `src/lib/tab-group.test.ts` | NEW. Exhaustive unit coverage of `TabGroupManager` against a fake api | Vitest. No `chrome` global needed — the seam is injected. Covers happy path, idempotency, races, feature absence, error propagation. |
| `src/background/service-worker.ts` | Wire manager into `START_SESSION`, `STOP_SESSION`, `chrome.tabs.onRemoved` | Three call sites, each wrapped in try/catch with `console.warn`. NO awaits added in the user-gesture path of `chrome.action.onClicked` or `chrome.commands.onCommand`. The manager is instantiated once at module top (mirrors `debuggerClient`). |
| `tests/service-worker-tab-group.test.ts` | NEW. Integration: SW dispatches into the manager at the three call sites | Mirror `service-worker-setpanel.test.ts` structure. Stub `chrome.tabGroups` and `chrome.tabs.group/ungroup` on the fake `chrome` global. Verifies wiring, not internal logic. |
| `tests/service-worker-setpanel.test.ts` | EXTEND `installFakeChrome()` to add `tabs.group`, `tabs.ungroup`, `tabGroups.query`, `tabGroups.update`, `tabGroups.get` so the existing setpanel tests don't break when SW imports the manager | Additive. Existing assertions unchanged. |
| `tests/manifest-regression.test.ts` | EXTEND to assert `tabGroups` is in `permissions` | Additive. |
| `docs/ARCHITECTURE.md` | Add one paragraph under "Service Worker" + new bullet under "Shared Libraries" for `tab-group.ts` | Mirror tone of existing `sidepanel-storage.ts` bullet. |
| `CHANGELOG.md` | Add `Added` entry under an unreleased section | Use the project's "Keep a Changelog" format. |

**Total files**: 9 (4 new, 5 modified)

## Implementation Steps

1. **Define `TabGroupApi` interface in `src/lib/tab-group.ts`** — narrow surface of exactly the four Chrome operations we need (`groupTab`, `ungroupTab`, `queryGroups`, `updateGroup`). Each method returns a `Promise<T>` and is allowed to reject. By keeping the interface minimal we make fakes trivial and reduce the blast radius if Chrome changes the API. *(Quality rationale: smallest possible interface = lowest coupling to Chrome internals.)*

2. **Implement `defaultTabGroupApi()` with feature detection** — returns a real `TabGroupApi` if `chrome.tabGroups` and `chrome.tabs.group` are both present, otherwise returns a `noopTabGroupApi` whose methods resolve with empty defaults. This is the single feature-detection point; downstream code never re-checks. *(Quality rationale: feature detection in one place, like `defaultApi()` in `sidepanel-storage.ts`.)*

3. **Implement `TabGroupManager` with three public methods**:
   - `joinSessionGroup(tabId, windowId): Promise<void>` — find or create the per-window DeskCheck group, add the tab, then `updateGroup` to set color + title (best-effort).
   - `leaveSessionGroup(tabId): Promise<void>` — ungroup the tab, then if its old group is now empty, no cleanup needed (Chrome auto-deletes empty groups). Update internal cache.
   - `forgetTab(tabId): void` — synchronous bookkeeping cleanup for `tabs.onRemoved`. Drops cached group ids that no longer have any tracked tabs.
   *(Quality rationale: three verbs map 1:1 to the three SW call sites; no leaky abstraction.)*

4. **Internal cache: `Map<windowId, groupId>`** — populated lazily on first join in a window, invalidated on `chrome.tabGroups.NOT_FOUND` errors during update. Always re-verifies via `queryGroups` before reusing a cached id. The cache is an optimization, not a source of truth; on any inconsistency it falls back to the query-and-create path. *(Quality rationale: idempotent and self-healing — never trust stale state.)*

5. **Idempotent error handling at every Chrome call** — every method wraps each Chrome call in try/catch and treats "tab does not exist", "group does not exist", "no permission", "tabGroups undefined" as benign. Errors are logged via `console.warn("[DeskCheck] tab group:", err)`. The manager never throws to its caller. *(Quality rationale: tab-group is cosmetic; it must never crash a session.)*

6. **Wire into `service-worker.ts`**:
   - Top of file: `import { TabGroupManager, defaultTabGroupApi } from "../lib/tab-group";` and `const tabGroupManager = new TabGroupManager(defaultTabGroupApi());` next to `const debuggerClient = new DebuggerClient();`.
   - In `START_SESSION` AFTER all the existing awaits (debugger attach, content script inject, sendMessage) — fire `void tabGroupManager.joinSessionGroup(activeTabId, windowId)` without awaiting. Grouping is non-blocking and best-effort; it must not delay the session start or affect the warnings array.
   - In `STOP_SESSION` AFTER `endSession()` and BEFORE the final return — fire `void tabGroupManager.leaveSessionGroup(tabToNotify)`. Non-blocking.
   - In `chrome.tabs.onRemoved` — call `tabGroupManager.forgetTab(tabId)` (synchronous) inside the existing handler, after the existing cleanup but before the panelBoundTabId handling.
   *(Quality rationale: zero awaits added, zero impact on the bind-on-open gesture window, zero new fields on the SW state.)*

7. **Window id resolution**: in `START_SESSION` we need the tab's windowId. The `Message` type for `START_SESSION` does not currently carry it. Two options: (a) extend the message, (b) call `chrome.tabs.get(tabId)` inside the manager. Choose (b) — keeps the message contract stable and isolates the dependency in one module. The manager exposes `joinSessionGroup(tabId)` (no windowId), and resolves windowId internally via the seam. *(Quality rationale: don't expand the message contract for an implementation detail; smaller public surface.)*

8. **Add the `tabGroups` permission to `manifest.json`** — alphabetical position next to `tabs`. Update `tests/manifest-regression.test.ts` to assert it's present.

9. **Extend `installFakeChrome()` in `tests/service-worker-setpanel.test.ts`** — add stubs for `tabs.group`, `tabs.ungroup`, `tabGroups.query`, `tabGroups.update`, `tabGroups.get` (all `vi.fn().mockResolvedValue(...)`). Existing setpanel tests must continue to pass unchanged.

10. **Write `src/lib/tab-group.test.ts`** — see Testing Strategy.

11. **Write `tests/service-worker-tab-group.test.ts`** — see Testing Strategy.

12. **Update `docs/ARCHITECTURE.md`** — paragraph + bullet.

13. **Update `CHANGELOG.md`** — `Added: Active recording tabs are automatically grouped under a "DeskCheck" tab group with a distinctive color, making it visible at a glance which tabs are under recording.`

14. **Run `make typecheck && make test`** — must be green before handoff.

## Definition of Done

- [ ] `tabGroups` permission added to `manifest.json` and pinned by manifest regression test
- [ ] `TabGroupManager` lives in `src/lib/tab-group.ts` with an injectable `TabGroupApi` seam
- [ ] Starting a session adds the active tab to a "DeskCheck" group in its current window
- [ ] Group has color `blue` (or another distinctive non-default) and title `DeskCheck`
- [ ] An existing "DeskCheck" group in the same window is reused, not duplicated
- [ ] Stopping a session ungroups the recorded tab
- [ ] Empty group is cleaned up after session end (Chrome's auto-delete on empty group is sufficient; manager verifies)
- [ ] Closing a recorded tab mid-session: SW state cleanup runs AND `forgetTab` runs without throwing
- [ ] Manager is idempotent — calling `leaveSessionGroup` on an already-ungrouped tab, a tab that no longer exists, or while `chrome.tabGroups` is unavailable does NOT throw
- [ ] Feature absence (`chrome.tabGroups === undefined`) is handled silently — start/stop continue to work
- [ ] Race conditions exercised in tests: group deleted between query and update; tab closed between group and color-update; two windows starting sessions concurrently
- [ ] No new awaits added in the gesture-sensitive paths (`chrome.action.onClicked`, `chrome.commands.onCommand`)
- [ ] No regressions in `tests/service-worker-setpanel.test.ts` (existing setpanel matrix #2/#2b stays green)
- [ ] >90% line coverage for `src/lib/tab-group.ts` (target enforced informally)
- [ ] `make typecheck` clean, `make test` green, no `any` introduced
- [ ] `docs/ARCHITECTURE.md` updated; `CHANGELOG.md` entry added
- [ ] Manual smoke test on a real Chrome instance: load extension, start session, see group; stop, see group remove; close tab mid-session, see no orphan

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `tabGroups` permission in `manifest.json` | Unit | Pure JSON read; existing `manifest-regression.test.ts` pattern. |
| 2 | `TabGroupManager` lives in `src/lib/tab-group.ts` with injectable seam | Unit | Architectural — verified by file existence + import shape. |
| 3 | Starting a session groups the active tab | Integration | Tests SW → manager wiring at the message-handler boundary. |
| 4 | Group has distinctive color + title `DeskCheck` | Unit | Pure manager logic; assert against constants. |
| 5 | Existing group in window is reused | Unit | Pure manager logic; fake api returns a pre-existing group. |
| 6 | Stopping a session ungroups the tab | Integration | Tests SW → manager wiring on STOP_SESSION. |
| 7 | Empty group cleaned up after session end | Unit | Manager verifies via fake api; Chrome's auto-delete is the actual mechanism. |
| 8 | Closing a recorded tab does not orphan group state | Integration | Tests SW `tabs.onRemoved` handler invokes `forgetTab`. |
| 9 | Idempotency on already-ungrouped / missing tab / missing group | Unit | Pure logic; fake api throws and we assert no escape. |
| 10 | Feature absence (`chrome.tabGroups` undefined) silently no-ops | Unit | `defaultTabGroupApi()` returns noop; manager calls noop. |
| 11 | Race: group deleted between query and update | Unit | Fake api throws on update; manager re-queries / falls through. |
| 12 | Race: tab closed between group and color-update | Unit | Fake api throws on update; manager swallows. |
| 13 | Race: two windows starting sessions concurrently | Unit | Two `joinSessionGroup` calls in parallel; assert two distinct groups, no cache cross-pollination. |
| 14 | No new awaits in gesture-sensitive paths | Unit | Static check via existing setpanel test extension — assert `chrome.sidePanel.open` is still called synchronously inside the click handler. |
| 15 | No regression of setpanel matrix #2/#2b | Unit | Existing tests must remain green (extended fake chrome only). |
| 16 | >90% coverage for `tab-group.ts` | Unit | Vitest coverage report. |
| 17 | Typecheck + test green, no `any` | Unit | `make typecheck && make test`. |
| 18 | Architecture doc + changelog updated | (none) | Manual review item, not a test row. |
| 19 | Manual smoke test on real Chrome | E2E (manual) | One-time verification that mocks reflect reality. Not in CI. |

**Quality planner bias**: I push the bulk of coverage into pure unit tests against the seam, with a thin integration layer to pin SW wiring. No automated e2e — the gain (verifying a Chrome API call we already mock-tested) does not justify the cost (full auth+unlock, Playwright Chromium boot, and the e2e suite is currently focused on the side panel visibility quirks, not tab groups). One manual smoke test is sufficient.

**Determinism rule**: All tests are deterministic. No real Chrome calls. No LLMs involved.

## Testing Strategy

- **Unit (`src/lib/tab-group.test.ts`)** — comprehensive coverage of `TabGroupManager`. Specific cases:
  - `joinSessionGroup` creates a new group when none exists in the window (asserts `groupTab` called with `createProperties: { windowId }`, then `updateGroup` with `{ title: "DeskCheck", color: "blue" }`)
  - `joinSessionGroup` reuses an existing DeskCheck group in the same window (fake api `queryGroups` returns one; assert `groupTab` called with `groupId`, NOT `createProperties`)
  - `joinSessionGroup` with two different windows creates two distinct groups
  - `joinSessionGroup` is a no-op when `chrome.tabGroups` is unavailable (noop api injected; assert no throw and no calls)
  - `joinSessionGroup` survives `groupTab` rejecting (tab gone)
  - `joinSessionGroup` survives `updateGroup` rejecting (group gone after group-add) — title/color fail silently, group still has the tab
  - `joinSessionGroup` survives `queryGroups` rejecting
  - `leaveSessionGroup` calls `ungroupTab` with `[tabId]`
  - `leaveSessionGroup` is idempotent — second call is a no-op-style swallow
  - `leaveSessionGroup` survives `ungroupTab` rejecting (tab gone, group gone, etc.)
  - `forgetTab` synchronously drops cached associations and never throws
  - Concurrent `joinSessionGroup(tabA, win1)` + `joinSessionGroup(tabB, win2)` do not pollute each other's cache (race test using `Promise.all`)
  - Cache invalidation: after `updateGroup` rejects with NOT_FOUND, the next `joinSessionGroup` in the same window queries again rather than using the stale cache
  - Constants `TAB_GROUP_TITLE === "DeskCheck"` and `TAB_GROUP_COLOR` is one of Chrome's allowed values

- **Integration (`tests/service-worker-tab-group.test.ts`)** — pins the SW → manager wiring. Mirrors the structure of `service-worker-setpanel.test.ts`:
  - Loads `service-worker.ts` against `installFakeChrome()` (extended with tabGroup stubs)
  - Dispatches `START_SESSION` and asserts `chrome.tabs.group` was called with the right tabId
  - Dispatches `STOP_SESSION` and asserts `chrome.tabs.ungroup` was called
  - Fires `tabs.onRemoved` for the recording tab and asserts no throw + no orphan state in the manager
  - Asserts `chrome.tabs.group` is NOT called inside the synchronous body of `chrome.action.onClicked` (gesture preservation)
  - Asserts the SW does not throw or alter behaviour when `chrome.tabGroups = undefined`

- **E2E**: NOT proposed for this feature. The mocks fully exercise the contract; a manual smoke test on real Chrome covers the "do the mocks reflect reality" question once.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: None. `e2e/sidepanel-debug.spec.ts` does not query tab groups and is not on a path that touches `chrome.tabGroups`.
- **New e2e tests needed**: None automated. One manual smoke test step added to the implementation checklist (load unpacked → start session → verify group → stop session → verify removed → close tab mid-session → verify no orphan).
- **Cost note**: Each e2e test does full auth+unlock — the cost is not justified for a cosmetic, fully-mockable feature.

**Test files to create/modify**:
- CREATE `src/lib/tab-group.test.ts`
- CREATE `tests/service-worker-tab-group.test.ts`
- MODIFY `tests/service-worker-setpanel.test.ts` (extend `installFakeChrome` only)
- MODIFY `tests/manifest-regression.test.ts` (assert new permission)

**Coverage target**: >90% lines for `src/lib/tab-group.ts`. Service worker delta is just three call sites, covered by the integration test.

## Code Quality Checklist

- [ ] Follows SOLID — `TabGroupManager` has one job (manage the DeskCheck group); `TabGroupApi` is the dependency-inversion seam
- [ ] No code duplication — feature detection in one place (`defaultTabGroupApi`)
- [ ] Clear naming: `joinSessionGroup` / `leaveSessionGroup` / `forgetTab` map to user-visible verbs
- [ ] Appropriate abstraction level: small interface, no premature generalisation (no "GroupRegistry", no "TabGroupRepository")
- [ ] Comprehensive error handling: every Chrome call try/wrapped, all benign errors logged via `console.warn` not thrown
- [ ] Strict types — no `any`. `TabGroupApi` methods return `Promise<chrome.tabGroups.TabGroup>`, etc.
- [ ] Edge cases: feature absent, group deleted mid-flight, tab closed mid-flight, two windows concurrently, cache stale
- [ ] Logging: warn-level only, with `[DeskCheck] tab group:` prefix matching project convention

## Patterns to Apply

| Pattern | Where | Why |
|---------|-------|-----|
| Injectable API seam | `TabGroupApi` parameter on `TabGroupManager` constructor | Tests never touch real Chrome — established by `sidepanel-storage.ts` |
| Feature detection at the boundary | `defaultTabGroupApi()` returns a noop when `chrome.tabGroups` is undefined | Single decision point; downstream code stays oblivious |
| Self-healing cache | Window→groupId map invalidated on NOT_FOUND, re-queried | Tolerates user manually dragging a tab out of the group or deleting it |
| Stateful coordinator class | `TabGroupManager` mirrors `DebuggerClient` | Established SW pattern: instantiate once at module top, methods share state |
| Best-effort async | All call sites use `void manager.joinSessionGroup(...)` not `await` | Grouping is cosmetic and must not block session start or consume gesture budget |

## Impact Assessment

**Positive Impacts**:
- Architecture: introduces a clean, narrow seam for a Chrome API without inflating the SW
- Maintainability: future tab-group enhancements (e.g. multi-tab sessions for feature #7) plug into the same manager
- Testability: 100% of Chrome API surface for this feature is unit-testable; no Chrome runtime needed
- User experience: visual cue for which tab is recording, addressing real confusion when many tabs are open

**Neutral** (what stays the same):
- Side panel binding logic — not touched
- Session state shape (`SessionMetadata`) — not touched
- Export schema — not touched
- Message protocol — not touched
- Keyboard shortcut behaviour — not touched
- Number of awaits in `chrome.action.onClicked` and `chrome.commands.onCommand` — zero new awaits

**Risks**:
- *User manually drags the recorded tab out of the DeskCheck group mid-session.* Mitigation: cache invalidation on NOT_FOUND; manager re-queries on next op. Worst case: stop session, group already gone — `leaveSessionGroup` swallows the error.
- *User manually renames the DeskCheck group.* Mitigation: we query by title; a renamed group won't be found and we create a fresh one. Acceptable — no crash, just a duplicate group, which is a self-inflicted edge case.
- *`chrome.tabGroups` permission denial in some forks (Edge, Brave).* Mitigation: feature detection returns noop. Session continues; no UI change.
- *Race: two parallel `START_SESSION` calls from concurrent windows could interleave on the cache.* Mitigation: cache is per-windowId; concurrent operations on different windows are independent. Concurrent operations on the same window are not a real scenario (the user gesture model prevents it), but the manager handles it gracefully via re-query.

## Estimated Effort

- Planning: Already done
- Implementation:
  - `tab-group.ts` module: ~25 minutes
  - `service-worker.ts` wiring: ~10 minutes
  - `manifest.json` + regression test extension: ~5 minutes
- Testing:
  - `tab-group.test.ts` (~14 unit tests): ~30 minutes
  - `service-worker-tab-group.test.ts` (~6 integration tests): ~20 minutes
  - Extend `installFakeChrome` in setpanel test: ~5 minutes
- Docs (architecture + changelog): ~10 minutes
- Manual smoke test: ~5 minutes
- Review prep / typecheck / lint: ~5 minutes
- **Total**: ~115 minutes (~2 hours)

## Technical Debt Addressed

- Establishes a precedent for `chrome.tabGroups` access via a single seam, so future tab-group work (feature #7 tab-switch follow-through) can extend the manager rather than reaching into Chrome from `service-worker.ts` directly.
- Avoids new debt: no message-contract expansion, no new SW state fields, no leak into the side panel layer.

## Formal Verification Assessment

- Concurrency concerns: Yes — concurrent `joinSessionGroup` across windows shares a cache. Bounded scope; covered by unit tests.
- State machine complexity: No — three verbs, all idempotent. Not worth a state machine.
- Conservation laws: No — tab groups are best-effort cosmetic state; no invariant must hold across crashes.
- Authorization model: No.
- Recommendation: **Not needed.** Standard unit + integration tests are sufficient. The blast radius of a bug here is "tab group looks weird", not data loss or privacy leak.

## Future Extensibility

This design accommodates several likely future changes without rework:
- **Feature #7 (tab-switch follow-through)**: when DeskCheck supports recording across multiple tabs, the manager simply gets `joinSessionGroup(newTabId)` calls for each follow-up tab. The "find or create" + cache logic already supports it.
- **Feature: customisable group color**: surface a `setColor(color: chrome.tabGroups.ColorEnum)` on the manager; the constant becomes a default. No call-site changes elsewhere.
- **Feature: collapse the DeskCheck group when no session is active**: add `collapseGroup(windowId)` to the manager. The `TabGroupApi` already exposes `updateGroup`.
- **Edge browsers without tabGroups**: already handled today via the noop api; no future work needed.
