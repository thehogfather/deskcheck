---
agent: safety-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-3
perspective: safety
---

# Safety Plan: Schema documentation for AI consumers (`agents.md`)

## Architecture Impact

**Components affected:**
- `src/lib/exporter.ts`: adds one entry to the in-memory `zipData` record before `zipSync`. No control flow changes.
- `src/types.ts`: literal type for `schema_version` widens (or shifts) by one constant value.
- `src/lib/exporter.test.ts`: new assertions, existing assertions preserved.
- `docs/ARCHITECTURE.md`: documentation refresh of the export schema diagram (non-code).

**New patterns or abstractions introduced:**
- A single string constant `AGENTS_MD` (or `agentsDoc`) co-located with the exporter. No new module, no new abstraction layer. Imported as a TypeScript value so it ships inside the bundled service worker — no `fs` access, no Vite asset plugin, no MV3 web-accessible-resource changes.

**Dependencies added or modified:**
- None. `fflate` already supports adding arbitrary string entries via `strToU8`.

**Breaking changes to existing interfaces:**
- `SessionExport.schema_version` literal type changes from `"1.0.0"` to `"1.1.0"`. This is a narrowing of a literal constant — any internal consumer that pinned on the literal `"1.0.0"` would fail to compile. Inside this repo, only `exporter.ts` writes the field and `exporter.test.ts` asserts on it; both are updated together.
- For external consumers (AI assistants reading the zip), the change is **purely additive**: `session.json` retains its exact shape, plus a new sibling file `agents.md` appears in the zip root. No field removed, no field renamed, no event-type semantics changed.

**Risk points in architecture this task touches:**
- The export hot path in the service worker. Any throw inside `exportSession` after a long recording session destroys user work because `clearSession()` runs unconditionally on success and the user has no second chance.
- The in-memory zip footprint. Feature #1 highlights service worker memory as the OOM ceiling; we are adding bytes to a structure that is already a known hot spot.

## Risk Assessment

### Identified Risks
| Risk | Severity | Likelihood | Impact | Mitigation |
|------|----------|------------|--------|------------|
| Existing AI consumers / scripts that pinned on `schema_version === "1.0.0"` reject the new export | Medium | Low | Consumer pipelines silently drop sessions | Bump to `1.1.0` (minor) per semver — additive change is exactly what minor bumps signal. Document the bump in `docs/ARCHITECTURE.md` changelog. |
| External consumer enumerates `Object.keys(zipEntries)` and asserts a fixed file count | Low | Very low | Consumer parser breaks | We control no external consumers today (no published schema, no public parser). Internal `exporter.test.ts` does not count keys, only checks specific keys exist. Add a regression test that asserts both `session.json` and `screenshots/*` paths still resolve. |
| `agents.md` content exceeds expectation and inflates the zip footprint, worsening OOM under feature #1's known memory ceiling | Low | Medium | Marginal increase in export-time memory pressure | Cap the doc at a few KB (target < 8 KB uncompressed, well under 0.01% of a typical 10 MB session). Doc is constant and deduplicated by gzip in fflate. |
| Doc drifts from the actual TS types over time, causing AI consumers to misinterpret events | Medium | High (over months) | AI-generated bug reports become wrong | Add a unit test that asserts `agents.md` mentions every `type` discriminator value from `TimelineEvent`. Test fails the next time someone adds an event type without updating the doc. |
| `agents.md` accidentally embeds user data (e.g., string-templated from session contents) | High | Very low | Privacy regression | Doc must be a **constant string**, no interpolation of session/event values. Enforced by code review and by importing the constant from a module that never sees the `session` argument. |
| Doc is treated as markdown by an editor that auto-resolves links / fetches images | Low | Low | Information leak through DNS lookups | Use no external URLs in the doc — only describe local file paths inside the zip. |
| Schema version literal type change ripples into other files that imported `SessionExport` | Low | Low | TypeScript build break | `make typecheck` runs in CI/`make build`. Update `src/types.ts` and `src/lib/exporter.ts` in the same commit. |
| `clearSession()` runs after a successful export — if the user later realises the doc misled them, there's no way to re-export | Low | N/A | Pre-existing behaviour, not introduced by this change | Out of scope. Documented as pre-existing risk only. |
| Hard-coded large string in source confuses bundle-size monitors | Minimal | Low | Cosmetic | Doc is well under any meaningful threshold; Vite tree-shakes the constant only if used (it is). |

### Failure Modes Analysis

1. **`zipSync` throws on the new entry**
   - Cause: malformed UTF-8 in the doc string (impossible — it's a TS string literal), or fflate version regression.
   - Detection: existing service worker error log; the user sees no download.
   - Recovery: revert this commit; doc string is the only new input to `zipSync`.

2. **Doc drift — new event type added without doc update**
   - Cause: developer adds a discriminator to `TimelineEvent` and forgets `agents.md`.
   - Detection: regression test asserts `agents.md` includes every literal discriminator value harvested from a sample-events fixture (or, more robustly, a hand-listed canonical list co-located with the doc constant — see Implementation).
   - Recovery: update the doc; tests go green.

3. **Schema version literal break**
   - Cause: an as-yet-unknown internal file pinned on `schema_version: "1.0.0"`.
   - Detection: `make typecheck` fails immediately.
   - Recovery: grep `1\.0\.0` and `schema_version` is already done — only `exporter.ts`, `exporter.test.ts`, `types.ts`, and `docs/ARCHITECTURE.md` reference it. Update all four atomically.

4. **External consumer rejects on unknown file**
   - Cause: a hypothetical strict consumer enumerates the zip and rejects unexpected entries.
   - Detection: would not be caught by our tests (we do not own the consumer).
   - Recovery: there are no known external consumers today; this risk is bounded by hypothesis. The semver bump is the contractual signal that consumers need to re-validate.

5. **Memory regression on the export path**
   - Cause: doc is unexpectedly large.
   - Detection: a test asserts `agents.md` byte length is under a sanity ceiling (e.g., 16 KB).
   - Recovery: trim the doc; rerun.

### Blast Radius
- **Affected users**: All users who export a session after upgrading. The change is silently additive — no user-facing UI changes, no popup changes, no permissions changes.
- **Affected systems**: Only the export path. Recording, storage, content script, popup, debugger client, and screenshot capture are untouched.
- **Data at risk**: None. No reads from `session`, no reads from storage, no new writes to `chrome.storage.local`. The doc is a constant.

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 1 | Add `src/lib/agents-doc.ts` exporting an `AGENTS_MD` constant string and an `AGENTS_MD_EVENT_TYPES` array (the canonical list of `TimelineEvent` discriminators that must appear in the doc) | `make typecheck` green; new file is unreferenced and safe to delete | Delete the new file |
| 2 | Add unit tests against the constant: contains schema version, contains all entries from `AGENTS_MD_EVENT_TYPES`, mentions `screenshots/`, mentions `session.json`, byte length under cap | `make test` green for the new tests; existing tests untouched and still green | Delete the new tests |
| 3 | In `src/types.ts`, change `schema_version: "1.0.0"` to `schema_version: "1.1.0"` | `make typecheck` — surfaces any unknown internal consumer | Revert this single line |
| 4 | In `src/lib/exporter.ts`, import `AGENTS_MD`, set `schema_version: "1.1.0"`, add `zipData["agents.md"] = strToU8(AGENTS_MD)` immediately after the existing `session.json` entry | `make typecheck` and `make test` — existing exporter tests must stay green; new exporter tests must pass | Revert these three lines |
| 5 | Update `src/lib/exporter.test.ts` with new assertions (see Test Strategy) **and keep all existing assertions intact**, only changing `expect(json.schema_version).toBe("1.0.0")` → `"1.1.0"` | `make test` green | Revert test file |
| 6 | Update `docs/ARCHITECTURE.md` Export Schema section to show the new file and bump the table to v0.4.0 / schema 1.1.0 | Documentation only; nothing to break | Revert doc |
| 7 | `make build` end-to-end | Full typecheck + bundle succeeds | None — build is a no-op on disk except `dist/` |
| 8 | Manual extension load (see Pre-deploy validation) | Real session export contains both files | Revert merge commit |

Each phase is independently revertable. Phases 1-2 are entirely additive (no production code touched). Phase 3 is the only "risky" line and is isolated.

## Files to Create/Modify
| File | Purpose | Risk Notes |
|------|---------|------------|
| `src/lib/agents-doc.ts` (new) | Exports the `AGENTS_MD` constant and the canonical `AGENTS_MD_EVENT_TYPES` list | Pure constant. No imports from `types.ts` (avoid circular complexity). The discriminator list is hand-maintained and asserted by a test that compares it against an exhaustive switch over `TimelineEvent` to fail if a new type is added. |
| `src/lib/agents-doc.test.ts` (new) | Asserts: contains schema version `1.1.0`; contains every value in `AGENTS_MD_EVENT_TYPES`; mentions `session.json`; mentions `screenshots/`; byte length < 16 KB | Pure unit tests, no Chrome mocks, no fixtures |
| `src/lib/exporter.ts` (modify, ~3 lines) | Import `AGENTS_MD`, bump `schema_version` to `"1.1.0"`, add `agents.md` entry to `zipData` | Hot path. Single revert restores prior behaviour. |
| `src/lib/exporter.test.ts` (modify, additive + 1 string change) | Update `1.0.0` → `1.1.0`; add three assertions: (1) zip contains `agents.md`, (2) `agents.md` is non-empty, (3) `agents.md` content matches expected markers (schema version, `screenshots/`). Keep existing `session.json` and screenshot assertions. | Existing assertions act as the regression guard. |
| `src/types.ts` (modify, 1 line) | `schema_version` literal type `"1.0.0"` → `"1.1.0"` | Compile-time safety net for unknown consumers. |
| `docs/ARCHITECTURE.md` (modify, ~6 lines) | Update Export Schema section to show `agents.md` sibling and bump version label; add changelog row | Doc only. |

**No changes to:** `src/background/service-worker.ts`, `src/content/*`, `src/popup/*`, `src/lib/session-store.ts`, `src/lib/debugger-client.ts`, `manifest.json` permissions, `package.json` dependencies. Zero blast radius outside the listed files.

## Backward-Compat Strategy

**Is the new file additive only?** Yes, and provably so:
- The exporter writes one new key to `zipData` after the existing keys are written.
- `session.json`'s in-memory shape is unchanged except for the `schema_version` string value (still a single field, still a string, still semver).
- No event types added, removed, renamed.
- No screenshot path conventions changed (`screenshots/{id}.png` is preserved).

**Does adding `agents.md` break any consumer that does `Object.keys(zip)`?**
- Internal: searched repo for `Object.keys` and `Object.entries` — only `session-metrics.ts`, `debugger-client.ts`, `widget.ts`, and `dom-utils.test.ts` use them, none on a zip. The exporter test does not enumerate keys; it does targeted lookups. Safe.
- External: there are no known external consumers. The semver minor bump is the contractual signal that the zip layout has been extended additively. Consumers that rejected on unknown files would need to re-validate after a minor bump anyway — that is exactly what minor bumps mean.

**Is the schema_version bump backward-compatible per the project's semver?**
- CLAUDE.md rule: "Schema version (`schema_version` field) follows semver. Changes to the schema must bump this version."
- The export contract per `docs/ARCHITECTURE.md` Export Schema section is the **whole zip layout**, not just `session.json`. Adding a sibling file is a schema change.
- Semver minor (`1.0.0` → `1.1.0`) is the correct, most risk-averse interpretation: additive, backward-compatible, signals to consumers that re-discovery is needed but old fields still work.
- Patch bump (`1.0.1`) would understate the change. Major bump (`2.0.0`) would overstate it and falsely alarm consumers. **Minor is the safe middle.**

## Rollback Plan

This is a Chrome extension distributed via the Chrome Web Store (or unpacked dev installs). There are no remote feature flags and no server-side toggles. Rollback strategies in order of preference:

1. **Single-commit revert (preferred)**: All changes land in one commit (or one squash-merged PR). `git revert <sha>` removes every change atomically. The next release reverts cleanly because the change is structurally additive — no migrations to reverse, no storage shape changes, no manifest permission changes.

2. **Out-of-band patch release**: If users have already downloaded a `1.1.0` zip and a downstream consumer is broken, ship a patch that drops `agents.md` again and restores `schema_version: "1.0.0"`. Old zips already in users' hands remain readable because nothing about `session.json` changed.

3. **No data migration required**: Zips are immutable artifacts on disk. There is no stateful component to reconcile.

### Trigger Conditions
When to roll back:
- Any export-path crash reported in the wild that did not exist on the prior release
- A downstream AI consumer reports rejection on `1.1.0` zips that worked on `1.0.0`
- `make build` regressions surface only after merge

### Rollback Steps
1. `git revert <merge-sha>` on `main`
2. `make bump-patch` to publish the rollback
3. `make build` and verify `dist/` is identical to the pre-feature-3 build (modulo version bump)
4. Tag and release

### Verification After Rollback
- [ ] `make test` green on reverted main
- [ ] Manually exported zip contains only `session.json` + `screenshots/`
- [ ] `schema_version` reads `"1.0.0"` again (or whatever the rollback target is)
- [ ] No orphaned references to `AGENTS_MD` anywhere

### Rollback Tested?
- [ ] No, but the change is small enough that `git revert` is the test. Tested implicitly by the principle that all changes land in a single squashed commit.

## Test Strategy (Comprehensive)

### Existing assertions that MUST stay green (regression guards)
These already exist in `src/lib/exporter.test.ts` and act as the contract guard:
- `unzipped["session.json"]` is defined (regression: we did not accidentally rename or drop it)
- `json.timeline.length === 6` (regression: timeline serialization unchanged)
- `json.summary.total_events === 6` (regression: summary unchanged)
- `json.session.tab_id === undefined` (regression: tab_id stripping still works)
- `unzipped["screenshots/ss_1.png"]` is defined and `length > 0` (regression: screenshot path convention unchanged)
- `buildSummary` event-counting tests (regression: summary logic untouched)
- `getExportFilename` test (regression: filename convention unchanged)

The only existing assertion that changes is `expect(json.schema_version).toBe("1.0.0")` → `"1.1.0"`. This is the deliberate, expected diff.

### New unit tests (in `src/lib/agents-doc.test.ts`)
- `AGENTS_MD` is a non-empty string
- `AGENTS_MD` contains the literal string `1.1.0` (the current schema version)
- `AGENTS_MD` contains the literal string `session.json`
- `AGENTS_MD` contains the literal string `screenshots/`
- `AGENTS_MD` contains every value in `AGENTS_MD_EVENT_TYPES`: `interaction`, `viewport_resize`, `network_error`, `console_error`, `js_exception`, `annotation`, `screenshot`
- `AGENTS_MD` byte length is under 16384 (sanity ceiling so the doc cannot quietly bloat the export)
- A type-level assertion (or runtime exhaustive switch) that proves `AGENTS_MD_EVENT_TYPES` covers every member of the `TimelineEvent["type"]` union — fails compile or test if a new event type is added without updating the constant

### New integration assertions (in `src/lib/exporter.test.ts`)
- After `exportSession(...)`, `unzipped["agents.md"]` is defined and non-empty
- The decoded `agents.md` content includes the schema version string, `session.json`, and `screenshots/`
- **Empty session regression**: `exportSession(makeSession(), [], {})` still produces a valid zip and that zip contains both `session.json` AND `agents.md` AND no errors are thrown — guards against the empty-session edge case
- **No-screenshot regression**: a session with events but no screenshots produces a zip with `session.json` + `agents.md` and zero `screenshots/` entries (the empty-screenshot path stays clean)
- **Co-presence regression**: a single test that, in one assertion block, checks `session.json`, `agents.md`, and `screenshots/ss_1.png` are all present in the same zip — the canonical "nothing got dropped" guard

### Edge cases
- Empty timeline (`events = []`)
- Empty screenshots (`screenshots = {}`)
- Both empty
- Session with one corrupted screenshot data URL (existing graceful-skip path) — verify `agents.md` still appears and the zip is still valid
- A timeline containing every event type — verify the doc actually documents all of them (covered by the discriminator coverage test)

### Integration / E2E
- Manual extension load (see Pre-deploy validation). No automated e2e changes — this project has no e2e harness today.

**E2E Test Impact:**
- **Existing e2e tests affected**: None — repo has no e2e suite.
- **New e2e tests needed**: None. The export path is fully exercisable from a unit test against `exportSession`.
- **Cost note**: N/A.

### Test files to create/modify
- `src/lib/agents-doc.ts` (new — production constant)
- `src/lib/agents-doc.test.ts` (new — constant content tests)
- `src/lib/exporter.test.ts` (modify — add 4 assertions, change one string literal, keep everything else)

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Every exported zip contains `agents.md` alongside `session.json` | Unit (against `exportSession`) | Pure function, no Chrome APIs needed. Fastest feedback, deterministic. |
| 2 | `agents.md` describes schema version, session metadata fields, and each event type | Unit (against `AGENTS_MD` constant) | The doc is a static constant — string-content assertions are deterministic and catch drift early. |
| 3 | `agents.md` explains the relationship between timeline entries and `screenshots/` directory | Unit (against `AGENTS_MD` constant) | Same as above. |
| 4 | An AI assistant given only the zip can produce a structured bug report without additional context | Manual / not asserted | Genuinely subjective; cannot be automated deterministically without making live LLM API calls (which violates the determinism rule). Asserted by proxy via #1-#3 plus manual review. **Do not** add a test that calls a real LLM. |
| 5 | Existing `session.json` + `screenshots/` paths still resolve | Unit (regression guard in `exporter.test.ts`) | Pure function, regression-critical. |
| 6 | Empty session still produces a valid zip with both files | Unit | Edge case, deterministic. |
| 7 | Schema version literal change does not break TypeScript consumers | Compile-time (`make typecheck`) | Free safety net; no test code required. |

**Determinism rule**: All proposed tests are deterministic and Chrome-API-free. DOD #4 is explicitly **not** asserted via a real LLM call — the constant-content tests give us proxy confidence and a human reviews the actual doc once at PR time.

## Pre-Deploy Validation (Manual)

1. `make typecheck` — must pass cleanly
2. `make test` — full suite must pass; new tests must run
3. `make build` — bundles successfully, `dist/` regenerated
4. Load `dist/` as unpacked extension in Chrome
5. Start a session on a real page (e.g., `https://example.com`)
6. Generate at least one of every kind of event the recorder produces: click an element, take a manual screenshot, add an annotation, force a console error (open DevTools and `console.error("test")`)
7. Stop & Download the session
8. Open the downloaded zip in Finder / `unzip -l`
9. **Verify**:
   - [ ] `session.json` is present at the root
   - [ ] `agents.md` is present at the root, alongside `session.json`
   - [ ] `screenshots/` directory contains the captured PNGs
   - [ ] `session.json` has `"schema_version": "1.1.0"`
   - [ ] `agents.md` opens in any markdown viewer and is human-readable
   - [ ] No extra files or unexpected content
10. Open `agents.md` and skim — does it actually describe every event type that appears in `session.json`? (Sanity check, not a test.)
11. **Smoke test for DOD #4**: paste the zip contents (or a representative session) into an AI assistant in a fresh session with **no prior context** and ask: "Produce a structured bug report from this." If the assistant produces sensible output without asking what the schema means, DOD #4 is met. (Manual, one-shot acceptance.)

## Schema Version Decision

**Decision**: Bump from `"1.0.0"` to `"1.1.0"` (semver minor).

**Rationale, most risk-averse reading of CLAUDE.md**:
- CLAUDE.md says "Changes to the schema must bump this version." It does not narrowly scope "schema" to mean only the JSON shape of `session.json`. The `docs/ARCHITECTURE.md` Export Schema section frames the schema as the **whole zip layout** (`session.json` + `screenshots/`).
- Adding a new file to that layout is therefore a schema change.
- Among the three semver options:
  - **Patch (`1.0.1`)**: understates the change. Patch is for bug fixes that do not affect contract. Adding a new file affects the contract.
  - **Minor (`1.1.0`)**: signals "additive, backward-compatible". This is exactly what we are doing — old `session.json` parsers continue to work unchanged, and a new sibling file is available for consumers that want it.
  - **Major (`2.0.0`)**: overstates the change. Major signals breaking changes, which would falsely alarm consumers who do not need to migrate anything.
- Minor is the **least surprising** signal to a downstream consumer reading the version string. It tells them: "Re-validate your zip-discovery code, but your existing `session.json` parsing still works." That is the truth.

**The bump is performed in the same commit as the doc addition** so that no intermediate state ever ships where the doc and the version disagree.

## Definition of Done
- [ ] `agents.md` appears in every exported zip alongside `session.json` (DOD #1)
- [ ] `agents.md` documents schema version, session metadata, every event type and its fields (DOD #2)
- [ ] `agents.md` explains the timeline ↔ `screenshots/` relationship (DOD #3)
- [ ] Manual smoke test against an AI assistant produces a sensible bug report from the zip alone (DOD #4)
- [ ] All existing `exporter.test.ts` regression assertions remain green
- [ ] New tests cover: presence of `agents.md`, content markers, every event type discriminator, byte-length cap, empty-session edge case
- [ ] `schema_version` bumped to `"1.1.0"` in `src/types.ts` and `src/lib/exporter.ts`
- [ ] `docs/ARCHITECTURE.md` updated to reflect new schema version and zip layout
- [ ] `make typecheck` passes
- [ ] `make test` passes
- [ ] `make build` passes
- [ ] Manually loaded extension produces a real export with all three artifacts
- [ ] All changes squashable into a single revertable commit

## Monitoring & Alerting

Chrome extensions distributed locally have no server-side telemetry. Monitoring is limited to:
- User-reported bugs via the repo's issue tracker
- The next contributor running `make test` (automated regression catch)
- Manual smoke after extension reload

No metrics dashboards, no alert thresholds, no on-call rotation. The mitigation is the test suite + the single-revert rollback path.

## Deployment Recommendations

- [ ] **Feature flag**: Not needed. No remote flag mechanism exists for a Chrome extension, and the change is small and easily reverted.
- [ ] **Gradual rollout**: Not applicable to local-installed extensions.
- [ ] **Staging verification**: Loading the unpacked `dist/` in Chrome and exporting one real session is the staging step. Required.
- [ ] **Off-hours deployment**: Not applicable.
- [ ] **Single-commit / single-PR**: **Required.** All changes squash into one commit so revert is atomic.

## Estimated Effort
- Planning: Already done
- Implementation: ~25 minutes (write the doc constant, wire it into exporter, bump version)
- Safety verification: ~10 minutes (review diff, confirm no spread changes, confirm regression guards intact)
- Testing: ~20 minutes (write new tests, run full suite, manual extension load)
- Documentation: ~5 minutes (`docs/ARCHITECTURE.md` refresh)
- **Total**: ~60 minutes

## Formal Verification Assessment
- Concurrency concerns: **No** — `exportSession` is a pure function called once per export from a single service worker entry point. No shared mutable state.
- State machine complexity: **No** — no states, no transitions, just an additive transformation.
- Conservation laws: **No** — no quantities being preserved.
- Authorization model: **No** — no access control changes.
- **Recommendation**: Formal verification not needed. This task has the structural simplicity that makes TLA+ overkill: pure function, no concurrency, no state, single revert path. The unit tests + regression guards are sufficient.

## Security Considerations
- [x] No secrets in code — `agents.md` is a constant describing a public schema
- [x] Input validation complete — no new inputs accepted
- [x] Output encoding — markdown is plain text, no HTML rendering involved
- [x] Authentication/authorization — N/A, no auth surface touched
- [x] OWASP top 10 — N/A, no web surface added
- [x] **No interpolation of user data** into `agents.md` — the constant must never embed session contents. This is the single most important security invariant and is enforced structurally by importing a static string from a module that has no access to runtime session data.
- [x] No external URLs in the doc — avoids any markdown viewer making outbound DNS requests on behalf of a user reviewing their own export
- [x] No new permissions in `manifest.json`
- [x] No new dependencies

---

## ℹ️ Risk Profile Note

This task is **structurally low-risk**: a pure additive change to a pure function in a single file, with a constant string and a literal version bump. The blast radius is bounded by `src/lib/exporter.ts` and a handful of tests.

The safety overhead in this plan (regression guards, byte-length cap, exhaustiveness check on event types, manual smoke test) is **proportionate**: it costs only ~60 minutes, and most of that cost is testing that we would do anyway. The plan does not propose feature flags, gradual rollouts, or formal verification — those would be over-engineering for the actual risk surface.

The one place where safety thinking earns its keep here is **the doc-drift test**: the exhaustiveness assertion against `TimelineEvent["type"]` ensures that six months from now, when someone adds a new event type, the test suite forces them to update `agents.md`. Without that guard, the doc silently rots and DOD #4 silently regresses for every future consumer.
