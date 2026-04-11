# deskcheck CLI

Local handoff receiver for DeskCheck session exports. Part of feature #14 phase 1.

## Usage (phase 1)

```sh
node cli/deskcheck.mjs listen --out ./sessions
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
