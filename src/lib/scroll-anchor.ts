// Pure scroll-anchoring helper for the side panel event list. Wraps
// the existing `shouldAutoScroll` primitive in a stateful helper that
// tracks:
//   - whether the user is currently "pinned to the bottom" (the sticky
//     state that feature #8 introduced)
//   - how many events have been appended since the user scrolled away
//     from the bottom (the number shown on the "new events" chip)
//
// The panel glue layer calls the three event methods in response to
// real DOM events and scroll-handler callbacks; this module owns the
// decision logic so it can be unit-tested without jsdom.
//
// Semantics:
//   onUserScroll(measurements) — user scrolled the list. If they are
//     back at the bottom, pending is reset to 0 and pinned becomes
//     true. If they scrolled away, pinned becomes false and the
//     pending counter is preserved.
//
//   onAppend() — a new event was appended to the list. If pinned, the
//     caller should scroll to the bottom (decideScrollAction returns
//     "scroll-to-bottom"). If not pinned, the pending counter
//     increments.
//
//   onJumpToBottom() — user clicked the chip. Pending resets to 0 and
//     pinned becomes true.
//
//   chipCount() — the number to show on the chip (0 means hide).

import { shouldAutoScroll } from "./sidepanel-render";

export interface ScrollMeasurements {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type ScrollDecision = "scroll-to-bottom" | "show-chip" | "noop";

export class ScrollAnchor {
  private pinned = true;
  private pending = 0;

  /** Feed a scroll event. Updates pinned + pending. */
  onUserScroll(m: ScrollMeasurements): void {
    if (shouldAutoScroll(m.scrollTop, m.scrollHeight, m.clientHeight)) {
      this.pinned = true;
      this.pending = 0;
    } else {
      this.pinned = false;
    }
  }

  /**
   * Feed an append. Returns the caller's next action:
   *   "scroll-to-bottom" — user is pinned, scroll them with the new content
   *   "show-chip"        — user is not pinned; increment and show chip
   */
  onAppend(): ScrollDecision {
    if (this.pinned) {
      return "scroll-to-bottom";
    }
    this.pending += 1;
    return "show-chip";
  }

  /** User clicked the "N new events" chip. Snap back to bottom. */
  onJumpToBottom(): void {
    this.pending = 0;
    this.pinned = true;
  }

  /** Number shown on the chip. 0 means the chip should not render. */
  chipCount(): number {
    return this.pending;
  }

  isPinned(): boolean {
    return this.pinned;
  }

  /** Reset to initial state — useful when the events list is replaced wholesale. */
  reset(): void {
    this.pinned = true;
    this.pending = 0;
  }
}
