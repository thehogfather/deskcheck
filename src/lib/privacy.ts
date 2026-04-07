// Pure module — no Chrome imports. Single source of truth for the
// sensitive-data warning copy used by the in-widget first-run notice, the
// pre-export reminder panel, and the PRIVACY.md file shipped inside every
// export zip. Mirrors the shape of session-metrics.ts (constants + a small
// pure decision helper, fully unit-testable).

export const PRIVACY_NOTICE_BULLETS: readonly string[] = [
  "Screenshots capture the visible viewport of the browser tab being recorded. Other tabs, other browser windows, the browser chrome itself, and anything outside the page (OS overlays, notifications, other apps) are never captured.",
  "Form inputs in the recorded tab are stored as you type them (passwords are masked, but other field values — email addresses, search queries, free-text fields — are stored verbatim).",
  "Network request and response headers for failed requests in the recorded tab are stored. Well-known auth headers like Authorization and Cookie are stripped, but custom headers are not.",
] as const;

export const PRIVACY_REMINDER_LINE =
  "This export may contain screenshots and form inputs from the recorded tab that are sensitive. It is intended for local use only — review before sharing.";

export const PRIVACY_MD_TEMPLATE = `# Privacy notice

This DeskCheck session export is intended for **local use only**. Review the
contents before sharing it with anyone — including AI assistants — because the
captured data can include information that is sensitive.

## What is recorded

DeskCheck records a **single browser tab** — the one you were on when you
started the session. It does not record other tabs, other browser windows,
the browser chrome itself, your desktop, OS notifications, other applications,
or anything outside that tab's viewport. If you switch to a different tab
during a session, DeskCheck keeps recording the original tab and will refuse
to take screenshots until you switch back.

## What this export may contain

- **Screenshots** of the visible viewport of the recorded tab. Only the page
  content inside the tab is captured — nothing from outside the tab is ever
  included. Even so, the page itself can display sensitive information:
  account details, payment forms, personal data, internal tooling, etc.
- **Form inputs** that were typed into the recorded tab during the session.
  Password fields are masked, but every other input value is stored verbatim,
  including email addresses, search queries, and free-text fields.
- **Network request and response headers** for failed requests issued by the
  recorded tab. Well-known authentication headers (\`Authorization\`,
  \`Cookie\`, \`Set-Cookie\`, \`Proxy-Authorization\`, \`X-Api-Key\`) are
  stripped before storage, but any other custom headers — including bespoke
  session tokens or tenant identifiers — are kept as captured.

## Recommended workflow

1. Open the zip on the same machine that recorded the session.
2. Skim \`session.json\` and the \`screenshots/\` directory for anything that
   should not leave the machine.
3. Redact, delete, or recapture as needed before sharing.

DeskCheck never transmits session data over the network. Everything stays on
your machine until you choose to share it.
`;

/**
 * Decide whether to display the first-run privacy notice for this session.
 * Named for intent (rather than `!seen`) so the call site documents the
 * behaviour and so future "version-bumped re-prompt" logic has a hook.
 */
export function shouldShowFirstRunNotice(seen: boolean): boolean {
  return !seen;
}
