# Current Task: Feature #11 — Side panel session controls: lifecycle, feedback, gated UI, reset

- **Feature ID**: feature-11
- **Title**: Side panel session controls: lifecycle, feedback, gated UI, reset
- **Priority**: Now
- **Persona**: Bug Reporter
- **Impact**: High | **Effort**: Medium-Large
- **Branch**: feature/feature-11
- **Session**: orch-20260408-232745-23798
- **Started**: 2026-04-08

## Goal

Give the side panel a coherent session-control surface — controls that only appear when they're meaningful, clear async feedback, full lifecycle transitions (pause/resume/stop/discard), auto-scroll that respects user intent, and a clean reset between runs.

## Description

Five related pieces of control and polish for the side panel, all landing together since they touch the same form and event-list surface. Absorbs former feature #10 (lifecycle controls).

1. **Gated interaction and lifecycle controls** — annotation textarea, screenshot button, element-picker trigger, and all lifecycle controls (Pause/Resume/Stop/Discard) are hidden entirely (not disabled) when no session is active. Pre-session shows Start + PII selector + (conditionally) Reset + empty-state text.

2. **Loading feedback on async actions** — Save annotation, capture screenshot, and Stop & Download show loading state while work is in flight; errors remain visible to the user.

3. **Auto-scroll event list to newest event, respecting user intent** — if user is pinned to bottom, new events auto-scroll; if scrolled up, a "new events" affordance lets them jump manually.

4. **Session lifecycle controls (Pause / Resume / Stop / Discard)** — Pause suspends capture but preserves session; Resume re-enables without losing timeline; Stop finalises + exports; Discard is destructive with confirmation. Pause/Resume recorded as timeline markers in `session.json`. Metadata gets `status` field: `running` / `paused` / `stopped`.

5. **Reset between sessions** — when no session is active and residual state remains, a Reset button clears the panel to idle (no confirmation; Stop already preserved data, Discard already dropped it). Hidden when active session or no residual state.

## Definition of Done

See `docs/roadmap.md` feature #11. Summary:
- Gated controls: 4 checks (hide-not-disable, empty-state, reveal on start, hide on stop/discard)
- Loading feedback: 4 checks (save, capture, stop, error-visible)
- Auto-scroll: 2 checks (pinned auto-scroll, scrolled-up indicator)
- Lifecycle: 9 checks (4 controls, pause/resume behaviour, timeline markers, discard dialog, confirmed cleanup, cancel path, metadata status)
- Reset: 3 checks (rendered only when needed, no confirm, hidden when active)
- Tests: 1 check (gated visibility, loading, scroll, lifecycle state machine, discard cleanup, cancel, reset)

## Constraints

- Manifest V3 Chrome extension; vanilla TypeScript, no framework
- Preserves the tab-bound recording privacy invariant (feature #2)
- Existing tests must continue to pass
- Service worker terminations are expected — state lives in storage, not memory
- Side panel is the primary UI (feature #8); in-page widget was removed in feature #8

## Out of scope

- Changing the event capture pipeline (content script / service worker responsibilities stay the same)
- Changing the export schema except for the added `status` field and pause/resume timeline markers (which bumps `schema_version`)
- New feature work not listed in feature #11 DoD
