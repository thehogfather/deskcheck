#!/usr/bin/env node
// Feature #14 phase-1 CLI — local handoff receiver.
//
// Usage:
//   deskcheck listen --out DIR [--port N]
//
// Binds 127.0.0.1 (loopback only), generates a per-run bearer token, and
// accepts `POST /upload` from the DeskCheck extension with the zip in the
// request body. Writes each zip atomically to DIR/<session-id>.zip via
// a tmp file + rename. Single-use per session-id (replay returns 409).
//
// Implementation lands in Phase 4 of the feature-14 orchestration cycle.
// This stub exists so typecheck + test discovery pass in Phase 3.

console.error("deskcheck CLI not yet implemented (phase 4 of feature-14)");
process.exit(1);
