# Current task: Feature #14 — CLI integration (Phase 1)

- **Feature ID**: feature-14
- **Title**: CLI integration: terminal-launched sessions with automatic handoff
- **Roadmap entry**: `docs/roadmap.md` → Priority: Now → #14
- **Cycle scope**: **Phase 1 only** — local handoff receiver (`deskcheck listen`). Phase 2 (terminal-launched sessions) is a separate orchestration cycle.
- **Priority**: Now (claimed for active work)
- **Persona**: Bug Reporter (primary), AI Consumer (secondary)
- **Effort**: Medium (phase 1 in isolation; ~3–5 days of focused work)
- **Branch**: `worktree-feature+feature-14`
- **Worktree**: `.claude/worktrees/feature+feature-14`
- **Started**: 2026-04-11
- **Orchestrator cycle**: three-plan competition with autonomous implementation through PR creation

## Phase status

- [x] Phase 0: initialize workspace + worktree
- [ ] Phase 1: generate 3 competing plans (speed / quality / safety)
- [ ] Phase 2: judge selects plan + generates Test Level Matrix
- [ ] Phase 3: generate acceptance tests (failing)
- [ ] Phase 4: implement until acceptance tests pass
- [ ] Phase 5: automated validation gate
- [ ] Phase 6: architecture + roadmap update + PR

## Brief

Full planner brief at `.orchestrator/plans/feature-14/brief.md`. That document is the contract the three planners and the judge read — it defines phase-1 scope, binding constraints, DoD subset, and the key decisions each planner must justify.

## Goal (one paragraph)

Let a developer run `deskcheck listen` in one terminal, record a DeskCheck session normally in the side panel, and have the resulting export land at a known on-disk path the terminal (or a shell caller like Claude Code) can read directly — eliminating the current "stop, download, find the zip in Downloads, drag into context" friction. Phase 1 achieves this with a local HTTP listener and an opt-in export branch in the service worker. Phase 2 will layer terminal-launched sessions (`deskcheck record <url>`) on top in a subsequent cycle.

## Binding constraints for this cycle

1. **Security**: listener binds `127.0.0.1` only, per-session tokens required, single-use, expire with the CLI process. Verified by test.
2. **Opt-in**: manual sessions without a listener URL in metadata continue to download via the existing path with zero behaviour change. Verified by test.
3. **Schema unchanged**: `schema_version` in `agents-doc.ts` stays put. This is a transport change, not a schema change.
4. **macOS-first**: Linux/Windows are future work, not in DoD.
5. **Phase 2 OUT OF SCOPE**: no Chrome launcher, no hash-fragment detection, no side panel badge.

## Out-of-scope for this cycle

- Phase 2: `deskcheck record <url>`, Chrome launcher, hash-fragment detection, side panel "connected to terminal session" badge, `--profile isolated` mode
- MCP wrapper (explicitly deferred per the roadmap entry)
- Linux/Windows Chrome launch paths
- Any change to `session.json` schema or event types
