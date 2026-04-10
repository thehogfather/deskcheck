// Standalone demo entry point for feature #13 — dogfooding mode.
//
// Mounts the real side panel UI via mountSidePanel with mock
// SidePanelDeps so the panel renders at a normal http://localhost URL
// without any Chrome extension APIs. Controls log to console instead
// of messaging a service worker.

import { mountSidePanel, type SidePanelDeps, type StorageOnChangedApi } from "../src/sidepanel/sidepanel";
import type { Message, TimelineEvent, SessionMetadata, SessionMetrics } from "../src/types";
import type { SessionStatus } from "../src/lib/session-status";
import type { PiiCaptureMode } from "../src/lib/pii-modes";
import type { SessionStorageApi } from "../src/lib/sidepanel-storage";
import { STORAGE_SESSION } from "../src/constants";

// ── Tiny event emitter ──────────────────────────────────────────────

type Listener<T extends unknown[]> = (...args: T) => unknown;

function createEmitter<T extends unknown[]>() {
  const listeners = new Set<Listener<T>>();
  return {
    addListener(fn: Listener<T>) { listeners.add(fn); },
    removeListener(fn: Listener<T>) { listeners.delete(fn); },
    emit(...args: T) { for (const fn of listeners) fn(...args); },
  };
}

// ── Demo data ───────────────────────────────────────────────────────

const SESSION_ID = "demo-session-001";
const SESSION_START = new Date().toISOString();
const PAGE_URL = "https://app.example.com/dashboard";

const DEMO_EVENTS: TimelineEvent[] = [
  {
    seq: 1, type: "interaction", subtype: "navigation",
    timestamp: ts(0), page_url: PAGE_URL,
    from_url: "https://app.example.com/login", to_url: PAGE_URL,
  },
  {
    seq: 2, type: "interaction", subtype: "click",
    timestamp: ts(2000), page_url: PAGE_URL,
    element: { tag: "button", selector: "button.submit-form", text: "Submit order" },
    coordinates: { x: 340, y: 520 },
  },
  {
    seq: 3, type: "network_error",
    timestamp: ts(3000), page_url: PAGE_URL,
    method: "POST", url: "https://api.example.com/v2/orders",
    status: 500, status_text: "Internal Server Error",
    request_headers: { "Content-Type": "application/json" },
    response_body_preview: '{"error":"unexpected null in cart.items"}',
  },
  {
    seq: 4, type: "console_error", level: "error",
    timestamp: ts(3200), page_url: PAGE_URL,
    message: "Uncaught TypeError: Cannot read properties of undefined (reading 'items')",
    stack_trace: "at CartService.checkout (cart.js:142:12)\nat handleSubmit (form.js:38:5)",
  },
  {
    seq: 5, type: "interaction", subtype: "click",
    timestamp: ts(5000), page_url: PAGE_URL,
    element: { tag: "a", selector: "a.retry-link", text: "Retry" },
    coordinates: { x: 280, y: 600 },
  },
  {
    seq: 6, type: "network_error",
    timestamp: ts(6000), page_url: PAGE_URL,
    method: "POST", url: "https://api.example.com/v2/orders",
    status: 500, status_text: "Internal Server Error",
    request_headers: { "Content-Type": "application/json" },
  },
  {
    seq: 7, type: "console_error", level: "warning",
    timestamp: ts(8000), page_url: PAGE_URL,
    message: "Rate limit approaching: 95% of quota used",
  },
  {
    seq: 8, type: "interaction", subtype: "click",
    timestamp: ts(12000), page_url: PAGE_URL,
    element: { tag: "a", selector: "nav.sidebar > a.settings", text: "Settings" },
    coordinates: { x: 60, y: 380 },
  },
  {
    seq: 9, type: "interaction", subtype: "navigation",
    timestamp: ts(12500), page_url: "https://app.example.com/settings",
    from_url: PAGE_URL, to_url: "https://app.example.com/settings",
  },
  {
    seq: 10, type: "interaction", subtype: "input",
    timestamp: ts(15000), page_url: "https://app.example.com/settings",
    element: { tag: "input", selector: "input#display-name", text: "" },
    value: "Jane Developer",
  },
  {
    seq: 11, type: "js_exception",
    timestamp: ts(17000), page_url: "https://app.example.com/settings",
    message: "RangeError: Maximum call stack size exceeded",
    stack_trace: "at deepClone (utils.js:89:3)\nat deepClone (utils.js:91:12)\nat deepClone (utils.js:91:12)",
    source_url: "https://app.example.com/assets/utils.js",
    line: 89, column: 3,
  },
  {
    seq: 12, type: "annotation",
    timestamp: ts(20000), page_url: "https://app.example.com/settings",
    text: "Bug: clicking Submit on the order form returns a 500. Happens consistently after adding 3+ items to cart.",
    screenshot_id: "screenshot-001",
  },
  {
    seq: 13, type: "viewport_resize",
    timestamp: ts(22000), page_url: "https://app.example.com/settings",
    from: { width: 1440, height: 900 },
    to: { width: 1024, height: 768 },
  },
];

function ts(offsetMs: number): string {
  return new Date(Date.now() - 25000 + offsetMs).toISOString();
}

// ── Mock session state ──────────────────────────────────────────────

let currentStatus: SessionStatus = "idle";
let sessionEvents: TimelineEvent[] = [];
let sessionScreenshots: Record<string, string> = {};
let piiMode: PiiCaptureMode = "full";
let eventEmitTimer: ReturnType<typeof setInterval> | null = null;
let nextEventIndex = 0;
let sessionStartTime: string = SESSION_START;

const storageChanged = createEmitter<[
  Record<string, { oldValue?: unknown; newValue?: unknown }>,
  string,
]>();

const runtimeMessage = createEmitter<[Message, ...unknown[]]>();

function buildSessionMetadata(): SessionMetadata {
  return {
    id: SESSION_ID,
    tab_id: 1,
    start_time: sessionStartTime,
    end_time: currentStatus === "stopped" ? new Date().toISOString() : null,
    duration_ms: Date.now() - new Date(sessionStartTime).getTime(),
    initial_url: PAGE_URL,
    user_agent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    pii_mode: piiMode,
    status: currentStatus === "idle" ? "stopped" : currentStatus as Exclude<SessionStatus, "idle">,
  };
}

function fireStorageChanged(session: SessionMetadata | undefined) {
  storageChanged.emit(
    { [STORAGE_SESSION]: { newValue: session } },
    "local",
  );
}

function startEventEmission() {
  nextEventIndex = 0;
  sessionEvents = [];
  sessionScreenshots = {};
  eventEmitTimer = setInterval(() => {
    if (nextEventIndex >= DEMO_EVENTS.length) {
      if (eventEmitTimer) clearInterval(eventEmitTimer);
      return;
    }
    const event = DEMO_EVENTS[nextEventIndex++];
    sessionEvents.push(event);
    runtimeMessage.emit({ type: "EVENT_APPENDED", event } as Message);
  }, 1500);
}

function stopEventEmission() {
  if (eventEmitTimer) {
    clearInterval(eventEmitTimer);
    eventEmitTimer = null;
  }
}

// ── Mock sendMessage ────────────────────────────────────────────────

async function handleMessage(msg: Message): Promise<unknown> {
  console.log("[DeskCheck Demo]", msg.type, msg);

  switch (msg.type) {
    case "GET_SESSION_STATE":
      return {
        recording: currentStatus === "running" || currentStatus === "paused",
        status: currentStatus,
        piiMode,
        sessionId: currentStatus !== "idle" ? SESSION_ID : null,
        activeTabId: 1,
      };

    case "GET_SESSION_METRICS": {
      const evtBytes = JSON.stringify(sessionEvents).length;
      return {
        startTime: sessionStartTime,
        eventCount: sessionEvents.length,
        screenshotCount: Object.keys(sessionScreenshots).length,
        eventsSizeBytes: evtBytes,
        screenshotsSizeBytes: 0,
      } satisfies SessionMetrics;
    }

    case "GET_EVENTS_SNAPSHOT":
      return { events: sessionEvents, screenshots: sessionScreenshots };

    case "START_SESSION": {
      currentStatus = "running";
      sessionStartTime = new Date().toISOString();
      piiMode = ("piiMode" in msg && msg.piiMode) ? msg.piiMode : "full";
      fireStorageChanged(buildSessionMetadata());
      startEventEmission();
      return { sessionId: SESSION_ID, piiMode };
    }

    case "PAUSE_SESSION":
      currentStatus = "paused";
      stopEventEmission();
      fireStorageChanged(buildSessionMetadata());
      return undefined;

    case "RESUME_SESSION":
      currentStatus = "running";
      fireStorageChanged(buildSessionMetadata());
      // Resume emitting remaining events
      if (nextEventIndex < DEMO_EVENTS.length) {
        eventEmitTimer = setInterval(() => {
          if (nextEventIndex >= DEMO_EVENTS.length) {
            if (eventEmitTimer) clearInterval(eventEmitTimer);
            return;
          }
          const event = DEMO_EVENTS[nextEventIndex++];
          sessionEvents.push(event);
          runtimeMessage.emit({ type: "EVENT_APPENDED", event } as Message);
        }, 1500);
      }
      return undefined;

    case "STOP_SESSION":
      currentStatus = "stopped";
      stopEventEmission();
      fireStorageChanged(buildSessionMetadata());
      console.log("[DeskCheck Demo] Session stopped. Would export zip here.");
      return undefined;

    case "EXPORT_SESSION":
      console.log("[DeskCheck Demo] Export requested. Events:", sessionEvents.length);
      // Simulate download delay
      await delay(800);
      currentStatus = "idle";
      runtimeMessage.emit({ type: "SESSION_CLEARED" } as Message);
      fireStorageChanged(undefined);
      return undefined;

    case "DISCARD_SESSION":
      currentStatus = "idle";
      stopEventEmission();
      sessionEvents = [];
      sessionScreenshots = {};
      runtimeMessage.emit({ type: "SESSION_CLEARED" } as Message);
      fireStorageChanged(undefined);
      return undefined;

    case "RESET_SESSION":
      sessionEvents = [];
      sessionScreenshots = {};
      nextEventIndex = 0;
      return undefined;

    case "ADD_ANNOTATION": {
      const seq = sessionEvents.length + 1;
      const annotationEvent: TimelineEvent = {
        seq,
        type: "annotation",
        timestamp: new Date().toISOString(),
        page_url: "https://app.example.com/settings",
        text: "text" in msg ? msg.text : "",
        screenshot_id: `screenshot-${String(seq).padStart(3, "0")}`,
      };
      sessionEvents.push(annotationEvent);
      runtimeMessage.emit({ type: "EVENT_APPENDED", event: annotationEvent } as Message);
      return undefined;
    }

    case "TAKE_SCREENSHOT":
      console.log("[DeskCheck Demo] Screenshot requested (trigger:", ("trigger" in msg ? msg.trigger : "unknown"), ")");
      return undefined;

    case "START_ELEMENT_PICKER":
      console.log("[DeskCheck Demo] Element picker requested — not available in standalone mode.");
      // Simulate a cancelled pick after a short delay
      await delay(500);
      runtimeMessage.emit({
        type: "PICK_ELEMENT_RESULT",
        element: null,
        devicePixelRatio: window.devicePixelRatio,
      } as Message);
      return undefined;

    default:
      console.log("[DeskCheck Demo] Unhandled message:", msg);
      return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Mock sessionStorage ─────────────────────────────────────────────

function createMockSessionStorage(): SessionStorageApi {
  const store: Record<string, unknown> = {};
  return {
    get(keys: string | string[]) {
      const result: Record<string, unknown> = {};
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const k of keyList) {
        if (k in store) result[k] = store[k];
      }
      return Promise.resolve(result);
    },
    set(items: Record<string, unknown>) {
      Object.assign(store, items);
      return Promise.resolve();
    },
  };
}

// ── Mount ────────────────────────────────────────────────────────────

async function main() {
  const root = document.getElementById("sidepanel-root");
  if (!root) {
    console.error("[DeskCheck Demo] #sidepanel-root not found");
    return;
  }

  let firstRunSeen = true; // Skip first-run notice for demo

  const deps: SidePanelDeps = {
    root,
    sendMessage: handleMessage,
    onChanged: storageChanged as StorageOnChangedApi,
    onWindowFocusChanged: {
      addListener() {},
      removeListener() {},
    },
    getCurrentWindowId: async () => 1,
    getFirstRunSeen: async () => firstRunSeen,
    markFirstRunSeen: async () => { firstRunSeen = true; },
    sessionStorage: createMockSessionStorage(),
    queryActiveTab: async () => ({
      id: 1,
      url: PAGE_URL,
      active: true,
      index: 0,
      pinned: false,
      highlighted: true,
      windowId: 1,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    }),
    onRuntimeMessage: runtimeMessage as SidePanelDeps["onRuntimeMessage"],
    readStorage: async (keys: string[]) => {
      const result: Record<string, unknown> = {};
      if (keys.includes("deskcheck_events")) {
        result["deskcheck_events"] = sessionEvents;
      }
      if (keys.includes("deskcheck_screenshots")) {
        result["deskcheck_screenshots"] = sessionScreenshots;
      }
      if (keys.includes(STORAGE_SESSION)) {
        result[STORAGE_SESSION] = currentStatus !== "idle" ? buildSessionMetadata() : undefined;
      }
      return result;
    },
  };

  await mountSidePanel(deps);
  console.log("[DeskCheck Demo] Side panel mounted. Ready for dogfooding.");
}

void main();
