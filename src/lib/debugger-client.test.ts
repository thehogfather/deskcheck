import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isExtensionUrl,
  formatStackTrace,
  sanitizeHeaders,
  DebuggerClient,
} from "./debugger-client";
import type { TimelineEventInput } from "../types";

describe("isExtensionUrl", () => {
  it("returns true for chrome-extension:// URLs", () => {
    expect(
      isExtensionUrl("chrome-extension://abc123/content.js"),
    ).toBe(true);
  });

  it("returns false for https:// URLs", () => {
    expect(isExtensionUrl("https://example.com")).toBe(false);
  });

  it("returns false for http:// URLs", () => {
    expect(isExtensionUrl("http://localhost:3000")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isExtensionUrl(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isExtensionUrl("")).toBe(false);
  });
});

describe("formatStackTrace", () => {
  it("formats call frames as indented stack trace", () => {
    const result = formatStackTrace({
      callFrames: [
        {
          functionName: "handleClick",
          url: "https://example.com/app.js",
          lineNumber: 42,
          columnNumber: 15,
        },
        {
          functionName: "",
          url: "https://example.com/main.js",
          lineNumber: 10,
          columnNumber: 5,
        },
      ],
    });
    expect(result).toBe(
      "  at handleClick (https://example.com/app.js:42:15)\n" +
      "  at (anonymous) (https://example.com/main.js:10:5)",
    );
  });

  it("handles empty call frames", () => {
    expect(formatStackTrace({ callFrames: [] })).toBe("");
  });

  it("uses (anonymous) for unnamed functions", () => {
    const result = formatStackTrace({
      callFrames: [
        { functionName: "", url: "test.js", lineNumber: 1, columnNumber: 0 },
      ],
    });
    expect(result).toContain("(anonymous)");
  });
});

describe("sanitizeHeaders", () => {
  it("strips sensitive headers", () => {
    const headers = {
      "Authorization": "Bearer secret-token",
      "Cookie": "session=abc123",
      "Content-Type": "application/json",
      "X-Api-Key": "key-123",
      "Accept": "text/html",
    };
    const result = sanitizeHeaders(headers);
    expect(result).toEqual({
      "Content-Type": "application/json",
      "Accept": "text/html",
    });
  });

  it("is case-insensitive", () => {
    const headers = {
      "authorization": "Bearer token",
      "COOKIE": "sid=x",
      "set-cookie": "foo=bar",
      "Proxy-Authorization": "Basic abc",
      "x-request-id": "123",
    };
    const result = sanitizeHeaders(headers);
    expect(result).toEqual({ "x-request-id": "123" });
  });

  it("returns empty object for all-sensitive headers", () => {
    const headers = { "Authorization": "Bearer x" };
    expect(sanitizeHeaders(headers)).toEqual({});
  });

  it("passes through non-sensitive headers unchanged", () => {
    const headers = { "Content-Type": "text/plain", "X-Custom": "value" };
    expect(sanitizeHeaders(headers)).toEqual(headers);
  });
});

// ── Feature #7: DebuggerClient.moveTo — opt-in tab switching ──
describe("DebuggerClient.moveTo", () => {
  type Listener = (...args: unknown[]) => void;

  interface FakeDebugger {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    onEvent: { addListener: (l: Listener) => void; removeListener: (l: Listener) => void };
    onDetach: { addListener: (l: Listener) => void; removeListener: (l: Listener) => void };
    _eventListeners: Listener[];
    _detachListeners: Listener[];
  }

  let fakeDebugger: FakeDebugger;

  function installFakeChrome(): void {
    const eventListeners: Listener[] = [];
    const detachListeners: Listener[] = [];
    fakeDebugger = {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
      onEvent: {
        addListener: (l) => eventListeners.push(l),
        removeListener: (l) => {
          const i = eventListeners.indexOf(l);
          if (i >= 0) eventListeners.splice(i, 1);
        },
      },
      onDetach: {
        addListener: (l) => detachListeners.push(l),
        removeListener: (l) => {
          const i = detachListeners.indexOf(l);
          if (i >= 0) detachListeners.splice(i, 1);
        },
      },
      _eventListeners: eventListeners,
      _detachListeners: detachListeners,
    };
    // @ts-expect-error — minimal chrome stub for the debugger surface.
    globalThis.chrome = { debugger: fakeDebugger };
  }

  /** Fire a CDP event to all registered onEvent listeners. */
  function emitCdp(tabId: number, method: string, params: Record<string, unknown>): void {
    for (const l of fakeDebugger._eventListeners) l({ tabId }, method, params);
  }

  /** A Network.responseReceived 500 — the client emits a network_error for it. */
  function networkError(tabId: number): void {
    emitCdp(tabId, "Network.requestWillBeSent", {
      requestId: `r-${tabId}`,
      request: { url: `https://t${tabId}.example.com/x`, method: "GET" },
    });
    emitCdp(tabId, "Network.responseReceived", {
      requestId: `r-${tabId}`,
      response: { status: 500, statusText: "err", url: `https://t${tabId}.example.com/x` },
    });
  }

  beforeEach(() => {
    installFakeChrome();
  });

  afterEach(() => {
    // @ts-expect-error — tear down the stub between tests.
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  it("detaches the old tab, attaches the new tab, and re-enables CDP domains", async () => {
    const client = new DebuggerClient();
    await client.attach(1, "https://t1.example.com", () => {});
    fakeDebugger.attach.mockClear();
    fakeDebugger.detach.mockClear();
    fakeDebugger.sendCommand.mockClear();

    await client.moveTo(2, "https://t2.example.com");

    expect(fakeDebugger.detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(fakeDebugger.attach).toHaveBeenCalledWith({ tabId: 2 }, "1.3");
    const enabled = fakeDebugger.sendCommand.mock.calls.map((c) => c[1]);
    expect(enabled).toEqual(["Network.enable", "Log.enable", "Runtime.enable"]);
  });

  it("routes events from the new tab and drops events from the old tab after a move", async () => {
    const events: TimelineEventInput[] = [];
    const client = new DebuggerClient();
    await client.attach(1, "https://t1.example.com", (e) => events.push(e));

    await client.moveTo(2, "https://t2.example.com");

    networkError(2); // new tab → captured
    networkError(1); // old tab → ignored

    const tabs = events.map((e) => (e.type === "network_error" ? e.url : null));
    expect(tabs).toContain("https://t2.example.com/x");
    expect(tabs).not.toContain("https://t1.example.com/x");
  });

  it("does NOT emit a capture-interrupted warning for its own intentional detach", async () => {
    const events: TimelineEventInput[] = [];
    const client = new DebuggerClient();
    await client.attach(1, "https://t1.example.com", (e) => events.push(e));

    // Simulate Chrome firing onDetach for tab 1 while moveTo is detaching
    // it — moveTo awaits detach(), and our fake resolves synchronously, so
    // fire the detach callback from inside the detach mock.
    fakeDebugger.detach.mockImplementationOnce(async ({ tabId }: { tabId: number }) => {
      for (const l of fakeDebugger._detachListeners) l({ tabId }, "target_closed");
    });

    await client.moveTo(2, "https://t2.example.com");

    const warnings = events.filter(
      (e) => e.type === "console_error" && e.message.includes("capture interrupted"),
    );
    expect(warnings).toHaveLength(0);
  });

  it("propagates a failed attach and leaves no tab attached for clean retry", async () => {
    const client = new DebuggerClient();
    await client.attach(1, "https://t1.example.com", () => {});
    fakeDebugger.attach.mockRejectedValueOnce(new Error("Another debugger is already attached"));

    await expect(client.moveTo(2, "https://t2.example.com")).rejects.toThrow();

    // A subsequent moveTo to a healthy tab must still work (attachedTabId
    // was left null, so no stale detach blocks the retry).
    fakeDebugger.detach.mockClear();
    await client.moveTo(3, "https://t3.example.com");
    expect(fakeDebugger.attach).toHaveBeenLastCalledWith({ tabId: 3 }, "1.3");
    // Nothing to detach — the failed attach left us unattached.
    expect(fakeDebugger.detach).not.toHaveBeenCalled();
  });
});
