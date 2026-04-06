import { describe, it, expect } from "vitest";
import {
  computeSessionMetrics,
  formatDuration,
  formatBytes,
  isOverSizeThreshold,
} from "./session-metrics";
import { TimelineEvent } from "../types";

describe("formatDuration", () => {
  it("returns '< 1s' for negative values", () => {
    expect(formatDuration(-100)).toBe("< 1s");
  });

  it("returns '< 1s' for 0", () => {
    expect(formatDuration(0)).toBe("< 1s");
  });

  it("returns '< 1s' for sub-second values", () => {
    expect(formatDuration(500)).toBe("< 1s");
    expect(formatDuration(999)).toBe("< 1s");
  });

  it("formats seconds", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 00s");
    expect(formatDuration(62000)).toBe("1m 02s");
    expect(formatDuration(3599000)).toBe("59m 59s");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatDuration(3600000)).toBe("1h 00m 00s");
    expect(formatDuration(3723000)).toBe("1h 02m 03s");
  });

  it("returns '< 1s' for NaN", () => {
    expect(formatDuration(NaN)).toBe("< 1s");
  });

  it("returns '< 1s' for Infinity", () => {
    expect(formatDuration(Infinity)).toBe("< 1s");
  });
});

describe("formatBytes", () => {
  it("returns '0 KB' for negative values", () => {
    expect(formatBytes(-1)).toBe("0 KB");
  });

  it("returns '0 KB' for NaN", () => {
    expect(formatBytes(NaN)).toBe("0 KB");
  });

  it("returns '0 KB' for 0", () => {
    expect(formatBytes(0)).toBe("0 KB");
  });

  it("returns '0 KB' for sub-KB values", () => {
    expect(formatBytes(500)).toBe("0 KB");
    expect(formatBytes(1023)).toBe("0 KB");
  });

  it("formats KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats MB", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(52428800)).toBe("50.0 MB");
  });

  it("formats GB", () => {
    expect(formatBytes(1073741824)).toBe("1.0 GB");
  });
});

describe("computeSessionMetrics", () => {
  const startTime = "2026-04-06T10:00:00.000Z";

  it("returns zeros for empty session", () => {
    const result = computeSessionMetrics([], {}, startTime);
    expect(result.startTime).toBe(startTime);
    expect(result.eventCount).toBe(0);
    expect(result.screenshotCount).toBe(0);
    expect(result.eventsSizeBytes).toBeGreaterThan(0); // "[]" has length 2
    expect(result.screenshotsSizeBytes).toBe(0);
  });

  it("counts events correctly", () => {
    const events = [
      { seq: 1, timestamp: "", type: "interaction", subtype: "click", page_url: "" },
      { seq: 2, timestamp: "", type: "interaction", subtype: "click", page_url: "" },
    ] as TimelineEvent[];
    const result = computeSessionMetrics(events, {}, startTime);
    expect(result.eventCount).toBe(2);
    expect(result.screenshotCount).toBe(0);
  });

  it("counts screenshots correctly", () => {
    const screenshots = {
      ss_1: "data:image/png;base64,abc123",
      ss_2: "data:image/png;base64,def456",
    };
    const result = computeSessionMetrics([], screenshots, startTime);
    expect(result.screenshotCount).toBe(2);
    expect(result.eventCount).toBe(0);
  });

  it("estimates size from events and screenshots separately", () => {
    const events = [
      { seq: 1, timestamp: "", type: "interaction", subtype: "click", page_url: "https://example.com" },
    ] as TimelineEvent[];
    const screenshots = { ss_1: "x".repeat(1000) };

    const result = computeSessionMetrics(events, screenshots, startTime);
    expect(result.eventsSizeBytes).toBeGreaterThan(0);
    expect(result.screenshotsSizeBytes).toBe(1000);
  });

  it("passes through startTime", () => {
    const result = computeSessionMetrics([], {}, startTime);
    expect(result.startTime).toBe(startTime);
  });
});

describe("isOverSizeThreshold", () => {
  it("returns false when below threshold", () => {
    expect(isOverSizeThreshold(100, 200)).toBe(false);
  });

  it("returns false when at threshold", () => {
    expect(isOverSizeThreshold(200, 200)).toBe(false);
  });

  it("returns true when above threshold", () => {
    expect(isOverSizeThreshold(201, 200)).toBe(true);
  });
});
