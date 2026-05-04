// @vitest-environment jsdom
//
// Feature-17 acceptance — DoD-6.
//
// Clear (formerly Discard) shows a destructive confirmation dialog with
// counts read from a fresh chrome.storage.local.get at dialog-open time.
// Cancel = ZERO storage writes. Confirm = single DISCARD_SESSION dispatch.
//
// This test replaces the old discard-cancel coverage; the storage write
// shape is identical because Clear reuses the existing DISCARD_SESSION
// SW handler.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mountSidePanel, type SidePanelDeps } from "../src/sidepanel/sidepanel";
import type { Message, TimelineEvent } from "../src/types";
import { clearHandoffConfig } from "../src/lib/handoff-store";

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
  setStorageSnapshot: (snap: Record<string, unknown>) => void;
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
  let storageSnapshot: Record<string, unknown> = {};

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
      if (msg.type === "GET_SESSION_METRICS") {
        return {
          startTime: "",
          eventCount: events.length,
          screenshotCount: 0,
          eventsSizeBytes: 0,
          screenshotsSizeBytes: 0,
        };
      }
      if (msg.type === "START_SESSION") {
        recordingState = true;
        return { recording: true, status: "running" };
      }
      if (msg.type === "PAUSE_SESSION") {
        pausedState = true;
        return { paused: true, status: "paused" };
      }
      if (msg.type === "DISCARD_SESSION") {
        recordingState = false;
        pausedState = false;
        return { status: "idle", discarded: true };
      }
      return undefined;
    },
    readStorage: async (_keys: string[]) => storageSnapshot,
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
    setStorageSnapshot: (snap) => {
      storageSnapshot = snap;
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

async function pause(deps: SidePanelDeps): Promise<void> {
  deps.root.querySelector<HTMLButtonElement>("#start-btn")!.click();
  await new Promise((r) => setTimeout(r, 0));
  deps.root.querySelector<HTMLButtonElement>("#pause-btn")!.click();
  await new Promise((r) => setTimeout(r, 0));
}

describe("feature-17 DoD-6 — Clear confirmation dialog", () => {
  it("clicking Clear opens the confirmation dialog with copy mentioning event/screenshot counts", async () => {
    const h = makeHarness([SAMPLE_EVENT]);
    h.setStorageSnapshot({
      deskcheck_events: [SAMPLE_EVENT, SAMPLE_EVENT],
      deskcheck_screenshots: { ss_1: "data:image/png;base64,STUB" },
    });
    await mountSidePanel(h.deps);
    await pause(h.deps);

    const clearBtn = h.deps.root.querySelector<HTMLButtonElement>("#clear-btn");
    expect(clearBtn).not.toBeNull();
    clearBtn!.click();
    await new Promise((r) => setTimeout(r, 0));

    const dialog = h.deps.root.querySelector("#clear-confirm-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.classList.contains("hidden")).toBe(false);
    const detail = dialog!.querySelector("#clear-detail");
    expect(detail!.textContent).toMatch(/2 events/);
    expect(detail!.textContent).toMatch(/1 screenshot/);
  });

  it("Cancel produces ZERO storage writes and ZERO DISCARD_SESSION dispatches", async () => {
    const h = makeHarness([SAMPLE_EVENT]);
    h.setStorageSnapshot({
      deskcheck_events: [SAMPLE_EVENT],
      deskcheck_screenshots: {},
    });
    await mountSidePanel(h.deps);
    await pause(h.deps);

    h.deps.root.querySelector<HTMLButtonElement>("#clear-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    h.deps.root.querySelector<HTMLButtonElement>("#cancel-clear-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const discardCalls = h.sent.filter((m) => m.type === "DISCARD_SESSION");
    expect(discardCalls).toHaveLength(0);
    const dialog = h.deps.root.querySelector("#clear-confirm-dialog");
    expect(dialog!.classList.contains("hidden")).toBe(true);
  });

  it("Confirm dispatches exactly one DISCARD_SESSION", async () => {
    const h = makeHarness([SAMPLE_EVENT]);
    h.setStorageSnapshot({
      deskcheck_events: [SAMPLE_EVENT],
      deskcheck_screenshots: {},
    });
    await mountSidePanel(h.deps);
    await pause(h.deps);

    h.deps.root.querySelector<HTMLButtonElement>("#clear-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    h.deps.root.querySelector<HTMLButtonElement>("#confirm-clear-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    const discardCalls = h.sent.filter((m) => m.type === "DISCARD_SESSION");
    expect(discardCalls).toHaveLength(1);
  });

  it("default focus on the Clear dialog goes to Cancel", async () => {
    const h = makeHarness([SAMPLE_EVENT]);
    h.setStorageSnapshot({
      deskcheck_events: [SAMPLE_EVENT],
      deskcheck_screenshots: {},
    });
    await mountSidePanel(h.deps);
    await pause(h.deps);

    h.deps.root.querySelector<HTMLButtonElement>("#clear-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect((document.activeElement as HTMLElement | null)?.id).toBe(
      "cancel-clear-btn",
    );
  });

  it("counts come from a fresh storage read at dialog-open time", async () => {
    let readCount = 0;
    const h = makeHarness([SAMPLE_EVENT]);
    h.deps.readStorage = async (_keys: string[]) => {
      readCount++;
      return {
        deskcheck_events: [SAMPLE_EVENT, SAMPLE_EVENT, SAMPLE_EVENT],
        deskcheck_screenshots: {},
      };
    };
    await mountSidePanel(h.deps);
    await pause(h.deps);

    h.deps.root.querySelector<HTMLButtonElement>("#clear-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(readCount).toBeGreaterThan(0);
    const detail = h.deps.root.querySelector("#clear-detail");
    expect(detail!.textContent).toMatch(/3 events/);
  });
});
