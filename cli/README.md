# deskcheck CLI

Local handoff receiver for DeskCheck session exports. Two subcommands: `listen` (long-running) and `record` (one-shot).

## Install globally

Do this once, from a deskcheck checkout, so `deskcheck` is on your PATH for use in any product repo:

```sh
make build                          # extension bundle the CLI loads
npm link                            # `deskcheck` on PATH
npx playwright install chromium     # Chrome for Testing (stable Chrome blocks --load-extension)
```

After that you can run `deskcheck record https://my.app` from any working directory — the CLI resolves its own extension `dist/` relative to the install location, so cwd doesn't matter. Override with `DESKCHECK_EXT_PATH=/path/to/dist` for dev.

### Optional: Claude Code slash command

If you use Claude Code, install the `/deskcheck-record` slash command so an agent in any product repo can drive the flow end-to-end (run the session, wait for the zip, surface findings):

```sh
# symlink keeps it in sync with this repo (recommended)
mkdir -p ~/.claude/commands
ln -sf "$PWD/commands/deskcheck-record.md" ~/.claude/commands/deskcheck-record.md
# or copy if you prefer not to symlink
# cp commands/deskcheck-record.md ~/.claude/commands/
```

Then in any project, type `/deskcheck-record https://your-app.local` and the agent takes it from there.

## `deskcheck record <url>` — one-shot capture

```sh
deskcheck record https://my.app --out ./sessions --profile isolated --timeout 900
```

Spawns a listener on 127.0.0.1, launches Chrome for Testing pointed at `<url>` with the DeskCheck extension pre-loaded and a handoff marker in the URL fragment. The session panel opens automatically. Reproduce the bug, then click **Download** in the panel — that POSTs the zip back to the listener and the CLI exits with a JSON summary on stdout. Exit codes: `0` success, `3` Chrome exited early, `4` timeout, `5` user discarded.

Intended for AI-assisted debugging: an agent (e.g. Claude Code running `/deskcheck-record`) calls this, waits for the zip at `sessions/<id>.zip`, unpacks `session.json`, and acts on the captured errors, network failures, and annotations.

## `deskcheck listen --out DIR` — long-running listener

```sh
deskcheck listen --out ./sessions
```

Starts a loopback HTTP server on a kernel-assigned `127.0.0.1` port. Prints a ready line with the bound URL and a per-run bearer token:

```
deskcheck listener ready
  url:   http://127.0.0.1:54329
  out:   /abs/path/to/sessions
  token: <64 hex chars>

Copy-paste into DeskCheck side panel → Attach CLI listener:
  http://127.0.0.1:54329 <64 hex chars>
```

Copy the last line and paste it into the DeskCheck side panel's "Attach CLI listener" input. From that point every session you export from the extension will POST directly to the listener and land at `./sessions/<session-id>.zip` instead of your Downloads folder.

## Security

- Binds `127.0.0.1` only. Non-loopback interfaces are refused at the kernel level.
- Per-run bearer token, required via `Authorization: Bearer <token>` header. Mismatches return 401 with no file written.
- Single-use per session id. A second upload for the same session id returns 409 (the first write is retained).
- Atomic file writes via temp-then-rename. A crash mid-upload leaves at most a `.tmp-*` file, never a half-written `<session-id>.zip`.
- Zero runtime dependencies — stdlib `http`, `fs/promises`, `crypto`, `path` only.
