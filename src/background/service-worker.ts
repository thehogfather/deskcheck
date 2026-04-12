import { Message, SessionMetadata, TimelineEvent, TimelineEventInput } from "../types";
import { OpfsSessionStore } from "../lib/opfs-session-store";
import type { SessionStore } from "../lib/session-store-types";
import { DebuggerClient } from "../lib/debugger-client";
import { DEFAULT_PII_MODE, parsePiiMode } from "../lib/pii-modes";
import {
  assignTabToDeskCheckGroup,
  removeTabFromDeskCheckGroup,
} from "../lib/tab-group";
import { SIDEPANEL_PATH } from "../constants";
import { exportSessionStreaming, getExportFilename } from "../lib/exporter";
import { computeSessionMetrics } from "../lib/session-metrics";
import {
  captureAndPersistScreenshot,
  buildScreenshotEvent,
  dataUrlToPngBytes,
} from "./screenshot";
import { nextStatus, type SessionStatus } from "../lib/session-status";
import { getHandoffConfig } from "../lib/handoff-store";
import { isValidLoopbackUrl, redactToken } from "../lib/handoff";
import { performHandoff } from "./handoff-post";
import { stripMarker } from "../lib/handoff-marker";
import { sendCancelSentinel } from "./handoff-cancel";
import {
  armPendingHandoff,
  getPendingHandoff,
  clearPendingHandoff,
  getAllPendingHandoffs,
  type PendingHandoffConfig,
} from "../lib/pending-handoff-store";
import { setHandoffConfig, clearHandoffConfig } from "../lib/handoff-store";

const debuggerClient = new DebuggerClient();
// One SessionStore instance owns all persistence for the worker. Its
// internal ensureReady() caches the OPFS handles after the first call,
// so subsequent message handlers do not pay the setup cost.
const store: SessionStore = new OpfsSessionStore();

// ── Side panel live broadcasts ──
//
// After feature #5 moved events out of chrome.storage.local into OPFS,
// the side panel can no longer subscribe to a storage key for live
// updates. Every store mutation that the side panel cares about goes
// through one of these helpers, which forwards a runtime broadcast to
// any open side panel document.
//
// `chrome.runtime.sendMessage` from the SW to other extension contexts
// rejects when there are no listeners (e.g., side panel closed). The
// rejections are non-fatal — we swallow them via .catch().

function broadcastToPanels(msg: Message): void {
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {
      // No listeners — common when the side panel is closed.
    });
  } catch {
    // chrome.runtime may not be ready in tests.
  }
}

async function appendEventBroadcast(
  input: TimelineEventInput,
): Promise<TimelineEvent> {
  const enriched = await store.appendEvent(input);
  broadcastToPanels({ type: "EVENT_APPENDED", event: enriched });
  return enriched;
}

let currentStatus: SessionStatus = "idle";
let activeTabId: number | null = null;
let activeSessionId: string | null = null;

// Feature #14 phase 2: sync mirror of pending handoffs for the
// chrome.action.onClicked gesture window (which must be sync).
const __pendingHandoffs = new Map<number, PendingHandoffConfig>();

async function rehydratePendingHandoffs(): Promise<void> {
  try {
    const all = await getAllPendingHandoffs();
    __pendingHandoffs.clear();
    for (const [tabIdStr, config] of Object.entries(all)) {
      __pendingHandoffs.set(Number(tabIdStr), config);
    }
  } catch {
    // storage unavailable on wake — start empty
  }
}

function isSessionInFlight(): boolean {
  return currentStatus === "running" || currentStatus === "paused";
}

// Debug buffer: the sidepanel entry posts visibility change events
// here so e2e tests can verify whether Chrome is actually hiding the
// panel on tab switch. Not load-bearing in production. Exposed on
// globalThis so serviceWorker.evaluate() in Playwright can read it.
interface VisibilityReport {
  kind: string;
  visibilityState: string;
  hidden: boolean;
  timestamp: number;
}
const sidepanelVisibilityReports: VisibilityReport[] = [];
(globalThis as unknown as {
  __deskcheckVisibilityReports?: VisibilityReport[];
}).__deskcheckVisibilityReports = sidepanelVisibilityReports;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (
    msg &&
    typeof msg === "object" &&
    (msg as { type?: string }).type === "SIDEPANEL_VISIBILITY"
  ) {
    sidepanelVisibilityReports.push({
      kind: (msg as { kind: string }).kind,
      visibilityState: (msg as { visibilityState: string }).visibilityState,
      hidden: (msg as { hidden: boolean }).hidden,
      timestamp: (msg as { timestamp: number }).timestamp,
    });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ── Side panel: bind-on-open model ──
//
// The side panel is bound to the tab the user summoned it from. From
// the moment the toolbar action is clicked the panel is visible ONLY
// on that one tab — switching to another tab hides it, returning to
// the bound tab brings it back. A recording session does not change
// the binding; the panel's home is decided at open time, not at
// recording start time.
//
// How this plays with Chrome's sidePanel API (empirically verified
// by e2e/sidepanel-debug.spec.ts and grounded in
// GoogleChrome/chrome-extensions-samples#987):
//
//   1. The manifest has NO `side_panel.default_path`. A global
//      default creates a Chrome-owned panel instance that overrides
//      per-tab setOptions and ignores the documented tab-switch
//      hide/show behaviour. All panel configuration is per-tab via
//      chrome.sidePanel.setOptions. Build-wise the sidepanel HTML
//      is added via vite-plugin-web-extension's `additionalInputs`
//      so it still gets bundled despite not being referenced in
//      the manifest.
//
//   2. openPanelOnActionClick is OFF so chrome.action.onClicked
//      fires with the clicked tab, giving us a user-gesture window.
//
//   3. Both setOptions({tabId, path, enabled: true}) and
//      open({tabId}) are fired SYNCHRONOUSLY from the click
//      listener — the listener itself is sync, not async, and
//      neither call is awaited. Awaiting setOptions before open
//      would consume the user gesture and open() would reject
//      with "may only be called in response to a user gesture."
//      Chrome processes the two IPCs in order, so the per-tab
//      override is registered before the panel opens. This is the
//      resolution pattern from issue #987.
//
//   4. Because the panel is a proper per-tab instance, the docs'
//      "switching to a tab where the side panel is not enabled →
//      hide" behaviour fires: the panel hides on other tabs and
//      reappears when the user returns to the bound tab.
//
//   5. If a session is active and the user clicks the action on a
//      different tab, the handler routes them back to the
//      recording tab rather than migrating the panel mid-session.
//
// Pinned by tests/service-worker-setpanel.test.ts and diagnosed by
// e2e/sidepanel-debug.spec.ts.
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: false })
  .catch((err) => {
    console.warn("[DeskCheck] setPanelBehavior failed:", err);
  });

let panelBoundTabId: number | null = null;

// Enable the real side panel on a specific tab as a per-tab override
// of the manifest default stub. The distinct path is what makes
// Chrome register this as a per-tab panel instance (so the
// documented per-tab hide/show on tab switch actually kicks in).
function enablePanelOnTab(tabId: number): Promise<void> {
  if (!chrome.sidePanel?.setOptions) return Promise.resolve();
  return chrome.sidePanel
    .setOptions({
      tabId,
      path: SIDEPANEL_PATH,
      enabled: true,
    })
    .catch((err) => {
      console.warn(
        `[DeskCheck] Failed to enable side panel for tab ${tabId}:`,
        err,
      );
    });
}

// Disable the panel on a specific tab via a per-tab override. Used
// to scope other tabs away during a binding and to disable newly
// created tabs while a binding is active.
function disablePanelOnTab(tabId: number): Promise<void> {
  if (!chrome.sidePanel?.setOptions) return Promise.resolve();
  return chrome.sidePanel
    .setOptions({ tabId, enabled: false })
    .catch((err) => {
      // Non-fatal — chrome:// tabs and the like will reject.
      console.warn(
        `[DeskCheck] Failed to disable side panel for tab ${tabId}:`,
        err,
      );
    });
}

// After enabling the panel on the bound tab (via a sync setOptions
// call inside a gesture), walk every OTHER tab and disable its
// panel so switching away from the bound tab hides the panel. Runs
// asynchronously after the gesture window has expired — neither
// setOptions nor tabs.query need a gesture.
async function scopeOtherTabsAwayFromBound(
  boundTabId: number,
): Promise<void> {
  panelBoundTabId = boundTabId;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    console.warn("[DeskCheck] Failed to query tabs for panel scoping:", err);
    return;
  }
  for (const t of tabs) {
    if (t.id == null || t.id === boundTabId) continue;
    await disablePanelOnTab(t.id);
  }
}

// Newly created tabs inherit the manifest default stub. While a
// binding is active we proactively disable the panel on each new
// tab so the stub (or anything else) doesn't flash up.
chrome.tabs.onCreated.addListener((tab) => {
  if (panelBoundTabId == null || tab.id == null) return;
  if (tab.id === panelBoundTabId) return;
  void disablePanelOnTab(tab.id);
});

// IMPORTANT: this listener is SYNC, not async. Both setOptions and
// open are fired SYNCHRONOUSLY (without await) so they share the
// user-gesture window — chrome.sidePanel.open() strictly requires a
// user gesture, and any await between the listener entry and the
// open() call consumes the gesture. Chrome processes the IPCs in
// order, so the per-tab override is established before Chrome opens
// the panel.
function openPanelInGestureWindow(tabId: number): void {
  void enablePanelOnTab(tabId);
  chrome.sidePanel.open({ tabId }).catch((err) => {
    console.warn("[DeskCheck] Failed to open side panel:", err);
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  // If a session is already active, route the click back to the
  // recording tab — never open a second panel elsewhere mid-session.
  const targetTabId =
    isSessionInFlight() && activeTabId != null ? activeTabId : tab.id;

  // Phase 2: check if this tab has a pending handoff to promote
  const pendingEntry = __pendingHandoffs.get(targetTabId);

  // Fire both calls synchronously inside the gesture window.
  openPanelInGestureWindow(targetTabId);

  // Async follow-up: scope other tabs away, promote pending handoff,
  // and (if we redirected) bring the recording tab into focus.
  void (async () => {
    await scopeOtherTabsAwayFromBound(targetTabId);

    // Promote pending handoff -> active deskcheck_handoff
    if (pendingEntry) {
      const activeConfig = {
        listener_url: pendingEntry.listener_url,
        token: pendingEntry.token,
        created_at: new Date().toISOString(),
      };
      try {
        await setHandoffConfig(activeConfig);
      } catch {
        // Storage write failed — continue without handoff
      }
      __pendingHandoffs.delete(targetTabId);
      await clearPendingHandoff(targetTabId);

      // Clear the badge
      chrome.action.setBadgeText({ tabId: targetTabId, text: "" });

      broadcastToPanels({
        type: "PENDING_HANDOFF_CHANGED",
        pending: null,
        active: activeConfig,
      });
    }

    if (targetTabId !== tab.id) {
      try {
        await chrome.tabs.update(targetTabId, { active: true });
      } catch {
        // Tab may have been closed.
      }
    }
  })();
});

function generateSessionId(): string {
  return crypto.randomUUID();
}

function buildSessionMetadata(
  tabId: number,
  url: string,
  viewport: { width: number; height: number },
  piiMode: SessionMetadata["pii_mode"],
): SessionMetadata {
  return {
    id: generateSessionId(),
    tab_id: tabId,
    start_time: new Date().toISOString(),
    end_time: null,
    duration_ms: null,
    initial_url: url,
    user_agent: navigator.userAgent,
    viewport,
    pii_mode: piiMode,
    status: "running",
  };
}

// ── Restore state on service worker wake ──

async function restoreState() {
  const session = await store.ensureReady();
  if (session && !session.end_time) {
    currentStatus = session.status ?? "running";
    activeSessionId = session.id;
    activeTabId = session.tab_id;
    setBadge(true);
  } else if (session && session.end_time) {
    currentStatus = "stopped";
    activeSessionId = session.id;
    setBadge(false);
  } else {
    currentStatus = "idle";
    setBadge(false);
  }
}

restoreState().catch((err) => {
  console.error("[DeskCheck] Failed to restore state:", err);
});
rehydratePendingHandoffs().catch(() => {});

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
    case "GET_SESSION_STATE": {
      const storedSession = await store.getSession();
      return {
        recording: isSessionInFlight(),
        paused: currentStatus === "paused",
        status: currentStatus,
        sessionId: activeSessionId,
        activeTabId,
        hasExportableSession: storedSession != null,
        piiMode: storedSession?.pii_mode ?? DEFAULT_PII_MODE,
      };
    }

    case "PAUSE_SESSION": {
      const transition = nextStatus(currentStatus, "pause");
      if (!transition.ok) return { status: currentStatus };
      const session = await store.getSession();
      if (session) {
        await appendEventBroadcast({
          type: "session_paused",
          timestamp: new Date().toISOString(),
          page_url: session.initial_url,
        });
        await store.updateSession({ status: "paused" });
      }
      currentStatus = "paused";
      return { status: currentStatus, paused: true };
    }

    case "RESUME_SESSION": {
      const transition = nextStatus(currentStatus, "resume");
      if (!transition.ok) return { status: currentStatus };
      const session = await store.getSession();
      if (session) {
        await appendEventBroadcast({
          type: "session_resumed",
          timestamp: new Date().toISOString(),
          page_url: session.initial_url,
        });
        await store.updateSession({ status: "running" });
      }
      currentStatus = "running";
      return { status: currentStatus, paused: false };
    }

    case "DISCARD_SESSION": {
      const transition = nextStatus(currentStatus, "discard");
      if (!transition.ok) return { status: currentStatus, discarded: false };
      const tabToNotify = activeTabId;
      try {
        await debuggerClient.detach();
      } catch (e) {
        console.warn("[DeskCheck] discard: detach failed (continuing):", e);
      }

      // Phase 2: best-effort cancel sentinel to wake the CLI
      const handoff = await getHandoffConfig();
      if (handoff && activeSessionId) {
        void sendCancelSentinel(handoff, activeSessionId, fetch).catch(() => {});
      }

      await store.deleteSession();
      await clearHandoffConfig();
      broadcastToPanels({ type: "SESSION_CLEARED" });
      broadcastToPanels({ type: "PENDING_HANDOFF_CHANGED", pending: null, active: null });
      currentStatus = "idle";
      activeSessionId = null;
      activeTabId = null;
      setBadge(false);
      if (tabToNotify != null) {
        await chrome.tabs.sendMessage(tabToNotify, { type: "SESSION_STOPPED" }).catch(() => {});
      }
      return { status: currentStatus, discarded: true };
    }

    case "RESET_SESSION": {
      const transition = nextStatus(currentStatus, "reset");
      if (!transition.ok) return { status: currentStatus, reset: false };
      await store.deleteSession();
      broadcastToPanels({ type: "SESSION_CLEARED" });
      currentStatus = "idle";
      activeSessionId = null;
      return { status: currentStatus, reset: true };
    }

    case "GET_SESSION_METRICS": {
      const session = await store.getSession();
      if (!session || !isSessionInFlight()) {
        return {
          startTime: "",
          eventCount: 0,
          screenshotCount: 0,
          eventsSizeBytes: 0,
          screenshotsSizeBytes: 0,
        };
      }
      const [eventCount, screenshotCount, sizes] = await Promise.all([
        store.countEvents(),
        store.countScreenshots(),
        store.computeByteSizes(),
      ]);
      return computeSessionMetrics(
        eventCount,
        screenshotCount,
        sizes.events,
        sizes.screenshots,
        session.start_time,
      );
    }

    case "MARKER_DETECTED": {
      const tabId = sender.tab?.id ?? msg.tabId;
      if (tabId == null) return;
      const marker = msg.marker;
      const pending: PendingHandoffConfig = {
        listener_url: `http://127.0.0.1:${marker.port}`,
        token: marker.token,
        session_id_hint: marker.sessionId,
        armed_at: new Date().toISOString(),
      };
      await armPendingHandoff(tabId, pending);
      __pendingHandoffs.set(tabId, pending);

      // Try to auto-open the side panel. Chrome requires a user gesture
      // for sidePanel.open(), but some builds (Chrome for Testing) may
      // allow it from an extension message handler. If it fails, fall
      // through to the badge cue.
      let autoOpened = false;
      if (!isSessionInFlight()) {
        try {
          void enablePanelOnTab(tabId);
          await chrome.sidePanel.open({ tabId });
          autoOpened = true;
          // Auto-open succeeded — promote the handoff immediately
          const activeConfig = {
            listener_url: pending.listener_url,
            token: pending.token,
            created_at: new Date().toISOString(),
          };
          await setHandoffConfig(activeConfig);
          __pendingHandoffs.delete(tabId);
          await clearPendingHandoff(tabId);
          void scopeOtherTabsAwayFromBound(tabId);
          broadcastToPanels({
            type: "PENDING_HANDOFF_CHANGED",
            pending: null,
            active: activeConfig,
          });
        } catch {
          // Expected on stable Chrome — fall through to badge
        }
      }

      if (!autoOpened && !isSessionInFlight()) {
        chrome.action.setBadgeText({ tabId, text: "OPEN" });
        chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
        try {
          chrome.action.setTitle({
            tabId,
            title: "DeskCheck — terminal session waiting. Click to open.",
          });
        } catch {
          // setTitle may not exist in all environments
        }
        broadcastToPanels({
          type: "PENDING_HANDOFF_CHANGED",
          pending,
          active: null,
        });
      }
      return { armed: true, autoOpened };
    }

    case "GET_PENDING_HANDOFF": {
      const tabId = sender.tab?.id;
      if (tabId == null) return { pending: null, active: null };
      const pending = __pendingHandoffs.get(tabId) ?? null;
      const active = await getHandoffConfig();
      return { pending, active };
    }

    case "CANCEL_PENDING_HANDOFF": {
      const tabId = msg.tabId ?? sender.tab?.id;
      if (tabId == null) return;
      const entry = __pendingHandoffs.get(tabId);
      if (entry) {
        __pendingHandoffs.delete(tabId);
        await clearPendingHandoff(tabId);
        chrome.action.setBadgeText({ tabId, text: "" });
        // Best-effort cancel sentinel
        const config = { listener_url: entry.listener_url, token: entry.token, created_at: entry.armed_at };
        void sendCancelSentinel(config, entry.session_id_hint, fetch).catch(() => {});
      }
      // Also clear any promoted handoff
      await clearHandoffConfig();
      broadcastToPanels({ type: "PENDING_HANDOFF_CHANGED", pending: null, active: null });
      return { cancelled: true };
    }

    case "START_SESSION": {
      const startTransition = nextStatus(currentStatus, "start");
      if (!startTransition.ok) return { recording: true, sessionId: activeSessionId, warnings: [] };
      activeTabId = msg.tabId;
      const piiMode = parsePiiMode(msg.piiMode);
      // Defence-in-depth: strip any #_deskcheck= marker that may remain
      const strippedUrl = stripMarker(msg.url)?.cleanHref ?? msg.url;
      const session = await store.createSession(
        buildSessionMetadata(msg.tabId, strippedUrl, msg.viewport, piiMode),
      );
      currentStatus = "running";
      activeSessionId = session.id;
      setBadge(true);
      // Panel binding is NOT touched here. Under the bind-on-open
      // model the panel's home tab was decided when the user clicked
      // the action. If the user started via the keyboard shortcut on
      // a tab that isn't the bound tab, the next action click will
      // re-route them to activeTabId via the onClicked handler.

      const warnings: string[] = [];

      if (activeTabId) {
        try {
          await debuggerClient.attach(activeTabId, msg.url, (event) => {
            // CDP events are dropped while paused or stopped.
            if (currentStatus !== "running") return;
            void appendEventBroadcast(event);
          });
        } catch (e) {
          console.warn("[DeskCheck] Failed to attach debugger:", e);
          warnings.push(
            "Could not attach debugger — console and network errors will not be captured. Close DevTools and restart the session.",
          );
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            files: ["src/content/index.js"],
          });
        } catch (e) {
          console.warn("[DeskCheck] Failed to inject content script:", e);
          warnings.push(
            "Could not inject content script — DOM interactions will not be recorded.",
          );
        }

        await new Promise((r) => setTimeout(r, 100));
        try {
          await chrome.tabs.sendMessage(activeTabId, {
            type: "SESSION_STARTED",
            sessionId: session.id,
            piiMode: session.pii_mode,
          });
        } catch {
          // Content script should pick up via storage.onChanged fallback
        }

        // Feature #9: best-effort tab grouping. Any failure is logged
        // and swallowed inside the helper — grouping is decorative and
        // must never block recording. Not awaited: we do not care
        // whether the cue appears before START_SESSION resolves.
        try {
          const tab = await chrome.tabs.get(activeTabId);
          if (tab.windowId != null) {
            void assignTabToDeskCheckGroup(activeTabId, tab.windowId);
          }
        } catch (err) {
          console.warn(
            "[DeskCheck] Failed to look up tab for grouping:",
            err,
          );
        }
      }
      return { recording: true, sessionId: session.id, warnings };
    }

    case "STOP_SESSION": {
      const stopTransition = nextStatus(currentStatus, "stop");
      if (!stopTransition.ok) return { recording: false, sessionId: activeSessionId };
      const tabToNotify = sender.tab?.id ?? activeTabId;
      await debuggerClient.detach();
      const now = new Date();
      const existing = await store.getSession();
      if (existing) {
        await store.updateSession({
          end_time: now.toISOString(),
          duration_ms:
            now.getTime() - new Date(existing.start_time).getTime(),
          status: "stopped",
        });
      }
      currentStatus = "stopped";
      const stoppedSessionId = activeSessionId;
      activeTabId = null;
      setBadge(false);
      // Panel stays bound so the user can still see the post-session
      // idle UI (first-run notice, next-session controls). Binding is
      // only released when the bound tab is closed.

      if (tabToNotify) {
        await chrome.tabs
          .sendMessage(tabToNotify, { type: "SESSION_STOPPED" })
          .catch(() => {
            // Tab may already be closed
          });
        // Feature #9: best-effort removal from the DeskCheck tab
        // group. Chrome auto-deletes the group if it becomes empty.
        // Unawaited — the helper never throws.
        void removeTabFromDeskCheckGroup(tabToNotify);
      }
      return { recording: false, sessionId: stoppedSessionId };
    }

    case "RECORD_EVENT": {
      if (currentStatus !== "running") return;
      if (sender.tab?.id && sender.tab.id !== activeTabId) return;
      if (
        msg.event.type === "interaction" &&
        msg.event.subtype === "navigation" &&
        msg.event.to_url
      ) {
        debuggerClient.updatePageUrl(msg.event.to_url);
      }
      await appendEventBroadcast(msg.event);
      return;
    }

    case "TAKE_SCREENSHOT": {
      if (!activeTabId) return { screenshotId: null, dataUrl: null };
      const captured = await captureAndPersistScreenshot(store, activeTabId);
      if (!captured) return { screenshotId: null, dataUrl: null };
      // Side panel needs the bytes — broadcast the data URL BEFORE the
      // EVENT_APPENDED so the row renders with its thumbnail in one
      // paint.
      broadcastToPanels({
        type: "SCREENSHOT_APPENDED",
        id: captured.id,
        dataUrl: captured.dataUrl,
      });
      await appendEventBroadcast(buildScreenshotEvent(captured, msg.trigger));
      return { screenshotId: captured.id, dataUrl: captured.dataUrl };
    }

    case "ADD_ANNOTATION": {
      if (!isSessionInFlight() || !activeTabId) return;
      // Annotation-attached screenshots are stored but not appended as
      // standalone timeline events — they live inline on the annotation
      // row in the side panel. Avoids the duplicate-row noise the
      // user reported on the first feature-8 prototype.
      const captured = await captureAndPersistScreenshot(store, activeTabId);
      if (captured) {
        broadcastToPanels({
          type: "SCREENSHOT_APPENDED",
          id: captured.id,
          dataUrl: captured.dataUrl,
        });
      }
      const tab = await chrome.tabs.get(activeTabId);

      let elementScreenshotId: string | undefined;
      if (msg.elementScreenshotData) {
        elementScreenshotId = `el_${Date.now()}`;
        // Element screenshots are also stored without a standalone
        // timeline event. The annotation event references them via
        // `element_screenshot_id`.
        const bytes = dataUrlToPngBytes(msg.elementScreenshotData);
        await store.appendScreenshot(elementScreenshotId, bytes);
        broadcastToPanels({
          type: "SCREENSHOT_APPENDED",
          id: elementScreenshotId,
          dataUrl: msg.elementScreenshotData,
        });
      }

      await appendEventBroadcast({
        timestamp: new Date().toISOString(),
        type: "annotation",
        text: msg.text,
        element: msg.element,
        screenshot_id: captured?.id ?? "",
        element_screenshot_id: elementScreenshotId,
        page_url: tab.url ?? "",
      });
      return { screenshotId: captured?.id };
    }

    case "GET_EVENTS_SNAPSHOT": {
      // Side panel hydration. Reads all events from OPFS plus enough
      // screenshot bytes (encoded as data URLs) to render thumbnails
      // for any screenshot/annotation events in the result. The
      // service worker holds the encoded data URLs only for the
      // duration of this single message — they are dropped from SW
      // memory immediately after the response is dispatched.
      const session = await store.getSession();
      if (!session) return { events: [], screenshots: {} };
      const events = await store.readEventsArray();
      const screenshots: Record<string, string> = {};
      // Collect every screenshot id referenced by the timeline.
      const referencedIds = new Set<string>();
      for (const e of events) {
        if (e.type === "screenshot") {
          referencedIds.add(e.id);
        } else if (e.type === "annotation") {
          if (e.screenshot_id) referencedIds.add(e.screenshot_id);
          if (e.element_screenshot_id) referencedIds.add(e.element_screenshot_id);
        }
      }
      for (const id of referencedIds) {
        const bytes = await store.readScreenshot(id);
        if (bytes) {
          screenshots[id] = bytesToPngDataUrl(bytes);
        }
      }
      return { events, screenshots };
    }

    case "EXPORT_SESSION": {
      const session = await store.getSession();
      if (!session) return { error: "No session" };
      const zipBytes = await exportSessionStreaming(store, session);
      const filename = getExportFilename(session);

      // Feature #14 phase 1: opt-in CLI handoff. Absence of the
      // `deskcheck_handoff` storage key is the kill switch — the
      // download path below is unchanged when no handoff is configured.
      // Any non-ok handoff result falls through to the download path
      // with a visible warning so the user knows the zip did not land
      // at the listener.
      let transportSucceeded = false;
      const handoff = await getHandoffConfig();
      if (handoff && isValidLoopbackUrl(handoff.listener_url)) {
        const result = await performHandoff(handoff, zipBytes, session.id, fetch);
        if (result.kind === "ok") {
          transportSucceeded = true;
        } else {
          const reason =
            result.kind === "rejected"
              ? `listener returned ${result.status}`
              : redactToken(result.reason);
          console.warn("[DeskCheck] handoff failed:", reason);
          broadcastToPanels({
            type: "EXPORT_WARNING",
            message: "Listener unreachable, saved to Downloads instead.",
          });
        }
      }

      if (!transportSucceeded) {
        // MV3 service workers in Chrome do NOT expose
        // `URL.createObjectURL` (as of Chrome 147 — confirmed
        // empirically). A Blob URL approach would save one encode pass
        // but is currently non-functional in this runtime. Until Chrome
        // ships URL.createObjectURL in SW, we fall back to a data URL
        // built via a chunked base64 encode. The streaming zip writer
        // still caps memory during the recording session (one screenshot
        // in flight at a time); this only re-encodes the finished zip
        // at download time, which is a bounded one-shot cost.
        try {
          const dataUrl = `data:application/zip;base64,${bytesToBase64(zipBytes)}`;
          await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
          transportSucceeded = true;
        } catch (e) {
          // Both transports failed. Surface a warning and DO NOT delete
          // the OPFS session — the user can try again.
          console.warn("[DeskCheck] download fallback failed:", e);
          broadcastToPanels({
            type: "EXPORT_WARNING",
            message: "Export failed. Session retained — try again.",
          });
        }
      }

      // Only clean up OPFS if at least one transport succeeded. This is
      // a behaviour change from the pre-feature-14 code, which cleaned
      // up unconditionally and assumed chrome.downloads.download could
      // not fail. The new invariant is:
      //
      //   session_cleared ⇒ at_least_one_transport_succeeded
      //
      // pinned by matrix row S12 in tests/service-worker-handoff.test.ts.
      if (transportSucceeded) {
        await store.deleteSession();
        broadcastToPanels({ type: "SESSION_CLEARED" });
        currentStatus = "idle";
        activeSessionId = null;
      }
      return { filename };
    }
  }
}

/**
 * Encode raw bytes to a base64 string in 8190-byte (multiple of 3)
 * chunks to avoid the `String.fromCharCode.apply(...)` argument limit
 * and to keep peak memory usage bounded on large inputs.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8190;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    let bin = "";
    for (let j = 0; j < slice.length; j++) {
      bin += String.fromCharCode(slice[j]);
    }
    parts.push(btoa(bin));
  }
  return parts.join("");
}

/**
 * Encode raw PNG bytes to a `data:image/png;base64,...` URL.
 *
 * Used by `GET_EVENTS_SNAPSHOT` to ship screenshot bytes to the side
 * panel one-by-one rather than the whole session at once.
 */
function bytesToPngDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

// ── Keyboard shortcuts ──

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "take-screenshot" && isSessionInFlight() && activeTabId) {
    const captured = await captureAndPersistScreenshot(store, activeTabId);
    if (captured) {
      broadcastToPanels({
        type: "SCREENSHOT_APPENDED",
        id: captured.id,
        dataUrl: captured.dataUrl,
      });
      await appendEventBroadcast(buildScreenshotEvent(captured, "manual"));
    }
    return;
  }
  if (command === "open-panel") {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    // Fire setOptions + open synchronously inside the remaining
    // gesture budget from the keyboard shortcut. Both are sent to
    // the browser process as IPCs and Chrome processes them in
    // order, so the per-tab override is registered before the
    // panel opens.
    void enablePanelOnTab(tab.id);
    chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
      console.warn("[DeskCheck] open-panel failed:", err);
    });
    void scopeOtherTabsAwayFromBound(tab.id);
    return;
  }
  if (command === "toggle-session") {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    if (isSessionInFlight()) {
      await handleMessage({ type: "STOP_SESSION" }, { tab } as any);
      return;
    }
    // Fire setOptions + open synchronously BEFORE START_SESSION's
    // own awaits consume the gesture budget.
    void enablePanelOnTab(tab.id);
    chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
      console.warn(
        "[DeskCheck] Failed to open side panel on toggle-session:",
        err,
      );
    });
    await handleMessage(
      {
        type: "START_SESSION",
        tabId: tab.id,
        url: tab.url ?? "",
        viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
      },
      { tab } as any,
    );
    void scopeOtherTabsAwayFromBound(tab.id);
  }
});

// ── Tab close handling ──

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const wasRecordingTab = tabId === activeTabId && isSessionInFlight();
  if (wasRecordingTab) {
    try {
      await debuggerClient.detach();
      const session = await store.getSession();
      if (session) {
        const now = new Date();
        await store.updateSession({
          end_time: now.toISOString(),
          duration_ms:
            now.getTime() - new Date(session.start_time).getTime(),
          status: "stopped",
        });
      }
    } catch (e) {
      console.error("[DeskCheck] Error during tab close cleanup:", e);
    } finally {
      currentStatus = "stopped";
      activeTabId = null;
      setBadge(false);
    }
  }
  // Feature #9: best-effort tab-group cleanup. This MUST run inside
  // its own fire-and-forget wrapper and MUST come after the
  // panelBoundTabId cleanup below, so a throwing tab-group call
  // cannot prevent the side panel binding from being released. The
  // helper itself never rejects, but we still wrap in `void` to make
  // the ordering self-evident to future readers.
  if (tabId === panelBoundTabId) {
    // The tab hosting the panel is gone. Chrome drops per-tab
    // sidePanel entries automatically on tab removal, so we just
    // need to forget about the binding. Previously scoped-away
    // tabs keep their disabled entries — the next click on one of
    // them will go through enablePanelOnTab, which re-enables it.
    panelBoundTabId = null;
  }
  if (wasRecordingTab) {
    void removeTabFromDeskCheckGroup(tabId);
  }
  // Phase 2: clear any pending handoff for this tab
  if (__pendingHandoffs.has(tabId)) {
    __pendingHandoffs.delete(tabId);
    void clearPendingHandoff(tabId);
  }
});

// ── Helpers ──

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
