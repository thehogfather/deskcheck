# Feature #14 — CLI integration (Phase 2) — Planner Brief

This brief is shared by the Speed, Quality, and Safety planners for the **Phase 2** orchestration cycle of feature #14. Phase 1 already shipped in PR #14 (merged to `main`). Read this brief in full before producing your plan.

## Orchestration scope

**This cycle plans PHASE 2 ONLY — terminal-launched sessions via `deskcheck record <url>`.** Phase 1 (`deskcheck listen` + extension POST path + paste affordance) has already landed on `main` and is live. DO NOT re-plan or re-implement any Phase 1 item.

Phase 2 closes the remaining friction: instead of the user manually opening Chrome + pasting the ready-line into the side panel, a single `deskcheck record <url>` command launches Chrome against the URL, the extension auto-detects the handoff marker, the session is wired to the listener before the user even starts recording, and the CLI blocks until the zip arrives and then prints a JSON summary.

## Project context (recap from Phase 1)

DeskCheck is a Chrome MV3 extension that records debugging sessions for AI-assisted bug fixing. Vanilla TypeScript, no framework.

- **Repo**: `/Users/patrick/Documents/workspace/deskcheck` on branch `feature/feature-14-phase-2` (forked from `main`)
- **Build**: `make build` (typecheck + vite build + copy icons)
- **Test**: `make test` (vitest run) · `make typecheck` (tsc --noEmit) · `make e2e` (Playwright)
- **Platform**: macOS local development (per CLAUDE.md — no GNU-only tools)
- **Architecture doc**: `docs/ARCHITECTURE.md`

### Phase 1 deliverables already on main (DO NOT RE-PLAN THESE)

| Concern | File(s) | Role |
|---|---|---|
| CLI listener | `cli/deskcheck.mjs` | `deskcheck listen --out DIR [--port N]`, 127.0.0.1 bind, per-run bearer token, `POST /upload`, atomic tmp+rename writes, replay defence |
| CLI tests | `cli/deskcheck.test.mjs` | Loopback bind, auth, content-type, session-id regex, replay, golden zip, traversal |
| Handoff pure module | `src/lib/handoff.ts` | `isValidLoopbackUrl`, `constantTimeEqual`, `redactToken`, `isHandoffConfig` guard |
| Handoff store | `src/lib/handoff-store.ts` | `get/set/clearHandoffConfig` wrapper over `chrome.storage.local['deskcheck_handoff']` |
| Handoff POST | `src/background/handoff-post.ts` | `performHandoff(config, zipBytes, sessionId, fetch)` — 30s timeout, `redirect: "error"`, discriminated result |
| Integration hook | `src/background/service-worker.ts` `EXPORT_SESSION` case (lines 661-732) | Reads `getHandoffConfig()`; if present and URL passes `isValidLoopbackUrl`, calls `performHandoff` before the download fallback. `EXPORT_WARNING` broadcast on non-ok result. Only deletes the session if a transport succeeded. |
| Side panel affordance | `src/sidepanel/sidepanel.ts` lines 247-340 (`handoff-row`) | "Attach CLI listener" paste row — input + Attach/Detach buttons. Reads/writes `deskcheck_handoff` key directly (not a session metadata field). |
| Storage constant | `src/constants.ts` | `STORAGE_HANDOFF_CONFIG = "deskcheck_handoff"` |
| Message type | `src/types.ts` | `EXPORT_WARNING` broadcast for `#async-error` slot |
| Privacy copy | `PRIVACY.md`, first-run notice | 127.0.0.1-only guarantee |
| README | `README.md` | Phase-1 walkthrough (`deskcheck listen --out ./sessions` → paste into side panel → record → zip lands) |
| Schema version | `src/lib/agents-doc.ts` | UNCHANGED (transport change only) — must stay unchanged in Phase 2 as well |

**Structural invariant you must preserve**: Phase 1 keeps the listener URL + token in `chrome.storage.local['deskcheck_handoff']`, **NOT** in `SessionMetadata`. This is a privacy invariant — the listener URL and token never land in the exported `session.json`. Phase 2 must keep this invariant: whatever new storage you add for pending handoffs should also live outside `SessionMetadata`.

## Phase 2 scope (from roadmap, verbatim)

From `docs/roadmap.md` lines 135–143:

> **Phase 2 — terminal-launched sessions:**
> - [ ] `deskcheck record <url> [--timeout S] [--profile existing|isolated] [--json]` starts a listener, launches Chrome against the URL with the session marker in the hash, and blocks until a matching session arrives or the timeout fires
> - [ ] On success the CLI prints a JSON summary to stdout: `{session_id, path, events, screenshots, duration_s}` and exits 0; on timeout or cancellation it exits non-zero with a structured error
> - [ ] The extension content script detects the `#_deskcheck=ID:TOKEN:PORT` marker on page load, strips it from the visible URL, and passes it to the service worker
> - [ ] The service worker opens the side panel bound to that tab and pre-populates the session config with the supplied id, token, and listener URL
> - [ ] The side panel shows a visible "Connected to terminal session <id>" badge whenever a handoff is wired
> - [ ] Pause / Resume / Stop / Discard behave exactly as today; Discard cancels the pending handoff and the CLI receives a cancelled response
> - [ ] `--profile isolated` spins a dedicated `--user-data-dir` with `--load-extension=dist/` so the flow works on a clean machine without a pre-installed extension
> - [ ] macOS-native Chrome launch path works end-to-end; Linux/Windows are noted as future work in docs

### Constraints (binding, not aspirational)

- **Security by default, again.** The listener still binds 127.0.0.1 only (phase 1 test pins this — do not regress). The hash-fragment marker must carry a cryptographically random token; a page that forges a marker against an already-running `deskcheck record` must be rejected by token compare on the CLI side. The content script must strip the marker from the visible URL before any timeline event records the initial URL, so the token never lands in `session.json`.
- **Opt-in remains opt-in.** A page that happens to contain `#_deskcheck=...` but does not match a currently-running listener must be a no-op (no silent POST, no side panel auto-bind). The existing opt-in invariant — "no listener URL in session metadata → no network traffic to localhost" — must still hold for non-CLI sessions.
- **Reuse the existing export path and schema.** The listener receives the exact same zip a Phase 1 POST would produce. `schema_version` in `agents-doc.ts` stays put.
- **macOS-first.** The Chrome launcher is macOS-native; Linux/Windows support is future work and MUST be noted in docs but is NOT in the DoD.
- **`--profile isolated` must actually work on a clean machine.** Spin a dedicated `--user-data-dir` with `--load-extension=dist/` and verify (at least by manual walkthrough) that a fresh user-data-dir with no pre-installed DeskCheck still records a session end-to-end.
- **No schema bump.** This is still a transport change. `agents-doc.ts` schema version is frozen.
- **No MCP wrapper.** Still out of scope.
- **Reuse Phase 1 machinery wholesale.** The Phase 2 listener is the **same** `deskcheck listen` server started under a different CLI subcommand. The Phase 2 extension export path is the **same** `performHandoff` call. Do not duplicate.

## Key decisions each planner must make and justify

1. **Chrome launch on macOS.** How do you find and launch Chrome against a URL with a hash fragment? Options include: `open -na "Google Chrome" --args <url> --user-data-dir=...`, `osascript`, `child_process.spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ...)`, or something else. Each has real tradeoffs (user gesture in the extension, profile isolation, stdout noise). Pick one and justify. Note that Chrome MV3 side-panel gesture rules mean the extension CANNOT auto-open the panel without a user gesture unless the page triggers it — think carefully about what "gesture" the content script has on page load.

2. **Hash-fragment marker format.** The roadmap specifies `#_deskcheck=ID:TOKEN:PORT`. Is that the literal format, or should it be URL-encoded/base64/JSON? What happens if the user's URL already has a hash (`https://app.example.com/#/login` — a hash-based router)? How do you strip the marker from the visible URL without breaking the page's own hash? Propose a concrete grammar and a strip-and-preserve algorithm.

3. **Where does the content script live for the hash detection?** It must run before the page's own hash-based router, at `document_start`. Do you change `manifest.json` `content_scripts.run_at` from `document_idle` (current) to `document_start` for a new slim pre-recorder script, or do you add a new content script entry for the marker detection and keep the existing recorder at `document_idle`? Consider that `document_start` runs before `DOMContentLoaded`, which limits what DOM APIs are available, but `location.hash` and `history.replaceState` are always available.

4. **Pending-handoff storage on the extension side.** The CLI hands the listener URL + token over the hash fragment. The service worker must bind them to the tab BEFORE the user clicks Stop. Do you: (a) extend the existing `deskcheck_handoff` storage key to a per-tab map, (b) add a new `deskcheck_pending_handoffs` map keyed by tab id, or (c) keep it in-memory in the service worker only? Each has persistence / SW-wake implications. Pick one and justify.

5. **Service worker: opening the side panel without a user gesture.** `chrome.sidePanel.open()` strictly requires a user gesture (the existing code pins this at lines 100-150 in service-worker.ts). A content-script-triggered auto-open is NOT a gesture. What do you do? Options: (a) mark the handoff as "armed" and show a persistent Chrome action badge asking the user to click the toolbar action, (b) rely on the content script's `click` / `pointerdown` on the page as the gesture and forward it to the SW in a way Chrome counts (unreliable — Chrome resets the gesture when the message crosses processes), (c) something else. Pick a concrete behaviour for the first-page-load moment and justify.

6. **Side panel badge.** Where does the "Connected to terminal session <id>" badge live visually? What does it look like (text chip, icon, colour)? How does it read the pending handoff — via a new message type or by polling storage? Concrete UI spec in the plan.

7. **CLI `record` subcommand ergonomics.** What exactly does `deskcheck record <url>` print to stderr while it waits (so the user knows it hasn't hung)? What does `--json` change about stdout vs stderr? What does the exit code mean on timeout vs cancellation vs failed upload? What is the timeout default? Think like a user running this from a Claude Code shell tool.

8. **Discard cancels the pending handoff → CLI receives cancelled response.** The CLI is blocking on a zip arriving at `POST /upload`. If the user clicks Discard in the side panel, the CLI needs to wake up with a cancelled exit code. How does the extension signal this? Options: (a) the extension POSTs a `DELETE /session/<id>` or similar, (b) a sentinel body (`application/x-deskcheck-cancel`) to the existing `/upload`, (c) the CLI polls some extension-exposed state (you can't — the extension doesn't expose anything). Pick a clean mechanism and justify.

9. **Test strategy (Test Level Matrix).** For each DoD item above, map it to: unit / integration / e2e / manual-verify. The judge will use this matrix to generate acceptance tests, so it must be concrete and name the test file where each will live.

10. **Rollback.** If Phase 2 ships broken, what's the fastest way to disable it without reverting the whole PR? (Hint: a feature flag or the absence of a marker already gives you most of this. State it explicitly.)

## Research you must do before writing the plan

Read these files in the worktree. Do not guess — read them. The planner that pretends to know the codebase and is wrong will lose.

1. `cli/deskcheck.mjs` — the Phase 1 listener. Understand `startListener`, `formatReadyLine`, token generation, session-id replay defence. Your `record` subcommand reuses `startListener` directly.
2. `cli/deskcheck.test.mjs` — understand the test harness (how listeners are spawned and torn down) so you match the style.
3. `src/background/service-worker.ts` — specifically the `EXPORT_SESSION` case (lines 661-732), the `chrome.action.onClicked` listener (lines 228-253), the `enablePanelOnTab` / `scopeOtherTabsAwayFromBound` helpers (lines 158-210), and the `START_SESSION` case (lines 446-519). Your pre-bind path hooks into a new message handler that lives near these.
4. `src/content/index.ts` — the existing content script. Understand `GUARD`, `init`, `chrome.runtime.sendMessage({ type: "RECORD_EVENT" })`, and the fallbacks. Decide whether the marker detection goes in this file or a new one.
5. `src/lib/handoff.ts`, `src/lib/handoff-store.ts`, `src/background/handoff-post.ts` — the Phase 1 handoff machinery you are reusing unchanged.
6. `src/sidepanel/sidepanel.ts` lines 247-340 — the existing paste affordance. Your badge lives in a nearby region; you can reuse the CSS classes.
7. `manifest.json` — look at `content_scripts` and permissions. Decide if you need any new permissions (you should minimise) or a new `run_at`.
8. `docs/ARCHITECTURE.md` — the Data Flow section for how exports work end-to-end.
9. `Makefile` — `make demo`, `make build`, `make test`. Your `make record` target (if any) matches conventions here.
10. `tests/service-worker-handoff.test.ts` — the test matrix style for service-worker message handlers. Phase 2 tests should match.

## Your output

Write your plan to `.orchestrator/plans/feature-14-phase-2/<role>-plan.md` where `<role>` is `speed`, `quality`, or `safety` matching your agent type. Structure your plan as:

1. **Executive summary** — 3-5 bullets: what you'd ship, why, what's the risk
2. **Proposed architecture** — file list (new files + modifications), component responsibilities, hash-fragment grammar, Chrome launch strategy, pending-handoff storage, panel-open gesture strategy
3. **Implementation sequence** — numbered steps in dependency order, each with the concrete files to touch
4. **Test Level Matrix** — a table mapping each DoD item to test level (unit/integration/e2e/manual) with the test file name where it will live
5. **Risks and tradeoffs** — specific to your optimization focus (speed = what are we NOT testing, quality = what technical debt are we paying down, safety = what failure modes are we hardening)
6. **Effort estimate** — person-days, broken down by step
7. **Open questions for the judge** — anything you deliberately left unresolved, with the decision the judge should make

**You must only research and write the plan. Do NOT make code changes, do NOT extend the CLI, do NOT modify the extension. The judge picks a winner and the implementer executes it in a later phase.**
