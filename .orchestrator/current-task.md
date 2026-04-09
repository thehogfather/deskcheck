# Current task: Feature #9 — Automatic tab group for active DeskCheck tabs

- **Feature ID**: feature-9
- **Title**: Automatic tab group for active DeskCheck tabs
- **Priority**: Later (claimed for active work)
- **Persona**: Bug Reporter
- **Effort**: Small
- **Branch**: feature/feature-9
- **Session**: orch-20260408-222003-4289
- **Worktree**: .claude/worktrees/feature-9
- **Started**: 2026-04-08

## Goal

Give users immediate visual feedback about which tab DeskCheck is actively recording, preventing confusion when many tabs are open.

## Description

When a recording session starts on a tab, automatically add that tab to a dedicated "DeskCheck" tab group via the `chrome.tabGroups` API — distinctive color and label so the user can see at a glance which tabs are under recording. When the session ends (or the tab is closed), remove the tab from the group; clean up the group if it becomes empty. If the group already exists in the current window, reuse it rather than creating a new one.

## Definition of Done (from docs/roadmap.md)

- [ ] `tabGroups` permission is added to `manifest.json`
- [ ] Starting a session adds the active tab to a "DeskCheck" tab group in the current window
- [ ] Tab group has a distinctive color and a clear label (e.g., "DeskCheck")
- [ ] If a "DeskCheck" group already exists in the window, the tab is added to it rather than creating a new one
- [ ] Ending a session removes the tab from the group
- [ ] If the group becomes empty after a session ends, the group is cleaned up
- [ ] Closing a recorded tab while a session is active does not leave orphaned group state
- [ ] Tab group behaviour is unit/integration-tested where possible (`chrome.tabGroups` API mocked)

## Constraints

- Manifest V3 Chrome extension; vanilla TypeScript, no framework
- Vitest-only unit tests (no real Chrome); all `chrome.tabs.group`, `chrome.tabGroups.*` calls must go through a thin injectable seam that tests can stub
- Must not regress the existing feature-8 bind-on-open side-panel behaviour — the SW currently has subtle sync/async ordering in `START_SESSION` and `chrome.action.onClicked`. Tab-group work must not reintroduce awaits that consume the user-gesture budget
- Missing/erroring `chrome.tabGroups` API (older Chrome, non-Chromium fork, or permission revoked) must not crash `START_SESSION`; grouping is best-effort
- Tab group cleanup must be idempotent: calling "remove tab from group" when the tab is already ungrouped, the group is already gone, or the tab itself is gone must not throw

## Out of scope

- Grouping across multiple tabs (sessions are single-tab; only the recorded tab is grouped)
- Tab-switch follow-through (feature #7)
- Color customization UI
