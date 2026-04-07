import { ScreenshotEvent } from "../types";
import { storeScreenshot, appendEvent } from "../lib/session-store";

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

export async function takeScreenshot(
  activeTabId: number,
  trigger: ScreenshotEvent["trigger"],
): Promise<{ id: string; dataUrl: string } | null> {
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
    await storeScreenshot(id, dataUrl);

    await appendEvent({
      timestamp: new Date().toISOString(),
      type: "screenshot",
      id,
      file: `screenshots/${id}.png`,
      viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
      trigger,
      page_url: tab.url ?? "",
    });
    return { id, dataUrl };
  } catch (e) {
    console.error("[DeskCheck] Screenshot failed:", e);
    return null;
  }
}
