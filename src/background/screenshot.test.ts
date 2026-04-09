import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  canCaptureRecordedTab,
  captureAndPersistScreenshot,
  buildScreenshotEvent,
  dataUrlToPngBytes,
} from "./screenshot";
import { FakeSessionStore } from "../lib/fake-session-store";

// DeskCheck records a single browser tab per session — the one that was
// active when the session started. canCaptureRecordedTab is the gate that
// keeps the screenshot pipeline from leaking content from an unrelated tab
// if the user switches tabs mid-session. The privacy notice makes this
// claim; the test pins the behaviour.

describe("canCaptureRecordedTab", () => {
  it("returns true when the recorded tab is active with a real window id", () => {
    expect(canCaptureRecordedTab({ active: true, windowId: 1 })).toBe(true);
  });

  it("refuses capture when the recorded tab is in the background (user switched tabs)", () => {
    expect(canCaptureRecordedTab({ active: false, windowId: 1 })).toBe(false);
  });

  it("refuses capture when the window id is missing", () => {
    // Real chrome.tabs.Tab objects can have windowId absent in edge cases
    // (e.g., the tab was dropped between get() and capture). Simulate it
    // with a partial object matching the Pick<> parameter shape.
    expect(
      canCaptureRecordedTab({ active: true } as Pick<chrome.tabs.Tab, "active" | "windowId">),
    ).toBe(false);
  });

  it("refuses capture when the window id is the sentinel WINDOW_ID_NONE (-1)", () => {
    expect(canCaptureRecordedTab({ active: true, windowId: -1 })).toBe(false);
  });

  it("refuses capture when the tab is null (tab lookup failed)", () => {
    expect(canCaptureRecordedTab(null)).toBe(false);
  });

  it("refuses capture when the tab is undefined", () => {
    expect(canCaptureRecordedTab(undefined)).toBe(false);
  });
});

// dataUrlToPngBytes is a pure helper. We test it without any chrome
// fakes so it's fast and deterministic.
describe("dataUrlToPngBytes", () => {
  it("decodes a base64 PNG data URL into raw bytes", () => {
    // 'AAEC' is the base64 of bytes 0x00 0x01 0x02
    const out = dataUrlToPngBytes("data:image/png;base64,AAEC");
    expect(Array.from(out)).toEqual([0, 1, 2]);
  });

  it("throws if the input is not a data URL (no comma)", () => {
    expect(() => dataUrlToPngBytes("notadataurl")).toThrow();
  });
});

// captureAndPersistScreenshot is the new feature-5 entry point: it
// captures via chrome.tabs.captureVisibleTab, decodes the data URL once,
// and persists raw PNG bytes to the SessionStore. No timeline event is
// appended — that's the caller's job in the service worker. The tests
// use FakeSessionStore so we don't need OPFS in jsdom.

function installFakeChromeTabs() {
  const fakeChrome = {
    tabs: {
      get: vi.fn().mockResolvedValue({
        id: 1,
        windowId: 100,
        active: true,
        url: "https://example.com/",
        width: 1024,
        height: 768,
      }),
      // 'AAEC' base64 → bytes [0,1,2]. Stable so the test can compare.
      captureVisibleTab: vi.fn().mockResolvedValue("data:image/png;base64,AAEC"),
    },
  };
  // @ts-expect-error — install fake on globalThis.
  globalThis.chrome = fakeChrome;
  return fakeChrome;
}

describe("captureAndPersistScreenshot", () => {
  let store: FakeSessionStore;

  beforeEach(async () => {
    installFakeChromeTabs();
    store = new FakeSessionStore();
    await store.createSession({
      id: "sess-screenshot-test",
      tab_id: 1,
      start_time: "2026-04-07T12:00:00.000Z",
      end_time: null,
      duration_ms: null,
      initial_url: "https://example.com/",
      user_agent: "test",
      viewport: { width: 1024, height: 768 },
      pii_mode: "full",
    });
  });

  it("returns the captured id, dataUrl, and tab metadata on success", async () => {
    const result = await captureAndPersistScreenshot(store, 1);
    expect(result).not.toBeNull();
    expect(result!.id).toMatch(/^ss_/);
    expect(result!.dataUrl).toBe("data:image/png;base64,AAEC");
    expect(result!.tab.id).toBe(1);
  });

  it("persists raw PNG bytes (NOT a base64 string) to the SessionStore", async () => {
    const result = await captureAndPersistScreenshot(store, 1);
    expect(result).not.toBeNull();
    const bytes = await store.readScreenshot(result!.id);
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual([0, 1, 2]);
  });

  it("does NOT append a timeline event — caller is responsible", async () => {
    const before = await store.countEvents();
    await captureAndPersistScreenshot(store, 1);
    const after = await store.countEvents();
    expect(after).toBe(before);
  });

  it("returns null and does not persist anything when the recorded tab is inactive", async () => {
    const fake = installFakeChromeTabs();
    fake.tabs.get.mockResolvedValueOnce({
      id: 1,
      windowId: 100,
      active: false,
      url: "https://example.com/",
      width: 1024,
      height: 768,
    });
    const result = await captureAndPersistScreenshot(store, 1);
    expect(result).toBeNull();
    expect(await store.countScreenshots()).toBe(0);
  });
});

describe("buildScreenshotEvent", () => {
  it("derives the OPFS file path from the captured id", () => {
    const ev = buildScreenshotEvent(
      {
        id: "ss_42",
        dataUrl: "data:image/png;base64,AAEC",
        tab: {
          id: 1,
          windowId: 100,
          active: true,
          url: "https://example.com/",
          width: 1024,
          height: 768,
        } as chrome.tabs.Tab,
      },
      "manual",
    );
    expect(ev.type).toBe("screenshot");
    expect(ev.id).toBe("ss_42");
    expect(ev.file).toBe("screenshots/ss_42.png");
    expect(ev.viewport).toEqual({ width: 1024, height: 768 });
    expect(ev.trigger).toBe("manual");
    expect(ev.page_url).toBe("https://example.com/");
  });
});
