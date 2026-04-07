// Acceptance test for feature #8 — Test Level Matrix row #2.
//
// Pins that the service worker calls
// chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }) at
// top-level (not just inside onInstalled), so the side panel opens
// directly when the user clicks the toolbar action — including after
// the SW has been terminated and respawned.
//
// We import the service worker module dynamically with a stub global
// `chrome` already in place, then assert the mock was called.

import { describe, it, expect, beforeEach, vi } from "vitest";

interface MockChrome {
  sidePanel: { setPanelBehavior: ReturnType<typeof vi.fn> };
  runtime: {
    onMessage: { addListener: ReturnType<typeof vi.fn> };
    onInstalled: { addListener: ReturnType<typeof vi.fn> };
  };
  action: {
    setBadgeText: ReturnType<typeof vi.fn>;
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  };
  commands: { onCommand: { addListener: ReturnType<typeof vi.fn> } };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    onRemoved: { addListener: ReturnType<typeof vi.fn> };
    get: ReturnType<typeof vi.fn>;
  };
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
  scripting: { executeScript: ReturnType<typeof vi.fn> };
}

function installFakeChrome(): MockChrome {
  const fake: MockChrome = {
    sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    runtime: {
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    commands: { onCommand: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onRemoved: { addListener: vi.fn() },
      get: vi.fn().mockResolvedValue({ id: 1, url: "" }),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue(undefined) },
  };
  // @ts-expect-error — install fake on globalThis.
  globalThis.chrome = fake;
  // @ts-expect-error — minimum navigator stub.
  if (!globalThis.navigator) globalThis.navigator = { userAgent: "test" };
  return fake;
}

describe("service worker setPanelBehavior (matrix #2)", () => {
  let mockChrome: MockChrome;

  beforeEach(async () => {
    vi.resetModules();
    mockChrome = installFakeChrome();
  });

  it("calls chrome.sidePanel.setPanelBehavior with openPanelOnActionClick:true on module init", async () => {
    await import("../src/background/service-worker");
    // Allow microtasks (top-level await chains) to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockChrome.sidePanel.setPanelBehavior).toHaveBeenCalled();
    const args = mockChrome.sidePanel.setPanelBehavior.mock.calls[0]?.[0];
    expect(args).toEqual({ openPanelOnActionClick: true });
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
