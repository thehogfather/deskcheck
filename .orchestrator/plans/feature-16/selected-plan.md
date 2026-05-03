---
agent: plan-judge
generated: 2026-05-02T00:00:00Z
task_id: feature-16
selected: speed
synthesis: speed-base + quality-test-matrix + safety-adversarial-e2e
---

# Plan Evaluation: Freeze PII capture mode at session start

## Selection Summary

**Base: Speed plan**, augmented with two surgical lifts:
- From **Quality**: the (status × residual) exhaustive matrix in `sidepanel-controls.test.ts`, and the `isActiveStatus` micro-guard inside `buildControlsModel` only (no new module file).
- From **Safety**: the **adversarial E2E** (DOM-mutate the radio mid-session, assert export `pii_mode` unchanged) — privacy is the highest-weighted criterion in this brief, and the marginal cost is one Playwright case.

**Rejected from Quality**: new `sidepanel-pii-indicator.ts` module, new `session-status.ts` module, ARCHITECTURE.md prose, 90% coverage gate. The brief states the freeze semantics are *already correct*; extracting modules to "document the contract" is over-engineering for a ~25-line change.

**Rejected from Safety**: the `console.warn` divergence assertion in `recorder.ts` (adds production hot-path code for a regression that cannot occur under current architecture — speculative); the `parsePiiMode` fallback discussion (out of scope per safety planner's own admission); the rollback rehearsal (UX-only, schema-stable, git revert is sufficient).

### Scoring (weights from brief: privacy impact, effort, regression risk, maintainability, blast radius)

| Criterion | Weight | Speed | Quality | Safety | Winner note |
|---|---|---|---|---|---|
| Privacy impact (regression containment) | 30% | 4.0 | 4.5 | 4.8 | Safety wins on adversarial E2E — pull that one piece |
| Effort | 20% | 4.8 | 3.0 | 3.5 | Speed; brief says feature is "mostly UX + tests" |
| Regression risk | 20% | 4.0 | 4.2 | 4.5 | Safety marginal; speed's 5 files have low surface |
| Maintainability | 15% | 3.5 | 4.5 | 3.8 | Quality wins, but new modules unjustified at this size |
| Blast radius | 15% | 4.5 | 4.0 | 4.2 | Speed: fewest touchpoints |
| **Weighted total** | 100% | **4.18** | **4.04** | **4.20** | Speed + adversarial E2E ≈ 4.30 |

Speed and Safety tie within noise; combining Speed's footprint with Safety's adversarial E2E dominates both. Quality's modular extraction loses on effort and offers little maintainability gain when sidepanel.ts already has `buildHandoffBadge` as the precedent — we follow that precedent inline.

## Rationale per criterion

- **Privacy impact**: The brief verifies freeze semantics are correct today. Risk is *future regression*, not current bug. One closure-freeze unit test + one adversarial E2E pins both vectors.
- **Effort**: Speed's ~45 min vs Quality's 110 min vs Safety's 100 min. Brief explicitly downgrades effort: "this feature is mostly UX + regression-safety tests."
- **Regression risk**: Speed's 5-file diff is the smallest reversible change. Adding the adversarial E2E (Safety) closes the only uncovered threat vector — DOM tampering.
- **Maintainability**: Quality's `sidepanel-pii-indicator.ts` mirrors `sidepanel-handoff-badge.ts` — but at ~25 lines of inline render code, extraction is premature. We will inline it next to where `buildPiiFieldset` already lives.
- **Blast radius**: All three plans touch the same render path. Speed has the fewest moving parts and reuses `.handoff-status` CSS verbatim.

## Final implementation steps

**Must-have (in order):**

1. **`src/lib/sidepanel-controls.ts`**: change `piiMode: true` (line 72) to `piiMode: status !== "running" && status !== "paused"`. Add `piiIndicator: !piiMode` to the returned `ControlsModel` (additive field — won't break callers).
2. **`src/sidepanel/sidepanel.ts`**: build a `capturePill` element using `<span class="handoff-status pii-indicator">Capture: ${selectedPiiMode}</span>` (reuse `.handoff-status` classes, add `.pii-indicator` modifier for any tweaks). Append to the toolbar block when `model.piiIndicator === true`. Update its text whenever `selectedPiiMode` changes pre-session and on every render. Keep the existing `if (model.piiMode) controls.appendChild(piiFieldset)` guard at line 1076 — it now does the right thing.
3. **`src/sidepanel/sidepanel.css`**: add a `.pii-indicator` rule that inherits from `.handoff-status` token vars (no new hex codes). Keep ≤10 lines.
4. **`src/lib/sidepanel-controls.test.ts`**: replace lines 106-107 with the (idle / stopped / running / paused) × (residual yes/no) matrix asserting `piiMode` and the new `piiIndicator` flag.
5. **`src/sidepanel/sidepanel.test.ts`**: update assertions at lines 239, 273, 1177 to status-conditional. Add a `transitionTo("running")` → fieldset absent + pill present test, plus the reverse via `transitionTo("idle")`.
6. **`src/content/recorder.test.ts`**: add the closure-freeze regression test — start session in `full`, fire a synthesised `chrome.storage.onChanged` event flipping `pii_mode` to `none`, dispatch an input event, assert the captured payload still uses full-mode shape.
7. **E2E coverage**: extend `e2e/input-capture.spec.ts` (preferred — reuse fixtures) with the **adversarial** case from Safety: start in `metadata`, type, then `evaluate(() => document.querySelector('input[value="full"]')?.click())`, type again, stop, assert exported `session.pii_mode === "metadata"` and every `interaction.subtype === "input"` event has `value_metadata` set and no `value` key. If `e2e/input-capture.spec.ts` already covers the happy path, add only the adversarial case (one new test block in the same file).
8. Run `make test`, `make typecheck`, `npx playwright test e2e/input-capture.spec.ts`.

**Nice-to-have if cheap (skip if any blocker):**

- Step 9 (skip-if-painful): factor the inline `capturePill` builder into a 5-line `buildCapturePill(mode)` helper at the bottom of `sidepanel.ts` (no new file). Acceptable to defer.

## Test Level Matrix

| # | DoD checkbox | Level | File path | Assertion |
|---|---|---|---|---|
| 1 | Fieldset hidden during running/paused | Unit (jsdom) | `src/sidepanel/sidepanel.test.ts` | After `transitionTo("running")`, `document.getElementById("pii-mode-fieldset")` is `null`; same for `"paused"` |
| 2 | Toolbar capture pill visible during active session | Unit (jsdom) | `src/sidepanel/sidepanel.test.ts` | After `transitionTo("running")`, `#capture-mode-pill` exists with text `Capture: <mode>` |
| 3 | `session.json pii_mode` reflects start-time mode | Unit | `src/lib/exporter.test.ts` (existing 140-153) | Round-trip: build session with `pii_mode: "metadata"`, export, parse, assert `session.pii_mode === "metadata"` (already pinned — keep green) |
| 4 | Recorder gates on session-scoped frozen value | Unit | `src/content/recorder.test.ts` | Start `full`, fire `chrome.storage.onChanged` with `pii_mode: "none"`, emit input event, assert payload has raw `value` (full-mode shape) |
| 5 | Pre-session selector unchanged | Unit (jsdom) | `src/sidepanel/sidepanel.test.ts` (existing 239, 273) | Idle status: fieldset present with three radios, change handler updates `selectedPiiMode` |
| 6 | Indicator visibility per status | Unit | `src/lib/sidepanel-controls.test.ts` | `buildControlsModel` matrix: `piiIndicator` true iff status ∈ {running, paused}; `piiMode` is its inverse |
| 7 | E2E metadata-mode input has `value_metadata`, no raw `value` (incl. adversarial DOM mutation) | E2E | `e2e/input-capture.spec.ts` | Start in metadata, type, attempt DOM-inject radio click for `full`, type again, stop, assert export `pii_mode === "metadata"` AND every input event has `value_metadata` set AND no event has a `value` key |

**Determinism**: All seven tests deterministic. No LLM calls anywhere in the stack.

## Acceptance criteria (Phase 5 boolean gate)

- `make typecheck` exit 0
- `make test` exit 0 with all seven matrix tests green
- `npx playwright test e2e/input-capture.spec.ts` exit 0
- `e2e/input-capture.spec.ts` contains a test asserting `pii_mode === "metadata"` AND `value_metadata` populated AND no `value` key, after a mid-session DOM radio mutation
- `git grep -n "pii-mode-fieldset" src/sidepanel/sidepanel.ts` shows the fieldset construction is gated by `model.piiMode` (i.e., not unconditionally appended)
- `git grep -n "schema_version" src/lib/exporter.ts` returns the same value as on `main` (no bump)
- `src/lib/exporter.golden.test.ts` green with no snapshot regen

## Risks the chosen plan accepts

1. **No service-worker write-guard** rejecting hypothetical future `pii_mode` mutations. Brief verifies only one write site exists today; we don't add a guard against a regression that hasn't happened.
2. **No `console.warn` divergence canary** in `recorder.ts`. Production hot-path stays clean; the closure-freeze test is the canary instead.
3. **No extracted `sidepanel-pii-indicator.ts` module**. Inline render in `sidepanel.ts` follows the precedent of `buildPiiFieldset`. Extraction can happen later if the file crosses a true threshold.
4. **No ARCHITECTURE.md update**. The freeze contract is encoded in tests, which are the live spec. If a future contributor needs prose, that's a separate doc PR.
5. **Default `parsePiiMode` fallback remains `full`**. Safety planner flagged this as a possible follow-up; out of scope for this cycle (acknowledged in their own brief).

## Open question for the implementer (pre-decided)

**Q**: Should the capture pill DOM live in the toolbar block or inside the controls block?
**Default**: Toolbar block, near the existing handoff-status pill — matches the brief's "indicator pill in the toolbar styled to match the feature #15 connection-status pill" wording verbatim and reuses the same CSS region. Implementer should only deviate if `sidepanel-render.ts` makes toolbar mounting awkward; in that case, place inside the controls panel and document the deviation in the PR.

## Orchestrator handoff

- Selected plan: **Speed (synthesis with adversarial E2E from Safety + matrix test from Quality)**
- Key rationale: Brief verifies freeze semantics are already correct; this is a UX + regression-pin job, not a refactor
- Estimated effort: ~60 min (Speed's 45 + 15 for adversarial E2E)
- Key risks accepted: no SW write-guard, no warn canary, no extracted module
- Test levels: 5 unit, 1 unit (jsdom integration-style), 1 E2E
