// Feature #9 — Automatic tab group for active DeskCheck tabs.
//
// Purpose: give Bug Reporters a visual cue for which tab DeskCheck is
// actively recording by placing it in a dedicated "DeskCheck" Chrome
// tab group (distinctive color + title). This is decorative,
// best-effort metadata — the recording itself MUST NOT depend on any
// tab-group call succeeding.
//
// Design
// ──────
// Two small functions with a single injectable seam:
//
//   - assignTabToDeskCheckGroup(tabId, windowId, api?)
//   - removeTabFromDeskCheckGroup(tabId, api?)
//
// Both are feature-detected via api.isAvailable() and wrapped in a
// single top-level try/catch that swallows every rejection from the
// injected API. Callers can fire-and-forget without worrying about
// unhandled rejections or the recording lifecycle stalling.
//
// We never cache group ids. `chrome.tabGroups.query({windowId, title})`
// is the source of truth on every operation — if the user manually
// deleted the group, renamed it, or dragged the tab out, we rediscover
// state on the next call. This makes the module stateless, race-free,
// and trivially correct under concurrent multi-window scenarios.
//
// Empty-group cleanup is delegated to Chrome, which auto-deletes groups
// when the last tab is removed. There is no explicit delete call and
// therefore no code path to test for it.
//
// ⚠️ CALL-SITE CONSTRAINT — DO NOT VIOLATE
// ────────────────────────────────────────
// These functions MUST NOT be called from inside
// `chrome.action.onClicked`, `chrome.commands.onCommand`, or any other
// handler that relies on the user-gesture token (notably the feature-8
// side panel code path that calls `chrome.sidePanel.open`). They await
// Chrome IPCs and would consume the gesture budget, breaking the
// synchronous ordering that `sidePanel.open()` requires. Permitted call
// sites are: `START_SESSION` / `STOP_SESSION` message handlers and the
// `chrome.tabs.onRemoved` listener, where the gesture window has long
// since closed.
//
// Pinned by:
//   - tests/tab-group.test.ts (unit, all error paths)
//   - tests/service-worker-tab-group.test.ts (integration + feature-8
//     regression guard: onClicked handler must not touch any method on
//     this module's injected api)

export const DESKCHECK_GROUP_TITLE = "DeskCheck";
// Blue differentiates the tab group from the red "REC" toolbar badge
// (set in service-worker.ts#setBadge) — the two cues are adjacent in
// Chrome's chrome, so using the same color would collapse them.
export const DESKCHECK_GROUP_COLOR: chrome.tabGroups.ColorEnum = "blue";

export interface TabGroupInfo {
  id: number;
  windowId: number;
  title?: string;
  color?: chrome.tabGroups.ColorEnum;
}

export interface TabGroupApi {
  /** Feature detection: true iff chrome.tabGroups + chrome.tabs.group/ungroup are callable. */
  isAvailable(): boolean;
  /** Wraps chrome.tabs.group: either adds a tab to an existing group or creates a new one. Resolves to the resulting groupId. */
  groupTabs(opts: chrome.tabs.GroupOptions): Promise<number>;
  /** Wraps chrome.tabGroups.query. */
  queryGroups(query: chrome.tabGroups.QueryInfo): Promise<TabGroupInfo[]>;
  /** Wraps chrome.tabGroups.update — sets title/color on an existing group. */
  updateGroup(
    groupId: number,
    updateProperties: chrome.tabGroups.UpdateProperties,
  ): Promise<void>;
  /** Wraps chrome.tabs.ungroup — removes tabs from their group. Idempotent in Chrome. */
  ungroupTabs(tabIds: number | number[]): Promise<void>;
}

/**
 * Real adapter backed by the runtime `chrome` APIs. Safe to import in a
 * service worker. If `chrome.tabGroups` is missing (older Chrome, a
 * non-Chromium fork, or permission revoked at runtime) `isAvailable()`
 * returns false and all other methods would throw — but they will not
 * be called because the helper functions short-circuit on
 * `isAvailable() === false`.
 */
export const realTabGroupApi: TabGroupApi = {
  isAvailable(): boolean {
    return (
      typeof chrome !== "undefined" &&
      chrome.tabs != null &&
      typeof chrome.tabs.group === "function" &&
      typeof chrome.tabs.ungroup === "function" &&
      chrome.tabGroups != null &&
      typeof chrome.tabGroups.query === "function" &&
      typeof chrome.tabGroups.update === "function"
    );
  },
  groupTabs(opts) {
    return chrome.tabs.group(opts);
  },
  queryGroups(query) {
    return chrome.tabGroups.query(query) as Promise<TabGroupInfo[]>;
  },
  updateGroup(groupId, updateProperties) {
    return chrome.tabGroups.update(groupId, updateProperties).then(() => {});
  },
  ungroupTabs(tabIds) {
    return chrome.tabs.ungroup(tabIds);
  },
};

function isValidWindowId(windowId: number): boolean {
  // chrome.windows.WINDOW_ID_NONE is -1. A tab group needs a real
  // window to live in.
  return Number.isInteger(windowId) && windowId >= 0;
}

/**
 * Add `tabId` to the "DeskCheck" tab group in its window. Creates the
 * group (with the configured title + color) if no matching group
 * exists; otherwise reuses the existing group id.
 *
 * Best-effort: any failure is logged and swallowed. Returns the
 * resulting groupId on success, or `null` if grouping was skipped or
 * failed.
 */
export async function assignTabToDeskCheckGroup(
  tabId: number,
  windowId: number,
  api: TabGroupApi = realTabGroupApi,
): Promise<number | null> {
  if (!api.isAvailable()) return null;
  if (!isValidWindowId(windowId)) return null;

  try {
    const existing = await api.queryGroups({
      windowId,
      title: DESKCHECK_GROUP_TITLE,
    });
    const match = existing[0];

    if (match) {
      await api.groupTabs({ tabIds: tabId, groupId: match.id });
      return match.id;
    }

    const groupId = await api.groupTabs({
      tabIds: tabId,
      createProperties: { windowId },
    });
    await api.updateGroup(groupId, {
      title: DESKCHECK_GROUP_TITLE,
      color: DESKCHECK_GROUP_COLOR,
    });
    return groupId;
  } catch (err) {
    console.warn("[DeskCheck:tab-group] assign failed:", err);
    return null;
  }
}

/**
 * Remove `tabId` from its tab group (whichever one it's in — we don't
 * verify it was the DeskCheck group; Chrome ungrouping is a no-op on
 * ungrouped tabs). Chrome auto-deletes the group if it becomes empty.
 *
 * Best-effort: any failure is logged and swallowed. Common benign
 * rejections:
 *   - "No tab with id: N." — tab was closed between STOP_SESSION and
 *     the ungroup call
 *   - "tab does not belong to a group" — user manually dragged the tab
 *     out of the group mid-session
 */
export async function removeTabFromDeskCheckGroup(
  tabId: number,
  api: TabGroupApi = realTabGroupApi,
): Promise<void> {
  if (!api.isAvailable()) return;
  try {
    await api.ungroupTabs(tabId);
  } catch (err) {
    console.warn("[DeskCheck:tab-group] remove failed:", err);
  }
}
