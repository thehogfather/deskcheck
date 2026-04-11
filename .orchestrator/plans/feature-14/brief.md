# Feature #14 — CLI integration (Phase 1) — Planner Brief

This brief is shared by the Speed, Quality, and Safety planners for the feature-14 orchestration cycle. Read it in full before producing your plan.

## Orchestration scope

**This cycle plans PHASE 1 ONLY — the local handoff receiver.** Phase 2 (terminal-launched sessions via `deskcheck record <url>`) is an explicitly separate orchestration cycle and is OUT OF SCOPE here. The selected plan for this cycle should stop at the end of phase 1.

Phase 1 alone removes most of the friction the feature exists to fix: the developer runs `deskcheck listen` in one terminal, starts a normal recording session in the side panel, and the export lands at a known on-disk path instead of the Downloads folder. No Chrome-launch complexity, no hash-fragment detection, no side panel badge. Those all live in phase 2.

## Project context

DeskCheck is a Chrome MV3 extension that records debugging sessions for AI-assisted bug fixing. Vanilla TypeScript, no framework.

- **Repo**: `/Users/patrick/Documents/workspace/deskcheck` (we are currently in worktree `.claude/worktrees/feature+feature-14` on branch `worktree-feature+feature-14`)
- **Build**: `make build` (typecheck + vite build + copy icons)
- **Test**: `make test` (vitest run) · `make typecheck` (tsc --noEmit)
- **Platform**: macOS local development (per CLAUDE.md — no GNU-only tools, POSIX-compatible shell only)
- **Architecture doc**: `docs/ARCHITECTURE.md` — read this for the full component map. Highlights below.

### Component layout (relevant to this feature)

- **Service worker** (`src/background/service-worker.ts`) — session lifecycle, export orchestration, message routing. The `EXPORT_SESSION` code path today calls into `src/lib/exporter.ts` which produces a zip and triggers `chrome.downloads.download()`. This is where the listener POST needs to hook in.
- **Shared libraries** (`src/lib/`):
  - `exporter.ts` — `exportSessionStreaming(store, session)` is the production export path. Reads events via `store.readEvents()` and streams screenshots via `store.readScreenshots()` so the whole session is never held in memory. Returns a Blob that is currently handed to `chrome.downloads`.
  - `session-store-types.ts` — `SessionStore` port used by everything (exporter, metrics, service worker).
  - `opfs-session-store.ts` — production OPFS-backed implementation.
  - `agents-doc.ts` — schema version constant. **MUST NOT BUMP** — this feature is a transport change, not a schema change.
- **Side panel** (`src/sidepanel/sidepanel.ts`) — user clicks Stop → message to service worker → export flow. Side panel UI does not change in phase 1 (no badge, no new controls).

### Test framework and conventions

- **Vitest** (`vitest run`). `tests/` directory holds unit and integration tests.
- Pure functions tested without Chrome API mocks.
- DOM tests use `// @vitest-environment jsdom`.
- Chrome API integration tested manually via extension load — but Vitest with a fake `chrome` global is used heavily in existing tests. See `tests/service-worker-*.test.ts` for patterns.
- Fake SessionStore exists at `src/lib/fake-session-store.ts` — use for exporter tests.

## The feature (from roadmap, verbatim for phase 1 scope)

Full feature #14 entry lives at `docs/roadmap.md`. The phase-1-scoped subset is:

**Goal** — let a developer start a normal DeskCheck recording session in the side panel, and have the resulting export land directly at a known path accessible from the terminal (no download-and-drop step), so a shell caller (including Claude Code) can immediately read `session.json` without any manual upload.

**Phase 1 description** — a `deskcheck listen --out DIR` process exposes an HTTP endpoint on `127.0.0.1` that accepts token-authorised session uploads. The extension gains an "export to local listener" code path alongside the existing download: if a listener is reachable and the session carries a matching token, POST the zip; otherwise fall back to the download path. With only phase 1 shipped, the developer runs `deskcheck listen` in one terminal, starts a session in the side panel as normal, and the zip lands under `DIR/<session-id>/` instead of Downloads.

### Constraints (binding, not aspirational)

- **Security by default.** The HTTP listener MUST bind `127.0.0.1` only — verified by an automated test that attempts a non-loopback connect and asserts failure. Every session carries a cryptographically random token that MUST be presented on upload. Tokens are single-use and expire when the session ends or the CLI process exits. Unauthorised uploads are rejected with 401 and leave no artifact on disk.
- **Opt-in handoff.** The extension MUST NOT POST to a local listener without an explicit session-id/token marker in session metadata. Manual sessions started from the side panel today (no CLI) MUST continue to download via the existing path with zero behaviour change. A unit test pinning "no listener URL in metadata → no network traffic to localhost" is required.
- **Reuse the existing export path.** The listener receives the exact same zip a download would produce, byte-for-byte. Schema version (`schema_version` in `agents-doc.ts`) is UNCHANGED. This is a transport change, not a schema change.
- **macOS-first.** Project targets macOS for local development. The listener and CLI must run on macOS; Linux/Windows support is future work and not in DoD.
- **MCP wrapper deferred.** Out of scope for this feature entirely.
- **Phase 2 out of scope.** No Chrome launcher, no hash-fragment detection, no side panel badge, no `--profile isolated` mode. Those all live in phase 2 and should not be proposed or implemented here.

### DoD (phase 1 subset, verbatim from the roadmap)

- [ ] A `deskcheck` CLI ships in the repo (language TBD — Node to share types with the extension, or a single Go binary for zero-install distribution)
- [ ] `deskcheck listen --out DIR` starts a local HTTP server on 127.0.0.1, prints the bound port and a human-readable ready line, and writes received zips under `DIR/<session-id>/`
- [ ] The extension background worker POSTs a finished session zip to a local listener when session metadata carries a listener URL + token
- [ ] The listener validates the per-session token and rejects uploads that do not match
- [ ] The listener is verified to bind 127.0.0.1 only — attempts to connect from a non-loopback interface fail
- [ ] Manual (non-CLI) sessions continue to download via the existing path with no behaviour change
- [ ] Integration test: a session POSTs to a test listener and the resulting zip matches a reference download byte-for-byte

Plus the cross-cutting items that must land with phase 1:
- [ ] Unit tests cover token generation, uniqueness, expiry, and rejection of mismatched tokens
- [ ] The first-run notice and `PRIVACY.md` are updated to mention CLI handoff and the 127.0.0.1-only guarantee
- [ ] Export schema (`schema_version`) is unchanged — verified by test

## Key decisions each planner must make and justify

1. **CLI language / runtime.** Node (shares TypeScript types with the extension — same `session.json` shape, same `TimelineEvent` discriminated union, same test framework) vs. a single static Go binary (zero-install distribution, no `node_modules`, no engine version drift). Each has real tradeoffs — pick one with reasoning grounded in your optimization focus.

2. **Protocol contract shape.** What does the session metadata field look like that tells the service worker "POST to a listener instead of downloading"? What does the HTTP request look like (multipart, raw zip body, JSON envelope)? How is the token presented (header, query, body)? Where does the listener URL come from in phase 1 if there's no CLI-launched session yet? (Hint: for phase 1 the user must configure it somehow — options include chrome.storage, a small "attach to listener" UI affordance, or a fixed well-known port. Propose and justify.)

3. **Integration point in the service worker.** Where exactly in the export flow does the POST-vs-download branch happen? Does it go before or after the existing download path? What happens on POST failure — retry, fallback to download, or fail hard? (The opt-in constraint and the user-feedback constraint together mean the behaviour must be predictable and visible.)

4. **On-disk layout of received sessions.** `DIR/<session-id>/session.json + screenshots/*.png + agents.md + PRIVACY.md`? Or `DIR/<session-id>.zip` unzipped on request? Or both? Pick one with reasoning.

5. **Test strategy (Test Level Matrix).** For each DoD item above, map it to one of: unit / integration / e2e / manual-verify. Propose the smallest set of tests that pins each DoD item. The judge will use this matrix to generate acceptance tests, so it must be concrete.

6. **Rollback / kill switch.** If the listener integration ships broken, what's the fastest way to disable it without rolling back the whole PR? (Feature flag? Off-by-default config? No integration until a session metadata field is set?) The opt-in constraint already gives you most of this for free — note how.

## Research you must do before writing the plan

Read these files in the worktree. Do not guess — read them. The planner that pretends to know the codebase and is wrong will lose to the planner that grounds its plan in the actual code.

1. `src/background/service-worker.ts` — find the current `EXPORT_SESSION` / stop-and-download handler. Identify the exact line(s) where the listener POST hook would be added.
2. `src/lib/exporter.ts` — understand `exportSessionStreaming` and what it currently returns. Decide whether the listener POST consumes the Blob directly or whether the export function needs to be split.
3. `src/lib/session-store-types.ts` — the `SessionStore` port. Understand `session.metadata` shape so you can decide where to store the listener URL / token.
4. `src/types.ts` — session metadata and timeline event types.
5. `package.json` — understand the current build/test setup, so your CLI proposal fits (or justifies not fitting).
6. `Makefile` — see how existing commands are wired. Any new CLI needs a `make` target to match conventions.
7. `docs/ARCHITECTURE.md` — the Data Flow section, for how the export path is called end-to-end.
8. At least one existing test file in `tests/` — pick something recent like `tests/service-worker-*.test.ts` — to match the test style.

## Your output

Write your plan to `.orchestrator/plans/feature-14/<role>-plan.md` where `<role>` is `speed`, `quality`, or `safety` matching your agent type. Structure your plan as:

1. **Executive summary** — 3-5 bullets: what you'd ship, why, what's the risk
2. **Proposed architecture** — file list (new files + modifications), component responsibilities, protocol contract
3. **Implementation sequence** — numbered steps in dependency order, each with the concrete files to touch
4. **Test Level Matrix** — a table mapping each DoD item to test level (unit/integration/e2e/manual) with the test file name where it will live
5. **Risks and tradeoffs** — specific to your optimization focus (speed = what are we NOT testing, quality = what technical debt are we paying down, safety = what failure modes are we hardening)
6. **Effort estimate** — person-days, broken down by step
7. **Open questions for the judge** — anything you deliberately left unresolved, with the decision the judge should make

**You must only research and write the plan. Do NOT make code changes, do NOT create the CLI, do NOT modify the extension. The judge picks a winner and the implementer executes it in a later phase.**
