// Pure function that performs the POST of a finished session zip to a
// configured CLI listener. Isolated from service-worker.ts so the unit
// test can stub `fetchImpl` without any chrome/network dependency.
//
// Returns a discriminated union: `ok` on a 2xx response, `rejected` on a
// 4xx/5xx, `transport_error` on fetch throw, redirect, or timeout. The
// service worker treats anything other than `ok` as a fall-through signal
// — it broadcasts a visible warning to the side panel's #async-error slot
// and proceeds to the existing chrome.downloads.download path.
//
// Redirect handling: `redirect: "error"` on the fetch request — a redirect
// from an expected loopback origin to anywhere else is a squatter signal
// in phase 1 and a handshake would catch it in phase 2.

import type { HandoffConfig } from "../lib/handoff";

export type HandoffResult =
  | { kind: "ok" }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "transport_error"; reason: string };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Send a finished session zip to the configured CLI listener.
 *
 * @param config - The handoff config record from `chrome.storage.local`.
 *                 The caller is responsible for having already validated
 *                 `config.listener_url` via `isValidLoopbackUrl`.
 * @param zipBytes - The finished session zip, exactly as `exportSessionStreaming`
 *                   produced it. Sent as the request body with
 *                   `Content-Type: application/zip` — no re-encoding.
 * @param sessionId - Placed in the `X-DeskCheck-Session-Id` header. The
 *                    listener uses it as the filename stem and as the
 *                    key in its `usedSessions` replay-defence set.
 * @param fetchImpl - Injected fetch. In production this is `globalThis.fetch`;
 *                    in unit tests it is a stub that returns canned Response
 *                    objects so we avoid any real network call.
 */
export async function performHandoff(
  _config: HandoffConfig,
  _zipBytes: Uint8Array,
  _sessionId: string,
  _fetchImpl: FetchLike,
): Promise<HandoffResult> {
  throw new Error("performHandoff not implemented");
}
