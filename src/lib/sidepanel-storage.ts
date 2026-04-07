// Per-window scroll position persistence for the side panel. Backed by
// chrome.storage.session (in-memory, cleared on browser restart) so
// scroll position does not survive a browser restart — restoring stale
// scroll positions across restarts would be confusing.
//
// Rejects WINDOW_ID_NONE (-1) as a defensive measure: a focus-changed
// event with WINDOW_ID_NONE means "no Chrome window has focus", which
// is never a valid scroll context.

export const STORAGE_SIDE_PANEL_SCROLL_PREFIX = "deskcheck_sidepanel_scroll_";

export interface SessionStorageApi {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function defaultApi(): SessionStorageApi {
  // chrome.storage.session is available in MV3 (Chrome ≥ 102). DeskCheck
  // requires `sidePanel` (Chrome ≥ 114), so this is always present.
  // The @types/chrome ambient declaration includes `session` so no
  // suppression is needed.
  return (chrome.storage as unknown as { session: SessionStorageApi }).session;
}

function key(windowId: number): string {
  return `${STORAGE_SIDE_PANEL_SCROLL_PREFIX}${windowId}`;
}

export async function getScrollPosition(
  windowId: number,
  api: SessionStorageApi = defaultApi(),
): Promise<number> {
  if (!Number.isFinite(windowId) || windowId < 0) return 0;
  const k = key(windowId);
  const result = await api.get(k);
  const raw = result[k];
  return typeof raw === "number" && raw >= 0 ? raw : 0;
}

export async function setScrollPosition(
  windowId: number,
  scrollY: number,
  api: SessionStorageApi = defaultApi(),
): Promise<void> {
  if (!Number.isFinite(windowId) || windowId < 0) return;
  const clamped = Math.max(0, Math.floor(scrollY));
  await api.set({ [key(windowId)]: clamped });
}
