// @vitest-environment jsdom
//
// Feature-17 acceptance — DoD-7.
//
// Clicking #end-btn dispatches STOP_SESSION + EXPORT_SESSION (the same
// pair as today's Stop+listener), exits to idle on success, and never
// touches a separate End-specific SW message. End is purely a transport
// affordance over the existing handoff path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mountSidePanel, type SidePanelDeps } from "../src/sidepanel/sidepanel";
import type { Message, TimelineEvent } from "../src/types";
import {
  setHandoffConfig,
  clearHandoffConfig,
} from "../src/lib/handoff-store";

function installFakeStorage(): void {
  const store: Record<string, unknown> = {};
  const fake = {
    get: vi.fn().mockImplementation(async (key: string) => {
      return key in store ? { [key]: store[key] } : {};
    }),
    set: vi.fn().mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn().mockImplementation(async (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete store[k];
    }),
  };
  // @ts-expect-error — install fake chrome global for jsdom
  globalThis.chrome = { storage: { local: fake } };
}

type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;
type FocusListener = (windowId: number) => void;
type RuntimeListener = (msg: Message) => void;

interface Harness {
  deps: SidePanelDeps;
  sent: Message[];
  fireRuntimeMessage: (msg: Message) => void;
}

function clearBody() {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

function makeHarness(events: TimelineEvent[]): Harness {
  const root = document.createElement("div");
  root.id = "sidepanel-root";
  document.body.appendChild(root);

  const sent: Message[] = [];
  const storageListeners = new Set<StorageListener>();
  const focusListeners = new Set<FocusListener>();
  const runtimeListeners = new Set<RuntimeListener>();
  let recordingState = false;
  let pausedState = false;

  const deps: SidePanelDeps = {
    root,
    sendMessage: async (msg: Message) => {
      sent.push(msg);
      if (msg.type === "GET_SESSION_STATE") {
        return {
          recording: recordingState,
          paused: pausedState,
          status: recordingState ? (pausedState ? "paused" : "running") : "idle",
          piiMode: "full",
        };
      }
      if (msg.type === "GET_EVENTS_SNAPSHOT") {
        return { events, screenshots: {} };
      }
      if (msg.type === "START_SESSION") {
        recordingState = true;
        return { recording: true, status: "running" };
      }
      if (msg.type === "PAUSE_SESSION") {
        pausedState = true;
        return { paused: true, status: "paused" };
      }
      if (msg.type === "STOP_SESSION") {
        return { stopped: true };
      }
      if (msg.type === "EXPORT_SESSION") {
        recordingState = false;
        pausedState = false;
        return { filename: "deskcheck.zip" };
      }
      return undefined;
    },
    onChanged: {
      addListener: (l) => storageListeners.add(l),
      removeListener: (l) => storageListeners.delete(l),
    },
    onWindowFocusChanged: {
      addListener: (l) => focusListeners.add(l),
      removeListener: (l) => focusListeners.delete(l),
    },
    onRuntimeMessage: {
      addListener: (l) => runtimeListeners.add(l),
      removeListener: (l) => runtimeListeners.delete(l),
    },
    getCurrentWindowId: async () => 7,
    getFirstRunSeen: async () => true,
    markFirstRunSeen: async () => {},
    initialEvents: events,
    initialScreenshots: {},
    initialPiiMode: "full",
  };

  return {
    deps,
    sent,
    fireRuntimeMessage: (msg) => {
      for (const l of runtimeListeners) l(msg);
    },
  };
}

beforeEach(async () => {
  clearBody();
  installFakeStorage();
  await clearHandoffConfig().catch(() => {});
});

afterEach(() => {
  // @ts-expect-error — clean up chrome global
  delete globalThis.chrome;
});

const SAMPLE_EVENT: TimelineEvent = {
  seq: 1,
  type: "console_error",
  level: "error",
  message: "boom",
  timestamp: "2026-04-12T00:00:00.000Z",
  page_url: "https://example.com/",
} as unknown as TimelineEvent;

async function pauseWithListener(h: Harness): Promise<void> {
  await setHandoffConfig({
    listener_url: "http://127.0.0.1:54329",
    token:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    created_at: "2026-04-12T00:00:00.000Z",
  });
  // Broadcast PENDING_HANDOFF_CHANGED so the panel updates its
  // listenerAttached state — the SW would normally emit this when the
  // config lands.
  h.fireRuntimeMessage({
    type: "PENDING_HANDOFF_CHANGED",
    pending: null,
    active: {
      listener_url: "http://127.0.0.1:54329",
      token:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      created_at: "2026-04-12T00:00:00.000Z",
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  h.deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
  await new Promise((r) => setTimeout(r, 0));
  h.deps.root.querySelector<HTMLButtonElement>("#pause-btn")!.click();
  await new Promise((r) => setTimeout(r, 0));
}

describe("feature-17 DoD-7 — End reuses STOP_SESSION + EXPORT_SESSION", () => {
  it("clicking #end-btn dispatches STOP_SESSION then EXPORT_SESSION (no new message types)", async () => {
    const h = makeHarness([SAMPLE_EVENT]);
    await mountSidePanel(h.deps);
    await pauseWithListener(h);

    const endBtn = h.deps.root.querySelector<HTMLButtonElement>("#end-btn");
    expect(endBtn).not.toBeNull();
    endBtn!.click();
    // Allow microtasks for the async chain (STOP -> EXPORT).
    await new Promise((r) => setTimeout(r, 10));

    const types = h.sent.map((m) => m.type);
    const stopIdx = types.indexOf("STOP_SESSION");
    const exportIdx = types.indexOf("EXPORT_SESSION");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeGreaterThan(stopIdx);

    // No new End-specific message types — End is a transport choice over
    // the existing EXPORT_SESSION branch.
    expect(types).not.toContain("END_SESSION");
  });

  it("clicking #end-btn does NOT open the pre-export reminder (the listener pill is sufficient signal)", async () => {
    const h = makeHarness([SAMPLE_EVENT]);
    await mountSidePanel(h.deps);
    await pauseWithListener(h);

    h.deps.root.querySelector<HTMLButtonElement>("#end-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const reminder = h.deps.root.querySelector("#pre-export-reminder");
    if (reminder) {
      // If the reminder element exists, it must remain hidden — End does
      // not open the pre-export reminder.
      expect(reminder.classList.contains("hidden")).toBe(true);
    }
  });
});
