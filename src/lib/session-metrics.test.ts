import { describe, it, expect } from "vitest";
import {
  computeSessionMetrics,
  formatDuration,
  formatBytes,
  isOverSizeThreshold,
} from "./session-metrics";

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
    const result = computeSessionMetrics(0, 0, 0, 0, startTime);
    expect(result.startTime).toBe(startTime);
    expect(result.eventCount).toBe(0);
    expect(result.screenshotCount).toBe(0);
    expect(result.eventsSizeBytes).toBe(0);
    expect(result.screenshotsSizeBytes).toBe(0);
  });

  it("passes event count through unchanged", () => {
    const result = computeSessionMetrics(2, 0, 120, 0, startTime);
    expect(result.eventCount).toBe(2);
    expect(result.screenshotCount).toBe(0);
    expect(result.eventsSizeBytes).toBe(120);
  });

  it("passes screenshot count through unchanged", () => {
    const result = computeSessionMetrics(0, 2, 0, 4096, startTime);
    expect(result.screenshotCount).toBe(2);
    expect(result.eventCount).toBe(0);
    expect(result.screenshotsSizeBytes).toBe(4096);
  });

  it("keeps events and screenshot sizes separate", () => {
    const result = computeSessionMetrics(1, 1, 80, 1000, startTime);
    expect(result.eventsSizeBytes).toBe(80);
    expect(result.screenshotsSizeBytes).toBe(1000);
  });

  it("passes through startTime", () => {
    const result = computeSessionMetrics(0, 0, 0, 0, startTime);
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
