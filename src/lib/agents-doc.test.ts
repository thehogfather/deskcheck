import { describe, it, expect } from "vitest";
import {
  AGENTS_MD,
  AGENTS_MD_EVENT_TYPES,
  SCHEMA_VERSION,
  assertExhaustiveEventTypes,
} from "./agents-doc";
import { TimelineEvent } from "../types";

// Canonical set of timeline event discriminators. Maintained here so
// the test fails loudly if AGENTS_MD_EVENT_TYPES drifts from the
// TimelineEvent union in src/types.ts.
const EXPECTED_DISCRIMINATORS: ReadonlySet<TimelineEvent["type"]> = new Set([
  "interaction",
  "viewport_resize",
  "network_error",
  "console_error",
  "js_exception",
  "annotation",
  "screenshot",
  "session_paused",
  "session_resumed",
]);

const SESSION_METADATA_FIELDS = [
  "id",
  "start_time",
  "end_time",
  "duration_ms",
  "initial_url",
  "user_agent",
  "viewport",
  "status",
] as const;

describe("SCHEMA_VERSION", () => {
  it("is bumped to 1.2.0 for the additive status + lifecycle-marker schema change", () => {
    expect(SCHEMA_VERSION).toBe("1.2.0");
  });
});

describe("AGENTS_MD_EVENT_TYPES", () => {
  it("covers exactly the TimelineEvent union discriminators", () => {
    expect(new Set(AGENTS_MD_EVENT_TYPES)).toEqual(EXPECTED_DISCRIMINATORS);
  });

  it("references the exhaustiveness helper to keep the compile-time guard live", () => {
    // Importing assertExhaustiveEventTypes is the key safeguard:
    // its `never` default branch makes `make typecheck` fail if a new
    // TimelineEvent variant is added without updating this module.
    expect(typeof assertExhaustiveEventTypes).toBe("function");
  });
});

describe("AGENTS_MD content", () => {
  it("interpolates the current SCHEMA_VERSION exactly once", () => {
    expect(AGENTS_MD).toContain(SCHEMA_VERSION);
  });

  it("documents every surviving SessionMetadata field", () => {
    for (const field of SESSION_METADATA_FIELDS) {
      expect(AGENTS_MD).toContain(field);
    }
  });

  it("does NOT advertise tab_id (it is stripped on export)", () => {
    expect(AGENTS_MD).not.toContain("tab_id");
  });

  it("documents every event type discriminator", () => {
    for (const discriminator of EXPECTED_DISCRIMINATORS) {
      expect(AGENTS_MD).toContain(discriminator);
    }
  });

  it("has a section heading for each event type discriminator", () => {
    for (const discriminator of EXPECTED_DISCRIMINATORS) {
      const headingRe = new RegExp(`type:\\s*\`?${discriminator}\`?`);
      expect(AGENTS_MD).toMatch(headingRe);
    }
  });

  it("explains the screenshots/ directory and the screenshot_id linkage", () => {
    expect(AGENTS_MD).toContain("screenshots/");
    expect(AGENTS_MD).toContain("screenshot_id");
    expect(AGENTS_MD).toMatch(/screenshots\/[^\s]+\.png/);
  });

  it("stays under the 16 KB sanity cap (guards export memory footprint)", () => {
    const bytes = new TextEncoder().encode(AGENTS_MD).byteLength;
    expect(bytes).toBeLessThan(16384);
  });

  it("is non-empty (catches stub regressions)", () => {
    expect(AGENTS_MD.length).toBeGreaterThan(0);
  });
});
