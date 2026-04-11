// Pure module for feature-14 phase-1 CLI handoff helpers. Zero chrome
// imports so the unit tests can run without any fake chrome global.
//
// Scope: URL validation (loopback only), constant-time string compare
// (for any future response-token compare), token redaction (so the token
// never lands in a console log verbatim), and a structural type guard
// for the `deskcheck_handoff` chrome.storage.local record.
//
// The URL validator is the structural enforcement of the brief's
// "127.0.0.1 only" constraint. Any change to this file should be
// accompanied by adversarial tests in handoff.test.ts — specifically the
// ones pinning `127.0.0.1.evil.com`, `[::1]`, `?q`, `#frag`, `/../`, and
// `https://127.0.0.1` as REJECTED.

/**
 * Shape of the record stored at `chrome.storage.local['deskcheck_handoff']`.
 * Intentionally NOT added to `SessionMetadata` — keeping the listener URL
 * and token out of the exported `session.json` is a structural privacy
 * property, not a runtime-stripping one.
 */
export interface HandoffConfig {
  /** Loopback listener URL, e.g. `http://127.0.0.1:54329`. No path/query/fragment. */
  listener_url: string;
  /** Bearer token from the CLI's ready-line output. Opaque hex. */
  token: string;
  /** ISO timestamp of when the user attached this listener. For UX display only. */
  created_at: string;
}

/**
 * Structural type guard for a stored handoff config. Rejects anything that
 * is not a plain object with the three string fields. Callers should treat
 * a `false` result as "no handoff configured" and fall through to the
 * download path.
 */
export function isHandoffConfig(value: unknown): value is HandoffConfig {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.listener_url === "string" &&
    typeof v.token === "string" &&
    typeof v.created_at === "string"
  );
}

/**
 * Reject anything that is not a strict loopback HTTP URL:
 *   - scheme MUST be `http:` (not https, not anything else)
 *   - host MUST be `127.0.0.1`, `localhost`, or `[::1]`
 *   - port MUST be present and numeric
 *   - path MUST be empty or `/` (no `/upload` at this level — that's the
 *     CLI endpoint, the config record stores only the origin)
 *   - query and fragment MUST be absent
 *
 * Adversarial cases the validator MUST reject (pinned by handoff.test.ts):
 *   - `http://127.0.0.1.evil.com:8787` — DNS suffix attack
 *   - `http://127.0.0.1:8787/../upload` — path-traversal
 *   - `http://127.0.0.1:8787?x=1` — query string
 *   - `http://127.0.0.1:8787#frag` — fragment
 *   - `https://127.0.0.1:8787` — https (MV3 extension fetch to self-signed is moot)
 *   - `http://evil.com` — non-loopback host
 *   - `http://127.0.0.1` — missing port
 */
export function isValidLoopbackUrl(_input: string): boolean {
  throw new Error("isValidLoopbackUrl not implemented");
}

/**
 * Constant-time string compare. Returns true iff the two strings are
 * byte-equal AND have the same length. Zero early-exits; loop length is
 * always `max(a.length, b.length)` so a length-mismatch does not leak via
 * timing. For bearer tokens specifically — the response is compared
 * extension-side after receiving the CLI's `ok: true` body, and the CLI
 * compares the `Authorization: Bearer` header against its own token on
 * the listener side.
 */
export function constantTimeEqual(_a: string, _b: string): boolean {
  throw new Error("constantTimeEqual not implemented");
}

/**
 * Redact any 16+ hex-char token-like substring from an arbitrary string,
 * replacing with `[redacted]`. Applied to every `console.warn` path in
 * feature-14 code so the token never lands in the DevTools log verbatim
 * even when a failure surfaces the underlying error object.
 */
export function redactToken(_text: string): string {
  throw new Error("redactToken not implemented");
}
