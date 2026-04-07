# Feature #3 — Schema documentation for AI consumers

**Roadmap source**: `docs/roadmap.md` → Priority: Now → Item 3
**Persona**: AI Consumer
**Branch**: `feature/schema-docs-for-ai-consumers`
**Worktree**: `.claude/worktrees/feature-schema-docs-for-ai-consumers`

## Goal

Make every exported `.zip` self-documenting so an AI assistant (or human teammate) given only the zip can parse `session.json` and produce a structured bug report without external references.

## Description

Include a lightweight `agents.md` file in every exported zip that describes the `session.json` schema — event types, field meanings, timeline structure, and how to interpret screenshots.

## Definition of Done (verbatim from roadmap)

- [ ] Every exported zip contains `agents.md` alongside `session.json`
- [ ] `agents.md` describes the schema version, session metadata fields, and each event type with field definitions
- [ ] `agents.md` explains the relationship between timeline entries and `screenshots/` directory
- [ ] An AI assistant given only the zip can produce a structured bug report without additional context

## Hard constraints (from existing code)

- Export currently lives in `src/lib/exporter.ts` → `exportSession()`. The zip is built by `fflate.zipSync` from a `Record<string, Uint8Array>`. The cleanest place to add `agents.md` is right next to `session.json` in `zipData`.
- Schema is defined in `src/types.ts` (`SessionExport`, `TimelineEvent` discriminated union, `SessionMetadata`, `SessionSummary`). The doc must stay in lock-step with the actual TypeScript types — the existing `schema_version` is `"1.0.0"`.
- Tests live in `src/lib/exporter.test.ts` (Vitest, no Chrome mocks for pure functions).
- Per `CLAUDE.md`: any change to the export schema must bump `schema_version`. **Adding `agents.md` is an additive change to the zip layout, not a change to `session.json`'s shape**, so the planners need to decide whether the `schema_version` bumps. (Recommendation hint: yes — the export contract is the whole zip, not just `session.json`. Bump to `1.1.0`.)

## Notes for planners

- The doc is meant to be read by AI assistants — markdown is appropriate, keep it concise but exhaustive over event-type fields.
- The doc is constant per `schema_version`. Two viable approaches: (a) static markdown file in `src/lib/` imported as a string at build time, (b) generated programmatically from a constant. Both are valid; the speed plan probably favours (a), the quality plan may favour (b) for keeping doc in sync with types.
- DOD #4 ("AI assistant given only the zip can produce a structured bug report without additional context") is hard to assert in a unit test. The acceptance test should at minimum verify the doc is present, mentions the schema version, mentions every event `type` discriminator value, and mentions the `screenshots/` directory.
