import { TimelineEvent } from "../types";

/**
 * Single source of truth for the export schema version. Bumped per
 * the project's semver rule whenever the export contract changes.
 *
 * The export contract is the *whole zip layout*, not just session.json.
 * 1.1.0 added the sibling `agents.md` doc; session.json's shape did not
 * change, so existing parsers still work — minor bump per semver.
 */
export const SCHEMA_VERSION = "1.1.0" as const;

/**
 * Canonical list of every TimelineEvent discriminator. Kept in lockstep
 * with the TimelineEvent union in src/types.ts via `assertExhaustiveEventTypes`
 * (compile-time guard) plus a runtime set-equality test.
 */
export const AGENTS_MD_EVENT_TYPES = [
  "interaction",
  "viewport_resize",
  "network_error",
  "console_error",
  "js_exception",
  "annotation",
  "screenshot",
] as const satisfies readonly TimelineEvent["type"][];

/**
 * Compile-time exhaustiveness check. The `never` default makes
 * `make typecheck` fail if a new TimelineEvent variant is added to
 * src/types.ts without updating this module — forcing the contributor
 * to also update AGENTS_MD_EVENT_TYPES and the AGENTS_MD body.
 *
 * Not called at runtime; existence is what matters.
 */
export function assertExhaustiveEventTypes(e: TimelineEvent): void {
  switch (e.type) {
    case "interaction":
    case "viewport_resize":
    case "network_error":
    case "console_error":
    case "js_exception":
    case "annotation":
    case "screenshot":
      return;
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

/**
 * Self-documenting schema reference shipped inside every export zip.
 * Read by AI assistants (and humans) so they can parse session.json
 * without external context.
 *
 * MUST NOT interpolate any runtime session data — only SCHEMA_VERSION.
 * This module imports nothing that touches session contents, so the
 * privacy invariant is structural.
 */
export const AGENTS_MD = `# DeskCheck session export

This zip is a recording of a debugging session captured by the
DeskCheck Chrome extension. Start with \`session.json\` — it is the
authoritative timeline. This file (\`agents.md\`) describes the
schema so an AI assistant can parse the export without external
documentation.

## Schema version

\`schema_version\` = \`${SCHEMA_VERSION}\`. The schema follows semver.
A minor bump means additive, backward-compatible changes; a major bump
means existing parsers may break. The version is the contract for the
*whole zip layout*, not only \`session.json\`.

## Zip layout

\`\`\`
deskcheck-session-<timestamp>.zip
├── session.json    # chronological timeline + summary (this is the entry point)
├── agents.md       # this file — schema reference
└── screenshots/    # PNG files referenced from timeline events by id
    ├── ss_1.png
    ├── ss_2.png
    └── ...
\`\`\`

## session.json structure

Top-level keys:

| Key | Type | Meaning |
|---|---|---|
| \`schema_version\` | string | Semver version of the export contract. |
| \`session\` | object | Session metadata — see below. |
| \`timeline\` | array | Chronological list of events, sorted by \`seq\` then \`timestamp\`. |
| \`summary\` | object | Aggregate counts derived from the timeline. |

## Session metadata fields (\`session\`)

| Field | Type | Meaning |
|---|---|---|
| \`id\` | string | Stable session identifier. |
| \`start_time\` | string (ISO 8601) | When recording started. |
| \`end_time\` | string \\| null | When recording stopped. \`null\` if the session never finished cleanly. |
| \`duration_ms\` | number \\| null | Wall-clock duration of the session. |
| \`initial_url\` | string | URL of the tab when recording started. |
| \`user_agent\` | string | Browser user agent string. |
| \`viewport\` | object | \`{ width, height }\` of the tab at recording start. |

## Timeline

The \`timeline\` array contains events in causal order. Every event has
these base fields:

| Field | Type | Meaning |
|---|---|---|
| \`seq\` | number | Monotonic sequence number assigned at capture time. Sort by this. |
| \`timestamp\` | string (ISO 8601) | When the event occurred. |
| \`page_url\` | string | URL of the page when the event was captured. |
| \`type\` | string | Discriminator — one of the values listed below. |

The \`type\` field selects the rest of the shape. There are seven
event types.

## Event types

### type: \`interaction\`

A user action against the page — click, input, scroll, or SPA
navigation. Use these to describe reproduction steps.

| Field | Type | Required | Meaning |
|---|---|---|---|
| \`subtype\` | \`"click"\` \\| \`"input"\` \\| \`"scroll"\` \\| \`"navigation"\` | yes | Kind of interaction. |
| \`element\` | object | no | Target element info: \`tag\`, \`id\`, \`class\`, \`text\`, \`selector\`, \`bounding_box\`. Passwords are masked. |
| \`coordinates\` | \`{ x, y }\` | for clicks | Page coordinates of the click. |
| \`value\` | string | for inputs | Final value (truncated to 200 chars; passwords masked as \`[password]\`). |
| \`scroll_position\` | \`{ x, y }\` | for scroll | New scroll position. |
| \`from_url\` / \`to_url\` | string | for navigation | Old and new URLs (SPA navigations). |

### type: \`viewport_resize\`

The tab viewport changed size.

| Field | Type | Meaning |
|---|---|---|
| \`from\` | \`{ width, height }\` | Previous viewport. |
| \`to\` | \`{ width, height }\` | New viewport. |

### type: \`network_error\`

A network request failed (status >= 400 or transport failure).

| Field | Type | Meaning |
|---|---|---|
| \`method\` | string | HTTP method. |
| \`url\` | string | Request URL. |
| \`status\` | number | HTTP status code (0 for transport failure). |
| \`status_text\` | string | HTTP status text. |
| \`request_headers\` | object | Request headers. **Sensitive headers (Authorization, Cookie, Set-Cookie, Proxy-Authorization, X-Api-Key) are stripped before storage.** |
| \`response_body_preview\` | string | Optional truncated response body. |

### type: \`console_error\`

A \`console.error\` or \`console.warn\` call from the page.

| Field | Type | Meaning |
|---|---|---|
| \`level\` | \`"error"\` \\| \`"warning"\` | Severity. |
| \`message\` | string | The console message. |
| \`stack_trace\` | string | Optional stack trace if available. |

### type: \`js_exception\`

An uncaught JavaScript exception in the page.

| Field | Type | Meaning |
|---|---|---|
| \`message\` | string | Exception message. |
| \`stack_trace\` | string | Stack trace. |
| \`source_url\` | string | Optional file URL where the exception originated. |
| \`line\` / \`column\` | number | Optional source position. |

### type: \`annotation\`

A user-authored note describing a symptom. **These are the
human-reported bug observations** — treat them as the primary
signal when assembling a bug report.

| Field | Type | Meaning |
|---|---|---|
| \`text\` | string | The annotation body. |
| \`element\` | object | Optional target element the user picked. |
| \`screenshot_id\` | string | ID of the full-viewport screenshot taken at annotation time. Resolves to \`screenshots/<screenshot_id>.png\`. |
| \`element_screenshot_id\` | string | Optional ID of a cropped element-only screenshot. |

### type: \`screenshot\`

A standalone screenshot capture (manual, navigation-triggered, or
attached to an annotation).

| Field | Type | Meaning |
|---|---|---|
| \`id\` | string | Screenshot identifier. The PNG lives at \`screenshots/<id>.png\`. |
| \`file\` | string | Relative path to the PNG inside the zip. |
| \`viewport\` | \`{ width, height }\` | Viewport at capture time. |
| \`trigger\` | \`"annotation"\` \\| \`"navigation"\` \\| \`"manual"\` | Why the screenshot was taken. |

## Screenshots directory

PNG files live under \`screenshots/\` and are referenced by id from the
timeline:

- A \`screenshot\` event with \`id: "ss_1"\` corresponds to \`screenshots/ss_1.png\`.
- An \`annotation\` event's \`screenshot_id\` field points to the same id —
  this is how you correlate a user note with what the screen looked
  like at the moment they wrote it.
- An \`annotation\` may also have an \`element_screenshot_id\` pointing
  to a tightly-cropped image of just the picked element.

If a referenced PNG is missing from the zip, treat it as a corrupted
capture (the exporter skips screenshots it cannot decode rather than
aborting the whole export).

## Summary fields

The \`summary\` object is derived from the timeline; use it for
quick-look totals without re-walking the events:

| Field | Type | Meaning |
|---|---|---|
| \`total_events\` | number | Length of \`timeline\`. |
| \`annotations\` | number | Count of \`annotation\` events. |
| \`console_errors\` | number | Count of \`console_error\` with \`level: "error"\`. |
| \`console_warnings\` | number | Count of \`console_error\` with \`level: "warning"\`. |
| \`network_failures\` | number | Count of \`network_error\` events. |
| \`js_exceptions\` | number | Count of \`js_exception\` events. |
| \`screenshots\` | number | Count of \`screenshot\` events. |
| \`pages_visited\` | string[] | Unique \`page_url\` values across the timeline. |

## Writing a bug report from this zip

1. **Start with the annotations.** They are the user's own words about
   what looked wrong. Each one carries a \`screenshot_id\` you can use
   to show what was on screen.
2. **Correlate each annotation with nearby errors.** Look for
   \`console_error\`, \`js_exception\`, and \`network_error\` events whose
   \`timestamp\` falls within a short window before the annotation —
   those are the most likely root cause signals.
3. **Reconstruct reproduction steps from \`interaction\` events.** Walk
   the timeline forward from session start, summarising click, input,
   scroll, and navigation events into a "steps to reproduce" list.
4. **Quote the failing requests verbatim.** For \`network_error\`
   events, include method, URL, and status. The sensitive headers have
   already been stripped, so what remains is safe to paste.
`;
