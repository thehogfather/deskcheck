import { SessionMetrics, TimelineEvent } from "../types";

export function computeSessionMetrics(
  events: TimelineEvent[],
  screenshots: Record<string, string>,
  startTime: string,
): SessionMetrics {
  const screenshotCount = Object.keys(screenshots).length;

  // Estimate size: JSON-serialized events + screenshot data URL strings
  const eventsSize = JSON.stringify(events).length;
  const screenshotsSize = Object.values(screenshots).reduce(
    (sum, dataUrl) => sum + dataUrl.length,
    0,
  );

  return {
    startTime,
    eventCount: events.length,
    screenshotCount,
    estimatedSizeBytes: eventsSize + screenshotsSize,
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "< 1s";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return "0 KB";

  if (bytes < 1048576) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1073741824) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

export function isOverSizeThreshold(
  bytes: number,
  thresholdBytes: number,
): boolean {
  return bytes > thresholdBytes;
}
