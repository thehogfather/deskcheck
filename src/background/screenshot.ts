import { ScreenshotEvent } from "../types";
import { storeScreenshot, appendEvent } from "../lib/session-store";

export async function takeScreenshot(
  activeTabId: number,
  trigger: ScreenshotEvent["trigger"],
): Promise<{ id: string; dataUrl: string } | null> {
  try {
    const dataUrl = (await chrome.tabs.captureVisibleTab({
      format: "png",
    })) as string;
    const id = `ss_${Date.now()}`;
    await storeScreenshot(id, dataUrl);

    const tab = await chrome.tabs.get(activeTabId);
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
    console.error("[Examiner] Screenshot failed:", e);
    return null;
  }
}
