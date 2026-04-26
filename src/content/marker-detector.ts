// Feature #14 phase 2 — marker-detector content script.
// Runs at document_start. Detects #_deskcheck=ID:TOKEN:PORT:v1 in the
// URL hash, strips it via history.replaceState, and sends MARKER_DETECTED
// to the service worker.
//
// This script MUST NOT import the recorder or any storage-writing module.
// It only uses handoff-marker.ts (pure) and chrome.runtime.sendMessage.

import { stripMarker } from "../lib/handoff-marker";

export interface MarkerDetectorDeps {
  href: string;
  replaceState: (data: unknown, unused: string, url: string) => void;
  sendMessage: (msg: unknown) => Promise<unknown>;
}

export function detectMarker(deps: MarkerDetectorDeps): boolean {
  const result = stripMarker(deps.href);
  if (!result) return false;

  deps.replaceState(null, "", result.cleanHref);

  deps.sendMessage({
    type: "MARKER_DETECTED",
    marker: result.marker,
    tabId: null,
  }).catch(() => {});

  return true;
}

// ── Entry point (runs on import in the browser) ──
if (typeof location !== "undefined" && typeof chrome !== "undefined") {
  detectMarker({
    href: location.href,
    replaceState: (data, unused, url) => history.replaceState(data, unused, url),
    sendMessage: (msg) => chrome.runtime.sendMessage(msg),
  });
}
