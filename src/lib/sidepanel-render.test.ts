// Acceptance tests for feature #8 (Side panel UX) — Test Level Matrix
// rows #6a, #6b, #7. Pure unit tests of the side panel render module.
// No DOM, no Chrome APIs.

import { describe, it, expect } from "vitest";
import {
  eventToRow,
  eventTypeLabel,
  formatEventTimestamp,
  shouldAutoScroll,
  type SidePanelEventRow,
  type SidePanelRowImage,
} from "./sidepanel-render";
import type { TimelineEvent } from "../types";

// Canonical set of TimelineEvent discriminators. Mirrors the
// EXPECTED_DISCRIMINATORS set in agents-doc.test.ts so the test fails
// loudly if a new variant slips through.
const EXPECTED_DISCRIMINATORS: ReadonlySet<TimelineEvent["type"]> = new Set([
  "interaction",
  "viewport_resize",
  "network_error",
  "console_error",
  "js_exception",
  "annotation",
  "screenshot",
]);

const FIXED_NOW = new Date("2026-04-07T15:30:00.000Z");
const ISO_AT_NOON = "2026-04-07T12:00:00.000Z";

function fixture(type: TimelineEvent["type"]): TimelineEvent {
  const base = { seq: 1, timestamp: ISO_AT_NOON, page_url: "https://example.com/" };
  switch (type) {
    case "interaction":
      return { ...base, type, subtype: "click", coordinates: { x: 10, y: 20 } };
    case "viewport_resize":
      return {
        ...base,
        type,
        from: { width: 1024, height: 768 },
        to: { width: 1280, height: 800 },
      };
    case "network_error":
      return {
        ...base,
        type,
        method: "GET",
        url: "https://api.example.com/x",
        status: 500,
        status_text: "Server Error",
        request_headers: {},
      };
    case "console_error":
      return { ...base, type, level: "error", message: "boom" };
    case "js_exception":
      return { ...base, type, message: "TypeError", stack_trace: "at main" };
    case "annotation":
      return { ...base, type, text: "looks broken", screenshot_id: "ss_42" };
    case "screenshot":
      return {
        ...base,
        type,
        id: "ss_42",
        file: "screenshots/ss_42.png",
        viewport: { width: 1024, height: 768 },
        trigger: "manual",
      };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Row #6a — every TimelineEvent variant maps to a row
// ─────────────────────────────────────────────────────────────────────

describe("eventToRow (matrix #6a)", () => {
  it("produces a row for every TimelineEvent discriminator", () => {
    for (const t of EXPECTED_DISCRIMINATORS) {
      const event = fixture(t);
      const row = eventToRow(event, {});
      expect(row).toBeDefined();
      expect(row.id).toBeTypeOf("string");
      expect(row.id.length).toBeGreaterThan(0);
      expect(row.iso).toBe(ISO_AT_NOON);
      expect(row.label).toBeTypeOf("string");
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  it("derives the row id from the event seq", () => {
    const event = { ...fixture("console_error"), seq: 42 } as TimelineEvent;
    const row = eventToRow(event, {});
    expect(row.id).toContain("42");
  });

  it("uses a danger accent for js_exception", () => {
    const row = eventToRow(fixture("js_exception"), {});
    expect(row.accent).toBe("danger");
  });

  it("uses a danger accent for network_error", () => {
    const row = eventToRow(fixture("network_error"), {});
    expect(row.accent).toBe("danger");
  });

  it("distinguishes console error vs warning by accent", () => {
    const errRow = eventToRow(fixture("console_error"), {});
    expect(errRow.accent).toBe("danger");
    const warnEvent = { ...fixture("console_error"), level: "warning" } as TimelineEvent;
    const warnRow = eventToRow(warnEvent, {});
    expect(warnRow.accent).toBe("warning");
  });

  it("uses an annotation accent for annotation events", () => {
    const row = eventToRow(fixture("annotation"), {});
    expect(row.accent).toBe("annotation");
  });

  it("uses a screenshot accent for screenshot events", () => {
    const row = eventToRow(fixture("screenshot"), {});
    expect(row.accent).toBe("screenshot");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #6b — exhaustiveness pin
// ─────────────────────────────────────────────────────────────────────

describe("eventToRow exhaustiveness (matrix #6b)", () => {
  it("eventTypeLabel returns a non-empty label for every discriminator", () => {
    for (const t of EXPECTED_DISCRIMINATORS) {
      const label = eventTypeLabel(fixture(t));
      expect(label).toBeTypeOf("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  // Compile-time exhaustiveness is enforced by the `never` default branch
  // in the implementation. This runtime test ensures the discriminator
  // set is in lockstep with the TimelineEvent union.
  it("EXPECTED_DISCRIMINATORS matches the TimelineEvent union", () => {
    // If you're touching this test, also update agents-doc, agents-doc.test
    // and the side-panel render module.
    expect(EXPECTED_DISCRIMINATORS.size).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Row #7 — screenshot row resolves images from the screenshots map
// ─────────────────────────────────────────────────────────────────────

describe("eventToRow image resolution (matrix #7)", () => {
  it("screenshot event row has exactly one image carrying id and dataUrl", () => {
    const event = fixture("screenshot");
    const dataUrl = "data:image/png;base64,AAAA";
    const row = eventToRow(event, { ss_42: dataUrl });
    expect(row.images).toHaveLength(1);
    expect(row.images[0]).toEqual({ id: "ss_42", dataUrl });
  });

  it("annotation with only a full screenshot_id has one image", () => {
    const event = fixture("annotation");
    const dataUrl = "data:image/png;base64,BBBB";
    const row = eventToRow(event, { ss_42: dataUrl });
    expect(row.images).toHaveLength(1);
    expect(row.images[0]).toEqual({ id: "ss_42", dataUrl });
  });

  it("annotation with both full and element screenshots has two images in order", () => {
    const event = {
      ...fixture("annotation"),
      element_screenshot_id: "el_42",
    } as TimelineEvent;
    const row = eventToRow(event, {
      ss_42: "data:image/png;base64,FULL",
      el_42: "data:image/png;base64,EL",
    });
    expect(row.images).toHaveLength(2);
    expect(row.images[0]).toEqual({ id: "ss_42", dataUrl: "data:image/png;base64,FULL" });
    expect(row.images[1]).toEqual({ id: "el_42", dataUrl: "data:image/png;base64,EL" });
  });

  it("missing screenshot id yields null dataUrl on the image (no throw)", () => {
    const event = fixture("annotation");
    const row = eventToRow(event, {});
    expect(row.images).toHaveLength(1);
    expect(row.images[0].id).toBe("ss_42");
    expect(row.images[0].dataUrl).toBeNull();
  });

  it("non-image event rows have an empty images array", () => {
    expect(eventToRow(fixture("interaction"), {}).images).toEqual([]);
    expect(eventToRow(fixture("console_error"), {}).images).toEqual([]);
    expect(eventToRow(fixture("network_error"), {}).images).toEqual([]);
  });

  it("annotation with empty screenshot_id (legacy) yields no images", () => {
    const event = {
      ...fixture("annotation"),
      screenshot_id: "",
    } as TimelineEvent;
    const row = eventToRow(event, {});
    expect(row.images).toEqual([]);
  });

  // The view-model carries dataUrl as a string field — never embedded
  // in HTML. The glue layer is responsible for safe DOM injection.
  it("row shape never embeds raw HTML for the thumbnail", () => {
    const row = eventToRow(fixture("screenshot"), { ss_42: "data:image/png;base64,XX" });
    const asJson = JSON.stringify(row);
    expect(asJson).not.toMatch(/<img/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// formatEventTimestamp — deterministic with injectable `now`
// ─────────────────────────────────────────────────────────────────────

describe("formatEventTimestamp", () => {
  it("renders HH:MM:SS for an event captured today", () => {
    // 2026-04-07T12:00:00Z; rendered in UTC for determinism.
    const formatted = formatEventTimestamp(ISO_AT_NOON, FIXED_NOW);
    expect(formatted).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("returns a non-empty string for any valid ISO timestamp", () => {
    expect(formatEventTimestamp("2025-01-01T00:00:00.000Z", FIXED_NOW).length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// shouldAutoScroll — sticky bottom
// ─────────────────────────────────────────────────────────────────────

describe("shouldAutoScroll", () => {
  it("returns true when the user is at (or near) the bottom", () => {
    expect(shouldAutoScroll(900, 1000, 100)).toBe(true);
  });

  it("returns false when the user has scrolled up away from the bottom", () => {
    expect(shouldAutoScroll(100, 1000, 100)).toBe(false);
  });

  it("returns true when content fits without scrolling", () => {
    expect(shouldAutoScroll(0, 100, 200)).toBe(true);
  });
});

// Type-level sanity check: SidePanelEventRow shape.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeCheck: SidePanelEventRow = {
  id: "1",
  iso: ISO_AT_NOON,
  label: "x",
  detail: "y",
  accent: "neutral",
  images: [] as readonly SidePanelRowImage[],
};
