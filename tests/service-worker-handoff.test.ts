// Acceptance tests for feature #14 phase 1 — service worker handoff wiring.
//
// Pins the EXPORT_SESSION branch that selects POST-to-listener vs the
// existing chrome.downloads.download path based on the presence of a
// `deskcheck_handoff` record in chrome.storage.local.
//
// Matrix rows covered here:
//   - D3 — SW POSTs to the listener when the handoff record is present
//   - D6 — SW does NOT call fetch when the handoff record is absent (opt-in pin)
//
// Supporting rows (S10, S11, S12) live in Phase 4 alongside the implementation.
//
// Mirrors the installFakeChrome/dispatch harness used by
// tests/service-worker-tab-group.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  downloads: {
    download: Fn;
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

/**
 * Install a fake `chrome` global keyed by storage.local key. The handoff
 * tests need per-key storage results because the SW reads both
 * `deskcheck_session` (OPFS session index) and `deskcheck_handoff` (the
 * feature-14 config record) from the same API.
 */
function installFakeChrome(initialStorage: Record<string, unknown>): MockChrome {
  const storage: Record<string, unknown> = { ...initialStorage };
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
      get: vi.fn().mockResolvedValue({
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
        get: vi.fn().mockImplementation(async (keys: string | string[] | undefined) => {
          if (typeof keys === "string") {
            return keys in storage ? { [keys]: storage[keys] } : {};
          }
          if (Array.isArray(keys)) {
            const out: Record<string, unknown> = {};
            for (const k of keys) {
              if (k in storage) out[k] = storage[k];
            }
            return out;
          }
          return { ...storage };
        }),
        set: vi.fn().mockImplementation(async (items: Record<string, unknown>) => {
          Object.assign(storage, items);
        }),
        remove: vi.fn().mockImplementation(async (keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete storage[k];
        }),
      },
    },
    downloads: {
      download: vi.fn().mockResolvedValue(123),
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
  const fakeOpfs = createFakeOpfsRoot();
  // @ts-expect-error — minimum navigator.storage stub.
  globalThis.navigator.storage = {
    getDirectory: async () => fakeOpfs.root,
  };
  if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
    // @ts-expect-error — minimum crypto stub.
    globalThis.crypto = { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2) };
  }
  return fake;
}

type MessageHandler = (
  msg: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

function dispatch(
  handler: MessageHandler,
  msg: unknown,
  sender: unknown = {},
): Promise<unknown> {
  return new Promise((resolveDispatch) => {
    handler(msg, sender, resolveDispatch);
  });
}

async function flushAsync() {
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
  mockChrome.sidePanel.setOptions.mockClear();
  mockChrome.sidePanel.open.mockClear();
  mockChrome.tabs.group.mockClear();
  mockChrome.tabs.ungroup.mockClear();
  mockChrome.downloads.download.mockClear();
  return { messageHandler };
}

async function startAndStopSession(messageHandler: MessageHandler) {
  await dispatch(messageHandler, {
    type: "START_SESSION",
    tabId: 42,
    url: "https://example.com/buggy",
    viewport: { width: 1280, height: 800 },
    piiMode: "full",
  });
  await flushAsync();

  const exportResult = await dispatch(messageHandler, {
    type: "EXPORT_SESSION",
  });
  await flushAsync();
  return exportResult;
}

describe("feature-14 phase 1: service worker handoff wiring", () => {
  let mockChrome: MockChrome;
  let messageHandler: MessageHandler;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    // Install the spy; individual tests set the implementation.
    // @ts-expect-error — install spy on globalThis.
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      // @ts-expect-error — restore to undefined
      delete globalThis.fetch;
    }
  });

  // ── D6 — opt-in pin: no handoff record → no fetch, download called ───────

  it("D6 — when deskcheck_handoff is absent, EXPORT_SESSION does not call fetch and downloads as today", async () => {
    vi.resetModules();
    mockChrome = installFakeChrome({}); // empty storage — no handoff record
    const handlers = await loadServiceWorker(mockChrome);
    messageHandler = handlers.messageHandler;

    await startAndStopSession(messageHandler);

    // The load-bearing opt-in assertion: zero network traffic when the
    // config key is absent.
    expect(fetchSpy).not.toHaveBeenCalled();
    // And the existing download path is used exactly once.
    expect(mockChrome.downloads.download).toHaveBeenCalledTimes(1);
    const call = mockChrome.downloads.download.mock.calls[0][0];
    expect(call.url).toMatch(/^data:application\/zip;base64,/);
    expect(call.saveAs).toBe(true);
  });

  // ── D3 — SW POSTs to the listener when handoff is configured ─────────────

  it("D3 — when deskcheck_handoff is set, EXPORT_SESSION POSTs the zip with Authorization: Bearer and Session-Id", async () => {
    vi.resetModules();
    mockChrome = installFakeChrome({
      deskcheck_handoff: {
        listener_url: "http://127.0.0.1:54329",
        token: "0123456789abcdef0123456789abcdef",
        created_at: "2026-04-11T22:00:00.000Z",
      },
    });
    // Happy path: fetch returns 201.
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, path: "/tmp/test.zip" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const handlers = await loadServiceWorker(mockChrome);
    messageHandler = handlers.messageHandler;

    await startAndStopSession(messageHandler);

    // fetch called once with the listener URL and the Authorization header.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    const url = String(call[0]);
    expect(url).toBe("http://127.0.0.1:54329/upload");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer 0123456789abcdef0123456789abcdef");
    expect(headers.get("Content-Type")).toBe("application/zip");
    expect(headers.get("X-DeskCheck-Session-Id")).toBeTruthy();
    // And since the handoff succeeded, chrome.downloads.download is NOT called.
    expect(mockChrome.downloads.download).not.toHaveBeenCalled();
  });
});
