---
agent: safety-planner
generated: 2026-04-08T22:30:00Z
task_id: feature-9
perspective: safety
---

# Safety Plan: Automatic Tab Group for Active DeskCheck Tabs

> Risk-first plan. The single inviolable invariant: **`START_SESSION` must succeed even if every line of tab-grouping code throws.** Tab groups are decoration; recording is the product.

## Architecture Impact

**Components affected:**
- `manifest.json` — adds `tabGroups` permission (triggers Chrome re-permission prompt on upgrade for existing users)
- `src/background/service-worker.ts` — `START_SESSION`, `STOP_SESSION`, and `tabs.onRemoved` paths gain best-effort calls into a new tab-group helper
- `src/lib/tab-group.ts` (new) — pure-ish module wrapping `chrome.tabs.group` / `chrome.tabGroups.*` behind an injectable `TabGroupApi` seam
- `tests/tab-group.test.ts` (new) — unit tests of the helper against a mock `TabGroupApi`
- `tests/service-worker-tabgroup.test.ts` (new) — integration test that the SW tolerates tabGroups failures
- `tests/manifest-regression.test.ts` — extended to assert `tabGroups` permission is present (and that core feature-8 invariants still hold)

**New patterns or abstractions introduced:**
- `TabGroupApi` interface — single seam for `chrome.tabs.group`, `chrome.tabGroups.update`, `chrome.tabGroups.query`, `chrome.tabGroups.move`. Allows testing without Chrome and lets the helper return a no-op implementation when the API is missing.
- `withGroupingBestEffort(fn)` wrapper — every grouping call site is wrapped in a try/catch that logs a warning prefixed `[DeskCheck:tab-group]` and returns. **Errors never propagate to the SW message handler.**

**Dependencies added or modified:**
- None (Chrome built-in API only)
- `@types/chrome` should already export `chrome.tabGroups` types — verify in plan step 1

**Breaking changes to existing interfaces:**
- None to TS interfaces
- **User-visible breaking change**: adding `tabGroups` to `permissions[]` causes Chrome to **disable the extension on upgrade until the user re-accepts permissions**. This is a known Chrome behavior for non-optional permission additions and must be communicated in the release notes and version bump.

**Risk points in architecture this task touches:**
- The synchronous user-gesture window in `chrome.action.onClicked` (feature-8). Tab-group code MUST NOT run inside that handler.
- The `START_SESSION` async chain that already has multiple `await` points (debugger attach, content script inject, sendMessage). Adding another await must not push total latency past the user's perception of "instant start."
- `tabs.onRemoved` which already does session cleanup and panel binding cleanup. Adding group cleanup increases the surface area of this critical path.

## Risk Assessment

### Identified Risks
| Risk | Severity | Likelihood | Impact | Mitigation |
|------|----------|------------|--------|------------|
| `chrome.tabGroups` missing on older Chrome / Chromium fork | High | Medium | START_SESSION crashes, recording dies | Feature-detect at module load; helper returns no-op stub if API absent. Helper is called via `void` so unhandled rejection cannot crash the SW. |
| Permission re-prompt on upgrade disables extension for active users | High | High | Users open Chrome tomorrow and DeskCheck is dead until they click "enable" | Document in release notes; bump minor (0.4.0 → 0.5.0) so the change is conspicuous in the changelog; verify behavior in a staging install before tagging |
| `chrome.tabs.group` resolves but tab is closed before we read groupId | Medium | Low | Stale `groupId` stored in module state; later `STOP_SESSION` tries to operate on a dead group | Wrap groupId fetch in try/catch; if `chrome.tabs.get(tabId)` throws "No tab with id" first, skip grouping entirely. Treat any error as "no group exists" — idempotent cleanup. |
| Another extension modifies the DeskCheck group concurrently | Medium | Low | Group color/title gets clobbered, or the group disappears between `group()` and `update()` | Don't fight it. On every START_SESSION re-query for an existing "DeskCheck" group by title before creating; if `update()` to set color/title fails, log and continue. The recording is still bound to the right tab. |
| SW wakes mid-session, group was manually dissolved by user | Medium | Medium | Visual feedback gone but session is fine | On `restoreState()`, do NOT re-group. The user explicitly removed the group; respect that. Log a one-line debug message and proceed. |
| `STOP_SESSION` fails to remove tab from group → tab stays "DeskCheck-decorated" forever | Low | Low | Stale visual state until user closes the tab | Acceptable. Document as known minor cosmetic. STOP_SESSION's idempotent helper logs and continues. User can manually drag the tab out of the group; nothing functional is broken. |
| Tab-group code runs inside `chrome.action.onClicked` and consumes the user-gesture token | Critical | Low (if we follow the rule) | `chrome.sidePanel.open()` rejects with "may only be called in response to a user gesture" → feature-8 broken | Hard rule: **NO tab-group calls in `onClicked`, `commands.onCommand`, or any sync path that needs the gesture window.** All grouping happens inside the `START_SESSION` message handler, which is already async and well past the gesture budget. Pinned by a regression test that asserts the onClicked handler does not call any TabGroupApi method. |
| `START_SESSION` regression — added await for grouping causes content script SESSION_STARTED race | Medium | Low | Existing content script timing relies on the 100ms sleep; an extra await might shift things | Place the grouping call AFTER the existing `setTimeout(100)` and `sendMessage(SESSION_STARTED)`. Grouping is the LAST thing START_SESSION does, so it cannot affect anything upstream. |
| `tabs.onRemoved` adds group cleanup that throws and aborts panel-binding cleanup | Medium | Low | `panelBoundTabId` stays set, breaking feature-8 panel scoping | Group cleanup runs in its own try/catch *after* the existing detach/endSession + panel binding clear. Order matters: feature-8 cleanup first, then group cleanup. |
| Title-based group lookup matches a user's own "DeskCheck" group (not ours) | Low | Low | We hijack a user-created group with the same name | Acceptable trade-off. The roadmap explicitly says "reuse existing DeskCheck group." Document in code comment: we do not tag groups with extension metadata because the API has no such field. |

### Failure Modes Analysis

1. **chrome.tabGroups API undefined**
   - Cause: Chromium fork, very old Chrome, or permission revoked at runtime
   - Detection: Feature-detect at module load; `tabGroupApi.available === false`
   - Recovery: All helper methods become no-ops. START_SESSION returns success. Console warning once at load: "[DeskCheck:tab-group] chrome.tabGroups API unavailable; visual grouping disabled."

2. **`chrome.tabs.group()` throws ("No tab with id N")**
   - Cause: User closed the tab between selecting "Start" and the SW reaching the group call
   - Detection: Promise rejects with Chrome error string
   - Recovery: `tabs.onRemoved` will fire next; let normal session-end cleanup take over. Helper logs and returns. START_SESSION still returns `recording: true` (the session was created moments earlier and the tab close handler will tear it down).

3. **`chrome.tabGroups.update(groupId, { title, color })` throws**
   - Cause: Group was deleted between the group() call and the update() call (race with another extension or user)
   - Detection: Promise rejects
   - Recovery: Log and continue. Tab is in a group; just not styled the way we wanted. Acceptable.

4. **`chrome.tabGroups.query({ title: "DeskCheck", windowId })` throws or returns stale data**
   - Cause: Chrome internal hiccup; window closed mid-query
   - Detection: Promise rejects or returns empty unexpectedly
   - Recovery: Treat as "no existing group" and create a new one. Worst case: a duplicate group is created. User can manually merge. Logged warning.

5. **STOP_SESSION cleanup fails to find/empty the group**
   - Cause: Group was manually edited (renamed, dissolved) between start and stop
   - Detection: `tabGroups.query` returns empty or wrong group
   - Recovery: No-op and continue. The session ends correctly. The user's manual changes are respected.

6. **`tabs.onRemoved` cleanup throws partway through**
   - Cause: chrome.tabGroups.query throws because the window itself is also being closed
   - Detection: Caught by helper's try/catch
   - Recovery: Logged and ignored. Chrome cleans up groups for closed windows automatically.

### Blast Radius
- **Affected users**: All DeskCheck users (Chrome ≥89 has tabGroups; older versions silently degrade)
- **Affected systems**: `START_SESSION` path, `STOP_SESSION` path, `tabs.onRemoved` listener, `manifest.json` permissions
- **Data at risk**: None. Tab groups are presentation-only state managed by Chrome. No session data, no exports, no storage modifications. Recording integrity is independent of grouping.
- **Worst plausible production impact**: If permission re-prompt + tabGroups runtime failure both hit the same user, the extension is disabled on upgrade and they have to click through a permission dialog. Once accepted, recording works normally.

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 1 | Add `tabGroups` to manifest.json permissions; bump version 0.4.0 → 0.5.0 | `make typecheck` + manifest-regression test passes | `git revert` (single-file change) |
| 2 | Create `src/lib/tab-group.ts` with `TabGroupApi` interface, feature detection, `addTabToDeskCheckGroup`, `removeTabFromDeskCheckGroup`, `cleanupEmptyDeskCheckGroup`, all wrapped in `withGroupingBestEffort` | New tab-group.test.ts passes (all error paths covered) | Delete file; revert manifest |
| 3 | Wire `addTabToDeskCheckGroup` into `START_SESSION` AFTER the existing sendMessage(SESSION_STARTED) — grouping is the last step, fire-and-forget via `void` | service-worker-setpanel.test.ts still passes (no regression in feature-8 invariants) | Remove the single call site |
| 4 | Wire `removeTabFromDeskCheckGroup` + `cleanupEmptyDeskCheckGroup` into `STOP_SESSION` AFTER existing sendMessage(SESSION_STOPPED) | service-worker-tabgroup.test.ts integration test passes | Remove the call site |
| 5 | Wire group cleanup into `tabs.onRemoved` AFTER feature-8 panel binding cleanup | tabs.onRemoved order test passes | Remove the call site |
| 6 | Add manifest-regression assertions for `tabGroups` permission | All manifest tests pass | Revert assertion |
| 7 | Manual verification: load unpacked, start session, observe group; stop session, observe cleanup; close tab mid-session, observe cleanup | All manual checks pass | Roll back via the feature flag (see Rollback Strategy) |

## Files to Create/Modify
| File | Purpose | Risk Notes |
|------|---------|------------|
| `manifest.json` | Add `tabGroups` to permissions; bump to 0.5.0 | Triggers Chrome re-permission prompt on upgrade — user-visible |
| `package.json` | Bump to 0.5.0 to match manifest | Must stay in sync (existing test pins this) |
| `src/lib/tab-group.ts` (new) | Pure helper module behind injectable seam | Single chokepoint for all grouping; all errors caught here |
| `src/background/service-worker.ts` | Three new call sites (START, STOP, onRemoved), all wrapped in `void` and try/catch | Must not regress feature-8 sync gesture handling — verified by test |
| `tests/tab-group.test.ts` (new) | Unit tests for the helper | Cover every error path explicitly |
| `tests/service-worker-tabgroup.test.ts` (new) | Integration: SW tolerates tabGroups failures | Asserts START_SESSION returns `recording:true` even when every tabGroups call rejects |
| `tests/manifest-regression.test.ts` | Add `tabGroups` permission assertion | Pin so future edits don't drop it |

## Definition of Done
- [ ] All identified risks have mitigations in place
- [ ] `tabGroups` permission added to manifest.json
- [ ] `START_SESSION` returns `recording: true` even when `chrome.tabGroups` is undefined / throws / rejects (test-pinned)
- [ ] `chrome.action.onClicked` handler does not import or call any TabGroupApi method (grep test or call-tracking test)
- [ ] `START_SESSION` successfully groups the tab on the happy path; group has color and label "DeskCheck"
- [ ] Existing "DeskCheck" group in the same window is reused (not duplicated)
- [ ] `STOP_SESSION` removes the tab from the group
- [ ] Empty group is cleaned up after `STOP_SESSION`
- [ ] `tabs.onRemoved` mid-session: feature-8 cleanup runs first, then group cleanup; both errors are independent
- [ ] Helper functions are idempotent (calling them when tab is ungrouped / group is gone / tab is gone is a no-op)
- [ ] Rollback procedure documented (see below) and tested by reverting locally
- [ ] All existing tests pass (especially `tests/service-worker-setpanel.test.ts` and `tests/manifest-regression.test.ts`)
- [ ] No type errors
- [ ] Release notes drafted mentioning the permission re-prompt

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | tabGroups permission in manifest | Unit (file-read) | Static manifest assertion, no Chrome runtime |
| 2 | START_SESSION succeeds when tabGroups missing | Integration | Crosses SW message handler + helper boundary; mocks chrome.* |
| 3 | START_SESSION succeeds when tabGroups throws | Integration | Same boundary; rejection path |
| 4 | onClicked never touches TabGroupApi | Unit | Static call-tracking against the mock; cheap and decisive |
| 5 | Happy-path grouping creates group with correct title+color | Unit | Pure helper against mock TabGroupApi |
| 6 | Existing group reused | Unit | Helper takes a query result; deterministic |
| 7 | STOP_SESSION removes tab from group | Integration | SW path + helper |
| 8 | Empty group cleanup | Unit | Pure helper logic |
| 9 | tabs.onRemoved mid-session ordering (panel binding cleared first) | Integration | Order is the property under test; needs the real handler chain |
| 10 | Helper is idempotent (no-op on missing tab/group) | Unit | Pure error-path coverage |
| 11 | Rollback (feature flag off) leaves grouping disabled | Unit | Single-flag check, no runtime needed |
| 12 | Manual visual verification of color/label in real Chrome | Manual | Cannot mock real Chrome chrome rendering |

**Safety planner bias**: Most coverage at unit level for the helper (cheap, exhaustive error paths) plus integration tests at the SW boundary where regressions would actually hurt users. Zero new e2e tests — the existing `e2e/sidepanel-debug.spec.ts` is the canary for feature-8 regressions and will catch any gesture-window damage.

**Determinism rule**: All tests use the injectable `TabGroupApi` mock. No real Chrome calls, no flaky timing dependencies, no LLM. Every test is deterministic.

## Testing Strategy (Comprehensive)

### Unit Tests (`tests/tab-group.test.ts`)
- `addTabToDeskCheckGroup` creates a new group when none exists, sets title="DeskCheck", sets a distinctive color
- `addTabToDeskCheckGroup` reuses an existing group with title="DeskCheck" in the same windowId
- `addTabToDeskCheckGroup` returns gracefully when `chrome.tabs.group` throws "No tab with id"
- `addTabToDeskCheckGroup` returns gracefully when `chrome.tabGroups.update` throws (group deleted mid-call)
- `addTabToDeskCheckGroup` returns gracefully when `chrome.tabGroups.query` throws
- `addTabToDeskCheckGroup` is a no-op when `TabGroupApi.available === false` (feature detection)
- `removeTabFromDeskCheckGroup` calls `chrome.tabs.ungroup` and swallows "No tab with id"
- `removeTabFromDeskCheckGroup` is a no-op when the tab is not currently in any group
- `cleanupEmptyDeskCheckGroup` queries the group, sees zero tabs, does nothing (Chrome auto-removes empty groups; this is just a sanity log)
- `cleanupEmptyDeskCheckGroup` swallows query errors
- `withGroupingBestEffort` logs a warning with the `[DeskCheck:tab-group]` prefix and returns undefined on any thrown error
- **Edge cases**:
  - tabGroupApi.available is false (older Chrome)
  - chrome.tabs.group resolves with `groupId === -1` (Chrome's "no group" sentinel)
  - chrome.tabGroups.query returns multiple matching groups (we pick the first)
  - title comparison is case-sensitive (we always use "DeskCheck" exactly)
  - windowId is undefined (treat as "any window" — Chrome's default)

### Integration Tests (`tests/service-worker-tabgroup.test.ts`)
- `START_SESSION` returns `{ recording: true }` when `chrome.tabGroups` is undefined on the global
- `START_SESSION` returns `{ recording: true }` when every TabGroupApi method rejects
- `START_SESSION` returns `{ recording: true }` and observably calls `addTabToDeskCheckGroup` on the happy path
- `STOP_SESSION` returns `{ recording: false }` even when group cleanup throws
- `tabs.onRemoved` for the recording tab clears `panelBoundTabId` (feature-8 invariant) BEFORE calling group cleanup; verified by interleaving a throwing group cleanup mock and asserting panel binding was already cleared
- Regression: `chrome.action.onClicked` handler invocation does NOT call any TabGroupApi method (mock is asserted not-called after the click)
- Regression: `chrome.sidePanel.open` is still called synchronously inside the click handler (re-asserts the feature-8 invariant from `service-worker-setpanel.test.ts`)

### E2E Tests
- **None added.** Tab-group visual rendering is Chrome's responsibility; we should not pin Chrome's chrome (heh) behavior in our tests.
- **Existing e2e tests affected**: `e2e/sidepanel-debug.spec.ts` may incidentally observe a tab group during its run; verify its assertions don't break (they shouldn't — it asserts panel visibility, not tab structure)
- **New e2e tests needed**: None. Manual verification once before release is sufficient for visual confirmation.
- **Cost note**: Saved zero e2e test runs but avoided creating a flaky Chrome-rendering test.

### Regression Tests
- `tests/service-worker-setpanel.test.ts` — must pass unchanged. Re-run as part of CI. Specifically the "calls sidePanel.open synchronously inside the click listener" test pins the feature-8 invariant.
- `tests/manifest-regression.test.ts` — extended to add `tabGroups` permission assertion AND keep the existing "no default_popup", "no side_panel.default_path", and version-match assertions
- `tests/sidepanel-no-direct-capture.test.ts` — must pass unchanged

### Load/Stress Tests
- N/A. Grouping is one-shot per session start/stop, not on a hot path.

### What Does NOT Need to Be Tested
- **Chrome's actual rendering of tab groups** — that's Chrome's job, not ours. We trust the API contract.
- **Color value semantics** — we pick a color from the documented enum (`blue` / `red` / etc.); we do not test that "blue" looks blue.
- **Cross-window grouping** — sessions are single-tab in a single window; we explicitly query by `windowId`.
- **Tab group collapse/expand state** — we don't touch it. Chrome's default behavior.
- **Concurrent SW wakes from multiple windows** — the SW is a singleton; no concurrency.
- **Performance of `chrome.tabGroups.query`** — it's a cheap, in-memory Chrome operation.

**Test files to create/modify**:
- Create: `tests/tab-group.test.ts`
- Create: `tests/service-worker-tabgroup.test.ts`
- Modify: `tests/manifest-regression.test.ts` (add tabGroups permission assertion)

## Rollback Strategy

### Trigger Conditions
Rollback if:
- Users report START_SESSION failing on Chrome upgrade (permission re-prompt friction is too high)
- Tab grouping conflicts with another popular extension (e.g., a tab manager) and users complain
- Visual grouping is disruptive to a workflow we didn't anticipate (e.g., users who rely on tab order)
- Any test in `tests/service-worker-setpanel.test.ts` starts flaking after merge

### Rollback Steps
**Option A — Feature flag (recommended, fastest):**
1. The `tab-group.ts` helper exports a top-level `TAB_GROUP_FEATURE_ENABLED` constant. Set to `false`.
2. `make build`, reload extension. Grouping is now a no-op everywhere.
3. The `tabGroups` permission stays in the manifest (removing it would trigger ANOTHER permission prompt). The permission is harmless when unused.

**Option B — Full revert:**
1. `git revert` the feature commit(s)
2. Bump to 0.5.1 (do not roll back to 0.4.0 — semver is monotonic)
3. Note in changelog: feature withdrawn pending redesign

### Verification After Rollback
- [ ] `make test` passes
- [ ] Manual: start a session, verify recording works as before, no group is created
- [ ] Manual: stop a session, verify clean shutdown
- [ ] Existing tab groups created during the buggy version do not break the rollback (they become inert; user can dissolve manually)

### Rollback Tested?
- [x] Yes — feature flag path is testable (a unit test sets `TAB_GROUP_FEATURE_ENABLED=false` and asserts every helper is a no-op)
- [ ] Full git revert: not pre-tested; documented procedure only

## Monitoring & Alerting

DeskCheck has no telemetry pipeline (single production dependency: fflate; "No external network requests" per ARCHITECTURE.md). Monitoring is by user report only.

### What We Watch (Manually)
| Signal | Source | Threshold |
|--------|--------|-----------|
| GitHub issues mentioning "tab group" or "permission" | Issue tracker | 1+ in first week post-release |
| GitHub issues mentioning "session won't start" or "extension disabled" | Issue tracker | Any |
| Chrome Web Store reviews mentioning tabs disappearing or being grouped weirdly | Web Store | Any |

### Alerts to Configure
- None automated. Manual review of release feedback for the first 7 days.

## Deployment Recommendations

- [x] **Feature flag**: Recommended — `TAB_GROUP_FEATURE_ENABLED` constant in `tab-group.ts`. Lets us ship the permission and the code in the same release but disable the behavior with a one-line patch.
- [x] **Gradual rollout**: Recommended — release to `next` channel first if available, otherwise pin a version tag and only update the Web Store listing after a 48h dogfood window
- [x] **Staging verification**: Required — load unpacked from `dist/`, exercise the happy path AND the "Chrome restart with active session" path before tagging
- [ ] **Off-hours deployment**: N/A for a Chrome extension

## Estimated Effort
- Planning: Already done
- Implementation: 45 minutes (helper + three call sites + manifest)
- Safety verification: 20 minutes (test the missing/throwing API paths explicitly)
- Testing: 60 minutes (unit + integration tests, including the regression assertions)
- Manual verification in real Chrome: 15 minutes
- **Total**: ~140 minutes (~2h20m)

## Formal Verification Assessment
- Concurrency concerns: **No.** SW is single-threaded; tab group operations are sequential per session
- State machine complexity: **No.** Three states (no group / in group / cleanup) with linear transitions
- Conservation laws: **No.** No counts, balances, or invariants beyond "tab is in at most one DeskCheck group at a time"
- Authorization model: **No.** No access control
- Recommendation: **Not needed.** This is a small additive feature with idempotent operations and clear failure boundaries. The cost of TLC modeling exceeds the benefit. Standard unit + integration tests are sufficient.
- If we did model it: invariants would be (a) tab is in at most one DeskCheck group at a time, (b) the group exists ⟺ at least one DeskCheck-recorded tab is in it (Chrome enforces this for us), (c) START_SESSION result.recording is independent of any TabGroupApi call result.

## What Breaks Production If This Ships?

**Most likely failure**: Permission re-prompt disables the extension for active users on auto-update. Mitigation: minor version bump (0.5.0) so the changelog is conspicuous; release notes explicitly mention it.

**Worst-case failure**: An unhandled rejection from a `tabGroups.*` call in some edge environment crashes `START_SESSION` and recording silently breaks. Mitigation: every call site is `void`-prefixed and wrapped in `withGroupingBestEffort`; integration tests pin that START_SESSION succeeds even when EVERY tab-group call rejects.

**Subtle regression**: Tab-group code accidentally runs inside the gesture-sensitive path of `chrome.action.onClicked` and breaks feature-8. Mitigation: explicit test asserting the onClicked handler does not invoke TabGroupApi. Hard rule documented in `tab-group.ts` header comment.

**Acceptable degraded state**: A stale "DeskCheck" group remains visible after a session ends because cleanup raced with another extension. User dismisses it manually. Recording still worked. Logged as a known minor.

## Security Considerations
- [x] No secrets in code
- [x] Input validation: tab IDs come from Chrome itself, not user input
- [x] Output encoding: title is a fixed literal string "DeskCheck"; no injection surface
- [x] Authentication/authorization: N/A (no auth in DeskCheck)
- [x] OWASP top 10: not relevant to a local-only Chrome extension; no network surface added
- [x] Permissions principle of least privilege: `tabGroups` is the minimum scope needed
- [x] Privacy: tab group title is a fixed literal "DeskCheck" — no user data leaks into Chrome's tab UI
