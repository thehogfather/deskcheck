---
description: Start a DeskCheck recording session and wait for the resulting zip so findings can be surfaced back to the user.
argument-hint: <target-url> [--timeout S]
---

Run the DeskCheck record flow against `$ARGUMENTS`, wait for the user to reproduce a bug and click **Download** in the side panel, then unzip the result and summarise what was captured.

## Steps

1. **Build the extension if `dist/` is missing.** The launcher points `--load-extension` at `dist/`; a fresh clone has no build.

   ```sh
   [ -d dist ] || make build
   ```

2. **Verify an extension-capable Chrome is available.** Stable Google Chrome blocks `--load-extension`; the launcher uses Playwright's bundled Chrome for Testing, system Chromium, or Canary. Playwright's copy is the most reliable — install it if missing:

   ```sh
   [ -d "$HOME/Library/Caches/ms-playwright" ] || npx playwright install chromium
   ```

3. **Kick off the record flow in the background.** Use `run_in_background: true` on the Bash call so you can keep working while the user drives Chrome. Allow ≥15 min for the user to reproduce — pass `--timeout 900` or higher if the default is too tight.

   ```sh
   mkdir -p sessions
   node cli/deskcheck-record.mjs "$TARGET_URL" --out ./sessions --profile isolated --timeout 900
   ```

   The CLI prints the generated hex `session: <id>` on stderr — capture it; that's the filename the zip will land at.

4. **Tell the user what to do.** The side panel has **Download, Pause, Discard** (no "Stop" button). With a CLI handoff armed, clicking **Download** POSTs to the listener instead of saving a file. Phrasing to use:

   > Chrome is open on `<url>`. Reproduce the issue, then click **Download** in the DeskCheck side panel. I'll pick up the zip automatically.

5. **Poll for the zip.** The background task exits with code `0` when the upload lands, `3` when Chrome exits early, `4` on timeout, `5` on user Discard. Use `ScheduleWakeup` at ~3-minute intervals; don't spin-poll.

6. **When the zip arrives, unpack and summarise.**

   ```sh
   TMP=$(mktemp -d -t deskcheck-check)
   unzip -q "sessions/<session-id>.zip" -d "$TMP"
   cat "$TMP/session.json" | python3 -m json.tool
   ```

   Surface back to the user, concisely:
   - `session.duration_ms`, `initial_url`, `pii_mode`
   - Every `timeline[]` entry of type `console_error`, `network_error`, `js_exception`, or `annotation` (with text + screenshot_id)
   - `summary.total_events` / `annotations` / failure counts

7. **Propose next debugging steps** based on what's in the timeline — cite `page_url` and screenshot paths (`$TMP/screenshots/<ss_id>.png`) so the user can look.

## Troubleshooting

- **Exit code 3 (chrome_exited) right after launch** — Chrome for Testing not found. Run `npx playwright install chromium` and retry.
- **Exit code 4 (timeout) after user clicked Download** — the upload 403'd and the extension fell back to file download. Check `~/Downloads/` for a `deskcheck-session-*.zip` from today, and verify the `session_id_hint` carry-through in `src/background/service-worker.ts` MARKER_DETECTED handler is still wired.
- **Panel says "Listener unreachable, saved to Downloads instead"** — same as above; the listener port may have died or the token/session mismatch fired.
- **User clicks something called "Stop"** — there isn't one. The button they want is **Download**.
