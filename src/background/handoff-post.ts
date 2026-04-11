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
// from a loopback origin to anywhere else is a squatter signal in phase 1.
// Phase 2 will add an explicit handshake, which is a stronger defence; for
// phase 1 the redirect-error behaviour is the cheap version.

import type { HandoffConfig } from "../lib/handoff";

export type HandoffResult =
  | { kind: "ok" }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "transport_error"; reason: string };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Total time budget for the POST, including connect + send + ack. */
export const HANDOFF_TIMEOUT_MS = 30_000;

/**
 * Send a finished session zip to the configured CLI listener.
 *
 * The caller is responsible for having already validated
 * `config.listener_url` via `isValidLoopbackUrl`; this function does not
 * re-validate and assumes the URL is safe to POST to.
 */
export async function performHandoff(
  config: HandoffConfig,
  zipBytes: Uint8Array,
  sessionId: string,
  fetchImpl: FetchLike,
): Promise<HandoffResult> {
  const url = `${config.listener_url.replace(/\/$/, "")}/upload`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "Authorization": `Bearer ${config.token}`,
          "X-DeskCheck-Session-Id": sessionId,
        },
        // `zipBytes` is a Uint8Array; BodyInit accepts BufferSource.
        body: zipBytes as unknown as BodyInit,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { kind: "transport_error", reason };
    }
    if (res.status >= 200 && res.status < 300) {
      return { kind: "ok" };
    }
    // 4xx/5xx and 3xx (which shouldn't happen with redirect: "error")
    return {
      kind: "rejected",
      status: res.status,
      reason: `listener returned ${res.status}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
