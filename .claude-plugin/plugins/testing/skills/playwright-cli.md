---
name: playwright-cli
description: Reference for browser automation via Playwright CLI. Covers the snapshot-act loop, session management, and command reference. Use when performing E2E testing, browser automation, or debugging web applications.
---

# Playwright CLI Reference

`@playwright/cli` provides browser automation through shell commands, designed for AI agent workflows. It is more token-efficient than MCP-based browser tools because it avoids schema loading and verbose accessibility tree output.

## Installation

```bash
npm install -g @playwright/cli@latest
playwright-cli install-browser
```

Or use via npx: `npx playwright-cli <command>`

## The Snapshot-Act Loop

The fundamental pattern for all browser interactions:

```
snapshot → read refs → act (click/fill/type) → snapshot → verify
```

1. **`snapshot`** returns a structured representation of the page with numbered element refs
2. Read the snapshot to find the target element's ref number
3. Perform an action using that ref (`click ref5`, `fill ref8 "text"`)
4. **`snapshot`** again to confirm the action worked
5. Repeat until the test workflow is complete

This loop replaces manual CSS/XPath selectors with dynamic ref-based targeting.

## Session Management

Use `-s=<name>` to maintain browser state across commands:

```bash
playwright-cli -s=mytest open http://localhost:3000
playwright-cli -s=mytest snapshot
playwright-cli -s=mytest click ref4
playwright-cli -s=mytest snapshot
playwright-cli -s=mytest close
```

Without `-s`, each command starts a fresh browser. Sessions persist cookies, auth state, and page context.

List and manage sessions:
```bash
playwright-cli list          # list active sessions
playwright-cli close-all     # close all sessions
playwright-cli kill-all      # force kill zombie sessions
```

## Command Reference

### Core Interaction
| Command | Description |
|---------|-------------|
| `open [url]` | Open browser, optionally navigate to URL |
| `close` | Close browser |
| `goto <url>` | Navigate to URL |
| `snapshot` | Capture page state with element refs |
| `screenshot [ref]` | Screenshot page or specific element |
| `click <ref> [button]` | Click element (button: left/right/middle) |
| `dblclick <ref>` | Double-click element |
| `fill <ref> <text>` | Clear and fill input field |
| `type <text>` | Type into focused element (appends) |
| `hover <ref>` | Hover over element |
| `select <ref> <val>` | Select dropdown option |
| `check <ref>` | Check checkbox/radio |
| `uncheck <ref>` | Uncheck checkbox |
| `upload <file>` | Upload file(s) |
| `drag <startRef> <endRef>` | Drag and drop |

### Keyboard
| Command | Description |
|---------|-------------|
| `press <key>` | Press key (e.g., `Enter`, `Tab`, `ArrowDown`) |
| `keydown <key>` | Key down event |
| `keyup <key>` | Key up event |

### Navigation
| Command | Description |
|---------|-------------|
| `go-back` | Browser back |
| `go-forward` | Browser forward |
| `reload` | Reload page |

### Tabs
| Command | Description |
|---------|-------------|
| `tab-list` | List all tabs |
| `tab-new [url]` | Open new tab |
| `tab-close [index]` | Close tab |
| `tab-select <index>` | Switch to tab |

### Inspection
| Command | Description |
|---------|-------------|
| `console [min-level]` | View console messages |
| `network` | View network requests since page load |
| `eval <func> [ref]` | Run JavaScript on page or element |
| `show` / `devtools-start` | Open browser DevTools |

### Storage & Auth
| Command | Description |
|---------|-------------|
| `state-save [file]` | Save auth/storage state to file |
| `state-load <file>` | Load auth/storage state from file |
| `cookie-list` | List cookies |
| `cookie-set <name> <value>` | Set cookie |
| `cookie-clear` | Clear all cookies |
| `localstorage-list` | List localStorage entries |
| `localstorage-set <key> <value>` | Set localStorage entry |
| `delete-data` | Clear all session data |

### Recording & Debugging
| Command | Description |
|---------|-------------|
| `tracing-start` / `tracing-stop` | Record trace |
| `video-start` / `video-stop` | Record video |
| `resize <w> <h>` | Resize browser window |

### Network Mocking
| Command | Description |
|---------|-------------|
| `route <pattern>` | Mock requests matching URL pattern |
| `route-list` | List active routes |
| `unroute [pattern]` | Remove route(s) |

## Options

| Flag | Description |
|------|-------------|
| `-s=<name>` | Named session (persists across commands) |
| `--headed` | Show browser window (default: headless) |
| `--help [command]` | Help for specific command |
| `--version` | Print version |

## Why CLI over MCP

- **Token efficiency**: No tool schemas loaded into context, no verbose accessibility trees
- **Composable**: Pipe commands, chain with `&&`, use in shell scripts
- **Debuggable**: Add `--headed` to watch the browser, use `screenshot` for evidence
- **Sessionful**: `-s=<name>` maintains state without reconnecting
