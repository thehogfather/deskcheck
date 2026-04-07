// STUB — Phase 3 (failing acceptance tests). Phase 4 will implement.
//
// Per-window scroll position persistence for the side panel. Backed by
// chrome.storage.session (in-memory, cleared on browser restart) so
// scroll position does not survive a browser restart — restoring stale
// scroll positions would be confusing.
//
// Rejects WINDOW_ID_NONE (-1) as a defensive measure.

export const STORAGE_SIDE_PANEL_SCROLL_PREFIX = "deskcheck_sidepanel_scroll_";

export interface SessionStorageApi {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function getScrollPosition(
  _windowId: number,
  _api?: SessionStorageApi,
): Promise<number> {
  throw new Error("sidepanel-storage.getScrollPosition not implemented");
}

export async function setScrollPosition(
  _windowId: number,
  _scrollY: number,
  _api?: SessionStorageApi,
): Promise<void> {
  throw new Error("sidepanel-storage.setScrollPosition not implemented");
}
