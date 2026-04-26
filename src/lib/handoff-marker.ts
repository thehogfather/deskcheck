// Pure module for feature #14 phase 2 marker grammar. Zero chrome imports.
//
// Grammar: #_deskcheck=<sessionId>:<token>:<port>:v1
//
// sessionId = 1-128 chars: [A-Za-z0-9._-]
// token     = exactly 64 hex chars
// port      = 1024-65535
// version   = "v1"

const SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const TOKEN_REGEX = /^[a-f0-9]{64}$/;

export interface ParsedMarker {
  sessionId: string;
  token: string;
  port: number;
}

export function parseMarker(hash: string): ParsedMarker | null {
  if (typeof hash !== "string" || hash.length === 0) return null;

  // Find the _deskcheck= segment. It can appear as:
  //   #_deskcheck=...          (pure marker)
  //   #/route&_deskcheck=...   (appended to hash router)
  const idx = hash.indexOf("_deskcheck=");
  if (idx < 0) return null;

  const payload = hash.slice(idx + "_deskcheck=".length);
  const parts = payload.split(":");
  if (parts.length !== 4) return null;

  const [sessionId, token, portStr, version] = parts;

  if (version !== "v1") return null;
  if (!SESSION_ID_REGEX.test(sessionId)) return null;
  if (!TOKEN_REGEX.test(token)) return null;

  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

  return { sessionId, token, port };
}

export interface StripResult {
  cleanHref: string;
  marker: ParsedMarker;
}

export function stripMarker(href: string): StripResult | null {
  if (typeof href !== "string") return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const hash = url.hash;
  if (!hash || !hash.includes("_deskcheck=")) return null;

  // Pattern A: pure marker — #_deskcheck=ID:TOKEN:PORT:v1
  const pureMatch = hash.match(
    /^#_deskcheck=([A-Za-z0-9._-]{1,128}):([a-f0-9]{64}):(\d{1,5}):v1$/
  );
  if (pureMatch) {
    const marker = parseMarker(hash);
    if (!marker) return null;
    const cleanHref = url.origin + url.pathname + url.search;
    return { cleanHref, marker };
  }

  // Pattern B: appended via & — #/route&_deskcheck=ID:TOKEN:PORT:v1
  const appendedMatch = hash.match(
    /^(#.*)&_deskcheck=([A-Za-z0-9._-]{1,128}):([a-f0-9]{64}):(\d{1,5}):v1$/
  );
  if (appendedMatch) {
    const markerHash = "#_deskcheck=" + appendedMatch[2] + ":" + appendedMatch[3] + ":" + appendedMatch[4] + ":v1";
    const marker = parseMarker(markerHash);
    if (!marker) return null;
    const cleanHash = appendedMatch[1];
    const cleanHref = url.origin + url.pathname + url.search + cleanHash;
    return { cleanHref, marker };
  }

  return null;
}

export function buildMarkerFragment(
  sessionId: string,
  token: string,
  port: number,
): string {
  return `#_deskcheck=${sessionId}:${token}:${port}:v1`;
}
