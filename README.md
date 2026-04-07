# DeskCheck

A Chrome extension (Manifest V3) that records debugging sessions for AI-assisted bug fixing. Captures user interactions, console errors, network failures, JS exceptions, screenshots, and your own annotations into a single exportable zip file.

## What it does

When you hit a bug you can't easily reproduce in words, start a DeskCheck session, repro the bug, and stop. You get a zip containing:

- `session.json` — chronological timeline of every click, input, scroll, navigation, console error, network failure, and JS exception
- `screenshots/` — PNGs captured manually or via annotations
- Annotations — your own notes attached to specific moments or DOM elements

The export is designed to be self-contained and easy for an AI assistant (or a colleague) to interpret.

## Install

DeskCheck is not yet on the Chrome Web Store. To install locally:

1. Clone this repo
2. Run `make build`
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `dist/` directory

## Usage

1. Click the DeskCheck icon → **Start Session**
2. Reproduce the bug — the floating widget on the bottom-right shows live metrics (duration, event count, size)
3. Use the widget to take screenshots, select an element, or add a note
4. Click **Stop & Download** to export the session zip

## Develop

```sh
make build       # typecheck + vite build + copy icons
make dev         # vite build --watch
make test        # vitest unit tests
make test-e2e    # Playwright E2E tests (launches Chrome with the extension)
make typecheck   # tsc --noEmit
make clean       # rm -rf dist
```

After `make build`, reload the extension at `chrome://extensions` to pick up changes.

## Architecture

Three components, all vanilla TypeScript (no framework):

- **Service worker** (`src/background/`) — session lifecycle, `chrome.debugger` for console/network capture, screenshots, storage, export
- **Content script** (`src/content/`) — DOM event recording, floating annotation widget (closed Shadow DOM), element picker
- **Popup** (`src/popup/`) — minimal session-start trigger

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for details and [`docs/roadmap.md`](docs/roadmap.md) for planned features.

## Privacy

DeskCheck is designed for **local use**. All data stays on your machine — no external network requests are made by the extension. Screenshots can capture sensitive content visible on screen, and form inputs are recorded (passwords are masked, sensitive HTTP headers like `Authorization`/`Cookie` are stripped from network errors). Review your export before sharing it.

## License

TBD.
