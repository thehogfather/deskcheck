# Current Task: Feature #8 — Side panel UX with live event timeline

- **Feature ID**: feature-8
- **Title**: Side panel UX with live event timeline
- **Priority**: Later (claimed for active work)
- **Persona**: Bug Reporter
- **Effort**: Large
- **Branch**: feature/side-panel-ux
- **Session**: orch-20260407-222834-15236
- **Started**: 2026-04-07

## Goal

Move the primary DeskCheck UI from the browser-action popup into a Chrome **side panel** (`chrome.sidePanel` API) that fills the full height of the browser window. The side panel persists across tab switches and shows a live, scrollable event feed above a sticky control form.

## Description

Visually modelled on the Claude Chrome extension's side panel: a scrollable event feed in the upper region, a sticky input/control form pinned to the bottom. The upper region shows a chronological list of captured events — DOM interactions, console errors, network failures, annotations, and screenshots — each with its timestamp. Any event that has an associated image (screenshots, annotation attachments) renders a small thumbnail inline. The lower region contains the existing session form (start/stop, annotation textarea, screenshot button, session metrics).

## Definition of Done

- [ ] Extension registers a side panel via `chrome.sidePanel`; clicking the toolbar action opens the side panel directly (no popup in between)
- [ ] Legacy popup HTML/JS is removed from the build (or reduced to a no-op launcher that immediately opens the side panel)
- [ ] The "Start Session" control lives in the side panel form, not in a popup
- [ ] Side panel fills the full browser height and renders a two-region layout (events above, form below)
- [ ] Upper region shows a live, chronological list of all captured events with per-event timestamp and type label
- [ ] Events that include a screenshot render a small thumbnail inline in the list
- [ ] Event list updates in real time as new events are captured (no manual refresh)
- [ ] Lower region contains the existing controls: start/stop, annotation textarea, screenshot, session metrics from feature #1
- [ ] Event list scrolls independently of the form region; form stays pinned to the bottom
- [ ] Side panel state (open/closed, scroll position) persists across tab switches within the same window
- [ ] Visual styling is consistent with the existing widget theme and matches the reference side-panel aesthetic (dark theme, rounded input, compact list rows)

## Constraints

- Manifest V3 Chrome extension; vanilla TypeScript, no framework
- Must preserve the privacy invariant from feature #2: tab-bound recording, `canCaptureRecordedTab()` gate stays intact
- Existing in-page widget (annotation overlay, element picker) stays — the side panel is the **chrome UI** (start/stop/metrics/event list), not a replacement for the in-page widget
- Existing tests must continue to pass; new tests required for side-panel logic
- `chrome.sidePanel` API is async; service worker may be terminated between events, so event-list updates must be driven by `chrome.storage.onChanged` or `chrome.runtime` messages, not in-memory subscriptions

## Out of scope

- Lifecycle controls (pause/resume/discard) — feature #10, depends on this
- Tab group visualization — feature #9, ships independently
- Refactoring the in-page widget itself (only the popup is being removed/reduced)
