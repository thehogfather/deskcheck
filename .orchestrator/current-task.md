---
feature_id: feature-2
title: Sensitive data warnings
persona: Bug Reporter
priority: now
session_id: orch-20260407-203409-26891
branch: feature/sensitive-data-warnings
worktree: .claude/worktrees/feature-sensitive-data-warnings
started: 2026-04-07
---

# Feature #2 — Sensitive data warnings

## Goal
Prevent accidental sharing of sensitive information in DeskCheck exports.

## Description
Show a one-time notice when recording starts explaining that screenshots capture
everything visible on screen. Show a reminder before export that the zip may
contain sensitive data and is intended for local use only. Include a brief
privacy note in the export zip itself.

## Definition of Done (acceptance criteria)
1. First-run notice appears when a session starts (dismissible, shown once per install).
2. Pre-export reminder appears in the widget when "Stop & Download" is clicked.
3. Export zip includes a `PRIVACY.md` noting that screenshots may contain sensitive data.
4. Notice text explains that DeskCheck captures visible screen content, form inputs, and network headers.

## Constraints
- Must remain a local-only Chrome MV3 extension (no network requests).
- Must not block users from completing core flows; both notices are reminders, not gates the user cannot bypass.
- The `schema_version` field need not change — `PRIVACY.md` is a sibling artifact in the zip, not part of `session.json`.

## Out of scope
- Persistent privacy preferences across multiple installs (sync storage)
- Configurable warning thresholds beyond the simple "shown once" toggle
- Redaction or scrubbing of captured data (covered by feature #4)

## Notes
- "Once per install" persistence: use `chrome.storage.local` for the dismissed flag.
- The pre-export reminder needs to surface in the widget UI. Stopping is a single
  action — the reminder must not be a long modal flow; a confirm step is acceptable
  if it is clear and dismissible in one click.
