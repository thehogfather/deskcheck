# Validation Gate — feature-5 (OPFS persistence)

**Session**: `orch-20260407-222525-6254`
**Branch**: `feature/incremental-persistence-opfs`
**Run**: 2026-04-08 (Phase 5, first attempt — no retries)

## Automated gates

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `make typecheck` (→ `tsc --noEmit`) | PASS — exit 0, no diagnostics |
| Test suite | `make test` (→ `vitest run`) | PASS — 14 files, 205 passed, 0 failed |
| Build | `make build` (→ `tsc --noEmit && vite build && cp -r icons dist/icons`) | PASS — exit 0 |
| Build artefacts | `dist/manifest.json`, `dist/src/background/service-worker.js`, `dist/src/content/index.js`, `dist/src/popup/index.js`, `dist/icons/` | PRESENT |

Build output sizes:
- `service-worker.js` — 32.07 KB (gzip 11.69 KB)
- `content/index.js` — 19.09 KB (gzip 6.85 KB)
- `popup/index.js` — 2.43 KB (gzip 1.06 KB)
- `manifest.json` — 1.04 KB

## Test breakdown (new tests introduced in this PR)

| Test file | Tests | DoD items covered |
|-----------|-------|-------------------|
| `src/lib/jsonl.test.ts` | 10 | JSONL encode/decode contract (supporting #9) |
| `src/lib/session-store.test.ts` | 32 | contract suite run against BOTH `FakeSessionStore` and `OpfsSessionStore`. Covers DoD #1, #2, #5, #6 |
| `src/lib/opfs-session-store.test.ts` | 4 | DoD #5 (metadata-only `chrome.storage.local` isolation), recovery on SW wake (supporting #8), partial-line tolerance (supporting #9) |
| `src/lib/exporter.golden.test.ts` | 2 | DoD #7 (schema preservation, byte-for-byte golden fixture) |
| `src/lib/exporter.streaming.test.ts` | 2 | DoD #3 (streaming export memory bound, 1000 events + 100 × 100 KB screenshots) |

50 new tests total. All 155 pre-existing tests untouched and still passing.

## DoD coverage matrix

| DoD item (verbatim from `docs/roadmap.md`) | Evidence |
|---|---|
| Events are appended to an OPFS file incrementally, not accumulated in a chrome.storage.local array | `session-store.test.ts` contract suite — both impls |
| Screenshots are written as individual PNG files to OPFS, not stored as base64 data URLs | `session-store.test.ts` + `opfs-session-store.test.ts` |
| Export reads from OPFS and streams into the zip without loading the full session into memory | `exporter.streaming.test.ts` — peak resident bytes asserted below `3 × one screenshot` |
| Session recording works for 100+ screenshots and 1000+ events without service worker OOM | `exporter.streaming.test.ts` exercises the 100 × 100 KB + 1000 events shape through the streaming pipeline; **additionally** on the pre-merge manual smoke checklist because vitest cannot reproduce MV3 worker memory pressure |
| `chrome.storage.local` is used only for lightweight session metadata (not events or screenshots) | `opfs-session-store.test.ts` — "chrome.storage.local is metadata-only". No key containing "event" or "screenshot" written; only `STORAGE_SESSION` remains after a full lifecycle. Structural: `STORAGE_EVENTS` and `STORAGE_SCREENSHOTS` removed from `src/constants.ts` |
| Session metrics from feature #1 continue to work correctly with OPFS-backed storage, with size computed from actual OPFS footprint | `session-store.test.ts` contract tests for `computeByteSizes` + updated `session-metrics.test.ts` for the numeric `computeSessionMetrics` signature |
| Existing export schema is preserved (no breaking changes to `session.json`) | `exporter.golden.test.ts` byte-for-byte against `src/lib/__fixtures__/golden-session.json` (fixture covers every `TimelineEvent` variant) + existing `exporter.test.ts` assertions |

## Pre-merge manual smoke checklist

The MV3 service worker memory pressure and the real-Chrome wake/sleep
cycle cannot be reproduced under vitest; they are verified manually in
a clean Chrome profile before the PR merges. Results will be pasted
into the PR description.

- [ ] `make clean && make build` produces `dist/` with no warnings
- [ ] Load `dist/` via `chrome://extensions` → Load unpacked, clean Chrome profile; no errors shown
- [ ] Happy path: record on `https://example.com`, 5 interactions + 2 screenshots, Stop & Download. Zip opens; `session.json` parses; `screenshots/` has 2 PNGs
- [ ] OPFS verification during recording: `chrome://inspect/#service-workers` → DeskCheck → Application → Storage → File System shows `sessions/<id>/events.jsonl` (≥5 lines) and `sessions/<id>/screenshots/` (2 PNGs). After download, the session directory is gone
- [ ] Recovery: start session, record 10 events, stop the worker from `chrome://serviceworker-internals`, wait 5s, interact again. Badge still REC, next `seq` is 11, final export contains events 1–11 in order
- [ ] Feature-1 metrics: 50 events + 5 screenshots → widget shows event count 50, screenshot count 5, both sizes non-zero, all values update within 2s of each new event
- [ ] Large session: `for (let i=0;i<1000;i++) document.body.click()` in the page console + 100 screenshots via shortcut → `chrome://extensions` Errors stays empty, Stop & Download produces a zip that opens

## Gate decision

**PASS** (first attempt, no retries). Automated gates green.
Pre-merge manual smoke is tracked in the PR description.
