// Pure function: POST a cancel sentinel to the CLI listener so it wakes
// up with a "cancelled" exit code. Mirrors handoff-post.ts shape.

import type { HandoffConfig } from "../lib/handoff";
import type { FetchLike } from "./handoff-post";

export type CancelResult =
  | { kind: "ok" }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "transport_error"; reason: string };

const CANCEL_TIMEOUT_MS = 5_000;

export async function sendCancelSentinel(
  config: HandoffConfig,
  sessionId: string,
  fetchImpl: FetchLike,
): Promise<CancelResult> {
  const url = `${config.listener_url.replace(/\/$/, "")}/upload`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-deskcheck-cancel",
          "Authorization": `Bearer ${config.token}`,
          "X-DeskCheck-Session-Id": sessionId,
        },
        body: "",
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
    return {
      kind: "rejected",
      status: res.status,
      reason: `listener returned ${res.status}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
