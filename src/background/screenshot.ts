import { ScreenshotEvent } from "../types";
import type { SessionStore } from "../lib/session-store-types";

/**
 * Pure decision: can DeskCheck screenshot the recorded tab right now?
 *
 * Only captures the tab the session is bound to. If the user has switched
 * to a different tab in the same window, or moved the recorded tab to the
 * background, `chrome.tabs.captureVisibleTab` would otherwise silently
 * screenshot whatever tab is currently active — leaking content from an
 * unrelated tab into the session. This helper returns false in that case
 * so the caller can refuse the capture.
 */
export function canCaptureRecordedTab(
  tab: Pick<chrome.tabs.Tab, "active" | "windowId"> | null | undefined,
): boolean {
  if (!tab) return false;
  if (tab.active !== true) return false;
  if (tab.windowId === undefined || tab.windowId < 0) return false;
  return true;
}

/**
 * Decode a `data:image/png;base64,...` URL into raw PNG bytes.
 *
 * Exported as a pure helper so the decoding is done exactly once per
 * capture — the service worker persists the bytes to OPFS and the
 * original data URL is dropped immediately, removing the biggest
 * in-memory retention point for long sessions (feature-5).
 */
export function dataUrlToPngBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) {
    throw new Error("dataUrlToPngBytes: not a data URL");
  }
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Result of a successful capture+persist call. */
export interface CapturedScreenshot {
  /** Stable id used as both the OPFS filename stem and the timeline reference. */
  id: string;
  /** The original data URL from chrome.tabs.captureVisibleTab. Used by the
   *  side panel for inline thumbnails — broadcast to it via SCREENSHOT_APPENDED. */
  dataUrl: string;
  /** The recorded tab metadata at the moment of capture. */
  tab: chrome.tabs.Tab;
}

/**
 * Capture the recorded tab and persist the bytes to the SessionStore.
 *
 * Returns the data URL + tab metadata so the caller can:
 *   1. Broadcast `SCREENSHOT_APPENDED` to the side panel for the live thumb,
 *   2. Decide whether to also append a `screenshot` timeline event.
 *
 * No timeline event is appended here. Timeline event creation lives in
 * the service worker so it can interleave the broadcasts in the right
 * order (SCREENSHOT_APPENDED before EVENT_APPENDED).
 */
export async function captureAndPersistScreenshot(
  store: SessionStore,
  activeTabId: number,
): Promise<CapturedScreenshot | null> {
  try {
    const tab = await chrome.tabs.get(activeTabId);

    if (!canCaptureRecordedTab(tab)) {
      console.warn(
        "[DeskCheck] Skipping screenshot — the recorded tab is not the active tab. Switch to the DeskCheck tab before capturing.",
      );
      return null;
    }

    const dataUrl = (await chrome.tabs.captureVisibleTab(tab.windowId!, {
      format: "png",
    })) as string;
    const id = `ss_${Date.now()}`;

    const bytes = dataUrlToPngBytes(dataUrl);
    await store.appendScreenshot(id, bytes);

    return { id, dataUrl, tab };
  } catch (e) {
    console.error("[DeskCheck] Screenshot failed:", e);
    return null;
  }
}

/**
 * Build a `ScreenshotEvent` payload from a captured screenshot.
 *
 * Pure builder — does not touch the store. The caller persists this via
 * `store.appendEvent()` (or the broadcasting wrapper).
 */
export function buildScreenshotEvent(
  captured: CapturedScreenshot,
  trigger: ScreenshotEvent["trigger"],
): Omit<ScreenshotEvent, "seq"> {
  return {
    timestamp: new Date().toISOString(),
    type: "screenshot",
    id: captured.id,
    file: `screenshots/${captured.id}.png`,
    viewport: {
      width: captured.tab.width ?? 0,
      height: captured.tab.height ?? 0,
    },
    trigger,
    page_url: captured.tab.url ?? "",
  };
}
