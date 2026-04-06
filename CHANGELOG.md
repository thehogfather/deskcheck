# Changelog

All notable changes to Examiner will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-04-06

### Changed
- Extracted shared DOM utilities (getSelector, getElementInfo, throttle, isExaminerUi) to `src/lib/dom-utils.ts`
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
- Examiner UI click filtering (widget/picker interactions excluded from timeline)
