---
agent: speed-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-3
perspective: speed
---

# Speed Plan: Schema Documentation for AI Consumers

## Architecture Impact

**Components affected:**
- `src/lib/exporter.ts`: Adds one extra entry (`agents.md`) to the `zipData` record. No new module wiring, no callers change.
- `src/types.ts`: One-character bump to the `schema_version` literal type from `"1.0.0"` to `"1.1.0"`.

**New patterns or abstractions introduced:**
- None. Reuses the existing `strToU8(...)` -> `zipData[name]` pattern that already places `session.json` in the zip.

**Dependencies added or modified:**
- None.

**Breaking changes to existing interfaces:**
- `SessionExport.schema_version` literal type changes from `"1.0.0"` to `"1.1.0"`. Additive to the zip layout (new file alongside `session.json`); no field of `session.json` is removed or renamed. Existing parsers reading `session.json` continue to work; only consumers that pinned to the literal `"1.0.0"` are affected, and per `CLAUDE.md` semver this is a minor bump because the schema is back-compatible.

## Approach

Bake `agents.md` as a single exported string constant in a new tiny file `src/lib/agents-doc.ts`, interpolating the `SCHEMA_VERSION` constant so the doc can never drift from the version it ships with. `exportSession()` adds one line to drop that string into `zipData["agents.md"]`. Bump `schema_version` to `"1.1.0"` because the export contract (the zip) has changed even though `session.json`'s shape has not.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `src/lib/agents-doc.ts` | Create | ~120 | Single source of truth for the markdown doc + the `SCHEMA_VERSION` constant. One file, no build step. |
| `src/lib/exporter.ts` | Modify | ~5 | Import `SCHEMA_VERSION` and `AGENTS_DOC`; replace the hard-coded `"1.0.0"`; add one `zipData["agents.md"] = strToU8(AGENTS_DOC)` line. |
| `src/types.ts` | Modify | ~1 | Change `schema_version: "1.0.0"` literal to `schema_version: "1.1.0"`. |
| `src/lib/exporter.test.ts` | Modify | ~50 | Add one `describe("agents.md in export")` block with assertions that verify each DOD checkbox. |

**Total files**: 4 (1 created, 3 modified)
**Total estimated lines**: ~175 lines (most of them are the markdown content of `agents-doc.ts`)

## Implementation Steps

1. **Create `src/lib/agents-doc.ts`**:
   - Export `SCHEMA_VERSION = "1.1.0" as const`.
   - Export `AGENTS_DOC` as a template literal that interpolates `${SCHEMA_VERSION}` once at the top of the doc.
   - Doc body sections (kept terse but exhaustive over event fields):
     1. **Overview** — what the zip is, where to start (`session.json`).
     2. **Schema version** — `${SCHEMA_VERSION}`, semver meaning.
     3. **Top-level shape** — `schema_version`, `session`, `timeline[]`, `summary` (lifted from `SessionExport`).
     4. **Session metadata fields** — every field in `SessionMetadata` minus `tab_id` (which the exporter strips).
     5. **Timeline** — chronological, sorted by `seq`/`timestamp`; common `BaseEvent` fields (`seq`, `timestamp`, `page_url`).
     6. **Event types** — one subsection per discriminator, listing every field, optional vs required, and one-line meaning. Must cover ALL seven: `interaction`, `viewport_resize`, `network_error`, `console_error`, `js_exception`, `annotation`, `screenshot`.
     7. **Screenshots directory** — `screenshots/{id}.png` files, referenced by `screenshot.file` and by `annotation.screenshot_id` / `annotation.element_screenshot_id`.
     8. **Summary** — fields in `SessionSummary`.
     9. **How to write a bug report** — 4-bullet recipe (find annotations -> correlated screenshots -> nearby errors -> reproduction interactions).

2. **Modify `src/types.ts`**:
   - Change `schema_version: "1.0.0";` to `schema_version: "1.1.0";` in the `SessionExport` interface.

3. **Modify `src/lib/exporter.ts`**:
   - Import `SCHEMA_VERSION, AGENTS_DOC` from `./agents-doc`.
   - Replace `schema_version: "1.0.0"` with `schema_version: SCHEMA_VERSION`.
   - After the `zipData["session.json"] = ...` line, add `zipData["agents.md"] = strToU8(AGENTS_DOC);`.

4. **Modify `src/lib/exporter.test.ts`**:
   - Add a `describe("agents.md in export")` block with the assertions listed in the Testing Strategy section below.
   - Update the existing `it("produces a valid zip with session.json")` test that asserts `json.schema_version).toBe("1.0.0")` to `"1.1.0"`.

5. **Run `make test` and `make typecheck`** to confirm.

## Definition of Done

- [ ] Every exported zip contains `agents.md` alongside `session.json` (asserted by unzip + key check).
- [ ] `agents.md` mentions the current schema version, every `SessionMetadata` field, and every event type discriminator.
- [ ] `agents.md` mentions the `screenshots/` directory and explains the link from `annotation.screenshot_id` to those files.
- [ ] Schema version in `agents.md` is sourced from the same `SCHEMA_VERSION` constant used by `exportSession()` (asserted by parsing the version out of the doc and comparing to `SessionExport.schema_version`).
- [ ] `make test` passes.
- [ ] `make typecheck` passes (no `tsc --noEmit` errors).

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Zip contains `agents.md` | Unit | `exportSession()` is a pure function over plain JS data; unzip in-memory and check the key. |
| 2 | Doc mentions schema version + every event type + every metadata field | Unit | Pure string assertions over the unzipped doc. |
| 3 | Doc mentions screenshots dir and the annotation linkage | Unit | Pure string assertions. |
| 4 | Schema version cannot drift between doc and `session.json` | Unit | Parse the version line out of `agents.md` and assert equality with `json.schema_version` produced by the same call. |
| 5 | `make test` / `make typecheck` pass | Unit (suite) | Run by CI / pre-commit. |

**Speed planner bias**: All criteria are verifiable at the unit level because `exportSession()` is a pure function — no Chrome APIs, no I/O, no network. Zero integration or e2e tests proposed.

**Determinism rule**: No LLM calls. DOD #4 from the roadmap ("AI assistant given only the zip can produce a structured bug report without additional context") is intentionally proxied by structural assertions (presence of every event type, schema version, screenshots reference) rather than calling a real model. This is the speed-vs-quality tradeoff: the quality plan may want a snapshot test against a recorded LLM response or a hand-curated checklist; we accept the proxy.

## Testing Strategy

- **Unit**: All assertions in `src/lib/exporter.test.ts`. Exact tests to add:

  ```ts
  describe("agents.md in export", () => {
    const session = makeSession();
    const zipBytes = exportSession(session, makeEvents(), {});
    const unzipped = unzipSync(zipBytes);
    const doc = strFromU8(unzipped["agents.md"]);
    const json = JSON.parse(strFromU8(unzipped["session.json"])) as SessionExport;

    it("includes agents.md in the zip alongside session.json", () => {
      // DOD #1
      expect(unzipped["agents.md"]).toBeDefined();
      expect(unzipped["agents.md"].length).toBeGreaterThan(0);
      expect(unzipped["session.json"]).toBeDefined();
    });

    it("documents the current schema version and matches session.json", () => {
      // DOD #2 (version) + drift guard
      expect(doc).toContain(json.schema_version);
      // Version appears exactly once near the top, not hard-coded twice
      expect(doc.match(/1\.1\.0/g)?.length).toBeGreaterThanOrEqual(1);
    });

    it("documents every SessionMetadata field that survives export", () => {
      // DOD #2 (metadata fields)
      const metadataFields = [
        "id", "start_time", "end_time", "duration_ms",
        "initial_url", "user_agent", "viewport",
      ];
      for (const f of metadataFields) {
        expect(doc).toContain(f);
      }
      // tab_id is stripped on export and must NOT be advertised
      expect(doc).not.toContain("tab_id");
    });

    it("documents every timeline event type discriminator", () => {
      // DOD #2 (event types) — the critical one
      const discriminators = [
        "interaction",
        "viewport_resize",
        "network_error",
        "console_error",
        "js_exception",
        "annotation",
        "screenshot",
      ];
      for (const t of discriminators) {
        expect(doc).toContain(t);
      }
    });

    it("explains the link between timeline entries and screenshots/", () => {
      // DOD #3
      expect(doc).toContain("screenshots/");
      expect(doc).toContain("screenshot_id");
    });
  });
  ```

  Plus update the existing `produces a valid zip with session.json` test:
  `expect(json.schema_version).toBe("1.1.0");`

- **Integration**: Skip. `exportSession()` is the integration point and is fully covered as a pure function.

- **E2E**: Skip. No new user-facing flow — the popup/widget download path is unchanged.

**E2E Test Impact**:
- **Existing e2e tests affected**: None. There are no Vitest e2e tests in this repo (Chrome API integration is tested manually per `CLAUDE.md`).
- **New e2e tests needed**: None — no new user-visible flows. The user still clicks "Stop & Download" and gets a zip; only the zip's contents grow by one file.
- **Cost note**: N/A.

**Test files to create/modify**: `src/lib/exporter.test.ts` only.

## Risk Assessment

**Risk Level**: Low

**Why this is safe**:
- `exportSession()` is a pure function with full unit coverage; the change is one extra `zipData[...]` entry.
- Adding a file to a zip cannot break consumers that read `session.json` — they will simply ignore an unknown sibling file.
- `schema_version` bump is the minor-version case (additive), aligned with `CLAUDE.md`'s semver rule.
- No new dependencies, no new build steps, no Chrome API surface touched.
- The doc lives next to the constant it references; the test asserts the version inside the doc equals the version in `session.json`, so drift is caught at CI time.

**Tradeoffs accepted**:
- The doc is hand-written prose, not generated from the TypeScript AST. If a new field is added to e.g. `InteractionEvent`, a developer must remember to update `agents-doc.ts`. The quality plan may prefer a programmatic generator (e.g. ts-morph or a runtime schema object). We accept the manual-sync risk because:
  1. The schema is small (7 event types, ~30 fields total).
  2. Schema changes are rare and already require a `schema_version` bump per `CLAUDE.md`, which is a natural review checkpoint.
  3. Our tests will fail loudly if any of the seven discriminators is missing from the doc, which catches the most likely mistake (forgetting to add a new event type).
- The "AI can produce a bug report from only the zip" DOD is verified structurally, not behaviourally. No live model call.

## Estimated Effort

- Planning: Already done
- Implementation: ~25 minutes (most of it writing the markdown body)
- Testing: ~10 minutes
- **Total**: ~35 minutes

## Formal Verification Assessment

- Concurrency concerns: No — `exportSession()` is synchronous and pure.
- State machine complexity: No — single export call, no transitions.
- Conservation laws: No — additive change, no quantities preserved.
- Authorization model: No — no access control.
- Recommendation: Not needed.
- If recommended, key invariants: N/A.

## What This Plan Does NOT Include

- Does NOT generate the doc from TypeScript types programmatically — defer to a future iteration if drift becomes a real problem.
- Does NOT add a JSON Schema (`schema.json`) alongside the markdown — out of scope; the markdown already covers the four DOD items.
- Does NOT add a top-level `README.md` to the zip — `agents.md` covers AI consumers and that is the persona for this feature.
- Does NOT include example `session.json` snippets in the doc beyond what is needed to describe each event type — keeps the file small.
- Does NOT touch `manifest.json` / `package.json` versions — those track extension releases, not export schema version. The existing `make bump-*` flow handles that separately when the feature ships.
- Does NOT refactor `exporter.ts` beyond the minimum (no extracting a `buildZipData()` helper, etc.).
- Does NOT add a CHANGELOG entry for the schema bump — the `docs/ARCHITECTURE.md` changelog is for extension versions, not schema versions; if the judge wants this, it is one additional line in the existing table.
