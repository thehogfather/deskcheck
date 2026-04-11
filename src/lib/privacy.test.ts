import { describe, it, expect } from "vitest";
import {
  PRIVACY_NOTICE_BULLETS,
  PRIVACY_MD_TEMPLATE,
  shouldShowFirstRunNotice,
} from "./privacy";

// Acceptance tests for feature #2 (sensitive data warnings) — Test Level Matrix
// rows #1–9. These tests pin the *content invariants* of the privacy module so
// that the in-widget banner, the pre-export reminder, and the PRIVACY.md file
// in the export zip all share a single source of truth and cannot drift apart.
// The wording itself is allowed to evolve as long as each topic remains
// represented.

describe("PRIVACY_NOTICE_BULLETS", () => {
  it("mentions visible screen content (matrix #1)", () => {
    const matched = PRIVACY_NOTICE_BULLETS.some((b) => /screen|visible/i.test(b));
    expect(matched).toBe(true);
  });

  it("mentions form inputs (matrix #2)", () => {
    const matched = PRIVACY_NOTICE_BULLETS.some((b) => /form|input/i.test(b));
    expect(matched).toBe(true);
  });

  it("mentions network headers (matrix #3)", () => {
    const matched = PRIVACY_NOTICE_BULLETS.some((b) => /header|network/i.test(b));
    expect(matched).toBe(true);
  });
});

describe("shouldShowFirstRunNotice", () => {
  it("returns true when the user has not seen the notice (matrix #4)", () => {
    expect(shouldShowFirstRunNotice(false)).toBe(true);
  });

  it("returns false when the user has already seen the notice (matrix #5)", () => {
    expect(shouldShowFirstRunNotice(true)).toBe(false);
  });
});

describe("PRIVACY_MD_TEMPLATE", () => {
  it("is a non-empty markdown document with a top-level heading (matrix #6)", () => {
    expect(PRIVACY_MD_TEMPLATE.startsWith("# ")).toBe(true);
    expect(PRIVACY_MD_TEMPLATE.length).toBeGreaterThanOrEqual(100);
  });

  it("mentions all three topics: screen, form, header (matrix #7)", () => {
    expect(PRIVACY_MD_TEMPLATE).toMatch(/screen|visible/i);
    expect(PRIVACY_MD_TEMPLATE).toMatch(/form|input/i);
    expect(PRIVACY_MD_TEMPLATE).toMatch(/header|network/i);
  });

  it("notes that the export is for local use only (matrix #8)", () => {
    // Either the literal phrase "local use only" or both "local" and "only" present.
    const literal = /local use only/i.test(PRIVACY_MD_TEMPLATE);
    const both = /\blocal\b/i.test(PRIVACY_MD_TEMPLATE) && /\bonly\b/i.test(PRIVACY_MD_TEMPLATE);
    expect(literal || both).toBe(true);
  });

  it("mentions screenshots and that they may contain sensitive data (matrix #9)", () => {
    expect(PRIVACY_MD_TEMPLATE).toMatch(/screenshot/i);
    expect(PRIVACY_MD_TEMPLATE).toMatch(/sensitive/i);
  });

  // D9 — Feature #14 phase 1: the privacy copy must be updated to
  // reflect the new transport surface. Any earlier copy claiming
  // "DeskCheck never transmits session data over the network" becomes
  // false once the CLI listener path ships, so the notice has to
  // mention the CLI handoff and the 127.0.0.1-only guarantee.
  it("D9 — PRIVACY_MD_TEMPLATE mentions CLI handoff and 127.0.0.1 loopback-only guarantee", () => {
    expect(PRIVACY_MD_TEMPLATE).toMatch(/cli|command[- ]line|terminal/i);
    expect(PRIVACY_MD_TEMPLATE).toMatch(/127\.0\.0\.1|loopback|localhost/i);
  });

  it("D9 — PRIVACY_NOTICE_BULLETS mentions the CLI handoff surface (feature-14)", () => {
    const matched = PRIVACY_NOTICE_BULLETS.some((b) =>
      /cli|command[- ]line|terminal|listener|handoff/i.test(b),
    );
    expect(matched).toBe(true);
  });
});
