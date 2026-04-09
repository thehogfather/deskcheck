// Acceptance tests for feature #9 — Automatic tab group for active DeskCheck tabs.
//
// Pins the service-worker wiring for tab-group lifecycle:
//
//   - START_SESSION assigns the recorded tab to a "DeskCheck" group
//   - STOP_SESSION ungroups the recorded tab
//   - chrome.tabs.onRemoved ungroups a closed recording tab
//
// Plus the critical NO-REGRESSION invariants for feature-8:
//
//   - chrome.action.onClicked handler MUST NOT call any chrome.tabs.group /
//     chrome.tabs.ungroup / chrome.tabGroups.* method. Those calls would
//     consume the user-gesture budget and break sidePanel.open().
//
//   - chrome.tabs.onRemoved cleanup of panelBoundTabId MUST run even if
//     the tab-group cleanup throws — the two cleanups are independent.
//
// Tests mirror the installFakeChrome / dispatch pattern from
// tests/service-worker-setpanel.test.ts. The fake chrome global includes
// stubs for tabs.group, tabs.ungroup, tabGroups.query, tabGroups.update.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakeOpfsRoot } from "../src/lib/__fixtures__/fake-opfs";

type Fn = ReturnType<typeof vi.fn>;

interface MockChrome {
  sidePanel: {
    setPanelBehavior: Fn;
    setOptions: Fn;
    open: Fn;
  };
  runtime: {
    onMessage: { addListener: Fn };
    onInstalled: { addListener: Fn };
    sendMessage: Fn;
  };
  action: {
    setBadgeText: Fn;
    setBadgeBackgroundColor: Fn;
    onClicked: { addListener: Fn };
  };
  commands: { onCommand: { addListener: Fn } };
  tabs: {
    query: Fn;
    sendMessage: Fn;
    update: Fn;
    get: Fn;
    group: Fn;
    ungroup: Fn;
    onRemoved: { addListener: Fn };
    onCreated: { addListener: Fn };
  };
  tabGroups: {
    query: Fn;
    update: Fn;
  };
  storage: {
    local: {
      get: Fn;
      set: Fn;
      remove: Fn;
    };
  };
  scripting: { executeScript: Fn };
  debugger: {
    attach: Fn;
    detach: Fn;
    sendCommand: Fn;
    onEvent: { addListener: Fn; removeListener: Fn };
    onDetach: { addListener: Fn; removeListener: Fn };
  };
}

function installFakeChrome(): MockChrome {
  const fake: MockChrome = {
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      setOptions: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    runtime: {
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
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      get: vi
        .fn()
        .mockResolvedValue({
          id: 42,
          url: "https://example.com",
          active: true,
          windowId: 7,
        }),
      group: vi.fn().mockResolvedValue(999),
      ungroup: vi.fn().mockResolvedValue(undefined),
      onRemoved: { addListener: vi.fn() },
      onCreated: { addListener: vi.fn() },
    },
    tabGroups: {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    },
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
  // @ts-expect-error — install fake on globalThis.
  globalThis.chrome = fake;
  if (!("navigator" in globalThis)) {
    // @ts-expect-error — minimum navigator stub.
    globalThis.navigator = { userAgent: "test" };
  }
  // OpfsSessionStore (constructed at module init by service-worker.ts)
  // calls navigator.storage.getDirectory() during createSession. Install
  // a fake OPFS root so the SW can run end-to-end in node.
  const fakeOpfs = createFakeOpfsRoot();
  // @ts-expect-error — minimum navigator.storage stub.
  globalThis.navigator.storage = {
    getDirectory: async () => fakeOpfs.root,
  };
  if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
    // @ts-expect-error — minimum crypto stub.
    globalThis.crypto = { randomUUID: () => "test-uuid" };
  }
  return fake;
}

type MessageHandler = (
  msg: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

type TabRemovedHandler = (
  tabId: number,
  removeInfo: { windowId: number; isWindowClosing: boolean },
) => void | Promise<void>;

type ActionClickHandler = (
  tab: { id?: number; url?: string },
) => void | Promise<void>;

function dispatch(
  handler: MessageHandler,
  msg: unknown,
  sender: unknown = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    handler(msg, sender, resolve);
  });
}

async function flushAsync() {
  // Give the SW's fire-and-forget `void` IIFEs and unawaited helper
  // calls enough iterations to settle.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

async function loadServiceWorker(mockChrome: MockChrome) {
  await import("../src/background/service-worker");
  await new Promise((r) => setTimeout(r, 0));
  const allMessageListeners = mockChrome.runtime.onMessage.addListener.mock
    .calls as Array<[MessageHandler]>;
  const mainListener = allMessageListeners
    .map((c) => c[0])
    .find((l) => {
      const noop = () => {};
      const result = l({ type: "__probe__" }, {}, noop);
      return result === true;
    });
  const messageHandler = mainListener as MessageHandler;
  const tabRemovedHandler = mockChrome.tabs.onRemoved.addListener.mock
    .calls[0]?.[0] as TabRemovedHandler;
  const actionClickHandler = mockChrome.action.onClicked.addListener.mock
    .calls[0]?.[0] as ActionClickHandler;
  // Clear module-init calls so each test observes a fresh baseline.
  mockChrome.sidePanel.setOptions.mockClear();
  mockChrome.sidePanel.open.mockClear();
  mockChrome.tabs.group.mockClear();
  mockChrome.tabs.ungroup.mockClear();
  // tabGroups may have been deleted by the "API unavailable" test —
  // guard so this helper can still be used in that scenario.
  if (mockChrome.tabGroups) {
    mockChrome.tabGroups.query.mockClear();
    mockChrome.tabGroups.update.mockClear();
  }
  return { messageHandler, tabRemovedHandler, actionClickHandler };
}

describe("feature-9: service worker tab-group wiring", () => {
  let mockChrome: MockChrome;
  let messageHandler: MessageHandler;
  let tabRemovedHandler: TabRemovedHandler;
  let actionClickHandler: ActionClickHandler;

  beforeEach(async () => {
    vi.resetModules();
    mockChrome = installFakeChrome();
    const handlers = await loadServiceWorker(mockChrome);
    messageHandler = handlers.messageHandler;
    tabRemovedHandler = handlers.tabRemovedHandler;
    actionClickHandler = handlers.actionClickHandler;
  });

  // ── matrix #2: START_SESSION grouping ──

  it("START_SESSION groups the active tab into a DeskCheck group in the tab's window (matrix #2)", async () => {
    mockChrome.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://example.com",
      active: true,
      windowId: 7,
    });
    mockChrome.tabGroups.query.mockResolvedValue([]);

    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
    await flushAsync();

    // Query to see if an existing DeskCheck group lives in window 7
    expect(mockChrome.tabGroups.query).toHaveBeenCalledWith({
      windowId: 7,
      title: "DeskCheck",
    });
    // Create a new group hosting tab 42
    expect(mockChrome.tabs.group).toHaveBeenCalledWith({
      tabIds: 42,
      createProperties: { windowId: 7 },
    });
    // Apply the distinctive title + color after creation
    expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(999, {
      title: "DeskCheck",
      color: "blue",
    });
  });

  it("START_SESSION reuses an existing DeskCheck group in the same window (matrix #4)", async () => {
    mockChrome.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://example.com",
      active: true,
      windowId: 7,
    });
    mockChrome.tabGroups.query.mockResolvedValue([
      { id: 555, windowId: 7, title: "DeskCheck", color: "blue" },
    ]);

    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
    await flushAsync();

    expect(mockChrome.tabs.group).toHaveBeenCalledWith({
      tabIds: 42,
      groupId: 555,
    });
    // Reusing an existing group must NOT trigger a re-title/re-color.
    expect(mockChrome.tabGroups.update).not.toHaveBeenCalled();
  });

  // ── matrix #5: STOP_SESSION ungrouping ──

  it("STOP_SESSION ungroups the recorded tab (matrix #5)", async () => {
    mockChrome.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://example.com",
      active: true,
      windowId: 7,
    });
    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
    await flushAsync();
    mockChrome.tabs.ungroup.mockClear();

    await dispatch(
      messageHandler,
      { type: "STOP_SESSION" },
      { tab: { id: 42 } },
    );
    await flushAsync();

    expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith(42);
  });

  // ── matrix #7: tab closed mid-session ──

  it("tabs.onRemoved ungroups a closed recording tab (matrix #7)", async () => {
    mockChrome.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://example.com",
      active: true,
      windowId: 7,
    });
    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
    await flushAsync();
    mockChrome.tabs.ungroup.mockClear();

    await tabRemovedHandler(42, { windowId: 7, isWindowClosing: false });
    await flushAsync();

    expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith(42);
  });

  it("tabs.onRemoved does NOT throw when the tab-group ungroup rejects (matrix #7)", async () => {
    mockChrome.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://example.com",
      active: true,
      windowId: 7,
    });
    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
    await flushAsync();
    mockChrome.tabs.ungroup.mockClear();
    mockChrome.tabs.ungroup.mockRejectedValueOnce(
      new Error("No tab with id"),
    );

    // Must not throw.
    await expect(
      (async () => {
        await tabRemovedHandler(42, {
          windowId: 7,
          isWindowClosing: false,
        });
        await flushAsync();
      })(),
    ).resolves.toBeUndefined();
  });

  // ── matrix #9, #10: best-effort graceful degradation ──

  it("START_SESSION succeeds when chrome.tabGroups is undefined (matrix #9)", async () => {
    // Tear the API off the fake and reload the SW so the module's
    // feature-detection picks up the absence.
    vi.resetModules();
    const freshChrome = installFakeChrome();
    delete (freshChrome as unknown as { tabGroups?: unknown }).tabGroups;
    // chrome.tabs.group/ungroup are part of chrome.tabs, still present.
    const { messageHandler: h } = await loadServiceWorker(freshChrome);

    const result = (await dispatch(h, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    })) as { recording: boolean; warnings: string[] };

    expect(result.recording).toBe(true);
    // Warnings array is the existing shape; tab-group absence is NOT
    // a user-visible warning (best-effort cosmetic).
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("START_SESSION succeeds when every tab-group API call rejects (matrix #10)", async () => {
    mockChrome.tabs.get.mockResolvedValue({
      id: 42,
      url: "https://example.com",
      active: true,
      windowId: 7,
    });
    mockChrome.tabGroups.query.mockRejectedValue(new Error("q boom"));
    mockChrome.tabs.group.mockRejectedValue(new Error("g boom"));
    mockChrome.tabGroups.update.mockRejectedValue(new Error("u boom"));

    const result = (await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    })) as { recording: boolean };
    await flushAsync();

    expect(result.recording).toBe(true);
  });

  // ── matrix #11: gesture budget regression guard for feature-8 ──

  it("chrome.action.onClicked handler does NOT call any tab-group API (matrix #11)", async () => {
    // This is the single most important regression test in this file.
    // Any tab-group call inside the sync click handler would consume
    // the user-gesture budget and break chrome.sidePanel.open. We
    // assert the stubs are untouched immediately after the sync
    // handler returns AND after all microtasks have drained.
    mockChrome.tabs.query.mockResolvedValue([{ id: 42 }, { id: 99 }]);

    actionClickHandler({ id: 42, url: "https://example.com" });

    // Immediately after the sync listener: none of the tab-group
    // primitives can have been called, even once.
    expect(mockChrome.tabs.group).not.toHaveBeenCalled();
    expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
    expect(mockChrome.tabGroups.query).not.toHaveBeenCalled();
    expect(mockChrome.tabGroups.update).not.toHaveBeenCalled();

    await flushAsync();

    // Even after the async IIFE that scopes other tabs has run, the
    // tab-group primitives must remain untouched. Only START_SESSION /
    // STOP_SESSION / tabs.onRemoved should ever call them.
    expect(mockChrome.tabs.group).not.toHaveBeenCalled();
    expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
    expect(mockChrome.tabGroups.query).not.toHaveBeenCalled();
    expect(mockChrome.tabGroups.update).not.toHaveBeenCalled();
  });

  // ── matrix #13: ordering: panelBoundTabId cleanup must run independently ──

  it("tabs.onRemoved clears panelBoundTabId even when tab-group cleanup throws (matrix #13)", async () => {
    // Bind the side panel to tab 42 via a click (feature-8 path).
    mockChrome.tabs.query.mockResolvedValue([{ id: 42 }, { id: 99 }]);
    actionClickHandler({ id: 42 });
    await flushAsync();

    // Start recording on the same tab so onRemoved hits both cleanup
    // branches (recording + panelBoundTabId).
    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
    await flushAsync();

    // Arrange for tab-group cleanup to throw.
    mockChrome.tabs.ungroup.mockRejectedValueOnce(
      new Error("ungroup boom"),
    );
    mockChrome.sidePanel.setOptions.mockClear();

    await tabRemovedHandler(42, { windowId: 7, isWindowClosing: false });
    await flushAsync();

    // The real assertion: a subsequent action click on a BRAND NEW tab
    // (not the removed 42) should open the panel on that new tab,
    // proving the binding to 42 was released. If panelBoundTabId had
    // not been cleared, the recording-tab-route branch would have
    // redirected us elsewhere, and open() would not be called with the
    // new tab id.
    mockChrome.sidePanel.open.mockClear();
    actionClickHandler({ id: 77, url: "https://later.example" });
    expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 77 });
  });
});
