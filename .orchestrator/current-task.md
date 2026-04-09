# Current Task

- **Feature ID**: feature-5
- **Title**: Incremental persistence (OPFS)
- **Priority**: Next
- **Persona**: Bug Reporter
- **Branch**: feature/incremental-persistence-opfs
- **Session**: orch-20260407-222525-6254
- **Started**: 2026-04-07

## Goal

Eliminate the memory ceiling for long recording sessions. Replace the current
`chrome.storage.local` accumulation model with streaming writes to the Origin
Private File System (OPFS). Events are appended to a file as they arrive;
screenshots are written as individual PNGs rather than held as base64 strings
in memory. On export, files are zipped directly from OPFS without loading the
full session into memory.

## Dependencies

- Feature #1 (session size indicator) — DONE. The indicator's size calculation
  must be updated to work with OPFS-backed storage (size computed from actual
  OPFS footprint).

## Definition of Done (from roadmap)

- [ ] Events are appended to an OPFS file incrementally, not accumulated in a
      chrome.storage.local array
- [ ] Screenshots are written as individual PNG files to OPFS, not stored as
      base64 data URLs
- [ ] Export reads from OPFS and streams into the zip without loading the full
      session into memory
- [ ] Session recording works for 100+ screenshots and 1000+ events without
      service worker OOM
- [ ] `chrome.storage.local` is used only for lightweight session metadata
      (not events or screenshots)
- [ ] Session metrics from feature #1 (duration, event/screenshot counts,
      size) continue to work correctly with OPFS-backed storage, with size
      computed from actual OPFS footprint
- [ ] Existing export schema is preserved (no breaking changes to
      `session.json`)

## Non-goals

- Changing the `session.json` schema or the shape of individual timeline events
- Adding OPFS fallback for non-Chrome browsers (the extension is Chrome-only)
- Cross-session migration of data written under the old storage model
