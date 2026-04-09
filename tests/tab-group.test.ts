// Acceptance tests for feature #9 — Automatic tab group for active DeskCheck tabs.
//
// Pins the behaviour of the pure helper module `src/lib/tab-group.ts`:
//
//   - assignTabToDeskCheckGroup(tabId, windowId, api?)
//   - removeTabFromDeskCheckGroup(tabId, api?)
//
// Both helpers are best-effort: they MUST NOT throw, they MUST feature-
// detect the chrome.tabGroups API via `api.isAvailable()`, and they MUST
// swallow every rejection from the injected API so a flaky Chrome cannot
// break the recording lifecycle.
//
// Tests run against a hand-rolled TabGroupApi stub — no real chrome.tabs
// or chrome.tabGroups calls.

import { describe, it, expect, vi } from "vitest";
import {
  assignTabToDeskCheckGroup,
  removeTabFromDeskCheckGroup,
  DESKCHECK_GROUP_TITLE,
  DESKCHECK_GROUP_COLOR,
  type TabGroupApi,
} from "../src/lib/tab-group";

type Fn = ReturnType<typeof vi.fn>;

interface StubApi extends TabGroupApi {
  isAvailable: Fn;
  groupTabs: Fn;
  queryGroups: Fn;
  updateGroup: Fn;
  ungroupTabs: Fn;
}

function makeStubApi(overrides: Partial<StubApi> = {}): StubApi {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    groupTabs: vi.fn().mockResolvedValue(1234),
    queryGroups: vi.fn().mockResolvedValue([]),
    updateGroup: vi.fn().mockResolvedValue(undefined),
    ungroupTabs: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as StubApi;
}

describe("tab-group: constants (matrix #3, #4)", () => {
  it("exports the distinctive title 'DeskCheck'", () => {
    expect(DESKCHECK_GROUP_TITLE).toBe("DeskCheck");
  });

  it("exports a distinctive color from Chrome's allowed set", () => {
    // chrome.tabGroups.ColorEnum allows: grey, blue, red, yellow, green,
    // pink, purple, cyan, orange. Any of these is fine for the test —
    // we just assert we picked a valid one. "blue" is the plan's choice
    // (differentiates from the red REC badge).
    expect([
      "grey",
      "blue",
      "red",
      "yellow",
      "green",
      "pink",
      "purple",
      "cyan",
      "orange",
    ]).toContain(DESKCHECK_GROUP_COLOR);
    expect(DESKCHECK_GROUP_COLOR).toBe("blue");
  });
});

describe("assignTabToDeskCheckGroup (matrix #2, #3, #4, #8)", () => {
  it("is a no-op when the chrome.tabGroups API is unavailable", async () => {
    const api = makeStubApi({
      isAvailable: vi.fn().mockReturnValue(false),
    });
    const result = await assignTabToDeskCheckGroup(42, 7, api);
    expect(result).toBeNull();
    expect(api.groupTabs).not.toHaveBeenCalled();
    expect(api.queryGroups).not.toHaveBeenCalled();
    expect(api.updateGroup).not.toHaveBeenCalled();
  });

  it("creates a new group with the DeskCheck title+color when none exists in the window", async () => {
    const api = makeStubApi({
      queryGroups: vi.fn().mockResolvedValue([]),
      groupTabs: vi.fn().mockResolvedValue(999),
    });
    const result = await assignTabToDeskCheckGroup(42, 7, api);

    expect(api.queryGroups).toHaveBeenCalledWith({
      windowId: 7,
      title: "DeskCheck",
    });
    expect(api.groupTabs).toHaveBeenCalledWith({
      tabIds: 42,
      createProperties: { windowId: 7 },
    });
    expect(api.updateGroup).toHaveBeenCalledWith(999, {
      title: "DeskCheck",
      color: "blue",
    });
    expect(result).toBe(999);
  });

  it("reuses an existing DeskCheck group in the same window without re-titling or re-coloring", async () => {
    const api = makeStubApi({
      queryGroups: vi.fn().mockResolvedValue([
        { id: 555, windowId: 7, title: "DeskCheck", color: "blue" },
      ]),
    });
    const result = await assignTabToDeskCheckGroup(42, 7, api);

    expect(api.groupTabs).toHaveBeenCalledWith({
      tabIds: 42,
      groupId: 555,
    });
    // Crucial: no createProperties, no updateGroup round-trip for reuse.
    const groupTabsArg = (api.groupTabs.mock.calls[0]?.[0] ?? {}) as Record<
      string,
      unknown
    >;
    expect(groupTabsArg.createProperties).toBeUndefined();
    expect(api.updateGroup).not.toHaveBeenCalled();
    expect(result).toBe(555);
  });

  it("resolves to null and does not throw when queryGroups rejects", async () => {
    const api = makeStubApi({
      queryGroups: vi.fn().mockRejectedValue(new Error("query boom")),
    });
    await expect(
      assignTabToDeskCheckGroup(42, 7, api),
    ).resolves.toBeNull();
    expect(api.groupTabs).not.toHaveBeenCalled();
  });

  it("resolves to null and does not throw when groupTabs rejects", async () => {
    const api = makeStubApi({
      groupTabs: vi.fn().mockRejectedValue(new Error("group boom")),
    });
    await expect(
      assignTabToDeskCheckGroup(42, 7, api),
    ).resolves.toBeNull();
    expect(api.updateGroup).not.toHaveBeenCalled();
  });

  it("resolves to null and does not throw when updateGroup rejects after a successful create", async () => {
    const api = makeStubApi({
      groupTabs: vi.fn().mockResolvedValue(999),
      updateGroup: vi.fn().mockRejectedValue(new Error("update boom")),
    });
    await expect(
      assignTabToDeskCheckGroup(42, 7, api),
    ).resolves.toBeNull();
  });

  it("resolves to null when the windowId is invalid", async () => {
    const api = makeStubApi();
    // Chrome's WINDOW_ID_NONE is -1; -1/undefined windowId cannot host
    // a group, so the helper should short-circuit.
    const result = await assignTabToDeskCheckGroup(42, -1, api);
    expect(result).toBeNull();
    expect(api.queryGroups).not.toHaveBeenCalled();
    expect(api.groupTabs).not.toHaveBeenCalled();
  });
});

describe("removeTabFromDeskCheckGroup (matrix #5, #7, #8)", () => {
  it("calls ungroupTabs with the tabId exactly once on the happy path", async () => {
    const api = makeStubApi();
    await removeTabFromDeskCheckGroup(42, api);
    expect(api.ungroupTabs).toHaveBeenCalledTimes(1);
    expect(api.ungroupTabs).toHaveBeenCalledWith(42);
  });

  it("is a no-op when the chrome.tabGroups API is unavailable", async () => {
    const api = makeStubApi({
      isAvailable: vi.fn().mockReturnValue(false),
    });
    await removeTabFromDeskCheckGroup(42, api);
    expect(api.ungroupTabs).not.toHaveBeenCalled();
  });

  it("resolves and does not throw when ungroupTabs rejects", async () => {
    const api = makeStubApi({
      ungroupTabs: vi.fn().mockRejectedValue(new Error("ungroup boom")),
    });
    await expect(
      removeTabFromDeskCheckGroup(42, api),
    ).resolves.toBeUndefined();
  });

  it("swallows a 'tab not found' rejection (tab already closed)", async () => {
    // A common race: by the time STOP_SESSION fires, the recorded tab
    // has already been closed by the user. chrome.tabs.ungroup rejects
    // with "No tab with id" — we must not propagate.
    const api = makeStubApi({
      ungroupTabs: vi
        .fn()
        .mockRejectedValue(new Error("No tab with id: 42.")),
    });
    await expect(
      removeTabFromDeskCheckGroup(42, api),
    ).resolves.toBeUndefined();
  });
});
