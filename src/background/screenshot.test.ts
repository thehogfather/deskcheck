import { describe, it, expect, beforeEach, vi } from "vitest";
import { canCaptureRecordedTab, takeScreenshot } from "./screenshot";

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

// takeScreenshot has two write side-effects: storing the screenshot in
// the screenshots map, and (by default) appending a timeline event. The
// `emitTimelineEvent: false` option suppresses the timeline event so
// annotation-attached screenshots don't show up twice in the side
// panel feed (once as a standalone screenshot row, then again inline
// on the annotation row). Tests use a stub chrome.* surface.

interface CapturedAppend {
  timestamp: string;
  type: string;
  id?: string;
  trigger?: string;
}

function installFakeChrome() {
  const events: CapturedAppend[] = [];
  const screenshotsMap: Record<string, string> = {};

  const fakeStorage = {
    state: {} as Record<string, unknown>,
    async get(keys: string | string[]) {
      const list = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (k in this.state) out[k] = this.state[k];
      }
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(this.state, items);
    },
    async remove() {},
  };

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
      captureVisibleTab: vi.fn().mockResolvedValue("data:image/png;base64,FAKE"),
    },
    storage: { local: fakeStorage },
  };
  // @ts-expect-error — install fake on globalThis.
  globalThis.chrome = fakeChrome;

  return { fakeChrome, events, screenshotsMap, fakeStorage };
}

describe("takeScreenshot emit-timeline-event option", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("appends a timeline screenshot event by default", async () => {
    const { fakeStorage } = installFakeChrome();
    const result = await takeScreenshot(1, "manual");
    expect(result).not.toBeNull();
    const events = (fakeStorage.state["deskcheck_events"] as { type: string }[]) ?? [];
    const screenshotEvents = events.filter((e) => e.type === "screenshot");
    expect(screenshotEvents).toHaveLength(1);
  });

  it("does not append a timeline event when emitTimelineEvent is false", async () => {
    const { fakeStorage } = installFakeChrome();
    const result = await takeScreenshot(1, "annotation", { emitTimelineEvent: false });
    expect(result).not.toBeNull();
    const events = (fakeStorage.state["deskcheck_events"] as { type: string }[]) ?? [];
    const screenshotEvents = events.filter((e) => e.type === "screenshot");
    expect(screenshotEvents).toHaveLength(0);
  });

  it("still stores the screenshot in the screenshots map when emitTimelineEvent is false", async () => {
    const { fakeStorage } = installFakeChrome();
    const result = await takeScreenshot(1, "annotation", { emitTimelineEvent: false });
    expect(result).not.toBeNull();
    const map = fakeStorage.state["deskcheck_screenshots"] as Record<string, string>;
    expect(map).toBeDefined();
    expect(Object.keys(map)).toContain(result!.id);
    expect(map[result!.id]).toBe("data:image/png;base64,FAKE");
  });
});
