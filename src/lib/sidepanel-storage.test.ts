// Acceptance tests for feature #8 — Test Level Matrix row #17.
// Pure unit tests for per-window scroll persistence.

import { describe, it, expect, beforeEach } from "vitest";
import {
  getScrollPosition,
  setScrollPosition,
  STORAGE_SIDE_PANEL_SCROLL_PREFIX,
  type SessionStorageApi,
} from "./sidepanel-storage";

function makeFakeStorage(): SessionStorageApi & { state: Record<string, unknown> } {
  const state: Record<string, unknown> = {};
  return {
    state,
    async get(key: string) {
      return key in state ? { [key]: state[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(state, items);
    },
  };
}

describe("STORAGE_SIDE_PANEL_SCROLL_PREFIX", () => {
  it("is exactly 'deskcheck_sidepanel_scroll_'", () => {
    expect(STORAGE_SIDE_PANEL_SCROLL_PREFIX).toBe("deskcheck_sidepanel_scroll_");
  });
});

describe("getScrollPosition / setScrollPosition (matrix #17)", () => {
  let api: ReturnType<typeof makeFakeStorage>;
  beforeEach(() => {
    api = makeFakeStorage();
  });

  it("round trips a scroll position for one window", async () => {
    await setScrollPosition(1, 420, api);
    const value = await getScrollPosition(1, api);
    expect(value).toBe(420);
  });

  it("returns 0 for a missing key (no error)", async () => {
    const value = await getScrollPosition(99, api);
    expect(value).toBe(0);
  });

  it("isolates scroll positions per window", async () => {
    await setScrollPosition(1, 100, api);
    await setScrollPosition(2, 200, api);
    expect(await getScrollPosition(1, api)).toBe(100);
    expect(await getScrollPosition(2, api)).toBe(200);
  });

  it("rejects WINDOW_ID_NONE (-1) as a no-op", async () => {
    await setScrollPosition(-1, 500, api);
    // No state should have been written.
    const keys = Object.keys(api.state);
    const matched = keys.filter((k) => k.startsWith(STORAGE_SIDE_PANEL_SCROLL_PREFIX));
    expect(matched).toHaveLength(0);
  });

  it("uses the documented key prefix", async () => {
    await setScrollPosition(7, 333, api);
    const matched = Object.keys(api.state).find((k) =>
      k.startsWith(STORAGE_SIDE_PANEL_SCROLL_PREFIX),
    );
    expect(matched).toBe(`${STORAGE_SIDE_PANEL_SCROLL_PREFIX}7`);
  });

  it("clamps negative scroll values to 0", async () => {
    await setScrollPosition(1, -50, api);
    const value = await getScrollPosition(1, api);
    expect(value).toBe(0);
  });
});
