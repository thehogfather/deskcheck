---
agent: quality-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-3
perspective: quality
---

# Quality Plan: Schema Documentation for AI Consumers

## Approach Summary

The doc is **generated programmatically from a single source of truth declared in TypeScript**, not authored as free-form markdown. The source of truth is a `SCHEMA_DOC` constant — a structured description of every event type, its discriminator value, and its fields — that lives in a new `src/lib/schema-doc.ts` module next to the types it describes.

Two pure functions consume that constant:
1. `renderAgentsMarkdown(schemaVersion)` — produces the `agents.md` string from `SCHEMA_DOC`. Pure, deterministic, easy to snapshot-test.
2. `getSchemaEventTypes()` — returns the list of discriminator values declared in `SCHEMA_DOC`. Used by the drift-detection test.

Drift between `src/types.ts` and the doc is prevented by a **runtime drift-detection test** in vitest that:
- Imports the actual `TimelineEvent` discriminated union via a tiny exhaustiveness helper.
- Asserts that every `type` discriminator value present in the union appears in `SCHEMA_DOC`, and vice versa.
- Asserts the rendered markdown mentions every discriminator, the current `schema_version`, and the `screenshots/` directory.

**Why this shape over the alternatives:**

| Alternative | Why rejected |
|---|---|
| Static `.md` file imported as a string (`?raw` import) | Easy to ship, but trivially drifts. Adding a new event type to `types.ts` would silently leave the doc stale. The drift-detection test would have to parse markdown, which is brittle. |
| Build-time codegen from TS AST (e.g. ts-morph) | Heavy dependency, complicates `make build`, hard to review, overkill for ~7 event types. Violates "don't over-engineer". |
| Co-locate doc inside `types.ts` as JSDoc + extract | Mixes concerns, makes `types.ts` noisy. JSDoc is also hard to assert on at runtime without parsing. |
| Constant-driven render (chosen) | Single TS module, no new dependencies, every field is type-checked, drift test is a 5-line `expect(...).toEqual(...)`. Reviewable in one sitting. |

The constant approach also gives us **one place to update** when a new event type is added: add it to `types.ts`, then add the matching entry to `SCHEMA_DOC`. The drift test fails loudly if you forget the second step. That is the strongest invariant we can cheaply enforce.

## Architecture Impact

**Components affected:**
- `src/lib/exporter.ts`: writes `agents.md` into the zip; bumps `schema_version` to `"1.1.0"`.
- `src/types.ts`: literal type for `schema_version` widens from `"1.0.0"` to `"1.1.0"` (one-character change, type-checked).
- `src/lib/` gains one new module: `schema-doc.ts`.

**New patterns or abstractions introduced:**
- A "doc-as-data" pattern (`SCHEMA_DOC` constant + `renderAgentsMarkdown()`). This is the only new abstraction. It mirrors how `session-metrics.ts` already separates pure functions from the components that consume them.

**Dependencies added or modified:**
- None. No new runtime or dev dependencies.

**Breaking changes to existing interfaces:**
- `SessionExport.schema_version` literal changes from `"1.0.0"` to `"1.1.0"`. This is a TS-level type change; downstream consumers that pin to the literal would notice. No `session.json` field is added, removed, or renamed. The zip layout gains one file (`agents.md`). Per CLAUDE.md ("export contract is the whole zip"), this is the right place to bump.

## Architectural Approach

The doc generator lives in `src/lib/` alongside other pure utilities (`session-metrics.ts`, `dom-utils.ts`) and follows the project's "pure functions, vitest-tested without Chrome mocks" convention. The exporter calls `renderAgentsMarkdown(SCHEMA_VERSION)` once and adds the result to the existing `zipData` map — a one-line change at the integration point. No service-worker, content-script, or popup changes; the doc is built at export time, not at runtime.

## Files to Create/Modify

| File | Purpose | Quality Considerations |
|---|---|---|
| `src/lib/schema-doc.ts` (new) | Defines `SCHEMA_VERSION` constant, `SCHEMA_DOC` data structure, `renderAgentsMarkdown()`, `getSchemaEventTypes()` | Pure module, no Chrome APIs, no I/O. All exports typed. Single source of truth for doc content. |
| `src/lib/schema-doc.test.ts` (new) | Unit tests for the renderer + drift-detection test | Tests pure functions in isolation. Drift test uses an exhaustiveness helper to enumerate union members. |
| `src/lib/exporter.ts` (modify) | Import `renderAgentsMarkdown` and `SCHEMA_VERSION`; add `agents.md` to `zipData`; use `SCHEMA_VERSION` instead of inline `"1.0.0"` literal | Removes the magic-string `"1.0.0"`; the version now lives in one place. Two-line addition to `zipData`. |
| `src/lib/exporter.test.ts` (modify) | Add integration test asserting `agents.md` is present in the zip, mentions every event type, and references `screenshots/` | Reuses existing `makeEvents()` factory; extends it to cover all 7 event types. |
| `src/types.ts` (modify) | Update `SessionExport.schema_version` literal from `"1.0.0"` to `"1.1.0"` | One-character change, type-checked at the call site in `exporter.ts`. |
| `docs/ARCHITECTURE.md` (modify) | Update Export Schema section to mention `agents.md`; add `0.4.0` row to Changelog | Keeps architecture doc in sync with reality. |
| `package.json`, `manifest.json` (modify) | Bump version `0.3.0` → `0.4.0` | Per project semver convention; schema bump is a user-visible change. |

**Total files**: 7 (3 new, 4 modified)

## Implementation Steps

1. **Create `src/lib/schema-doc.ts`** — declare `SCHEMA_VERSION = "1.1.0"`, declare `SCHEMA_DOC` as a typed constant (an array of event-type descriptors with `type`, `description`, and `fields: { name, type, required, description }[]`), and implement `renderAgentsMarkdown(version)` that walks the constant and produces markdown sections for: header, schema version, top-level layout, session metadata fields, each event type, screenshots directory relationship, and a "how to write a bug report" closing section. *Quality rationale: data and rendering separated so each is independently testable; the constant is the single source of truth.*

2. **Add an exhaustiveness helper inside `schema-doc.ts`** — a tiny `assertExhaustiveEventTypes()` that uses a `switch` on `TimelineEvent['type']` with a `never` default. Imported by the drift test. *Quality rationale: leverages TS to make "I added a type but forgot the doc" a compile error in tests.*

3. **Write `src/lib/schema-doc.test.ts`** — three test groups:
   - `renderAgentsMarkdown`: snapshot-style assertions on key sections (header contains version; every discriminator appears; `screenshots/` mentioned; session metadata fields enumerated).
   - `getSchemaEventTypes`: returns exactly the 7 known discriminator values.
   - **Drift detection**: a list of `EXPECTED_TYPES` (hand-maintained) is compared against `getSchemaEventTypes()` and against the rendered markdown via regex. The exhaustiveness helper guarantees `EXPECTED_TYPES` is complete.

   *Quality rationale: every DOD checkbox is asserted by a test, not just "the file exists".*

4. **Modify `src/lib/exporter.ts`** — replace the inline `"1.0.0"` with `SCHEMA_VERSION`; add `zipData["agents.md"] = strToU8(renderAgentsMarkdown(SCHEMA_VERSION))` directly after the `session.json` line. *Quality rationale: minimal diff at the integration point keeps the change reviewable.*

5. **Update `src/types.ts`** — change `schema_version: "1.0.0"` to `schema_version: "1.1.0"`. *Quality rationale: TS literal types catch any path that still uses the old version.*

6. **Extend `src/lib/exporter.test.ts`** — add an event-coverage helper that produces one event of each `TimelineEvent` subtype (interaction, viewport_resize, network_error, console_error, js_exception, annotation, screenshot — currently `makeEvents()` covers 5 of 7, missing `viewport_resize` and `js_exception`). Add an `it("includes agents.md alongside session.json")` block that asserts presence, schema-version mention, every-discriminator mention, and `screenshots/` mention. Update the existing `schema_version` assertion to `"1.1.0"`. *Quality rationale: integration test exercises the full export path with full event coverage.*

7. **Update `docs/ARCHITECTURE.md`** — add `agents.md` to the Export Schema diagram, add a `0.4.0` Changelog row (`Schema docs for AI consumers; export schema bumped to 1.1.0`). *Quality rationale: architecture doc is the entry point for new contributors; it must reflect the new zip layout.*

8. **Bump `package.json` and `manifest.json` to `0.4.0`** via `make bump-minor`. *Quality rationale: per CLAUDE.md, manifest and package versions must always match; the schema bump justifies a minor.*

9. **Run `make typecheck && make test`** to verify nothing breaks. *Quality rationale: green test suite is the merge gate.*

## How the Doc Stays in Sync with the Schema

This is the most important quality property of this feature. The strategy has **three overlapping safeguards**:

1. **Single source of truth (data, not prose)**: `SCHEMA_DOC` is the only place where event-type field descriptions live. The markdown is generated, never hand-edited. Any change to the doc happens by editing the constant — and that constant is type-checked.

2. **TS exhaustiveness check**: a `switch (e.type) { ... default: const _: never = e }` helper in `schema-doc.ts` references every member of the `TimelineEvent` union. If a new event type is added to `types.ts` without updating the helper, **the build fails at typecheck time** (`make build` runs `tsc --noEmit`).

3. **Runtime drift-detection test**: `schema-doc.test.ts` asserts that the set of discriminators returned by `getSchemaEventTypes()` (derived from `SCHEMA_DOC`) equals an `EXPECTED_TYPES` constant in the test. The exhaustiveness helper from safeguard #2 is also imported in the test file, so adding a new TS event type but forgetting `SCHEMA_DOC` produces both a failing test and a typecheck error.

Together, these mean: **you cannot add a new event type to `types.ts` and ship a stale doc**. The compiler catches it, and the test catches it.

## Test Strategy

### Unit tests (`src/lib/schema-doc.test.ts`)

- `renderAgentsMarkdown()`:
  - Includes `# DeskCheck Session Schema` heading
  - Mentions `Schema version: 1.1.0`
  - Contains a `## Session metadata` section enumerating every `SessionMetadata` field name
  - Contains one `### type: <discriminator>` heading for each of the 7 event types
  - For each event type, lists the fields in a table or bullet list
  - Mentions `screenshots/` directory and explains the `screenshot.id` ↔ `screenshots/{id}.png` relationship
  - Mentions the `screenshot_id` field on annotation events linking back to the screenshots directory
- `getSchemaEventTypes()`:
  - Returns exactly `["interaction", "viewport_resize", "network_error", "console_error", "js_exception", "annotation", "screenshot"]` (order-insensitive)
- **Drift detection**:
  - `expect(new Set(getSchemaEventTypes())).toEqual(new Set(EXPECTED_TYPES))`
  - The exhaustiveness helper is imported (forces TS-level coverage)
  - For each `EXPECTED_TYPES` value, `expect(rendered).toMatch(new RegExp(\`type: ${type}\`))`

### Integration test (`src/lib/exporter.test.ts`)

- Extend `makeEvents()` (or add `makeAllEventTypes()`) to produce one event of each of the 7 subtypes.
- New `it("includes agents.md alongside session.json")`:
  - Unzip the export
  - `expect(unzipped["agents.md"]).toBeDefined()`
  - Decode to string
  - Assert it mentions `1.1.0`, every discriminator, and `screenshots/`
- Update existing `expect(json.schema_version).toBe("1.0.0")` to `"1.1.0"`.

### Drift-detection test

Same module as unit tests above. Co-located so a contributor running `npx vitest src/lib/schema-doc.test.ts` sees a single failure with a clear message ("Event type 'X' is in SCHEMA_DOC but not in TimelineEvent" or vice versa).

### DOD → Test Mapping

| DOD checkbox | Test that proves it |
|---|---|
| Every exported zip contains `agents.md` alongside `session.json` | `exporter.test.ts` → `it("includes agents.md alongside session.json")` asserts `unzipped["agents.md"]` is defined |
| `agents.md` describes the schema version, session metadata fields, and each event type with field definitions | `schema-doc.test.ts` → schema-version assertion, session-metadata-section assertion, per-event-type heading assertion, per-event-type fields assertion |
| `agents.md` explains the relationship between timeline entries and `screenshots/` directory | `schema-doc.test.ts` → asserts presence of `screenshots/`, `screenshot.id`, and the `screenshot_id` linkage from annotation events |
| AI assistant given only the zip can produce a structured bug report without additional context | Cannot be unit-asserted; covered indirectly by the four assertions above plus a manual smoke test (load extension → record → export → feed zip to Claude → verify it produces a bug report). Documented in PR description. |

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|---|---|---|
| 1 | Every exported zip contains `agents.md` alongside `session.json` | Integration | Tests the boundary between `exporter` and the zip (fflate); must verify the file is actually in the archive |
| 2 | `agents.md` describes schema version, metadata, and event types with fields | Unit | Pure render function; no I/O; fastest feedback |
| 3 | `agents.md` explains screenshots/ relationship | Unit | Same pure render function; assertions on output string |
| 4 | AI can produce a bug report from only the zip | Manual smoke (acceptance) | Cannot be deterministically asserted in vitest; documented in PR; surrogate is the union of unit + integration assertions |
| 5 | Doc stays in sync with `types.ts` (drift detection) | Unit | TS exhaustiveness + set-equality on discriminators; runs in milliseconds |
| 6 | `schema_version` bumps to `1.1.0` | Unit | Single literal assertion in exporter test |

**Quality planner bias**: I prefer unit tests (5 of 6 criteria), one integration test for the file-in-zip boundary, and accept that DOD #4 is acceptance-grade (not automatable in vitest without an LLM call, which violates determinism).

**Determinism rule**: No test calls an LLM. DOD #4's "AI can produce a bug report" is assessed manually in the PR; the unit and integration tests verify the *necessary preconditions* for that to be possible (doc present, complete, accurate).

## Schema Version Decision

**Bump to `1.1.0`** (minor).

Reasoning grounded in CLAUDE.md ("Schema version follows semver. Changes to the schema must bump this version.") and the project's framing of the export contract:

- The export contract is the **whole zip**, not just `session.json` (CLAUDE.md: "the export schema is the product's core contract... a zip containing session.json and screenshots/").
- Adding `agents.md` to the zip is an **additive** change to that contract — existing parsers that read `session.json` continue to work unchanged.
- Additive changes are minor bumps in semver (`1.0.0` → `1.1.0`).
- Skipping the bump would silently change the contract, violating the project's semver commitment and making it impossible for downstream tools to detect that `agents.md` is now available.

The corresponding `package.json` / `manifest.json` bump is `0.3.0` → `0.4.0` (minor), since this is a user-visible feature.

## Architecture Impact (changelog text)

Append to `docs/ARCHITECTURE.md`:

**Export Schema section** — update to:
```
deskcheck-session-{timestamp}.zip
├── session.json    # { schema_version, session, timeline[], summary }
├── agents.md       # Self-describing schema doc for AI consumers (generated)
└── screenshots/    # PNGs referenced by timeline events
```

**Changelog table** — add row:
| 0.4.0 | Self-documenting exports: every zip includes generated `agents.md` describing the schema. Export contract bumped to 1.1.0 (additive, no `session.json` shape changes). |

**Shared Libraries section** — add bullet:
- **schema-doc.ts** — Single source of truth for the export schema doc. Pure renderer (`renderAgentsMarkdown`) consumed by `exporter.ts`. Drift between this constant and `types.ts` is caught by typecheck + unit tests.

The doc generation lives in `src/lib/` (Shared Libraries layer), not in the service worker, content script, or popup — it is pure and called only at export time.

## Code Quality Checklist

- [ ] Follows SOLID principles where applicable (single responsibility: `schema-doc.ts` does one thing — describe and render the schema)
- [ ] No code duplication: `SCHEMA_VERSION` lives in one place; no duplicated event-type lists
- [ ] Clear naming: `SCHEMA_DOC`, `renderAgentsMarkdown`, `getSchemaEventTypes`, `assertExhaustiveEventTypes`
- [ ] Appropriate abstraction level: a constant + pure function, not a templating engine
- [ ] Error handling: render is total — no inputs that can fail; exporter path unchanged for screenshot error handling
- [ ] Types properly defined: no `any`; the `SCHEMA_DOC` constant is typed against `TimelineEvent['type']`
- [ ] Edge cases: empty events list still produces a complete `agents.md` (it's not data-dependent)
- [ ] Logging/monitoring: not needed; pure function

## Patterns to Apply

| Pattern | Where | Why |
|---|---|---|
| Single source of truth | `SCHEMA_VERSION` constant in `schema-doc.ts`, imported by `exporter.ts` and `types.ts` (via literal) | Eliminates the magic-string `"1.0.0"` currently duplicated between `exporter.ts` and `types.ts` |
| Data + pure renderer | `SCHEMA_DOC` data + `renderAgentsMarkdown()` function | Makes content reviewable (data) and rendering testable (function) independently |
| Exhaustiveness check | `assertExhaustiveEventTypes()` helper | Compile-time guarantee that all union members are covered |
| Pure function in `src/lib/` | `schema-doc.ts` follows the same shape as `session-metrics.ts` | Matches existing project convention; testable without Chrome mocks |

## Impact Assessment

**Positive Impacts**:
- Export becomes self-documenting; new AI consumers need zero external context
- `SCHEMA_VERSION` is now a single source of truth (improvement over current duplicated literal)
- Drift-detection test means future event-type additions can't ship a stale doc
- Architecture doc is brought back in sync with the actual export shape

**Neutral** (what stays the same):
- `session.json` shape is unchanged
- All other components (service worker, content script, popup) untouched
- Existing tests continue to pass after the version literal update

**Risks**:
- *Risk*: The drift test could give false confidence if `EXPECTED_TYPES` is hand-maintained and forgotten. *Mitigation*: import the TS exhaustiveness helper in the same test file so a new event type produces a typecheck error before the test even runs.
- *Risk*: Generated markdown could be hard to read by humans. *Mitigation*: snapshot the rendered output and review it during the PR; the constant-driven approach guarantees consistency, not aesthetics.
- *Risk*: Bumping `schema_version` could break a downstream tool that pins to `"1.0.0"`. *Mitigation*: this project has no external consumers yet (per repo state); the bump establishes the convention for future ones.

## Estimated Effort

- Planning: Already done
- Implementation: 35 minutes (constant + renderer + exporter integration + version bumps)
- Testing: 25 minutes (unit + drift + integration + extending `makeEvents()`)
- Review prep: 10 minutes (PR description, manual smoke test of export → feed to AI)
- **Total**: 70 minutes

⚠️ **Quality Investment**: This thorough approach takes ~2x longer than a static-markdown speed plan (~30 min). Worth it because the doc-as-data design means the test suite, not human discipline, prevents drift. Without this, the doc rots the first time someone adds an event type.

## Technical Debt Addressed

- **Eliminates duplicated `"1.0.0"` literal** between `src/types.ts` and `src/lib/exporter.ts` by introducing `SCHEMA_VERSION` as the single source of truth.
- **Closes a documentation gap**: the architecture doc currently shows the export contract as `session.json` + `screenshots/`; after this feature it accurately reflects the contract.
- **Avoids new debt**: by choosing data-driven over hand-authored markdown, we don't ship a doc that will rot the first time the schema changes.

## Formal Verification Assessment

- Concurrency concerns: No — pure function called once at export time, no shared state
- State machine complexity: No — the doc is a constant per schema version
- Conservation laws: No — no quantities to preserve
- Authorization model: No — local-only export
- **Recommendation**: Formal verification not needed. Standard unit + integration tests are sufficient.

## Future Extensibility

- **Adding a new event type** (e.g., `voice_annotation` for feature #6): add the variant to `TimelineEvent` in `types.ts`, add the matching entry to `SCHEMA_DOC`, add the case to `assertExhaustiveEventTypes()`. Forgetting any step fails typecheck or tests.
- **Adding a new top-level zip file** (e.g., `PRIVACY.md` from feature #2): the same pattern (`zipData["PRIVACY.md"] = strToU8(...)`) extends naturally; if `PRIVACY.md` is also schema-versioned, it becomes another renderer in `src/lib/`.
- **Internationalization**: `renderAgentsMarkdown` could accept a locale argument later; for now, English-only per the AI Consumer persona (English is the lingua franca for AI assistants).
- **Schema version 2.0**: when a breaking change happens, the constant changes, the version bumps, and the test suite catches every event type that needs re-documentation.
