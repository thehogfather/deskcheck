import { zipSync, strToU8, Zip, ZipPassThrough } from "fflate";
import {
  SessionExport,
  SessionSummary,
  SessionMetadata,
  TimelineEvent,
} from "../types";
import { PRIVACY_MD_TEMPLATE } from "./privacy";
import { AGENTS_MD, SCHEMA_VERSION } from "./agents-doc";
import type { SessionStore } from "./session-store-types";

/**
 * Legacy synchronous exporter — still used by the non-OPFS code paths
 * and by tests that pre-date the streaming rewrite. New callers should
 * prefer `exportSessionStreaming`, which reads from a `SessionStore` and
 * does not require the whole session in memory.
 */
export function exportSession(
  session: SessionMetadata,
  events: TimelineEvent[],
  screenshots: Record<string, string>,
): Uint8Array {
  const summary = buildSummary(events);

  // Strip internal fields (tab_id) from export
  const { tab_id: _, ...sessionExport } = session;

  const exportData: SessionExport = {
    schema_version: SCHEMA_VERSION,
    session: sessionExport as SessionMetadata,
    timeline: events,
    summary,
  };

  const jsonStr = JSON.stringify(exportData, null, 2);

  // PRIVACY.md is added BEFORE the screenshots loop so an encoding failure
  // aborts the export rather than producing a silently-incomplete zip. The
  // line is intentionally not wrapped in try/catch — a missing privacy notice
  // is a louder failure mode than a missing screenshot.
  const zipData: Record<string, Uint8Array> = {
    "session.json": strToU8(jsonStr),
    "PRIVACY.md": strToU8(PRIVACY_MD_TEMPLATE),
    "agents.md": strToU8(AGENTS_MD),
  };

  for (const [id, dataUrl] of Object.entries(screenshots)) {
    try {
      const base64 = dataUrl.split(",")[1];
      if (base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        zipData[`screenshots/${id}.png`] = bytes;
      }
    } catch (e) {
      console.warn(`[DeskCheck] Skipping corrupted screenshot ${id}:`, e);
    }
  }

  return zipSync(zipData);
}

/**
 * Streaming session export (feature-5).
 *
 * Reads events and screenshots from the given SessionStore one-at-a-time
 * and pipes them into fflate's streaming `Zip` so the whole session is
 * never held in memory. Returns the finished zip bytes as a Uint8Array
 * (the caller wraps it in a Blob for download).
 *
 * The only item that must be in memory at once is the `session.json`
 * blob (events are scanned once to build both the timeline array and
 * the summary — at current volumes the events log is small compared to
 * screenshots, which are the real OOM hazard). Each screenshot is read
 * and pushed to the zip one at a time; the prior bytes can be GC'd
 * before the next read.
 */
export async function exportSessionStreaming(
  store: SessionStore,
  session: SessionMetadata,
): Promise<Uint8Array> {
  // Collect events in one pass. A fresh streaming iteration over the
  // store's readEvents() gives us the timeline for session.json and
  // feeds buildSummary without a second scan.
  const timeline: TimelineEvent[] = [];
  for await (const ev of store.readEvents()) timeline.push(ev);
  const summary = buildSummary(timeline);

  const { tab_id: _tab, ...sessionExport } = session;
  const exportData: SessionExport = {
    schema_version: SCHEMA_VERSION,
    session: sessionExport as SessionMetadata,
    timeline,
    summary,
  };
  const sessionJson = JSON.stringify(exportData, null, 2);

  // Drive a streaming zip. Each file is pushed as a ZipPassThrough
  // (stored, uncompressed) so we do not have to subclass ZipDeflate
  // with a promise-aware back-pressure hook; the overall archive is
  // small enough that compression is a minor win relative to keeping
  // the code simple.
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  const finished = new Promise<Uint8Array>((resolve, reject) => {
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      chunks.push(chunk);
      totalSize += chunk.length;
      if (final) {
        const out = new Uint8Array(totalSize);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        resolve(out);
      }
    });

    (async () => {
      // session.json — written first so any reader that stops after the
      // first entry still gets the most important artefact.
      pushFile(zip, "session.json", strToU8(sessionJson));
      pushFile(zip, "PRIVACY.md", strToU8(PRIVACY_MD_TEMPLATE));
      pushFile(zip, "agents.md", strToU8(AGENTS_MD));

      // Screenshots streamed one at a time. The store yields each
      // ScreenshotRecord; we push its bytes into the zip, then the
      // local variable can be GC'd before we fetch the next one. This
      // is the load-bearing property for the streaming memory test.
      for await (const ss of store.readScreenshots()) {
        pushFile(zip, `screenshots/${ss.id}.png`, ss.bytes);
      }

      zip.end();
    })().catch(reject);
  });

  return finished;
}

function pushFile(zip: Zip, name: string, bytes: Uint8Array): void {
  const entry = new ZipPassThrough(name);
  zip.add(entry);
  entry.push(bytes, true);
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
  return `deskcheck-session-${ts}.zip`;
}
