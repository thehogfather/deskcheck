// STUB — Phase 3 (failing acceptance tests). Phase 4 will implement.
//
// Pure module: maps a TimelineEvent to a SidePanelEventRow view-model
// the side panel glue layer can render. No DOM, no Chrome APIs.
//
// PRIVACY-CRITICAL: screenshot rows must NEVER carry the data URL
// directly into the rendered DOM. The row carries a placeholder id and
// the dataUrl as a string field; the glue layer decides whether to
// render <img> based on the user's reveal action. See selected-plan.md
// architectural decision #4.

import type { TimelineEvent } from "../types";

export type RowAccent =
  | "neutral"
  | "danger"
  | "warning"
  | "success"
  | "info"
  | "annotation"
  | "screenshot";

export interface SidePanelEventRow {
  /** Stable row id derived from `seq`. */
  id: string;
  /** ISO timestamp from the source event. */
  iso: string;
  /** Display label, e.g. "Click", "Console error". */
  label: string;
  /** Free-text detail line, may be empty. */
  detail: string;
  /** Visual accent for the row. */
  accent: RowAccent;
  /**
   * Set when the row references a screenshot. The glue layer renders
   * a placeholder by default and only swaps in <img src=dataUrl> on
   * explicit reveal.
   */
  screenshotPlaceholderId: string | null;
  screenshotDataUrl: string | null;
}

export function eventToRow(
  _event: TimelineEvent,
  _screenshots: Record<string, string>,
): SidePanelEventRow {
  throw new Error("sidepanel-render.eventToRow not implemented");
}

export function eventTypeLabel(_event: TimelineEvent): string {
  throw new Error("sidepanel-render.eventTypeLabel not implemented");
}

/**
 * Format an ISO timestamp as HH:MM:SS in the user's locale. Takes an
 * injectable `now` so tests can be deterministic.
 */
export function formatEventTimestamp(_iso: string, _now?: Date): string {
  throw new Error("sidepanel-render.formatEventTimestamp not implemented");
}

/**
 * Compile-time exhaustiveness guard, mirrors agents-doc.assertExhaustiveEventTypes.
 * Adding a new TimelineEvent variant must fail `make typecheck` until
 * `eventToRow` handles it.
 */
export function assertExhaustiveSidePanelEvent(_e: TimelineEvent): void {
  // Implementation must enumerate every discriminator and fall through
  // to a `const _: never = e` branch.
}

/**
 * Decide whether to auto-scroll the events list to the bottom after a
 * new row is appended. Auto-scroll is sticky: if the user scrolled up
 * away from the bottom, don't yank them back.
 */
export function shouldAutoScroll(
  _scrollTop: number,
  _scrollHeight: number,
  _clientHeight: number,
): boolean {
  throw new Error("sidepanel-render.shouldAutoScroll not implemented");
}
