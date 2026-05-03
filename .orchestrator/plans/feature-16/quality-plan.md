---
agent: quality-planner
generated: 2026-05-02T00:00:00Z
task_id: feature-16
perspective: quality
---

# Quality Plan: Freeze PII capture mode at session start

## Architecture Impact

**Components affected:**
- `src/lib/sidepanel-controls.ts` — `ControlVisibility` gains a `piiIndicator` flag; `piiMode` becomes status-conditional.
- `src/sidepanel/sidepanel.ts` — uses two new helpers; no growth of the megafile.
- New module `src/lib/sidepanel-pii-indicator.ts` — pure render of the indicator pill.
- New module `src/lib/session-status.ts` (extension) — narrow type `ActiveStatus = "running" | "paused"` exported alongside existing `SessionStatus`.

**New patterns or abstractions introduced:**
- Extracted indicator-pill builder pattern (mirrors `sidepanel-handoff-badge.ts`) — keeps sidepanel.ts under control.
- Discriminated-union narrowing via `isActiveStatus(status): status is ActiveStatus` — replaces ad-hoc `status === "running" || status === "paused"`.

**Dependencies added or modified:** None.

**Breaking changes to existing interfaces:** None — `ControlVisibility.piiMode` shape unchanged; new field additive. `pii_mode` schema field unchanged.

## Architectural Approach
Push all visibility logic into the existing pure view-model (`buildControlsModel`) and the new pure indicator module — the side panel glue layer becomes a thin mounter. Reuse feature #15's pill aesthetic by sharing CSS variables (no duplicate styles). Recorder freeze semantics are already correct; we add tests that pin the invariant rather than refactor working code.

## Files to Create/Modify
| File | Purpose | Quality Considerations |
|------|---------|----------------------|
| `src/lib/session-status.ts` | Add `ActiveStatus` union + `isActiveStatus` guard | Narrow type, single source of truth |
| `src/lib/sidepanel-controls.ts` | `piiMode` status-conditional; new `piiIndicator` flag | Keep file pure, exhaustive over status |
| `src/lib/sidepanel-pii-indicator.ts` (NEW) | Pure builder `buildPiiIndicator(mode): HTMLElement` + `piiIndicatorLabel(mode)` | Mirrors handoff-badge module; zero Chrome APIs |
| `src/sidepanel/sidepanel.ts` | Mount indicator in toolbar; gate fieldset on `model.piiMode` | Delete inline construction; thin glue |
| `src/sidepanel/sidepanel.css` | New `.pii-indicator` rule reusing handoff-status tokens | DRY via shared CSS variables |
| `src/lib/sidepanel-controls.test.ts` | Update PII row to status-conditional matrix | One assertion per (status × flag) |
| `src/lib/sidepanel-pii-indicator.test.ts` (NEW) | Pure unit tests for label + DOM shape | jsdom only |
| `src/sidepanel/sidepanel.test.ts` | Update three pinned assertions to status-conditional | Add transitionTo(running)→absent test |
| `src/content/recorder.test.ts` | Add mid-session storage-change freeze regression test | One invariant per test |
| `e2e/input-capture.spec.ts` | Add "metadata-mode input survives mid-session UI noise" case | Reuses existing fixture helpers |
| `docs/ARCHITECTURE.md` | New "PII mode is frozen at session start" subsection | Contract documented |

**Total files**: 11 (3 new, 8 modified)

## Implementation Steps
1. **Add `ActiveStatus` type + guard** in `session-status.ts`. Rationale: replace `string === "running" || === "paused"` checks across files with a single guard the type-checker enforces.
2. **Update `buildControlsModel`**: `piiMode = !isActiveStatus(status)`; add `piiIndicator = isActiveStatus(status)`. Exhaustive across status × residual.
3. **Create `sidepanel-pii-indicator.ts`** exporting `piiIndicatorLabel(mode): string` (e.g. `"Capture: metadata"`) and `buildPiiIndicator(mode): HTMLElement` returning a `<span class="pii-indicator">` with icon slot + text. Pure, no Chrome APIs.
4. **Wire into `sidepanel.ts`**: build indicator once per render based on `selectedPiiMode`/`session.pii_mode`; append to toolbar when `model.piiIndicator` true; remove fieldset append when `!model.piiMode`. Delete the now-dead change-handler branch in active state.
5. **Add CSS** for `.pii-indicator` reusing handoff-status custom properties (no duplicate hex codes).
6. **Migrate existing tests**: update `sidepanel-controls.test.ts:106-107` to status-conditional matrix; update `sidepanel.test.ts` three assertions; each test pins exactly one invariant.
7. **Add recorder regression test**: simulate `chrome.storage.onChanged` firing with a different `pii_mode` mid-session; assert `capturePayloadForMode` was invoked with the start-time mode.
8. **Add E2E case** in `e2e/input-capture.spec.ts`: start in `metadata`, type, mid-session attempt to mutate via storage write, type again, stop, assert all input events used metadata-mode payload shape.
9. **Document the contract** in `docs/ARCHITECTURE.md` with a "PII mode lifecycle" section pointing to the three freeze points (sidepanel hide, recorder closure, service-worker write-once).

## Definition of Done
- [ ] `buildControlsModel` returns `piiMode:false, piiIndicator:true` for running/paused; opposite for idle/stopped
- [ ] `#pii-mode-fieldset` absent from DOM during running/paused (queried via `document.getElementById`, not `display`)
- [ ] `.pii-indicator` element present with correct label during running/paused, absent otherwise
- [ ] `session.json pii_mode` invariant: equals start-time mode after radio churn + pause/resume + storage write
- [ ] Recorder closure freeze pinned by regression test
- [ ] All existing pre-session selector tests still green (zero behaviour change for idle/stopped)
- [ ] E2E: metadata-mode input event has `value_metadata` populated, no raw `value`
- [ ] No `any` types introduced; no new linting warnings; coverage ≥80% on new modules
- [ ] `docs/ARCHITECTURE.md` updated; tests pass; `make typecheck` clean

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `buildControlsModel` status matrix | Unit | Pure function, exhaustive enumeration cheap |
| 2 | Fieldset absent during running/paused | Unit (jsdom) | DOM contract, no Chrome APIs needed |
| 3 | Indicator pill renders correct label per mode | Unit (jsdom) | Pure builder over enum |
| 4 | `session.json pii_mode` start-time invariant | Integration | Spans sidepanel→service-worker→exporter |
| 5 | Recorder ignores mid-session storage `pii_mode` change | Unit | Closure-scoped logic, mockable storage event |
| 6 | Pre-session selector unchanged | Unit | Status=idle path of existing tests |
| 7 | Metadata-mode input has `value_metadata` no `value` | E2E | Real content-script + OPFS round-trip |

**Quality planner bias**: 5 unit, 1 integration, 1 e2e — match the pyramid. Each DoD criterion maps to exactly ONE level.

**Determinism rule**: All tests deterministic. No live LLM calls anywhere in this feature.

## Testing Strategy
- **Unit**: 4 new + 3 updated tests across `sidepanel-controls.test.ts`, `sidepanel-pii-indicator.test.ts`, `recorder.test.ts`, `sidepanel.test.ts`.
- **Integration**: One jsdom test in `sidepanel.test.ts` that drives `transitionTo("running")` → asserts fieldset removed + indicator mounted; then `transitionTo("idle")` → reversed. One exporter round-trip test pinning `pii_mode` start-time invariant across pause/resume.
- **E2E**: One new Playwright case extending `input-capture.spec.ts` for the mid-session storage-mutation scenario.

**E2E Test Impact** (REQUIRED):
- **Existing e2e tests affected**: `e2e/input-capture.spec.ts` (extended, not rewritten); `e2e/session.spec.ts` if it asserts fieldset visibility during running (verify and update if so).
- **New e2e tests needed**: One — "metadata mode survives mid-session UI noise" in input-capture.spec.ts.
- **Cost note**: Group all assertions in the new case into a single test to keep auth+unlock count at +1.

**Test files to create/modify**: as listed in table above.
**Coverage target**: 90% for new modules (`sidepanel-pii-indicator.ts`, status guard); maintain existing % elsewhere.

## Code Quality Checklist
- [ ] SOLID: indicator is a single-responsibility module
- [ ] DRY: CSS reuses handoff-status tokens; no duplicated mode-label strings
- [ ] Naming: `piiIndicator`/`buildPiiIndicator`/`isActiveStatus` follow project conventions
- [ ] Abstraction: extracted only because sidepanel.ts is 1346 lines; threshold justified
- [ ] Error handling: `parsePiiMode` already defensive; indicator falls back to default mode if storage corrupt
- [ ] Types: discriminated union for `ActiveStatus`; no `any`
- [ ] Edge cases: idle→running→paused→running→stopped transitions; mid-session storage write with same mode (no-op)
- [ ] Logging: none added — UI-only change

## Patterns to Apply
| Pattern | Where | Why |
|---------|-------|-----|
| Pure view-model | `buildControlsModel` extension | Already the codebase idiom |
| Builder helper module | `sidepanel-pii-indicator.ts` | Mirrors `sidepanel-handoff-badge.ts` |
| Type guard | `isActiveStatus` | Replaces magic string checks |
| Shared CSS tokens | `.pii-indicator` reuses `--success`/`--bg-elev-2` | DRY visual language |

## Impact Assessment
**Positive Impacts**:
- Sidepanel.ts no longer grows; new feature lives in dedicated module
- Type guard eliminates a class of "missed status" bugs
- Architecture doc captures the freeze contract for future contributors

**Neutral**:
- Service worker, recorder semantics, schema, storage layout: unchanged

**Risks**:
- Existing `sidepanel.test.ts` assertions break — mitigated by explicit migration in step 6
- Indicator pill style drift from handoff pill — mitigated by sharing CSS custom properties

## Estimated Effort
- Implementation: 45 min
- Testing: 50 min (more thorough)
- Docs + review prep: 15 min
- **Total**: ~110 min

> ⚠️ **Quality Investment**: ~30 min longer than minimal approach. Worth it because (a) sidepanel.ts is already 1346 lines and growing every feature, (b) the freeze contract spans 3 files and deserves documentation, (c) the type guard prevents a recurring bug class.

## Technical Debt Addressed
- Inlined `buildPiiFieldset` extracted alongside the new indicator module — reduces sidepanel.ts surface
- Magic-string status checks replaced with typed guard
- Undocumented freeze contract now in ARCHITECTURE.md

## Formal Verification Assessment
- Concurrency concerns: No — single-recorder per session
- State machine complexity: Mild — status × pii_mode, but pii_mode is write-once
- Conservation laws: Yes — `session.pii_mode` is invariant across session lifetime (the key property)
- Authorization model: No
- Recommendation: Not needed — invariants are pinned by tests; complexity does not warrant TLA+
- Key invariants: (1) `session.pii_mode` written once at start, never mutated; (2) recorder closure mode equals start-time mode for session lifetime; (3) fieldset visible iff `!isActiveStatus(status)`; (4) indicator visible iff `isActiveStatus(status)`

## Future Extensibility
Adding a fourth PII mode requires touching only `pii-modes.ts` and `sidepanel-pii-indicator.ts` label map — the visibility model and freeze contract scale unchanged. If feature #17's pause-first lifecycle introduces new statuses, `isActiveStatus` becomes the single edit point.
