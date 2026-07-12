# Changelog

All notable changes to DeskCheck will be documented in this file.

Since v0.2.0, sections are generated at release time from conventional commit
subjects (`scripts/release-notes.mjs`) — the same notes published on each
[GitHub Release](https://github.com/thehogfather/deskcheck/releases).

## [0.6.0] - 2026-07-12

### Features
- prebuilt extension packages via GitHub Releases
- opt-in tab switching during a session
- two-row toolbar — status above controls
- pause-first lifecycle simplification
- freeze PII capture mode at session start
- persistent CLI handoff status badge in toolbar
- replace Unicode/CSS-mask icons with Lucide SVG nodes
- open side panel UI in popup window on marker detection
- auto-open side panel on marker detection
- CLI record subcommand + chrome launcher + tests
- extension-side implementation
- side panel "Attach CLI listener" affordance + privacy copy update
- wire EXPORT_SESSION to the CLI handoff path
- implement handoff module chain + CLI listener
- standalone dogfooding mode
- bigger picker icon with 'select' label + crosshair cursor
- polish toolbar and picker UX
- side panel control layout refinement
- auto-group recording tabs under a DeskCheck label
- side panel session controls (lifecycle, feedback, gated UI, reset)
- schema 1.2.0 + lifecycle state machine + store facade
- bridge side panel live feed to OPFS via runtime broadcasts
- OPFS-backed incremental persistence (closes #5)
- remove in-page widget; element picker + pause + reminder in side panel
- inline-only annotation screenshots + always-visible 100px thumbs
- side panel UX replaces popup
- pure lib modules for side panel UX
- record exact per-class counts in metadata mode
- add Full/Metadata/None capture modes for input events
- ship agents.md schema doc inside every export
- add sensitive-data warnings (feature #2)

### Fixes
- harden tab switching — review findings from PR #23
- recompute controls after events snapshot hydrates
- skip dispatch when work-in-progress signals are present
- support feature-numbered roadmaps
- detect direct invocation via realpath
- make deskcheck CLI usable from any repo
- extension adopts CLI session_id as session.id
- open panel as tab via CDP for isolated profiles
- use Chrome for Testing for --profile isolated
- isolated profile uses chrome://extensions + CDP navigation
- add --disable-extensions-except for isolated profile
- picker button sizing and crosshair icon visibility
- annotation textarea auto-grows, hide resize handle, fix icon rendering
- hide hint text on all PII segments, not just unselected ones
- address dogfooding feedback on icon alignment, PII weight, picker position
- remove color:transparent from .btn-icon so SVG masks render
- load CSS via JS import instead of HTML link
- restore data URL export path + update e2e metrics helper
- bind-on-open side panel + e2e coverage for new UX
- scope screenshots to the recorded tab, tighten copy

### Other
- judge selects quality plan + 7 safety grafts
- three competing plans (speed/quality/safety)
- Add Playwright E2E test infrastructure
- Split size display into events and screenshots
- Add live session metrics bar to widget overlay
- Add session metrics pure module with acceptance tests
- Add architecture docs, gitignore orchestrator artifacts
- Consolidate UI into widget overlay, debounce input events, update icon
- Fix security and error-handling issues before open-source release
- Rename extension from Examiner to DeskCheck

## [0.2.0] - 2026-04-06

### Changed
- Extracted shared DOM utilities (getSelector, getElementInfo, throttle, isDeskCheckUi) to `src/lib/dom-utils.ts`
- Extracted cropScreenshot to `src/lib/image-utils.ts`
- Decoupled exporter from session-store — `exportSession()` is now a pure function
- Extracted takeScreenshot to `src/background/screenshot.ts`
- Extracted bytesToBase64 to `src/lib/encoding.ts`
- Converted DebuggerClient from module singleton to class
- Service worker reduced from 295 to 220 lines

### Added
- Vitest test infrastructure with 37 unit tests
- Project CLAUDE.md with build/test/architecture docs
- Makefile with dev, build, test, typecheck, clean, bump targets
- CHANGELOG.md

### Removed
- Dead `isActiveTab()` function from content script
- Duplicate `getSelector`/`getElementInfo` implementations

## [0.1.0] - 2026-04-06

### Added
- Session recording: clicks, text input, scroll, viewport resize, SPA navigation
- DevTools capture via chrome.debugger: console errors, network failures, JS exceptions
- Annotation widget with element picker (Shadow DOM)
- Element screenshot cropping on annotation
- Tab-scoped recording (only records events from session tab)
- Automatic content script injection on extension install/update
- Export as zip (session.json + screenshots)
- Keyboard shortcuts: Alt+Shift+R (toggle session), Alt+Shift+S (screenshot), Alt+Shift+A (annotation)
- Chrome extension noise filtering (chrome-extension:// URLs excluded)
- DeskCheck UI click filtering (widget/picker interactions excluded from timeline)
