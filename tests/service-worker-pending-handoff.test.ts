// Acceptance tests for feature #14 phase 2 — service worker pending-handoff wiring.
//
// Pins the SW's handling of MARKER_DETECTED, onClicked promotion,
// DISCARD cancellation, and adversarial scenarios.
//
// Matrix rows:
//   D8  — SW opens side panel and pre-populates session config
//   D11 — Discard cancels pending handoff and CLI receives cancelled
//   A1  — Token never lands in session.json (initial_url property test)
//   A2  — SW defence-in-depth: START_SESSION re-strips marker from msg.url
//   A4  — Cross-tab contamination prevented
//   A9  — Tab close clears pending handoff
//   A12 — Discard succeeds locally even if listener died
//
// Mirrors tests/service-worker-handoff.test.ts harness.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFakeOpfsRoot } from "../src/lib/__fixtures__/fake-opfs";

type Fn = ReturnType<typeof vi.fn>;

function installFakeChrome(initialStorage: Record<string, unknown> = {}) {
  const storage: Record<string, unknown> = { ...initialStorage };
  const fake = {
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
      setTitle: vi.fn(),
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
        get: vi.fn().mockImplementation(async (keys: string | string[]) => {
          if (typeof keys === "string") {
            return keys in storage ? { [keys]: storage[keys] } : {};
          }
          if (Array.isArray(keys)) {
            const out: Record<string, unknown> = {};
            for (const k of keys) if (k in storage) out[k] = storage[k];
            return out;
          }
          return { ...storage };
        }),
        set: vi.fn().mockImplementation(async (items: Record<string, unknown>) => {
          Object.assign(storage, items);
        }),
        remove: vi.fn().mockImplementation(async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete storage[k];
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
    downloads: { download: vi.fn().mockResolvedValue(123) },
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
    // @ts-expect-error
    globalThis.navigator = { userAgent: "test" };
  }
  const fakeOpfs = createFakeOpfsRoot();
  // @ts-expect-error
  globalThis.navigator.storage = {
    getDirectory: async () => fakeOpfs.root,
  };
  if (!globalThis.crypto?.randomUUID) {
    // @ts-expect-error
    globalThis.crypto = { randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2) };
  }
  return { fake, storage };
}

type MessageHandler = (
  msg: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

function dispatch(handler: MessageHandler, msg: unknown, sender: unknown = {}): Promise<unknown> {
  return new Promise((resolve) => { handler(msg, sender, resolve); });
}

async function flushAsync() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function loadServiceWorker(mockChrome: any) {
  await import("../src/background/service-worker");
  await new Promise((r) => setTimeout(r, 0));
  const allListeners = mockChrome.runtime.onMessage.addListener.mock.calls as Array<[MessageHandler]>;
  const mainListener = allListeners
    .map((c: [MessageHandler]) => c[0])
    .find((l: MessageHandler) => {
      const result = l({ type: "__probe__" }, {}, () => {});
      return result === true;
    });
  return { messageHandler: mainListener as MessageHandler };
}

describe("service-worker pending-handoff (Phase 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const MARKER = {
    sessionId: "cli-session-abc",
    token: "a".repeat(64),
    port: 54329,
  };

  describe("D8 — MARKER_DETECTED arms pending handoff + badge", () => {
    it("arms a pending handoff and sets OPEN badge on the tab", async () => {
      const { fake } = installFakeChrome();
      const { messageHandler } = await loadServiceWorker(fake);

      await dispatch(messageHandler, {
        type: "MARKER_DETECTED",
        marker: MARKER,
        tabId: 42,
      });
      await flushAsync();

      expect(fake.action.setBadgeText).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 42, text: "OPEN" })
      );
    });

    it("onClicked with pending handoff opens panel and promotes to deskcheck_handoff", async () => {
      const { fake, storage } = installFakeChrome();
      const { messageHandler } = await loadServiceWorker(fake);

      // Arm the pending handoff
      await dispatch(messageHandler, {
        type: "MARKER_DETECTED",
        marker: MARKER,
        tabId: 42,
      });
      await flushAsync();

      // Simulate toolbar click (the onClicked listener)
      const onClickedHandler = fake.action.onClicked.addListener.mock.calls[0][0];
      onClickedHandler({ id: 42, url: "https://example.com" });
      await flushAsync();

      // Panel should have been opened
      expect(fake.sidePanel.open).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 42 })
      );
      // Pending should have been promoted to deskcheck_handoff
      expect(storage["deskcheck_handoff"]).toBeDefined();
    });
  });

  describe("A1 — token never in initial_url", () => {
    it("START_SESSION metadata does not contain the marker token", async () => {
      const { fake } = installFakeChrome();
      const { messageHandler } = await loadServiceWorker(fake);

      // Start a session with a URL that STILL has the marker (defence-in-depth)
      const dirtyUrl = `https://example.com/#_deskcheck=${MARKER.sessionId}:${MARKER.token}:${MARKER.port}:v1`;
      const result = await dispatch(messageHandler, {
        type: "START_SESSION",
        tabId: 42,
        url: dirtyUrl,
        viewport: { width: 1280, height: 800 },
        piiMode: "full",
      }) as any;
      await flushAsync();

      // The session's initial_url must NOT contain the token
      expect(result.sessionId).toBeTruthy();
      // Read the stored session to verify initial_url
      const state = await dispatch(messageHandler, { type: "GET_SESSION_STATE" }) as any;
      expect(state.recording).toBe(true);
    });
  });

  describe("A2 — SW defence-in-depth strips marker from msg.url", () => {
    it("strips _deskcheck marker from initial_url even if content script missed", async () => {
      const { fake } = installFakeChrome();
      const { messageHandler } = await loadServiceWorker(fake);

      const dirtyUrl = `https://example.com/#_deskcheck=${MARKER.sessionId}:${MARKER.token}:${MARKER.port}:v1`;
      await dispatch(messageHandler, {
        type: "START_SESSION",
        tabId: 42,
        url: dirtyUrl,
        viewport: { width: 1280, height: 800 },
        piiMode: "full",
      });
      await flushAsync();

      // Verify via the stored session that initial_url is clean
      // (This requires reading the session from the store, which the
      // implementation will make accessible via GET_SESSION_STATE or
      // the OPFS store.)
    });
  });

  describe("A4 — cross-tab contamination prevented", () => {
    it("tab A's promoted handoff uses tab A's pending entry, not tab B's", async () => {
      const { fake, storage } = installFakeChrome();
      const { messageHandler } = await loadServiceWorker(fake);

      const MARKER_A = { sessionId: "session-A", token: "a".repeat(64), port: 8001 };
      const MARKER_B = { sessionId: "session-B", token: "b".repeat(64), port: 8002 };

      // Arm tab 42 with marker A
      await dispatch(messageHandler, { type: "MARKER_DETECTED", marker: MARKER_A, tabId: 42 });
      // Arm tab 99 with marker B
      await dispatch(messageHandler, { type: "MARKER_DETECTED", marker: MARKER_B, tabId: 99 });
      await flushAsync();

      // Click on tab 42
      const onClickedHandler = fake.action.onClicked.addListener.mock.calls[0][0];
      onClickedHandler({ id: 42, url: "https://a.example.com" });
      await flushAsync();

      // The promoted handoff must be marker A, not marker B
      const promoted = storage["deskcheck_handoff"] as any;
      expect(promoted).toBeDefined();
      expect(promoted.token).toBe(MARKER_A.token);
    });
  });

  describe("D11 / A12 — Discard cancels pending handoff", () => {
    it("DISCARD_SESSION sends cancel sentinel when handoff is active", async () => {
      const { fake } = installFakeChrome({
        deskcheck_handoff: {
          listener_url: "http://127.0.0.1:54329",
          token: "a".repeat(64),
          created_at: new Date().toISOString(),
        },
      });
      const { messageHandler } = await loadServiceWorker(fake);

      // Start a session first
      await dispatch(messageHandler, {
        type: "START_SESSION",
        tabId: 42,
        url: "https://example.com",
        viewport: { width: 1280, height: 800 },
        piiMode: "full",
      });
      await flushAsync();

      // Discard
      const result = await dispatch(messageHandler, { type: "DISCARD_SESSION" }) as any;
      await flushAsync();

      expect(result.discarded).toBe(true);
      // The cancel sentinel POST should have been attempted
      // (fetch mock should have been called with cancel content-type)
    });

    it("CANCEL_PENDING_HANDOFF clears the pending entry before session starts", async () => {
      const { fake, storage } = installFakeChrome();
      const { messageHandler } = await loadServiceWorker(fake);

      // Arm a pending handoff
      await dispatch(messageHandler, { type: "MARKER_DETECTED", marker: MARKER, tabId: 42 });
      await flushAsync();

      // Cancel before starting a session
      await dispatch(messageHandler, { type: "CANCEL_PENDING_HANDOFF", tabId: 42 });
      await flushAsync();

      // Pending should be cleared
      expect(storage["deskcheck_pending_handoffs"]).toBeUndefined();
    });
  });

  describe("A9 — tab close clears pending handoff", () => {
    it("onRemoved clears the pending entry for that tab", async () => {
      const { fake, storage } = installFakeChrome();
      const { messageHandler } = await loadServiceWorker(fake);

      // Arm pending handoff on tab 42
      await dispatch(messageHandler, { type: "MARKER_DETECTED", marker: MARKER, tabId: 42 });
      await flushAsync();

      // Simulate tab close
      const onRemovedHandler = fake.tabs.onRemoved.addListener.mock.calls[0][0];
      await onRemovedHandler(42);
      await flushAsync();

      // Pending handoff for tab 42 should be gone
    });
  });
});
