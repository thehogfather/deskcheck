---
agent: safety-planner
generated: 2026-05-02T00:00:00Z
task_id: feature-16
perspective: safety
---

# Safety Plan: Freeze PII capture mode at session start

## Architecture Impact

**Components affected:**
- `src/lib/sidepanel-controls.ts` — `buildControlsModel()` returns status-conditional `piiMode` (idle/stopped → true; running/paused → false).
- `src/sidepanel/sidepanel.ts` — render new non-interactive indicator pill on `running`/`paused`; existing `appendChild(piiFieldset)` becomes conditional.
- `src/sidepanel/sidepanel.css` — new `.capture-indicator` rules cloned from `.handoff-status` (lines 564-625).
- `src/content/recorder.ts` — add dev-only invariant assertion comparing in-flight `opts.piiMode` against `chrome.storage.local`'s `pii_mode` (warn-only, not throw).
- `src/content/index.ts` — guard against duplicate `SESSION_STARTED` overwriting an in-flight recorder mode (idempotency check).

**New patterns:** Decorative "status pill" pattern reused from feature #15 — no new abstractions.

**Dependencies:** None added.

**Breaking changes:** None — `pii_mode` schema, message contracts, and pre-session selector all unchanged.

**Risk points:** input recording is the privacy contract; any leak of raw values into `value_metadata` mode is a P0.

## Risk Assessment

### Identified Risks
| # | Risk | Severity | Likelihood | Impact | Mitigation |
|---|------|----------|------------|--------|------------|
| R1 | Future refactor re-reads `piiMode` from storage per-event, leaking raw values when user switches mode mid-flight | High | Medium | Privacy violation | Lock in a unit test that mutates `chrome.storage` mid-session and asserts recorder still uses original mode |
| R2 | Content script re-loads mid-session (e.g. extension update), `GET_SESSION_STATE` returns stored `pii_mode`, but storage was somehow corrupted | High | Low | Wrong mode applied on resumed page | Add `parsePiiMode` fallback to `DEFAULT_PII_MODE` (`full` is safest? — see note); pin via test |
| R3 | Duplicate `SESSION_STARTED` arrives (e.g. second tab attach, race with `GET_SESSION_STATE` fallback), `startSession` early-returns but mode could drift if guard removed | High | Low | Two recorders disagree | `isRecording` guard already in place at `index.ts:37`; pin with test |
| R4 | Hidden fieldset reappears momentarily during status transition, user clicks it and expects mode change | Medium | Low | Misleading UX, no actual leak | Render is synchronous through `buildControlsModel`; add render-flicker test that transitions `idle → running → paused → running → stopped` and asserts fieldset never appears mid-transition |
| R5 | Storage `pii_mode` differs from in-flight recorder mode (silent divergence) | Medium | Low | Export metadata mismatches actual capture | Dev-only `console.warn` assertion in recorder; runtime-cheap |
| R6 | Existing tests assume fieldset always present (`sidepanel.test.ts:239,273,1177`, `sidepanel-controls.test.ts:106-107`) — silent regression risk | Medium | High | CI green on broken behaviour | Update tests as part of this change, **not** later |
| R7 | E2E PII leak: input typed in `metadata` mode produces an event with raw `value` field | Critical | Low | Privacy contract broken | Required E2E test asserts NO `value` field, only `value_metadata` |
| R8 | Existing `exporter.golden.test.ts` snapshot drifts | Low | Medium | False CI failure | Verify golden does not need regen; re-run before commit |

### Failure Modes Analysis
1. **Mid-session storage `pii_mode` mutation** — test simulates `chrome.storage.onChanged` with new pii_mode, asserts recorder `opts.piiMode` unchanged. Detection: dev-mode `console.warn`. Recovery: closure already isolates.
2. **Duplicate SESSION_STARTED** — test fires twice with different modes, asserts only first wins. Detection: `isRecording` guard. Recovery: stop+restart explicitly.
3. **Service-worker restart mid-session** — `restoreState` reads `session.pii_mode` from store; new `SESSION_STARTED` not re-broadcast. Pin via test that `restoreState` does not re-trigger recorder.
4. **Storage `pii_mode` corrupted/missing** — `parsePiiMode(undefined) → DEFAULT_PII_MODE = "full"`. **Note**: full is the most permissive; consider whether the safer default should be `none` for resumes where mode is unknown. Flag this for judge consideration.
5. **Indicator pill flicker** — render test across all status transitions.

### Blast Radius
- **Affected users**: All extension users on next install/update.
- **Affected systems**: Side panel UI, content recorder, exporter (read-only on `pii_mode`).
- **Data at risk**: Raw input values if R1/R7 regress. **This is the worst-case outcome and the only one that warrants P0 escalation.**

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 1 | Update `buildControlsModel` → `piiMode: preSession` | Unit test: matrix of (status × residual) → piiMode flag | Revert single file |
| 2 | Update existing tests asserting fieldset presence | All updated tests green | Revert test files |
| 3 | Render indicator pill in `sidepanel.ts` on running/paused | jsdom render test verifies pill visible / fieldset absent | Revert sidepanel.ts diff |
| 4 | Add CSS for `.capture-indicator` | Visual smoke: load extension, verify pill matches handoff-status pill | Revert CSS hunk |
| 5 | Add recorder mid-session storage-mutation invariant test | Test passes (already correct behaviour) | N/A — test only |
| 6 | Add dev-only `console.warn` assertion in recorder if storage `pii_mode` ≠ closure | Unit test verifies warn fires on divergence | Revert recorder.ts diff |
| 7 | Add E2E test (Playwright): metadata mode + input typing | E2E green; assert no raw `value` | Revert e2e file |
| 8 | Add E2E adversarial test: DOM-mutate radio mid-session | E2E green; export pii_mode unchanged | Revert e2e file |

## Files to Create/Modify
| File | Purpose | Risk Notes |
|------|---------|------------|
| `src/lib/sidepanel-controls.ts` | Make `piiMode` status-conditional | Single line change; high blast radius if logic wrong |
| `src/lib/sidepanel-controls.test.ts` | Update unit assertions | Must update lines 106-107 |
| `src/sidepanel/sidepanel.ts` | Render indicator pill | Touch render path — verify no flicker |
| `src/sidepanel/sidepanel.test.ts` | Update fieldset assertions at lines 239, 273, 1177; add indicator tests | Don't drop coverage |
| `src/sidepanel/sidepanel.css` | New `.capture-indicator` rules | Visual only |
| `src/content/recorder.ts` | Dev-only invariant warn | Must not affect production hot path |
| `src/content/recorder.test.ts` | Mid-session storage mutation test | New file/section |
| `e2e/pii-metadata.spec.ts` (new) | E2E input + adversarial DOM test | First input-event E2E coverage |

## Definition of Done
- [ ] PII fieldset absent from DOM on running/paused, present on idle/stopped
- [ ] Capture indicator pill visible on running/paused, absent otherwise
- [ ] `session.json.pii_mode` immutable post-Start (pinned by test)
- [ ] Recorder closure-frozen (pinned by mid-session mutation test)
- [ ] Pre-session selector unchanged (pinned by existing tests)
- [ ] Dev-only divergence warning fires when storage diverges from closure
- [ ] E2E: metadata mode → input → exported event has `value_metadata`, NO `value`
- [ ] E2E adversarial: DOM-injected radio change does NOT alter export `pii_mode` or event payloads
- [ ] All existing tests green; golden snapshot unchanged
- [ ] Rollback procedure documented and revert-tested locally

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|---------------|-----------------|-----------|
| 1 | `buildControlsModel` status-conditional `piiMode` | Unit | Pure function, exhaustive matrix |
| 2 | Indicator pill visibility per status | Unit (jsdom) | DOM render logic, fast |
| 3 | Fieldset absent on running/paused | Unit (jsdom) | Structural absence, not styling |
| 4 | Recorder ignores mid-session storage mutation | Unit | Closure freeze invariant |
| 5 | Duplicate SESSION_STARTED guard | Unit | Idempotency invariant |
| 6 | Dev-only divergence warning | Unit | Mock console.warn, assert called |
| 7 | Round-trip: metadata mode → input event has value_metadata | Integration | Recorder + exporter boundary |
| 8 | E2E: real Chrome, metadata mode, no raw value leak | E2E | Privacy contract — must run end-to-end |
| 9 | E2E adversarial DOM mutation | E2E | Threat-model coverage |

**Determinism**: All tests deterministic; no LLM calls in scope. E2E uses fixture pages, fixed inputs.

## Testing Strategy

### Unit Tests
- `buildControlsModel` matrix: (idle, stopped, running, paused) × (residual yes/no) → `piiMode` flag.
- Indicator pill: renders correct label per mode; absent on idle/stopped.
- Recorder: start with `metadata`, fire `chrome.storage.onChanged` with `pii_mode: "full"`, emit input event, assert payload uses metadata.
- Recorder: duplicate `startSession("full")` then `startSession("none")` — assert second is a no-op.
- Recorder: dev-mode storage divergence triggers single `console.warn`.

**Edge cases**:
- `parsePiiMode(undefined)`, `parsePiiMode("garbage")`, `parsePiiMode(null)` all → `DEFAULT_PII_MODE`.
- Status transition flicker: idle → running → paused → running → stopped (assert fieldset never appears mid-flow).
- Service-worker `restoreState` after wake: does not retrigger `SESSION_STARTED`.

### Integration Tests
- Start session in `metadata` mode → fire jsdom input event → flush via exporter → `session.pii_mode === "metadata"`, event has `value_metadata`, no `value`.

### E2E Tests
- **Existing affected**: any e2e covering Start/Stop flow — verify still passes.
- **New e2e (REQUIRED)**:
  1. Start session in `metadata` mode → type into fixture input → Stop+download → assert exported event has `value_metadata` populated, NO `value` field, `pii_mode: "metadata"`.
  2. **Adversarial**: start in `metadata` → DOM-inject radio click for `full` mid-session → type input → Stop → assert export still `pii_mode: "metadata"` and no raw value.
- **Cost note**: Group both assertions per session to minimise auth+unlock overhead — 2 sessions max.

### Regression Tests
- `exporter.golden.test.ts` unchanged.
- Pre-session Full/Metadata/None selection still works.
- Feature #11 hide-not-disable contract still holds (fieldset removed, not styled hidden).

## Rollback Strategy

### Trigger Conditions
- Any reported case of raw input value in `session.json` when user selected metadata/none.
- Indicator pill rendering errors that block side panel.
- Test failures on main post-merge.

### Rollback Steps
1. `git revert <merge-commit-sha>` on main.
2. `make bump-patch` → publish hotfix.
3. Notify users via release notes; advise re-export of any sessions taken since merge if mode confusion occurred.
4. Per-commit revert map: each phase above is a separate commit so partial revert is possible (e.g. revert only the indicator pill without losing the test pinning).

### Verification After Rollback
- [ ] `make test` green on reverted main.
- [ ] Manual smoke: start session, change radio, stop — old (broken) behaviour restored, no crash.
- [ ] No data corruption — past `session.json` files unaffected (read-only feature).

### Rollback Tested?
- [ ] Local: revert the PR branch, run full test suite, verify pre-feature behaviour.

## Monitoring & Alerting
N/A — Chrome extension, no server telemetry. User-facing detection is bug reports. Add dev-only `console.warn` for divergence as a developer-time canary.

## Deployment Recommendations
- [ ] **Feature flag**: Not needed — UX-only change, schema unchanged.
- [ ] **Gradual rollout**: N/A — extension publishes whole-version.
- [ ] **Staging verification**: Manual smoke in unpacked extension before publishing.
- [ ] **Off-hours**: Not applicable.

## Estimated Effort
- Planning: done
- Implementation: 35 min
- Safety verification (assertions, rollback rehearsal): 15 min
- Testing (unit + integration + 2 E2E): 50 min
- **Total**: ~100 min

## Formal Verification Assessment
- Concurrency concerns: Yes — multiple tabs, service-worker restarts, duplicate SESSION_STARTED. Mitigated by closure freeze + `isRecording` guard.
- State machine complexity: No — simple status enum already covered by feature #11.
- Conservation laws: Yes — "pii_mode at start = pii_mode in every captured event". Pinned by integration test.
- Authorization model: No.
- **Recommendation**: Formal verification not needed — invariants are simple and pinnable by unit/integration tests. The closure-freeze pattern is the verification.
- Key invariant: `∀ event in session: event was captured under session.pii_mode`. Pin via mid-session mutation test.

## Security Considerations
- [x] No secrets in code.
- [x] Input validation: `parsePiiMode` already defends against garbage.
- [x] Output encoding: indicator pill text is mode literal — no user input.
- [x] Auth/authz: N/A.
- [x] OWASP: privacy disclosure (A02:2021) — directly addressed by this feature.
- [x] **Open question for judge**: should `parsePiiMode` fallback be `none` (safest) instead of `full` when storage is corrupted? Currently `full` — the most permissive. Recommend revisiting in a follow-up if judge agrees. Out of scope for this cycle.
