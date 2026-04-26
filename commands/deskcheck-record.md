---
description: Start a DeskCheck recording session against a URL and wait for the resulting zip, then surface findings from the captured session.
argument-hint: <target-url> [--timeout S]
---

The user wants to capture a browser session (console errors, failed network requests, DOM interactions, screenshots, annotations) and hand the result back to you — usually so you can diagnose a bug in the repo you're currently working in.

Invoke this from **any repo**, not the deskcheck repo. `deskcheck` is a global CLI; it knows where its own extension build lives.

## Prerequisites — verify once, then proceed

```sh
command -v deskcheck            # should print a path; if not, see below
```

If `deskcheck` is not on PATH, ask the user to run (once, in the deskcheck repo):

```sh
cd <path-to-deskcheck-checkout>
make build          # builds dist/ — the Chrome extension the CLI loads
npm link            # puts `deskcheck` on PATH
npx playwright install chromium   # Chrome for Testing; --load-extension is blocked on stable Chrome
```

Don't attempt the install yourself unless the user asks — it's their global tooling.

## Run the session

The target URL is `$ARGUMENTS`. Pick an `--out` directory **inside the current repo** (e.g. `./sessions/`) so the zip is easy to read back from here.

```sh
mkdir -p sessions
deskcheck record "$TARGET_URL" --out ./sessions --profile isolated --timeout 900
```

**Critical invocation notes:**
- Run this with `run_in_background: true` so you can keep responding to the user while they drive Chrome.
- The CLI prints `deskcheck: session: <hex-id>` on stderr at startup — capture it. That's the zip filename.
- `--profile isolated` launches a fresh Chrome for Testing with the DeskCheck extension pre-loaded. No signed-in profile needed, no interference with the user's browser.
- `--timeout 900` gives the user 15 minutes to reproduce. Bump higher for involved bugs.

## Brief the user clearly

The panel has **Download**, **Pause**, and **Discard** buttons. There is no "Stop". When a CLI handoff is armed (this flow), **Download** POSTs the zip to the listener instead of saving a file. Tell the user:

> Chrome is open on `<url>`. Reproduce the issue — click around, trigger the error, add annotations via the pencil/camera button if helpful. When done, click **Download** in the DeskCheck side panel and I'll pick up the results.

## Wait for the zip

Don't spin-poll. Use `ScheduleWakeup` at ~3 minute intervals. Background task exit codes:
- `0` — zip received at `sessions/<id>.zip`
- `3` — Chrome exited early (user closed the window without clicking Download)
- `4` — timeout (user walked away)
- `5` — user clicked Discard

## Surface findings

When exit code is `0`:

```sh
TMP=$(mktemp -d -t deskcheck-check)
unzip -q "sessions/<id>.zip" -d "$TMP"
python3 -m json.tool "$TMP/session.json"
```

Report back to the user:
- **Session meta** — `duration_ms`, `initial_url`, `pii_mode`, `status`
- **Findings** — every `timeline[]` entry of type `console_error`, `network_error`, `js_exception`, or `annotation`, quoting the error text / annotation text verbatim
- **Screenshots** — list the paths under `$TMP/screenshots/<ss_id>.png`; these are referenced by `screenshot_id` on annotations and some events
- **Summary counts** — `summary.total_events`, `summary.annotations`, `summary.console_errors`, `summary.network_failures`, `summary.js_exceptions`

Then, **without asking**, propose specific next debugging steps tied to what's in the repo — grep for the failing URL, read the file where the stack trace points, check for recent changes that could explain the error. The point of the whole flow is that you act on the findings, not just report them.

## Troubleshooting

- **"Extension build not found at ..."** — the deskcheck checkout's `dist/` doesn't exist. Tell the user to run `make build` in the deskcheck repo. For an alternate path, set `DESKCHECK_EXT_PATH=/path/to/dist`.
- **Exit code 3 right at launch** — Chrome for Testing not installed. `npx playwright install chromium`.
- **Panel shows "Listener unreachable, saved to Downloads instead"** — the upload 403'd. Check `~/Downloads/` for a `deskcheck-session-*.zip` timestamped during the session; it has the same content, just landed in the wrong place. Root cause is usually a session-id / token mismatch in the extension.
- **User says they don't see a Download button** — they're looking at the wrong UI. The DeskCheck side panel opens automatically when Chrome hits the marker; if they closed it, the extension icon in the toolbar reopens it.
