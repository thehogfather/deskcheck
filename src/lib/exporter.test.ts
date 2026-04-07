import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  exportSession,
  buildSummary,
  getExportFilename,
} from "./exporter";
import {
  SessionMetadata,
  TimelineEvent,
  SessionExport,
} from "../types";

function makeSession(overrides?: Partial<SessionMetadata>): SessionMetadata {
  return {
    id: "test-session-id",
    tab_id: 42,
    start_time: "2026-04-06T10:00:00.000Z",
    end_time: "2026-04-06T10:05:00.000Z",
    duration_ms: 300000,
    initial_url: "https://example.com",
    user_agent: "TestAgent/1.0",
    viewport: { width: 1280, height: 720 },
    ...overrides,
  };
}

function makeEvents(): TimelineEvent[] {
  return [
    {
      seq: 1,
      timestamp: "2026-04-06T10:00:01.000Z",
      type: "interaction",
      subtype: "click",
      element: { tag: "button", selector: "#btn" },
      coordinates: { x: 100, y: 200 },
      page_url: "https://example.com",
    },
    {
      seq: 2,
      timestamp: "2026-04-06T10:00:02.000Z",
      type: "console_error",
      level: "error",
      message: "Test error",
      page_url: "https://example.com",
    },
    {
      seq: 3,
      timestamp: "2026-04-06T10:00:03.000Z",
      type: "console_error",
      level: "warning",
      message: "Test warning",
      page_url: "https://example.com",
    },
    {
      seq: 4,
      timestamp: "2026-04-06T10:00:04.000Z",
      type: "network_error",
      method: "POST",
      url: "https://api.example.com/submit",
      status: 500,
      status_text: "Internal Server Error",
      request_headers: {},
      page_url: "https://example.com/form",
    },
    {
      seq: 5,
      timestamp: "2026-04-06T10:00:05.000Z",
      type: "annotation",
      text: "Something broke",
      screenshot_id: "ss_1",
      page_url: "https://example.com/form",
    },
    {
      seq: 6,
      timestamp: "2026-04-06T10:00:06.000Z",
      type: "screenshot",
      id: "ss_1",
      file: "screenshots/ss_1.png",
      viewport: { width: 1280, height: 720 },
      trigger: "annotation",
      page_url: "https://example.com/form",
    },
  ];
}

describe("buildSummary", () => {
  it("counts event types correctly", () => {
    const summary = buildSummary(makeEvents());
    expect(summary.total_events).toBe(6);
    expect(summary.annotations).toBe(1);
    expect(summary.console_errors).toBe(1);
    expect(summary.console_warnings).toBe(1);
    expect(summary.network_failures).toBe(1);
    expect(summary.js_exceptions).toBe(0);
    expect(summary.screenshots).toBe(1);
  });

  it("collects unique pages visited", () => {
    const summary = buildSummary(makeEvents());
    expect(summary.pages_visited).toContain("https://example.com");
    expect(summary.pages_visited).toContain("https://example.com/form");
    expect(summary.pages_visited.length).toBe(2);
  });

  it("handles empty events", () => {
    const summary = buildSummary([]);
    expect(summary.total_events).toBe(0);
    expect(summary.pages_visited).toEqual([]);
  });
});

describe("exportSession", () => {
  it("produces a valid zip with session.json", () => {
    const session = makeSession();
    const events = makeEvents();
    const zipBytes = exportSession(session, events, {});
    const unzipped = unzipSync(zipBytes);

    expect(unzipped["session.json"]).toBeDefined();
    const json = JSON.parse(
      strFromU8(unzipped["session.json"]),
    ) as SessionExport;
    expect(json.schema_version).toBe("1.0.0");
    expect(json.timeline.length).toBe(6);
    expect(json.summary.total_events).toBe(6);
  });

  it("strips tab_id from exported session", () => {
    const session = makeSession({ tab_id: 99 });
    const zipBytes = exportSession(session, [], {});
    const unzipped = unzipSync(zipBytes);
    const json = JSON.parse(strFromU8(unzipped["session.json"]));
    expect(json.session.tab_id).toBeUndefined();
  });

  it("includes screenshots as PNG files in zip", () => {
    const session = makeSession();
    // Minimal 1x1 red PNG as data URL
    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    const screenshots = { ss_1: pngDataUrl };
    const zipBytes = exportSession(session, [], screenshots);
    const unzipped = unzipSync(zipBytes);
    expect(unzipped["screenshots/ss_1.png"]).toBeDefined();
    expect(unzipped["screenshots/ss_1.png"].length).toBeGreaterThan(0);
  });
});

describe("exportSession privacy notice", () => {
  it("includes PRIVACY.md at the zip root in an empty session (matrix #10)", () => {
    const zipBytes = exportSession(makeSession(), [], {});
    const unzipped = unzipSync(zipBytes);
    expect(unzipped["PRIVACY.md"]).toBeDefined();
    expect(unzipped["PRIVACY.md"].length).toBeGreaterThan(0);
  });

  it("includes PRIVACY.md alongside screenshots (matrix #11)", () => {
    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    const zipBytes = exportSession(makeSession(), makeEvents(), { ss_1: pngDataUrl });
    const unzipped = unzipSync(zipBytes);
    expect(unzipped["PRIVACY.md"]).toBeDefined();
    expect(unzipped["screenshots/ss_1.png"]).toBeDefined();
  });

  it("PRIVACY.md content references screenshots and sensitive data (matrix #12)", () => {
    const zipBytes = exportSession(makeSession(), [], {});
    const unzipped = unzipSync(zipBytes);
    const text = strFromU8(unzipped["PRIVACY.md"]);
    expect(text).toMatch(/screenshot/i);
    expect(text).toMatch(/sensitive/i);
  });
});

describe("getExportFilename", () => {
  it("formats filename from session start time", () => {
    const session = makeSession({
      start_time: "2026-04-06T14:30:00.000Z",
    });
    expect(getExportFilename(session)).toBe(
      "deskcheck-session-2026-04-06T14-30-00-000.zip",
    );
  });
});
