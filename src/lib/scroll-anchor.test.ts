import { describe, it, expect, beforeEach } from "vitest";
import { ScrollAnchor } from "./scroll-anchor";

// Helper: geometry where pinned-to-bottom is true.
const PINNED = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 };
// Helper: geometry where the user has scrolled up (away from bottom).
const SCROLLED_UP = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
// Helper: everything fits (no scrollbar) — also counts as "pinned".
const FITS = { scrollTop: 0, scrollHeight: 50, clientHeight: 100 };

describe("ScrollAnchor initial state", () => {
  it("starts pinned with zero pending", () => {
    const a = new ScrollAnchor();
    expect(a.isPinned()).toBe(true);
    expect(a.chipCount()).toBe(0);
  });
});

describe("ScrollAnchor.onUserScroll", () => {
  let anchor: ScrollAnchor;
  beforeEach(() => {
    anchor = new ScrollAnchor();
  });

  it("stays pinned when user is at the bottom", () => {
    anchor.onUserScroll(PINNED);
    expect(anchor.isPinned()).toBe(true);
  });

  it("becomes unpinned when user scrolls up away from the bottom", () => {
    anchor.onUserScroll(SCROLLED_UP);
    expect(anchor.isPinned()).toBe(false);
  });

  it("re-pinning resets the pending counter", () => {
    anchor.onUserScroll(SCROLLED_UP);
    anchor.onAppend();
    anchor.onAppend();
    expect(anchor.chipCount()).toBe(2);
    anchor.onUserScroll(PINNED);
    expect(anchor.chipCount()).toBe(0);
    expect(anchor.isPinned()).toBe(true);
  });

  it("treats 'everything fits' as pinned", () => {
    anchor.onUserScroll(FITS);
    expect(anchor.isPinned()).toBe(true);
  });
});

describe("ScrollAnchor.onAppend", () => {
  let anchor: ScrollAnchor;
  beforeEach(() => {
    anchor = new ScrollAnchor();
  });

  it("returns scroll-to-bottom when pinned", () => {
    expect(anchor.onAppend()).toBe("scroll-to-bottom");
    expect(anchor.chipCount()).toBe(0);
  });

  it("returns show-chip when not pinned, and increments pending", () => {
    anchor.onUserScroll(SCROLLED_UP);
    expect(anchor.onAppend()).toBe("show-chip");
    expect(anchor.chipCount()).toBe(1);
    expect(anchor.onAppend()).toBe("show-chip");
    expect(anchor.chipCount()).toBe(2);
  });
});

describe("ScrollAnchor.onJumpToBottom", () => {
  it("clears the pending counter and re-pins", () => {
    const anchor = new ScrollAnchor();
    anchor.onUserScroll(SCROLLED_UP);
    anchor.onAppend();
    anchor.onAppend();
    expect(anchor.chipCount()).toBe(2);
    anchor.onJumpToBottom();
    expect(anchor.chipCount()).toBe(0);
    expect(anchor.isPinned()).toBe(true);
  });
});

describe("ScrollAnchor.reset", () => {
  it("returns to initial state", () => {
    const anchor = new ScrollAnchor();
    anchor.onUserScroll(SCROLLED_UP);
    anchor.onAppend();
    anchor.reset();
    expect(anchor.isPinned()).toBe(true);
    expect(anchor.chipCount()).toBe(0);
  });
});

describe("ScrollAnchor — realistic user flow", () => {
  it("user scrolls up, events arrive, user clicks chip to jump back", () => {
    const anchor = new ScrollAnchor();

    // Starting state: pinned at bottom, no pending.
    expect(anchor.isPinned()).toBe(true);

    // Two events arrive while pinned — should scroll.
    expect(anchor.onAppend()).toBe("scroll-to-bottom");
    expect(anchor.onAppend()).toBe("scroll-to-bottom");
    expect(anchor.chipCount()).toBe(0);

    // User scrolls up to inspect an older row.
    anchor.onUserScroll(SCROLLED_UP);
    expect(anchor.isPinned()).toBe(false);

    // Three more events arrive — chip should show 3.
    anchor.onAppend();
    anchor.onAppend();
    anchor.onAppend();
    expect(anchor.chipCount()).toBe(3);

    // User clicks the chip.
    anchor.onJumpToBottom();
    expect(anchor.isPinned()).toBe(true);
    expect(anchor.chipCount()).toBe(0);

    // More events arrive; pinned, so they scroll.
    expect(anchor.onAppend()).toBe("scroll-to-bottom");
  });
});
