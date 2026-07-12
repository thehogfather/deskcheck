# DeskCheck

Chrome extension (Manifest V3) that records debugging sessions for AI-assisted bug fixing.

## Build & Run

```
make build        # typecheck + vite build + copy icons
make dev          # vite build --watch
make test         # vitest run
make typecheck    # tsc --noEmit
make clean        # rm -rf dist
```

Load the extension: `chrome://extensions` → enable Developer mode → Load unpacked → select `dist/`.

## Architecture

Three components, all vanilla TypeScript (no framework):

- **Service worker** (`src/background/`) — session lifecycle, chrome.debugger for console/network capture, screenshots, storage, export, side panel registration
- **Content script** (`src/content/`) — DOM event recording, element picker overlay (Shadow DOM). Triggered on demand by the side panel — no in-page widget
- **Side panel** (`src/sidepanel/`) — primary UI: start/pause/stop, live event feed, annotation textarea, element picker trigger, screenshot button, PII mode selector, session metrics, first-run notice, pre-export reminder. Replaces the legacy popup

Shared modules in `src/lib/`: session storage, debugger CDP client, exporter, DOM utilities, side panel render/storage/events-source helpers.

## Export Schema

The export is the product's core contract. A zip containing:
- `session.json` — chronological timeline of all events (interactions, console errors, network failures, annotations, screenshots)
- `screenshots/` — PNGs referenced by the timeline

Schema version (`schema_version` field) follows semver. Changes to the schema must bump this version.

## Testing

- **Framework**: Vitest
- **Pure functions**: tested without Chrome API mocks (dom-utils, exporter, encoding)
- **DOM tests**: use `// @vitest-environment jsdom` directive
- **Chrome API integration**: tested manually via extension load

## Versioning & Releases

Semver. `manifest.json` and `package.json` versions must always match (`make verify-version` checks this; CI enforces it).

```
make bump-patch     # 0.1.0 → 0.1.1 (also bump-minor / bump-major); syncs manifest.json
make package        # build + zip → build/deskcheck-vX.Y.Z.zip
make release-patch  # full release from main: guards, tests, bump, changelog, commit, tag
```

Releases are cut with `make release-{patch,minor,major}` (see `scripts/release.sh`), then published by pushing: `git push origin main --follow-tags`. The tag push triggers `.github/workflows/release.yml`, which verifies the tag matches the manifest versions, builds, packages, and creates a GitHub Release with the zip attached.

Release notes and `CHANGELOG.md` sections are generated from conventional commit subjects since the last tag by `scripts/release-notes.mjs` (feat/fix/perf surface; chore/docs/test/refactor/ci are excluded; `type!:` marks breaking changes). Write commit subjects accordingly — they are the changelog.
