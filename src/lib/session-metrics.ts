import { SessionMetrics } from "../types";

/**
 * Build the live session-metrics snapshot for the widget overlay.
 *
 * Signature is numeric-only (feature-5). The caller is responsible for
 * fetching the counts and sizes from the SessionStore — this function
 * just formats the resulting shape. Byte totals should come from the
 * store's `computeByteSizes()`, which reads file sizes from OPFS rather
 * than measuring in-memory strings.
 */
export function computeSessionMetrics(
  eventCount: number,
  screenshotCount: number,
  eventsSizeBytes: number,
  screenshotsSizeBytes: number,
  startTime: string,
): SessionMetrics {
  return {
    startTime,
    eventCount,
    screenshotCount,
    eventsSizeBytes,
    screenshotsSizeBytes,
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
