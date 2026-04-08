// Acceptance test for feature #8 — Test Level Matrix row #2.
//
// Pins the service worker's side panel behaviour under the
// bind-on-open, per-tab-only scoping model. The non-obvious
// constraints (each one was empirically discovered via
// e2e/sidepanel-debug.spec.ts — see that spec for the reasoning):
//
//   - setPanelBehavior({ openPanelOnActionClick: false }) is called
//     at top level so Chrome forwards toolbar clicks to our own
//     chrome.action.onClicked handler. This gives us the click's tab
//     id inside a fresh user-gesture window.
//
//   - The onClicked handler is SYNC (not async). It fires
//     chrome.sidePanel.open({ tabId }) synchronously — any `await`
//     before the open() call would consume the user-gesture token
//     and open() would reject with "may only be called in response
//     to a user gesture."
//
//   - The handler NEVER disables the global default_path. Disabling
//     global while a panel is open on a tab that inherits global
//     instantly closes that panel (empirically verified). Scoping is
//     achieved entirely by per-tab setOptions({ enabled: false }) on
//     OTHER tabs.
//
//   - The handler NEVER sets a fresh per-tab entry with the same
//     path as global on the bound tab. Doing so creates a "different
//     panel instance" that silently breaks subsequent open() calls
//     for that tab. The bound tab is left to inherit the global
//     default.
//
//   - When rebinding to a tab that WAS previously scoped away
//     (existing per-tab entry with enabled:false), setOptions must
//     pass the path when re-enabling — enabling without a path leaves
//     the entry path-less and open() rejects with "No active side
//     panel for tabId". This is the ONE case where setting a per-tab
//     entry with the same path as global is safe, because Chrome
//     treats "modify existing" differently from "create fresh".
//
//   - While a session is active, action clicks on non-recording tabs
//     route the user back to the recording tab via chrome.tabs.update
//     instead of opening a second panel.
//
//   - START_SESSION and STOP_SESSION do NOT touch setOptions. Panel
//     binding is decided at open time, not at recording start time.
//
//   - When the bound tab is closed, we clear our scoped-away
//     bookkeeping for that tab and drop the binding. Previously
//     scoped-away tabs keep their disabled per-tab entries; the next
//     action click on one of them will re-enable it via the rebind
//     path.
//
// We import the service worker module dynamically with a stub global
// `chrome` already in place, then exercise the captured handlers.

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
    onRemoved: { addListener: Fn };
    onCreated: { addListener: Fn };
    get: Fn;
    group: Fn;
    ungroup: Fn;
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
      onRemoved: { addListener: vi.fn() },
      onCreated: { addListener: vi.fn() },
      get: vi
        .fn()
        .mockResolvedValue({
          id: 1,
          url: "https://example.com",
          active: true,
          windowId: 7,
        }),
      // feature-9: tab-group primitives. SW imports the helper which
      // feature-detects chrome.tabGroups, so these must exist on the
      // fake global even when this test file only cares about feature-8.
      group: vi.fn().mockResolvedValue(999),
      ungroup: vi.fn().mockResolvedValue(undefined),
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
  // calls navigator.storage.getDirectory() during createSession. In a
  // node test environment that property is missing — install a fake
  // OPFS root so the SW can run end-to-end.
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

/** Dispatch a message to the service worker and await the response. */
function dispatch(
  handler: MessageHandler,
  msg: unknown,
  sender: unknown = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    handler(msg, sender, resolve);
  });
}

describe("service worker setPanelBehavior (matrix #2)", () => {
  let mockChrome: MockChrome;

  beforeEach(async () => {
    vi.resetModules();
    mockChrome = installFakeChrome();
  });

  it("calls chrome.sidePanel.setPanelBehavior with openPanelOnActionClick:false on module init", async () => {
    await import("../src/background/service-worker");
    // Allow microtasks (top-level await chains) to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockChrome.sidePanel.setPanelBehavior).toHaveBeenCalled();
    const args = mockChrome.sidePanel.setPanelBehavior.mock.calls[0]?.[0];
    // openPanelOnActionClick is OFF because we handle action clicks
    // ourselves via chrome.action.onClicked.
    expect(args).toEqual({ openPanelOnActionClick: false });
  });

  it("registers a chrome.action.onClicked listener on module init", async () => {
    await import("../src/background/service-worker");
    await new Promise((r) => setTimeout(r, 0));
    expect(mockChrome.action.onClicked.addListener).toHaveBeenCalled();
  });

  it("does not crash if setPanelBehavior rejects (catch attached)", async () => {
    mockChrome.sidePanel.setPanelBehavior.mockRejectedValueOnce(new Error("transient"));
    // Importing must not throw.
    await expect(import("../src/background/service-worker")).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    // Sanity: it was still called.
    expect(mockChrome.sidePanel.setPanelBehavior).toHaveBeenCalled();
  });
});

describe("service worker bind-on-open side panel (matrix #2b)", () => {
  let mockChrome: MockChrome;
  let messageHandler: MessageHandler;
  let tabRemovedHandler: TabRemovedHandler;
  let tabCreatedHandler: (tab: { id?: number }) => void;
  let actionClickHandler: ActionClickHandler;

  async function loadServiceWorker() {
    await import("../src/background/service-worker");
    await new Promise((r) => setTimeout(r, 0));
    // The SW registers TWO onMessage listeners: a lightweight debug
    // listener for SIDEPANEL_VISIBILITY reports, and the main
    // handleMessage listener. We want the main one — identify it by
    // picking the listener that returns true (async responder).
    const allMessageListeners = mockChrome.runtime.onMessage.addListener.mock
      .calls as Array<[MessageHandler]>;
    const mainListener = allMessageListeners
      .map((c) => c[0])
      .find((l) => {
        const noop = () => {};
        const result = l({ type: "__probe__" }, {}, noop);
        return result === true;
      });
    messageHandler = mainListener as MessageHandler;
    tabRemovedHandler = mockChrome.tabs.onRemoved.addListener.mock
      .calls[0]?.[0] as TabRemovedHandler;
    tabCreatedHandler = mockChrome.tabs.onCreated.addListener.mock
      .calls[0]?.[0] as (tab: { id?: number }) => void;
    actionClickHandler = mockChrome.action.onClicked.addListener.mock
      .calls[0]?.[0] as ActionClickHandler;
    expect(messageHandler).toBeTypeOf("function");
    expect(tabRemovedHandler).toBeTypeOf("function");
    expect(tabCreatedHandler).toBeTypeOf("function");
    expect(actionClickHandler).toBeTypeOf("function");
    // Clear any module-init calls so each test observes a fresh baseline.
    mockChrome.sidePanel.setOptions.mockClear();
    mockChrome.sidePanel.open.mockClear();
  }

  /**
   * Wait for all pending async microtasks kicked off by the sync
   * onClicked listener (via its void IIFE) to settle.
   */
  async function flushAsync() {
    // Give the IIFE enough iterations to walk through its awaits.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    mockChrome = installFakeChrome();
    await loadServiceWorker();
  });

  it("calls sidePanel.open synchronously inside the click listener", () => {
    // open() must be invoked SYNCHRONOUSLY inside the handler — before
    // any await — or the user-gesture token is consumed and the real
    // Chrome API rejects. By checking that open() is already in the
    // mock's call list before we yield to the event loop, we pin the
    // sync-first invariant.
    actionClickHandler({ id: 42, url: "https://example.com/buggy" });
    expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it("enables the clicked tab with path+enabled:true and disables other tabs", async () => {
    mockChrome.tabs.query.mockResolvedValueOnce([
      { id: 42, url: "https://example.com" },
      { id: 99, url: "https://iana.org" },
      { id: 7, url: "https://wikipedia.org" },
    ]);

    actionClickHandler({ id: 42, url: "https://example.com" });
    await flushAsync();

    const setOptionsCalls = mockChrome.sidePanel.setOptions.mock.calls.map(
      (c) => c[0],
    );

    // 1. The bound tab gets {tabId, path, enabled: true}. This must
    //    be the FIRST setOptions call — it's fired synchronously
    //    inside the gesture window, before any await.
    expect(setOptionsCalls[0]).toEqual({
      tabId: 42,
      path: "src/sidepanel/index.html",
      enabled: true,
    });

    // 2. Other tabs get {tabId, enabled: false} — no path, because
    //    we're disabling them, not reconfiguring. (Fresh per-tab
    //    entries with a path hit Chrome's "different instance" trap
    //    from issue #987.)
    const disableCalls = setOptionsCalls
      .slice(1)
      .filter(
        (c) =>
          typeof (c as { tabId?: number }).tabId === "number" &&
          (c as { enabled?: boolean }).enabled === false,
      );
    const disabledTabIds = disableCalls.map(
      (c) => (c as { tabId: number }).tabId,
    );
    expect(disabledTabIds).toEqual(expect.arrayContaining([99, 7]));
    expect(disabledTabIds).not.toContain(42);
    for (const call of disableCalls) {
      expect((call as { path?: string }).path).toBeUndefined();
    }

    // 3. The GLOBAL default is NEVER disabled — that would close
    //    the already-open panel on the bound tab.
    const globalDisables = setOptionsCalls.filter(
      (c) =>
        !("tabId" in (c as object)) &&
        (c as { enabled?: boolean }).enabled === false,
    );
    expect(globalDisables).toHaveLength(0);
  });

  it("re-enables a previously scoped-away tab with path on rebind", async () => {
    // First bind: tab 42 is the bound one, tabs 99 and 7 get scoped away.
    mockChrome.tabs.query.mockResolvedValueOnce([
      { id: 42 },
      { id: 99 },
      { id: 7 },
    ]);
    actionClickHandler({ id: 42 });
    await flushAsync();
    mockChrome.sidePanel.setOptions.mockClear();

    // Rebind: user clicks action on tab 99. 99 was scoped away, so
    // it must be re-enabled WITH path (modifying the existing
    // disabled entry — safe because it's not a fresh entry).
    mockChrome.tabs.query.mockResolvedValueOnce([
      { id: 42 },
      { id: 99 },
      { id: 7 },
    ]);
    actionClickHandler({ id: 99 });
    await flushAsync();

    const setOptionsCalls = mockChrome.sidePanel.setOptions.mock.calls.map(
      (c) => c[0],
    );
    // First call must be the unscoping of 99 (with path).
    expect(setOptionsCalls[0]).toEqual({
      tabId: 99,
      path: "src/sidepanel/index.html",
      enabled: true,
    });
    // Subsequent calls scope other tabs (42 and 7) away — no path,
    // enabled:false.
    const disables = setOptionsCalls.slice(1);
    const disabledTabIds = disables
      .map((c) => (c as { tabId?: number }).tabId)
      .filter((x) => x != null);
    expect(disabledTabIds).toEqual(expect.arrayContaining([42, 7]));
    expect(disabledTabIds).not.toContain(99);
  });

  it("routes action clicks back to the recording tab while a session is active", async () => {
    // Bind + start a session on tab 42.
    mockChrome.tabs.query.mockResolvedValue([{ id: 42 }, { id: 99 }]);
    actionClickHandler({ id: 42 });
    await flushAsync();
    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
    mockChrome.sidePanel.open.mockClear();
    mockChrome.tabs.update.mockClear();

    // User clicks the action icon from a DIFFERENT tab (99).
    actionClickHandler({ id: 99 });
    await flushAsync();

    // Panel must be opened on the RECORDING tab (42), not 99.
    expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    // Chrome must be asked to foreground the recording tab.
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
  });

  it("does NOT touch sidePanel.setOptions on START_SESSION", async () => {
    mockChrome.tabs.query.mockResolvedValue([{ id: 42 }]);
    actionClickHandler({ id: 42 });
    await flushAsync();
    mockChrome.sidePanel.setOptions.mockClear();

    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });

    // START_SESSION is capture-only in the bind-on-open model.
    expect(mockChrome.sidePanel.setOptions).not.toHaveBeenCalled();
  });

  it("does NOT touch sidePanel.setOptions on STOP_SESSION", async () => {
    mockChrome.tabs.query.mockResolvedValue([{ id: 42 }]);
    actionClickHandler({ id: 42 });
    await flushAsync();
    await dispatch(messageHandler, {
      type: "START_SESSION",
      tabId: 42,
      url: "https://example.com/buggy",
      viewport: { width: 1280, height: 800 },
      piiMode: "full",
    });
    mockChrome.sidePanel.setOptions.mockClear();

    await dispatch(
      messageHandler,
      { type: "STOP_SESSION" },
      { tab: { id: 42 } },
    );

    // Panel stays bound after STOP — idle UI, new session, etc.
    expect(mockChrome.sidePanel.setOptions).not.toHaveBeenCalled();
  });

  it("does not touch sidePanel.setOptions when the bound tab is closed", async () => {
    mockChrome.tabs.query.mockResolvedValue([{ id: 42 }]);
    actionClickHandler({ id: 42 });
    await flushAsync();
    mockChrome.sidePanel.setOptions.mockClear();

    await tabRemovedHandler(42, { windowId: 1, isWindowClosing: false });

    // Chrome auto-cleans the per-tab entries for a removed tab, so
    // there is nothing to restore. We just drop our bookkeeping.
    expect(mockChrome.sidePanel.setOptions).not.toHaveBeenCalled();
  });

  it("disables the side panel on newly-created tabs while a binding is active", async () => {
    mockChrome.tabs.query.mockResolvedValue([{ id: 42 }]);
    actionClickHandler({ id: 42 });
    await flushAsync();
    mockChrome.sidePanel.setOptions.mockClear();

    // Simulate Chrome firing onCreated for a brand new tab.
    tabCreatedHandler({ id: 200 });
    await flushAsync();

    expect(mockChrome.sidePanel.setOptions).toHaveBeenCalledWith({
      tabId: 200,
      enabled: false,
    });
  });

  it("ignores onCreated events for tabs with no id", () => {
    mockChrome.sidePanel.setOptions.mockClear();
    tabCreatedHandler({});
    expect(mockChrome.sidePanel.setOptions).not.toHaveBeenCalled();
  });

  it("ignores onCreated events when no binding is active", () => {
    mockChrome.sidePanel.setOptions.mockClear();
    tabCreatedHandler({ id: 500 });
    expect(mockChrome.sidePanel.setOptions).not.toHaveBeenCalled();
  });

  it("does not crash if sidePanel.setOptions rejects (catch attached)", async () => {
    mockChrome.tabs.query.mockResolvedValue([{ id: 42 }, { id: 99 }]);
    mockChrome.sidePanel.setOptions.mockRejectedValue(
      new Error("transient"),
    );
    actionClickHandler({ id: 42 });
    await flushAsync();
    // open() is still attempted on the target tab, synchronously.
    expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it("does not crash if sidePanel.open rejects (catch attached)", async () => {
    mockChrome.sidePanel.open.mockRejectedValue(new Error("no gesture"));
    actionClickHandler({ id: 42 });
    await flushAsync();
    expect(mockChrome.sidePanel.open).toHaveBeenCalled();
  });
});
