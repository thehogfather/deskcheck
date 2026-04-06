import { Message } from "../types";
import {
  createSession,
  endSession,
  clearSession,
  getSession,
  getEvents,
  getScreenshots,
  appendEvent,
  storeScreenshot,
} from "../lib/session-store";
import { DebuggerClient } from "../lib/debugger-client";

const debuggerClient = new DebuggerClient();
import { exportSession, getExportFilename } from "../lib/exporter";
import { takeScreenshot } from "./screenshot";

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

restoreState().catch((err) => {
  console.error("[DeskCheck] Failed to restore state:", err);
});

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

// ── Message handler ──

chrome.runtime.onMessage.addListener(
  (msg: Message, sender, sendResponse) => {
    handleMessage(msg, sender)
      .then(sendResponse)
      .catch((err) => {
        console.error("[DeskCheck] Message handler error:", err);
        sendResponse({ error: String(err) });
      });
    return true;
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

      const warnings: string[] = [];

      if (activeTabId) {
        try {
          await debuggerClient.attach(activeTabId, msg.url, (event) => {
            appendEvent(event);
          });
        } catch (e) {
          console.warn("[DeskCheck] Failed to attach debugger:", e);
          warnings.push("Could not attach debugger — console and network errors will not be captured. Close DevTools and restart the session.");
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            files: ["src/content/index.js"],
          });
        } catch (e) {
          console.warn("[DeskCheck] Failed to inject content script:", e);
          warnings.push("Could not inject content script — DOM interactions will not be recorded.");
        }

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
      return { recording: true, sessionId: session.id, warnings };
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

      if (tabToNotify) {
        await chrome.tabs.sendMessage(tabToNotify, { type: "SESSION_STOPPED" }).catch(() => {
          // Tab may already be closed
        });
      }
      return { recording: false, sessionId: stoppedSessionId };
    }

    case "RECORD_EVENT": {
      if (!recording) return;
      if (sender.tab?.id && sender.tab.id !== activeTabId) return;
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
      if (!activeTabId) return { screenshotId: null, dataUrl: null };
      const ss = await takeScreenshot(activeTabId, msg.trigger);
      return { screenshotId: ss?.id ?? null, dataUrl: ss?.dataUrl ?? null };
    }

    case "ADD_ANNOTATION": {
      if (!recording || !activeTabId) return;
      const ss = await takeScreenshot(activeTabId, "annotation");
      const tab = await chrome.tabs.get(activeTabId);

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
          page_url: tab.url ?? "",
        });
      }

      await appendEvent({
        timestamp: new Date().toISOString(),
        type: "annotation",
        text: msg.text,
        element: msg.element,
        screenshot_id: ss?.id ?? "",
        element_screenshot_id: elementScreenshotId,
        page_url: tab.url ?? "",
      });
      return { screenshotId: ss?.id };
    }

    case "EXPORT_SESSION": {
      const session = await getSession();
      if (!session) return { error: "No session" };
      const events = await getEvents();
      const screenshots = await getScreenshots();
      const zipBytes = exportSession(session, events, screenshots);
      const filename = getExportFilename(session);
      const blob = new Blob([zipBytes.buffer as ArrayBuffer], { type: "application/zip" });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      await clearSession();
      return { filename };
    }
  }
}

// ── Keyboard shortcuts ──

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "take-screenshot" && recording && activeTabId) {
    await takeScreenshot(activeTabId, "manual");
  }
  if (command === "toggle-annotation" && recording && activeTabId) {
    await chrome.tabs.sendMessage(activeTabId, { type: "FOCUS_ANNOTATION" }).catch(() => {});
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
    try {
      await debuggerClient.detach();
      await endSession();
    } catch (e) {
      console.error("[DeskCheck] Error during tab close cleanup:", e);
    } finally {
      recording = false;
      activeSessionId = null;
      activeTabId = null;
      setBadge(false);
    }
  }
});

// ── Helpers ──

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
