// Pure module: maps a TimelineEvent to a SidePanelEventRow view-model
// the side panel glue layer can render. No DOM, no Chrome APIs.
//
// PRIVACY-CRITICAL: screenshot rows carry the data URL as a string
// field on the view-model — they never embed it in HTML. The glue
// layer renders a placeholder by default and only swaps in
// `<img src=dataUrl>` on explicit user reveal. See selected-plan.md
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

export function eventTypeLabel(event: TimelineEvent): string {
  switch (event.type) {
    case "interaction":
      switch (event.subtype) {
        case "click":
          return "Click";
        case "input":
          return "Input";
        case "scroll":
          return "Scroll";
        case "navigation":
          return "Navigate";
      }
      return "Interaction";
    case "viewport_resize":
      return "Viewport resize";
    case "network_error":
      return "Network error";
    case "console_error":
      return event.level === "warning" ? "Console warning" : "Console error";
    case "js_exception":
      return "JS exception";
    case "annotation":
      return "Annotation";
    case "screenshot":
      return "Screenshot";
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function eventDetail(event: TimelineEvent): string {
  switch (event.type) {
    case "interaction":
      if (event.subtype === "navigation") {
        return event.to_url ?? event.page_url;
      }
      if (event.subtype === "input") {
        if (event.value_metadata) {
          const m = event.value_metadata;
          return `${m.length} chars (${m.word_count} words)`;
        }
        return event.element?.selector ?? "";
      }
      if (event.subtype === "click") {
        const sel = event.element?.selector;
        return sel ?? "";
      }
      if (event.subtype === "scroll" && event.scroll_position) {
        return `(${event.scroll_position.x}, ${event.scroll_position.y})`;
      }
      return "";
    case "viewport_resize":
      return `${event.from.width}×${event.from.height} → ${event.to.width}×${event.to.height}`;
    case "network_error":
      return `${event.method} ${event.url} (${event.status})`;
    case "console_error":
      return event.message;
    case "js_exception":
      return event.message;
    case "annotation":
      return event.text;
    case "screenshot":
      return event.trigger;
  }
}

function eventAccent(event: TimelineEvent): RowAccent {
  switch (event.type) {
    case "interaction":
      return "neutral";
    case "viewport_resize":
      return "info";
    case "network_error":
      return "danger";
    case "console_error":
      return event.level === "warning" ? "warning" : "danger";
    case "js_exception":
      return "danger";
    case "annotation":
      return "annotation";
    case "screenshot":
      return "screenshot";
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function resolveScreenshot(
  event: TimelineEvent,
  screenshots: Record<string, string>,
): { id: string | null; dataUrl: string | null } {
  if (event.type === "screenshot") {
    const dataUrl = screenshots[event.id];
    return { id: event.id, dataUrl: dataUrl ?? null };
  }
  if (event.type === "annotation") {
    if (!event.screenshot_id) return { id: null, dataUrl: null };
    const dataUrl = screenshots[event.screenshot_id];
    return { id: event.screenshot_id, dataUrl: dataUrl ?? null };
  }
  return { id: null, dataUrl: null };
}

export function eventToRow(
  event: TimelineEvent,
  screenshots: Record<string, string>,
): SidePanelEventRow {
  const screenshot = resolveScreenshot(event, screenshots);
  return {
    id: `row-${event.seq}`,
    iso: event.timestamp,
    label: eventTypeLabel(event),
    detail: eventDetail(event),
    accent: eventAccent(event),
    screenshotPlaceholderId: screenshot.id,
    screenshotDataUrl: screenshot.dataUrl,
  };
}

/**
 * Format an ISO timestamp as HH:MM:SS in UTC for determinism. The
 * `now` parameter is currently unused but kept in the signature so
 * future "today vs older" formatting can branch on it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function formatEventTimestamp(iso: string, _now?: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * Compile-time exhaustiveness guard. Mirrors
 * `assertExhaustiveEventTypes` in `agents-doc.ts`. Adding a new
 * `TimelineEvent` variant must fail `make typecheck` until both
 * `eventToRow` and this function handle it.
 *
 * Not called at runtime; existence is what matters.
 */
export function assertExhaustiveSidePanelEvent(e: TimelineEvent): void {
  switch (e.type) {
    case "interaction":
    case "viewport_resize":
    case "network_error":
    case "console_error":
    case "js_exception":
    case "annotation":
    case "screenshot":
      return;
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

/**
 * Decide whether to auto-scroll the events list to the bottom after a
 * new row is appended. Auto-scroll is sticky: if the user scrolled up
 * away from the bottom, don't yank them back.
 */
export function shouldAutoScroll(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  // If everything fits, always "auto-scroll" (no-op).
  if (scrollHeight <= clientHeight) return true;
  const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
  // Within 32px of the bottom counts as "at the bottom".
  return distanceFromBottom <= 32;
}
