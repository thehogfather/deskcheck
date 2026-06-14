// Acceptance tests for feature #7 — opt-in tab switching during a session.
//
// Exercises the service worker's SWITCH_RECORDING_TAB handler end-to-end
// against a fake chrome + fake OPFS: the debugger pointer moves, the
// content script is (re)injected on the new tab, the session's bound tab
// is updated, and a `tab_switch` event lands in the timeline. Also pins
// the failure path: if attaching to the new tab fails, the session stays
// on the original tab rather than tearing down.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakeOpfsRoot } from "../src/lib/__fixtures__/fake-opfs";

type Fn = ReturnType<typeof vi.fn>;

function installFakeChrome(): any {
  const tabUrls: Record<number, string> = {
    42: "https://example.com/recording-tab",
    99: "https://example.com/the-other-tab",
  };
  const fake = {
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      setOptions: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    runtime: {
      id: "test-ext-id",
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 42 }, { id: 99 }]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      onRemoved: { addListener: vi.fn() },
      onCreated: { addListener: vi.fn() },
      get: vi.fn(async ({}: unknown) => undefined) as Fn,
      group: vi.fn().mockResolvedValue(999),
      ungroup: vi.fn().mockResolvedValue(undefined),
    },
    tabGroups: { query: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue(undefined) },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue(undefined) },
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  // tabs.get resolves a tab object by id with a stable url + windowId.
  fake.tabs.get = vi.fn(async (arg: number | { tabId?: number }) => {
    const id = typeof arg === "number" ? arg : (arg?.tabId ?? 0);
    return { id, url: tabUrls[id] ?? "https://example.com/unknown", active: true, windowId: 7 };
  }) as Fn;

  // @ts-expect-error — install fake on globalThis.
  globalThis.chrome = fake;
  if (!("navigator" in globalThis)) {
    // @ts-expect-error — minimal navigator stub.
    globalThis.navigator = { userAgent: "test" };
  }
  const fakeOpfs = createFakeOpfsRoot();
  // @ts-expect-error — minimal navigator.storage stub.
  globalThis.navigator.storage = { getDirectory: async () => fakeOpfs.root };
  if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
    // @ts-expect-error — minimal crypto stub.
    globalThis.crypto = { randomUUID: () => "test-uuid" };
  }
  return fake;
}

type MessageHandler = (
  msg: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

function dispatch(handler: MessageHandler, msg: unknown, sender: unknown = {}): Promise<any> {
  return new Promise((resolve) => {
    handler(msg, sender, resolve);
  });
}

describe("service worker SWITCH_RECORDING_TAB (feature #7)", () => {
  let mockChrome: ReturnType<typeof installFakeChrome>;
  let messageHandler: MessageHandler;

  async function loadServiceWorker() {
    await import("../src/background/service-worker");
    await new Promise((r) => setTimeout(r, 0));
    const listeners = mockChrome.runtime.onMessage.addListener.mock.calls as Array<[MessageHandler]>;
    messageHandler = listeners
      .map((c) => c[0])
      .find((l) => l({ type: "__probe__" }, {}, () => {}) === true) as MessageHandler;
    expect(messageHandler).toBeTypeOf("function");
  }

  async function startSessionOnTab42() {
    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/recording-tab",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    mockChrome = installFakeChrome();
    await loadServiceWorker();
  });

  it("moves the debugger, re-injects the content script, and rebinds the session", async () => {
    await startSessionOnTab42();
    mockChrome.debugger.attach.mockClear();
    mockChrome.debugger.detach.mockClear();
    mockChrome.scripting.executeScript.mockClear();

    const res = (await dispatch(messageHandler, {
      type: "SWITCH_RECORDING_TAB",
      tabId: 99,
    })) as { switched?: boolean };

    expect(res.switched).toBe(true);
    // Debugger detached the old tab and attached the new one.
    expect(mockChrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    expect(mockChrome.debugger.attach).toHaveBeenCalledWith({ tabId: 99 }, "1.3");
    // Content script injected into the new tab.
    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 99 },
      files: ["src/content/index.js"],
    });
    // The session is now bound to tab 99.
    const state = (await dispatch(messageHandler, { type: "GET_SESSION_STATE" })) as {
      activeTabId?: number;
    };
    expect(state.activeTabId).toBe(99);
  });

  it("logs a tab_switch event with from/to urls into the timeline", async () => {
    await startSessionOnTab42();
    await dispatch(messageHandler, { type: "SWITCH_RECORDING_TAB", tabId: 99 });

    const snapshot = (await dispatch(messageHandler, { type: "GET_EVENTS_SNAPSHOT" })) as {
      events: Array<Record<string, unknown>>;
    };
    const sw = snapshot.events.find((e) => e.type === "tab_switch");
    expect(sw).toBeDefined();
    expect(sw).toMatchObject({
      from_tab_id: 42,
      from_url: "https://example.com/recording-tab",
      to_tab_id: 99,
      to_url: "https://example.com/the-other-tab",
    });
  });

  it("broadcasts RECORDING_TAB_CHANGED so other panels re-evaluate", async () => {
    await startSessionOnTab42();
    mockChrome.runtime.sendMessage.mockClear();
    await dispatch(messageHandler, { type: "SWITCH_RECORDING_TAB", tabId: 99 });
    const broadcasts = mockChrome.runtime.sendMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(broadcasts).toContainEqual({ type: "RECORDING_TAB_CHANGED", tabId: 99 });
  });

  it("is a no-op when switching to the tab that is already recording", async () => {
    await startSessionOnTab42();
    mockChrome.debugger.attach.mockClear();
    const res = (await dispatch(messageHandler, {
      type: "SWITCH_RECORDING_TAB",
      tabId: 42,
    })) as { switched?: boolean };
    expect(res.switched).toBe(false);
    expect(mockChrome.debugger.attach).not.toHaveBeenCalled();
  });

  it("is rejected when there is no in-flight session", async () => {
    const res = (await dispatch(messageHandler, {
      type: "SWITCH_RECORDING_TAB",
      tabId: 99,
    })) as { switched?: boolean };
    expect(res.switched).toBe(false);
  });

  it("keeps the session on the original tab when attaching to the new tab fails", async () => {
    await startSessionOnTab42();
    // First attach (the move to 99) fails; the recovery re-attach to 42
    // succeeds.
    mockChrome.debugger.attach.mockRejectedValueOnce(new Error("DevTools already open"));

    const res = (await dispatch(messageHandler, {
      type: "SWITCH_RECORDING_TAB",
      tabId: 99,
    })) as { switched?: boolean; warnings?: string[] };

    expect(res.switched).toBe(false);
    expect(res.warnings?.[0]).toMatch(/DevTools|original tab/i);
    // Recording is still bound to tab 42, not 99.
    const state = (await dispatch(messageHandler, { type: "GET_SESSION_STATE" })) as {
      activeTabId?: number;
    };
    expect(state.activeTabId).toBe(42);
  });
});
