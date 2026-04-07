---
agent: plan-judge
generated: 2026-04-07T00:00:00Z
task_id: feature-3
selected: synthesis
base_plan: safety
borrows_from: [quality, speed]
---

# Plan Evaluation: Schema documentation for AI consumers

## Executive Summary

Selected a **synthesis that takes the safety plan as its base** (one hand-authored constant in a new `agents-doc.ts` module, minimal 3-line change to `exporter.ts`, empty-session regression guards, 16 KB byte cap) and **grafts on the TS exhaustiveness check from the quality plan** so adding a new `TimelineEvent` variant is a compile-time failure until the doc constant is updated. The quality plan's data-driven renderer and unrelated `package.json`/`manifest.json` version bump are rejected as over-engineering for a Medium/Small-sized task.

## Plans Evaluated

### Speed Plan Summary
- **Core approach**: Single template-literal constant in `src/lib/agents-doc.ts`, string assertions in the existing exporter test file.
- **Estimated effort**: ~35 min
- **Key tradeoff**: Drift resistance relies entirely on string-content assertions against a hand-maintained list of discriminators — no compile-time guard. The doc and the test both hard-code the list of seven event types, so adding an 8th type in `types.ts` will only be caught if the developer also updates the test.

### Quality Plan Summary
- **Core approach**: `SCHEMA_DOC` data structure describing every event type and its fields, consumed by a pure `renderAgentsMarkdown()` renderer. Drift prevented by both a TS exhaustiveness helper and a runtime set-equality test. Also bumps extension version `0.3.0` → `0.4.0` and updates `docs/ARCHITECTURE.md`.
- **Estimated effort**: ~70 min
- **Key tradeoff**: The data-driven renderer is a whole new mini-DSL (`{ name, type, required, description }[]` per event type) to describe ~30 fields. That is more machinery than this feature warrants, and every field description still needs to be hand-maintained — the data-driven shape does not actually reduce the drift surface, it just relocates it. The extension version bump is also unrelated to this feature's scope.

### Safety Plan Summary
- **Core approach**: Hand-authored `AGENTS_MD` constant + a co-located `AGENTS_MD_EVENT_TYPES` canonical discriminator list, tiny set of content assertions, empty-session/no-screenshot regression guards, 16 KB sanity cap, atomic single-commit rollback.
- **Estimated effort**: ~60 min
- **Key tradeoff**: The discriminator list is still hand-maintained in `agents-doc.ts`; the plan mentions an exhaustiveness helper but leaves its wiring slightly under-specified. That gap is easy to close by adopting the quality plan's exhaustiveness pattern verbatim.

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|---|---|---|---|---|---|
| Risk vs. blast radius | 20% | 4.0 | 3.0 | 4.5 | All three are structurally low risk; safety explicitly enumerates every adjacent file it touches and keeps the doc source-only (no user data interpolation). Quality inflates blast radius with an unrelated `manifest.json`/`package.json` bump. |
| DOD coverage in tests | 20% | 3.5 | 4.5 | 4.5 | Speed covers DOD #1-3 via string assertions but skips empty-session regression. Quality and safety both cover every automatable DOD item; safety adds empty-session + no-screenshot + co-presence regressions that directly guard the export hot path. |
| Drift resistance | 25% | 2.5 | 4.5 | 4.0 | **The most important criterion for this feature.** Speed has no compile-time guard. Safety sketches one; quality fully wires an exhaustiveness helper. Synthesis closes safety's gap by adopting quality's helper verbatim. |
| Reviewability | 15% | 5.0 | 3.0 | 4.5 | Speed and safety are one new file + ~3 lines of production diff. Quality adds a data schema, a renderer, a drift test, an exhaustiveness helper, an architecture doc update, and an extension version bump — ~7 files for a Small-sized feature. |
| Effort proportionality (Medium/Small) | 20% | 5.0 | 2.5 | 4.0 | Roadmap sizes this as "Impact: Medium / Effort: Small". Quality's 70 minutes and 7 files materially exceed Small; the unrelated version bump is scope creep. Speed matches Small. Safety is slightly over Small on paper (60 min) but every minute is on proportionate regression guards. |
| **Weighted Total** | 100% | **3.85** | **3.55** | **4.30** | Safety wins, with quality's exhaustiveness check grafted on for drift resistance. |

## Context Analysis

| Factor | Assessment | Impact |
|---|---|---|
| Urgency | Low | This is a roadmap feature, not a hotfix. Quality-of-implementation matters more than speed. |
| Blast radius | Low | Pure function, additive zip entry, no storage or permission changes. Favours keeping the change minimal. |
| Code area | Core contract (export path) | The schema is the product's "core contract" per CLAUDE.md — drift resistance is non-negotiable — but the change itself is at the leaf of that contract (an additive zip file). Favours minimal diff + strong drift guard, not wholesale refactor. |
| Technical debt | Low | The codebase is small, well-tested, and just merged feature #1 cleanly. No latent debt to fix in passing; reject quality plan's "clean up duplicated 1.0.0 literal" as out-of-scope. |
| User visibility | Internal (AI consumer persona) | Not human-user-facing. Favours correctness over polish. |

## Recommendation

### Selected Plan: Synthesis (Safety base + Quality's exhaustiveness check)

### Rationale

The entire point of this feature is that AI consumers should be able to trust the doc, which means drift resistance is the single most important quality bar. The safety plan matches that bar with a minimal-diff, high-regression-guard approach that fits the roadmap's Small sizing; the quality plan matches it with a data-driven renderer that substantially overshoots sizing without actually reducing drift surface (the field descriptions still have to be written by hand regardless of whether they live in a markdown template or an object literal). The one thing the quality plan gets unambiguously right is the **TS exhaustiveness helper** — a `switch` on `TimelineEvent['type']` with a `never` default, imported by the test file, which makes "adding a new event type without updating the doc constant" a typecheck error rather than a soft guideline. That pattern is about five lines of code and belongs in any winning plan. I am rejecting the quality plan's `manifest.json`/`package.json` version bump because it is unrelated to this feature and violates the project's "immutable changes, incremental commits" principle — extension versions are bumped by `make bump-*` at release time, not folded into feature commits. I am rejecting the quality plan's `SCHEMA_DOC`-data-plus-renderer scheme because the doc is small enough (~30 fields across 7 event types) that a hand-written template literal is more reviewable, and the data-driven shape does not actually eliminate the need to hand-maintain field descriptions. The speed plan is close but loses on drift resistance because it has no compile-time guard — a future contributor adding an 8th event type would only be caught if they also remembered to update the test, which is exactly the kind of coupling the exhaustiveness helper eliminates for free.

### Incorporated Elements from Other Plans
- **From Safety plan**: hand-authored `AGENTS_MD` constant in `src/lib/agents-doc.ts`; co-located `AGENTS_MD_EVENT_TYPES` canonical list; 16 KB byte cap; empty-session and no-screenshot regression tests; co-presence ("nothing got dropped") assertion; single-commit rollback model; no interpolation of session data into the doc (privacy invariant); schema version bump to `1.1.0`.
- **From Quality plan**: `assertExhaustiveEventTypes()` helper that uses a `switch (e.type) { ... default: const _: never = e }` pattern to force `AGENTS_MD_EVENT_TYPES` to cover every member of the `TimelineEvent['type']` union at compile time; drift test that imports the helper alongside a set-equality assertion.
- **From Speed plan**: keep the assertion style lightweight (string `.toContain()` checks on the rendered constant, not a full parser); keep the new test file colocated with the new module; reject speculative refactors.

## The Selected Plan

### Approach

Create a single new module `src/lib/agents-doc.ts` that exports:
1. `SCHEMA_VERSION = "1.1.0" as const` — the single source of truth for the schema version.
2. `AGENTS_MD_EVENT_TYPES` — a `readonly` tuple of every `TimelineEvent['type']` discriminator, exactly covering the union.
3. `AGENTS_MD` — a template literal containing the hand-authored markdown doc, interpolating `${SCHEMA_VERSION}` exactly once near the top.
4. `assertExhaustiveEventTypes()` — a zero-runtime-cost helper that uses a `switch` over `TimelineEvent['type']` with a `never` default. This forces `AGENTS_MD_EVENT_TYPES` to be complete at compile time.

Modify `src/lib/exporter.ts` to import `SCHEMA_VERSION` and `AGENTS_MD`, use `SCHEMA_VERSION` instead of the hard-coded `"1.0.0"`, and add `zipData["agents.md"] = strToU8(AGENTS_MD)` right after the `session.json` entry.

Update `src/types.ts` to change the `schema_version` literal type from `"1.0.0"` to `"1.1.0"`.

Tests split across two files:
- `src/lib/agents-doc.test.ts` (new) — unit tests on the constant: contains version, contains every discriminator, contains `session.json` / `screenshots/`, under byte cap, exhaustiveness helper is referenced so TS enforces coverage.
- `src/lib/exporter.test.ts` (modified) — integration-level assertions against the full exported zip: `agents.md` is present alongside `session.json`, regression tests for empty timeline and empty screenshots, co-presence assertion, updated `schema_version` literal.

### File-by-file Change List

| File | Change | Approx LOC | Purpose |
|---|---|---|---|
| `src/lib/agents-doc.ts` | **Create** | ~150 (most of it markdown body) | Exports `SCHEMA_VERSION`, `AGENTS_MD_EVENT_TYPES`, `AGENTS_MD`, `assertExhaustiveEventTypes`. Single source of truth for the doc. |
| `src/lib/agents-doc.test.ts` | **Create** | ~60 | Unit tests for the constant and the exhaustiveness guard. |
| `src/lib/exporter.ts` | **Modify** | ~4 lines changed | Import `SCHEMA_VERSION` and `AGENTS_MD`; replace the hard-coded `"1.0.0"` with `SCHEMA_VERSION`; add `zipData["agents.md"] = strToU8(AGENTS_MD)` after the `session.json` line. |
| `src/lib/exporter.test.ts` | **Modify** | ~50 added, 1 changed | Add an `"agents.md in export"` describe block with presence, co-presence, empty-session, and empty-screenshot regressions. Change `expect(json.schema_version).toBe("1.0.0")` → `"1.1.0"`. |
| `src/types.ts` | **Modify** | 1 line | `schema_version: "1.0.0"` → `schema_version: "1.1.0"` on `SessionExport`. |

**Total**: 2 new files, 3 modified files. Roughly 260 lines of net-new content, mostly the markdown body of `AGENTS_MD`.

### Files Deliberately NOT Modified

- `docs/ARCHITECTURE.md` — **skip**. The quality plan proposes a changelog row and schema diagram update; this is nice-to-have but not required by any DOD item and not by CLAUDE.md. Defer as a follow-up if the reviewer asks.
- `package.json` / `manifest.json` — **skip**. Extension versions are bumped by `make bump-*` at release time per CLAUDE.md's versioning section. Folding an extension bump into a schema-docs feature conflates two concerns and violates incremental-commit discipline. The next `make bump-minor` before release will pick this feature up.
- Everything else: `src/background/*`, `src/content/*`, `src/popup/*`, `src/lib/session-store.ts`, `src/lib/debugger-client.ts`, `src/lib/dom-utils.ts`, `src/lib/session-metrics.ts`.

### Schema Version Decision

**Bump to `"1.1.0"`** (semver minor).

Rationale, consistent across all three plans and confirmed here:
- CLAUDE.md is explicit: "Schema version follows semver. Changes to the schema must bump this version."
- The export contract per `docs/ARCHITECTURE.md` is the **whole zip layout**, not only `session.json`. Adding a sibling file is a schema change.
- The change is purely additive — `session.json`'s shape is unchanged, so old parsers continue to work. Minor bump is the semver-correct signal.
- The `SCHEMA_VERSION` constant lives in one place (`agents-doc.ts`) and is consumed by `exporter.ts`, eliminating the currently-duplicated `"1.0.0"` literal between `exporter.ts` and `types.ts`.

**No extension version bump** (`package.json` / `manifest.json` stay at their current value). That is a release-time action, not a feature-commit action.

### Drift Resistance — How It Is Enforced

Three independent safeguards, each cheap to add:

1. **Compile-time**: `assertExhaustiveEventTypes()` is a `switch (e.type) { case "interaction": ... default: const _: never = e; return _; }` helper. Any new member added to the `TimelineEvent` union in `types.ts` immediately makes `make typecheck` fail inside `agents-doc.ts` until a matching case is added. Because adding the case requires touching `agents-doc.ts`, the contributor is forced to look at the doc in the same commit.

2. **Test-time (set equality)**: `agents-doc.test.ts` asserts `new Set(AGENTS_MD_EVENT_TYPES)` equals a hand-maintained `EXPECTED_TYPES` set and that every value appears as a literal substring in `AGENTS_MD`. If the contributor updates the helper but forgets the constant or the markdown body, the test fails with a clear mismatch.

3. **Test-time (integration)**: `exporter.test.ts` asserts `agents.md` is in the exported zip and contains the current schema version string. Catches any case where the doc is wired to the wrong constant.

Together these mean: **you cannot add a new event type and ship a stale doc.** The compiler catches it in one place, and two different test assertions catch it in two others.

### `AGENTS_MD` Content Outline (for the implementer)

The markdown body should cover, in order:
1. `# DeskCheck session export` — one-paragraph overview; pointer to `session.json` as the starting point.
2. `## Schema version` — interpolates `${SCHEMA_VERSION}`; one sentence on semver meaning.
3. `## Zip layout` — the three-file tree (`session.json`, `agents.md`, `screenshots/`).
4. `## session.json structure` — top-level keys: `schema_version`, `session`, `timeline`, `summary`.
5. `## Session metadata fields` — every field on `SessionMetadata` minus `tab_id` (which the exporter strips): `id`, `start_time`, `end_time`, `duration_ms`, `initial_url`, `user_agent`, `viewport`. One-line meaning each.
6. `## Timeline` — chronological, sorted by `seq`/`timestamp`; `BaseEvent` fields (`seq`, `timestamp`, `page_url`).
7. `## Event types` — one subsection per discriminator. Each subsection: heading like `### type: interaction`, one-sentence description, fields table (name / required? / meaning). Must cover all 7: `interaction`, `viewport_resize`, `network_error`, `console_error`, `js_exception`, `annotation`, `screenshot`.
8. `## Screenshots directory` — explains `screenshots/{id}.png` and the `screenshot.id` ↔ `annotation.screenshot_id` / `annotation.element_screenshot_id` linkage.
9. `## Summary fields` — every field on `SessionSummary`.
10. `## Writing a bug report from this zip` — 4-bullet recipe: (a) enumerate annotations as user-reported symptoms, (b) correlate each with its `screenshot_id`, (c) look for `console_error`/`js_exception`/`network_error` events within a short time window before the annotation, (d) use `interaction` events to describe reproduction steps.

**Must stay under 16 KB** (enforced by test). Current outline is comfortably under that.

**Must not interpolate any runtime session data** — only `SCHEMA_VERSION`. Enforced by the fact that `agents-doc.ts` does not import from any module that sees session contents.

---

### Definition of Done (Final)

- [ ] Every exported zip contains `agents.md` alongside `session.json` (DOD #1 from roadmap)
- [ ] `agents.md` describes the schema version, every surviving `SessionMetadata` field, and every event type discriminator with field definitions (DOD #2)
- [ ] `agents.md` explains the relationship between timeline entries and the `screenshots/` directory, including the `annotation.screenshot_id` → `screenshots/{id}.png` linkage (DOD #3)
- [ ] An AI assistant given only the zip can produce a structured bug report without additional context (DOD #4 — asserted by proxy via #1-#3 plus manual smoke test noted in PR description; **no live LLM call in any test**)
- [ ] `schema_version` in `SessionExport` is bumped to `"1.1.0"` and sourced from a single `SCHEMA_VERSION` constant
- [ ] Adding a new `TimelineEvent` variant without updating `AGENTS_MD_EVENT_TYPES` fails `make typecheck` (exhaustiveness invariant)
- [ ] `AGENTS_MD` byte length is under 16384 (sanity cap against silent doc bloat)
- [ ] Empty-session export (`exportSession(makeSession(), [], {})`) still produces a valid zip containing both `session.json` and `agents.md`
- [ ] `make typecheck` passes
- [ ] `make test` passes
- [ ] `make build` passes

### Test Level Matrix (Final)

Each DOD criterion maps to exactly ONE test level. All tests are deterministic (no live LLM calls).

| # | Acceptance Criterion | Test Level | Test File | Specific Assertion(s) | Rationale |
|---|---|---|---|---|---|
| 1 | Every exported zip contains `agents.md` alongside `session.json` | Integration (pure-function integration test against `exportSession`) | `src/lib/exporter.test.ts` | In a new `describe("agents.md in export")`: call `exportSession(makeSession(), makeEvents(), {})`, `unzipSync`, assert `unzipped["agents.md"]` is defined, assert `unzipped["agents.md"].length > 0`, assert `unzipped["session.json"]` is still defined (co-presence). | `exportSession` is the component boundary between schema doc and the `fflate` zip; needs an integration-style test that actually builds the zip and inspects it. |
| 2 | `agents.md` describes schema version, session metadata fields, and every event type with field definitions | Unit | `src/lib/agents-doc.test.ts` | (a) `expect(AGENTS_MD).toContain(SCHEMA_VERSION)`; (b) for each field in `["id", "start_time", "end_time", "duration_ms", "initial_url", "user_agent", "viewport"]`, `expect(AGENTS_MD).toContain(field)`; (c) `expect(AGENTS_MD).not.toContain("tab_id")` (tab_id is stripped on export and must not be advertised); (d) for each discriminator in `AGENTS_MD_EVENT_TYPES`, `expect(AGENTS_MD).toContain(discriminator)`; (e) for each discriminator, assert a section heading like `type: <discriminator>` matches via regex. | `AGENTS_MD` is a pure constant — string assertions are the fastest and most deterministic level. |
| 3 | `agents.md` explains the timeline ↔ `screenshots/` relationship | Unit | `src/lib/agents-doc.test.ts` | (a) `expect(AGENTS_MD).toContain("screenshots/")`; (b) `expect(AGENTS_MD).toContain("screenshot_id")`; (c) `expect(AGENTS_MD).toMatch(/screenshots\/[^\s]+\.png/)` to catch the path convention. | Same rationale as #2 — pure string assertions on a constant. |
| 4 | AI assistant given only the zip can produce a structured bug report without additional context | Manual smoke (noted in PR description) | N/A — not automated | Documented in the PR: load `dist/`, record a session with at least one of each event type, export, paste/attach the zip contents to a fresh AI chat with the prompt "Produce a structured bug report from this." Pass condition: the AI produces sensible output without asking what the schema means. | **Determinism rule**: a live LLM call in CI is non-deterministic and violates project conventions. The four criteria above verify the necessary preconditions; DOD #4 is acceptance-grade. |
| 5 | Drift: `AGENTS_MD_EVENT_TYPES` covers every member of `TimelineEvent['type']` | Unit (compile-time assisted) | `src/lib/agents-doc.test.ts` | (a) import `assertExhaustiveEventTypes` from `agents-doc.ts` (the import alone forces typecheck coverage); (b) runtime assertion `expect(new Set(AGENTS_MD_EVENT_TYPES)).toEqual(new Set(["interaction", "viewport_resize", "network_error", "console_error", "js_exception", "annotation", "screenshot"]))`. | Belt-and-braces: the TS `never` check is the primary guard, the set-equality is the readable failure message. |
| 6 | `AGENTS_MD` under 16 KB sanity cap | Unit | `src/lib/agents-doc.test.ts` | `expect(new TextEncoder().encode(AGENTS_MD).byteLength).toBeLessThan(16384)`. | Cheap static invariant; guards the export memory footprint. |
| 7 | `schema_version` bumped to `"1.1.0"` end-to-end | Integration | `src/lib/exporter.test.ts` | Update existing `produces a valid zip with session.json` test: `expect(json.schema_version).toBe("1.1.0")`. Also assert `AGENTS_MD` contains the exact same version string as `json.schema_version` (drift guard between doc and JSON in a single exported zip). | Catches any regression where the constant and the exported JSON disagree. |
| 8 | Empty session still produces both files | Integration | `src/lib/exporter.test.ts` | Add `it("produces a valid zip even with no events or screenshots")`: `exportSession(makeSession(), [], {})`, unzip, assert both `session.json` and `agents.md` are present and non-empty, no throw. | Regression guard for the export hot path; cheap insurance. |
| 9 | Schema version literal type change doesn't break any internal consumer | Compile-time | `make typecheck` (no test code) | Relies on `tsc --noEmit` catching any place that still types `schema_version: "1.0.0"`. | Free safety net; no test code required. |

**Rules applied:**
- Pure string assertions on the `AGENTS_MD` constant live at unit level (`agents-doc.test.ts`).
- Anything that exercises the full zip-building path lives at integration level (`exporter.test.ts`) because it crosses the `fflate` boundary.
- DOD #4 is explicitly not automated — documented as manual smoke per CLAUDE.md's "Chrome API integration tested manually" convention.
- All tests deterministic. No LLM mocks needed because no test touches an LLM.

### Testing Strategy (Final)

- **Unit** (`src/lib/agents-doc.test.ts`, new):
  - `AGENTS_MD` contains `SCHEMA_VERSION` (drift guard between version constant and doc text).
  - `AGENTS_MD` contains every metadata field; does **not** contain `tab_id`.
  - `AGENTS_MD` contains every discriminator in `AGENTS_MD_EVENT_TYPES` and has a `type: <discriminator>` section heading for each.
  - `AGENTS_MD` contains `screenshots/` and `screenshot_id`.
  - `AGENTS_MD` byte length < 16384.
  - `AGENTS_MD_EVENT_TYPES` equals the canonical 7-element set.
  - Imports `assertExhaustiveEventTypes` (making the compile-time check part of the test surface).

- **Integration** (`src/lib/exporter.test.ts`, modified):
  - New `describe("agents.md in export")` block:
    - `agents.md` present in unzipped output alongside `session.json` (co-presence regression).
    - `agents.md` contains the same version string as `json.schema_version` (end-to-end drift guard).
    - Empty-session case: `exportSession(makeSession(), [], {})` still produces a valid zip with both files.
    - No-screenshot case: events present, screenshots empty, both files present.
  - Update existing `produces a valid zip with session.json` test: change `"1.0.0"` assertion to `"1.1.0"`.
  - Keep all other existing assertions untouched (they are the regression guard that guarantees `session.json` and `screenshots/` paths still resolve).

- **E2E**: none. No Vitest e2e harness in this repo per CLAUDE.md; the Chrome API integration step is manual.

- **Manual smoke** (documented in PR description, not run by CI):
  - `make build`, load unpacked extension, record a session with at least one of each event type (click, manual screenshot, annotation, forced `console.error("test")`), Stop & Download, open zip.
  - Verify `session.json`, `agents.md`, `screenshots/` are present.
  - `session.json` has `"schema_version": "1.1.0"`.
  - Paste the zip contents into a fresh AI chat: "Produce a structured bug report from this." Confirm it answers without asking for the schema.

### Risk Mitigations (Final)

1. **Doc drift (primary risk, high likelihood over months)**: Compile-time exhaustiveness helper + runtime set-equality test + end-to-end version-string match between `AGENTS_MD` and `json.schema_version`. Three independent safeguards.
2. **Privacy regression via session-data interpolation**: `agents-doc.ts` is a constant-only module that does not import from any module handling runtime session data. Enforced structurally, not by policy.
3. **Silent doc bloat**: 16 KB byte cap enforced by unit test.
4. **Empty-session edge case on the export hot path**: explicit integration test for `exportSession(session, [], {})`.
5. **Schema version literal break in an unknown internal consumer**: covered for free by `make typecheck` — CI runs it.
6. **External consumer that pinned on `schema_version === "1.0.0"`**: not applicable (no known external consumers today), and the minor bump is the contractual signal that re-validation is needed.
7. **Rollback**: all changes in a single squashed commit. `git revert <sha>` is atomic. No storage migration, no manifest permission change, no user-visible UI change.

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|---|---|---|---|---|
| Concurrency | N | N | N | N |
| State machine | N | N | N | N |
| Conservation | N | N | N | N |
| Authorization | N | N | N | N |

**Recommendation**: **SKIP**. Pure function called once per export, no concurrency, no state, no authorization surface. All three planners correctly declined formal verification. The unit + integration test coverage is sufficient for the risk surface.

---

## Orchestrator Handoff

This evaluation is the final decision — no human checkpoint follows. The orchestrator will:
1. Commit all plans to `docs/plans/feature-3/` for audit trail.
2. Use the Test Level Matrix above to generate acceptance tests at the specified levels and files.
3. Proceed directly to implementation.

### Acceptance criteria for "done" (exact commands)

The validation gate runs, in order:

```
make typecheck
make test
make build
```

Pass conditions:
- `make typecheck` exits 0 with no `tsc --noEmit` errors. (This also validates the exhaustiveness invariant — a missing case in `assertExhaustiveEventTypes` would fail here.)
- `make test` exits 0. Full Vitest suite green, including:
  - All pre-existing tests in `buildSummary`, `exportSession`, `getExportFilename` describe blocks.
  - New `describe("agents.md in export")` block in `exporter.test.ts` (6 assertions from the matrix above).
  - New `src/lib/agents-doc.test.ts` (7 assertions from the matrix above).
- `make build` exits 0 (full typecheck + Vite bundle succeeds + icons copied).

No manual step is blocking for the validation gate; the DOD #4 manual smoke test is documented in the PR description but does not block the gate.

**Summary for git commit**:
- Selected plan: Synthesis (Safety base + Quality exhaustiveness check)
- Key rationale: smallest diff that still makes doc drift a compile error.
- Estimated effort: ~55 minutes (safety's 60 minus the architecture doc update that's deferred).
- Key risks: doc drift (mitigated by 3 independent guards); privacy regression via user-data interpolation (mitigated structurally by constant-only module).
- Test levels: 7 unit, 5 integration, 0 e2e, 1 manual (acceptance).
