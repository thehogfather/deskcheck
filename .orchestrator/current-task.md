# Current task: Feature #14 — CLI integration (Phase 2)

- **Feature ID**: feature-14-phase-2
- **Title**: CLI integration Phase 2 — terminal-launched sessions (`deskcheck record <url>`)
- **Roadmap entry**: `docs/roadmap.md` → Priority: Now → #14 → Phase 2 DoD (lines 135-143)
- **Cycle scope**: **Phase 2 only** — terminal-launched sessions. Phase 1 already shipped in PR #14.
- **Priority**: Now (claimed for active work)
- **Persona**: Bug Reporter (primary), AI Consumer (secondary)
- **Effort**: Large (Chrome launcher + content script + service worker pre-bind + side panel badge + CLI subcommand + tests)
- **Branch**: `feature/feature-14-phase-2`
- **Session ID**: `orch-20260411-234231-94601`
- **Started**: 2026-04-11
- **Orchestrator cycle**: three-plan competition with autonomous implementation through PR creation

## Phase status

- [x] Phase 0: initialize workspace + worktree + brief
- [ ] Phase 1: generate 3 competing plans (speed / quality / safety)
- [ ] Phase 2: judge selects plan + generates Test Level Matrix
- [ ] Phase 3: generate acceptance tests (failing)
- [ ] Phase 4: implement until acceptance tests pass
- [ ] Phase 5: automated validation gate
- [ ] Phase 6: architecture + roadmap update + PR

## Brief

Full planner brief at `.orchestrator/plans/feature-14-phase-2/brief.md`. That document is the contract the three planners and the judge read.

## Goal (one paragraph)

Let a developer run `deskcheck record <url>` in one terminal, have Chrome launch with the URL + a session marker in the hash fragment, have the extension content script detect the marker and wire the session to the listener before the user even starts recording, and have the terminal block until the zip arrives then print a JSON summary. Everything built on top of Phase 1's `deskcheck listen` + `performHandoff` + `deskcheck_handoff` storage key — the Phase 2 listener IS the same listener, under a different CLI subcommand.

## Binding constraints for this cycle

1. **Security**: listener still binds 127.0.0.1 only; hash-fragment token is cryptographically random; content script strips marker before any timeline event captures the URL.
2. **Opt-in**: a page with a stray `#_deskcheck=...` that does not match a live listener must be a no-op.
3. **Schema unchanged**: `schema_version` in `agents-doc.ts` stays put.
4. **macOS-first**: Linux/Windows are future work.
5. **No Phase 1 regressions**: the existing paste affordance continues to work; the existing tests stay green.
6. **Reuse, don't duplicate**: Phase 2 imports `startListener`, `performHandoff`, `HandoffConfig` — it does not re-implement any of them.

## Out of scope for this cycle

- MCP wrapper (still deferred).
- Linux / Windows Chrome launch.
- Schema changes.
- Any re-implementation of Phase 1 machinery.
