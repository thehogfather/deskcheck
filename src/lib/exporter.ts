import { zipSync, strToU8 } from "fflate";
import {
  SessionExport,
  SessionSummary,
  SessionMetadata,
  TimelineEvent,
} from "../types";

export function exportSession(
  session: SessionMetadata,
  events: TimelineEvent[],
  screenshots: Record<string, string>,
): Uint8Array {
  const summary = buildSummary(events);

  // Strip internal fields (tab_id) from export
  const { tab_id: _, ...sessionExport } = session;

  const exportData: SessionExport = {
    schema_version: "1.0.0",
    session: sessionExport as SessionMetadata,
    timeline: events,
    summary,
  };

  const jsonStr = JSON.stringify(exportData, null, 2);

  const zipData: Record<string, Uint8Array> = {
    "session.json": strToU8(jsonStr),
  };

  for (const [id, dataUrl] of Object.entries(screenshots)) {
    const base64 = dataUrl.split(",")[1];
    if (base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      zipData[`screenshots/${id}.png`] = bytes;
    }
  }

  return zipSync(zipData);
}

export function buildSummary(events: TimelineEvent[]): SessionSummary {
  const pages = new Set<string>();
  let annotations = 0;
  let consoleErrors = 0;
  let consoleWarnings = 0;
  let networkFailures = 0;
  let jsExceptions = 0;
  let screenshots = 0;

  for (const event of events) {
    pages.add(event.page_url);
    switch (event.type) {
      case "annotation":
        annotations++;
        break;
      case "console_error":
        if (event.level === "error") consoleErrors++;
        else consoleWarnings++;
        break;
      case "network_error":
        networkFailures++;
        break;
      case "js_exception":
        jsExceptions++;
        break;
      case "screenshot":
        screenshots++;
        break;
    }
  }

  return {
    total_events: events.length,
    annotations,
    console_errors: consoleErrors,
    console_warnings: consoleWarnings,
    network_failures: networkFailures,
    js_exceptions: jsExceptions,
    screenshots,
    pages_visited: [...pages],
  };
}

export function getExportFilename(session: SessionMetadata): string {
  const ts = session.start_time.replace(/[:.]/g, "-").replace("Z", "");
  return `examiner-session-${ts}.zip`;
}
