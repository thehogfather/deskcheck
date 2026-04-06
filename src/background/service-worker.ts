import { Message, ScreenshotEvent } from "../types";
import {
  createSession,
  endSession,
  getSession,
  appendEvent,
  storeScreenshot,
} from "../lib/session-store";
import * as debuggerClient from "../lib/debugger-client";
import { exportSession, getExportFilename } from "../lib/exporter";

let recording = false;
let activeTabId: number | null = null;
let activeSessionId: string | null = null;

// ── Restore state on service worker wake ──

async function restoreState() {
  const session = await getSession();
  if (session && !session.end_time) {
    recording = true;
    activeSessionId = session.id;
    activeTabId = session.tab_id;
    setBadge(true);
  }
}

restoreState();

// ── Inject content script into existing tabs on install/update ──

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith("chrome://")) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content/index.js"],
      });
    } catch {
      // Can't inject into some pages (chrome://, chrome-extension://, etc.)
    }
  }
});

// ── Badge ──

function setBadge(active: boolean) {
  chrome.action.setBadgeText({ text: active ? "REC" : "" });
  chrome.action.setBadgeBackgroundColor({ color: active ? "#dc2626" : "#000" });
}

// ── Screenshot ──

async function takeScreenshot(
  trigger: ScreenshotEvent["trigger"],
): Promise<{ id: string; dataUrl: string } | null> {
  if (!activeTabId) return null;
  try {
    const dataUrl = (await chrome.tabs.captureVisibleTab({ format: "png" })) as string;
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

// ── Message handler ──

chrome.runtime.onMessage.addListener(
  (msg: Message, sender, sendResponse) => {
    handleMessage(msg, sender)
      .then(sendResponse)
      .catch((err) => {
        console.error("[Examiner] Message handler error:", err);
        sendResponse({ error: String(err) });
      });
    return true; // keep channel open for async response
  },
);

async function handleMessage(
  msg: Message,
  sender: chrome.runtime.MessageSender,
) {
  switch (msg.type) {
    case "GET_SESSION_STATE":
      return { recording, sessionId: activeSessionId, activeTabId };

    case "START_SESSION": {
      activeTabId = msg.tabId;
      const session = await createSession(msg.tabId, msg.url, msg.viewport);
      recording = true;
      activeSessionId = session.id;
      setBadge(true);

      // Attach debugger for console/network capture
      if (activeTabId) {
        try {
          await debuggerClient.attach(activeTabId, msg.url, (event) => {
            appendEvent(event);
          });
        } catch (e) {
          console.warn("[Examiner] Failed to attach debugger:", e);
        }

        // Ensure content script is injected (handles pages open before extension load)
        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            files: ["src/content/index.js"],
          });
        } catch (e) {
          console.warn("[Examiner] Failed to inject content script:", e);
        }

        // Give content script a moment to register its listeners, then notify
        await new Promise((r) => setTimeout(r, 100));
        try {
          await chrome.tabs.sendMessage(activeTabId, {
            type: "SESSION_STARTED",
            sessionId: session.id,
          });
        } catch {
          // Content script should pick up via storage.onChanged fallback
        }
      }
      return { recording: true, sessionId: session.id };
    }

    case "STOP_SESSION": {
      const tabToNotify = sender.tab?.id ?? activeTabId;
      await debuggerClient.detach();
      await endSession();
      recording = false;
      const stoppedSessionId = activeSessionId;
      activeSessionId = null;
      activeTabId = null;
      setBadge(false);

      // Notify content script (sender may be popup, so use activeTabId as fallback)
      if (tabToNotify) {
        try {
          chrome.tabs.sendMessage(tabToNotify, { type: "SESSION_STOPPED" });
        } catch {
          // Tab may already be closed
        }
      }
      return { recording: false, sessionId: stoppedSessionId };
    }

    case "RECORD_EVENT": {
      if (!recording) return;
      // Only record events from the session tab
      if (sender.tab?.id && sender.tab.id !== activeTabId) return;
      // Keep debugger client aware of current page URL
      if (
        msg.event.type === "interaction" &&
        msg.event.subtype === "navigation" &&
        msg.event.to_url
      ) {
        debuggerClient.updatePageUrl(msg.event.to_url);
      }
      await appendEvent(msg.event);
      return;
    }

    case "TAKE_SCREENSHOT": {
      const ss = await takeScreenshot(msg.trigger);
      return { screenshotId: ss?.id ?? null, dataUrl: ss?.dataUrl ?? null };
    }

    case "ADD_ANNOTATION": {
      if (!recording) return;
      const ss = await takeScreenshot("annotation");
      const tab = activeTabId ? await chrome.tabs.get(activeTabId) : null;

      // Store element screenshot if provided
      let elementScreenshotId: string | undefined;
      if (msg.elementScreenshotData) {
        elementScreenshotId = `el_${Date.now()}`;
        await storeScreenshot(elementScreenshotId, msg.elementScreenshotData);
        await appendEvent({
          timestamp: new Date().toISOString(),
          type: "screenshot",
          id: elementScreenshotId,
          file: `screenshots/${elementScreenshotId}.png`,
          viewport: msg.element?.bounding_box
            ? { width: msg.element.bounding_box.width, height: msg.element.bounding_box.height }
            : { width: 0, height: 0 },
          trigger: "annotation",
          page_url: tab?.url ?? "",
        });
      }

      await appendEvent({
        timestamp: new Date().toISOString(),
        type: "annotation",
        text: msg.text,
        element: msg.element,
        screenshot_id: ss?.id ?? "",
        element_screenshot_id: elementScreenshotId,
        page_url: tab?.url ?? "",
      });
      return { screenshotId: ss?.id };
    }

    case "EXPORT_SESSION": {
      const session = await getSession();
      if (!session) return { error: "No session" };
      const zipBytes = await exportSession();
      const filename = getExportFilename(session);
      // Service workers can't use URL.createObjectURL — use base64 data URL
      const base64 = bytesToBase64(zipBytes);
      const dataUrl = `data:application/zip;base64,${base64}`;
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
      return { filename };
    }
  }
}

// ── Keyboard shortcuts ──

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "take-screenshot" && recording) {
    await takeScreenshot("manual");
  }
  if (command === "toggle-annotation" && recording && activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: "FOCUS_ANNOTATION" });
  }
  if (command === "toggle-session") {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    if (recording) {
      await handleMessage({ type: "STOP_SESSION" }, { tab } as any);
    } else {
      await handleMessage(
        {
          type: "START_SESSION",
          tabId: tab.id,
          url: tab.url ?? "",
          viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
        },
        { tab } as any,
      );
    }
  }
});

// ── Tab close handling ──

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeTabId && recording) {
    await debuggerClient.detach();
    await endSession();
    recording = false;
    activeSessionId = null;
    activeTabId = null;
    setBadge(false);
  }
});

// ── Helpers ──

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
