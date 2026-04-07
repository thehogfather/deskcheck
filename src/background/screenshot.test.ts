import { describe, it, expect } from "vitest";
import { canCaptureRecordedTab } from "./screenshot";

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
