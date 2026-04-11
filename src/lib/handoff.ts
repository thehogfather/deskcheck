// Pure module for feature-14 phase-1 CLI handoff helpers. Zero chrome
// imports so the unit tests can run without any fake chrome global.
//
// Scope: URL validation (loopback only), constant-time string compare
// (so any future token compare cannot leak via timing), token redaction
// (so the token never lands in a console log verbatim), and a structural
// type guard for the `deskcheck_handoff` chrome.storage.local record.
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

const ALLOWED_LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  // URL.hostname strips the square brackets from an IPv6 literal so the
  // allowlist uses the bare form. The URL constructor still requires the
  // brackets in the input string.
  "[::1]",
]);

/**
 * Reject anything that is not a strict loopback HTTP URL.
 * See the file header for the exhaustive accept/reject set.
 */
export function isValidLoopbackUrl(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  // URL.hostname is lowercased already, but be explicit for clarity.
  const host = url.hostname.toLowerCase();
  // Reconstruct the [::1] form with brackets — URL.hostname strips them.
  const hostWithBrackets = host === "::1" ? "[::1]" : host;
  if (!ALLOWED_LOOPBACK_HOSTS.has(hostWithBrackets)) return false;
  if (url.port === "") return false;
  const portNum = Number.parseInt(url.port, 10);
  if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) return false;
  // URL normalises `/../upload` to `/upload` — so `pathname !== ""` and
  // `pathname !== "/"` both catch path-traversal and stray paths.
  if (url.pathname !== "" && url.pathname !== "/") return false;
  if (url.search !== "") return false;
  if (url.hash !== "") return false;
  // Reject anything with credentials baked in.
  if (url.username !== "" || url.password !== "") return false;
  return true;
}

/**
 * Constant-time string compare. Returns true iff the two strings are
 * byte-equal AND have the same length. The loop length is always
 * `max(a.length, b.length)` so a length mismatch cannot leak via timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let acc = 0;
  for (let i = 0; i < len; i++) {
    // charCodeAt returns NaN past the end — coerce to 0 for a deterministic
    // accumulator. Equal-length strings with equal contents yield acc === 0.
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    acc |= ca ^ cb;
  }
  return acc === 0 && a.length === b.length;
}

/**
 * Redact any 16+ hex-char token-like substring from an arbitrary string,
 * replacing each match with `[redacted]`. Applied to every `console.warn`
 * path in feature-14 code so the token never lands in the DevTools log
 * verbatim even when a failure surfaces the underlying error object.
 */
export function redactToken(text: string): string {
  if (typeof text !== "string") return "";
  return text.replace(/[a-f0-9]{16,}/gi, "[redacted]");
}
