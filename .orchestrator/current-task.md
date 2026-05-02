# Current task: Feature #16 — Freeze PII capture mode at session start

- **Feature ID**: feature-16
- **Title**: Freeze PII capture mode at session start
- **Roadmap entry**: `docs/roadmap.md` → Priority: Now → #16 (lines 150-168)
- **Priority**: Now
- **Persona**: Bug Reporter
- **Impact**: High | **Effort**: Small
- **Branch**: `feature/feature-16`
- **Session ID**: `orch-20260502-213511-81971`
- **Started**: 2026-05-02
- **Orchestrator cycle**: three-plan competition with autonomous implementation through PR creation

## Phase status

- [x] Phase 0: initialize workspace + worktree + brief
- [ ] Phase 1: generate 3 competing plans (speed / quality / safety)
- [ ] Phase 2: judge selects plan + generates Test Level Matrix
- [ ] Phase 3: generate acceptance tests (failing)
- [ ] Phase 4: implement until acceptance tests pass
- [ ] Phase 5: automated validation gate
- [ ] Phase 6: architecture + roadmap update + PR

## Goal (one paragraph)

Make the export's PII guarantees unambiguous. Today the PII mode selector remains interactive during a recording, and `session.json`'s `pii_mode` field reflects the value at stop-time rather than session-start. A 160s real recording with three mid-flight switches (full → metadata → none) saved only the final value, leaving downstream consumers unable to trust the metadata. This feature freezes the mode at the moment Start is clicked, hides the mode selector entirely from the active-session DOM, and renders a small non-interactive indicator ("Capture: full | metadata | none") in the toolbar so the user can see which mode is in force without being able to change it. Because the mode is frozen, `session.session.pii_mode` is once again truthful and no `pii_mode_changed` timeline events are needed.

## Binding constraints (Definition of Done lifted from roadmap)

1. **Hide-not-disable.** PII mode fieldset must be absent from the DOM during running/paused — extends feature #11 control-gating contract.
2. **Schema unchanged.** `pii_mode` stays a single string field on `session.session`. No `schema_version` bump.
3. **Indicator is decorative.** Reads-only; styled to match the feature #15 connection-status pill. Communicates "locked" by the absence of an interactive control, not via "(locked)" text.
4. **Recorder gates on a frozen value.** Content-script input listener reads PII mode ONCE at session start, caches it for the lifetime of the session. Mid-session storage updates (e.g. from another window) MUST NOT change in-flight recording behaviour.
5. **Pre-session selector unchanged.** Full / Metadata / None options work as today before Start.

## Definition of Done (from roadmap)

- [ ] PII mode fieldset is hidden from the DOM during running/paused states (matches feature #11 hide-not-disable contract)
- [ ] Toolbar shows a non-interactive "Capture: full | metadata | none" indicator while a session is active, styled to match the feature #15 connection-status pill
- [ ] `session.json` `pii_mode` field reflects the mode at Start time and never changes for the lifetime of the session
- [ ] Recorder gates input events on a session-scoped frozen mode value, not on a live read of storage
- [ ] Existing pre-session selector behaviour (Full / Metadata / None) is unchanged
- [ ] Unit tests cover: indicator visibility per status, frozen-mode persistence across pause/resume cycles, recorder gate behaviour after a mid-session storage update
- [ ] E2E test: start a session in `metadata` mode, type into an input on a fixture page, confirm the captured `interaction.subtype === "input"` event has `value_metadata` populated and no raw value (closes the existing input-event e2e coverage gap)

## Out of scope for this cycle

- Feature #17 (Pause-first lifecycle simplification) — separate cycle.
- Schema changes — `pii_mode` field shape unchanged, no `schema_version` bump.
- New PII mode beyond Full / Metadata / None.
