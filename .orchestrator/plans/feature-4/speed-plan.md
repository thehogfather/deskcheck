---
agent: speed-planner
generated: 2026-04-07T19:45:00Z
task_id: feature-4
perspective: speed
---

# Speed Plan: PII Capture Modes

## Architecture Impact

**Components affected:**
- Popup (`src/popup/`): adds a 3-way mode selector before "Start Session"
- Service worker (`src/background/service-worker.ts`): plumbs `captureMode` from `START_SESSION` into session creation
- Session store (`src/lib/session-store.ts`): stores `captureMode` on `SessionMetadata`
- Content script (`src/content/index.ts` + `recorder.ts`): receives mode and gates input event capture
- Types (`src/types.ts`): adds `CaptureMode` type, extends `SessionMetadata` and `START_SESSION` / `SESSION_STARTED` messages, extends `InteractionEvent` with optional metadata-only fields
- New helper (`src/lib/pii.ts`): pure function `extractInputMetadata(value, target)` — easy to unit test

**New patterns or abstractions introduced:**
- One new pure helper module (`src/lib/pii.ts`). No new abstractions in the recorder — just a branch on mode.

**Dependencies added or modified:**
- None

**Breaking changes to existing interfaces:**
- `SessionMetadata` gains a `capture_mode: CaptureMode` field. Existing exports are forward-compatible because consumers only need to ignore unknown fields. Schema version stays `1.0.0` — additive change. (If the judge prefers, bump to `1.1.0`; speed default is no bump.)

## Approach
Add a `captureMode` setting threaded popup → service worker → content script. Branch the existing `emitInput()` debounced handler in `recorder.ts` on the mode: Full keeps current behaviour, Metadata calls a new pure `extractInputMetadata()` helper and emits a value-less event with metadata fields, None returns early. Persist the mode on `SessionMetadata` so it shows up in the export.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/types.ts` | Modify | ~15 | Add `CaptureMode` union, extend `SessionMetadata`, extend `InteractionEvent` with optional metadata fields, extend `START_SESSION` and `SESSION_STARTED` messages |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/index.html` | Modify | ~10 | Add a `<fieldset>` with three radio buttons (Full default / Metadata / None) |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/popup.css` | Modify | ~15 | Minimal styling for the radio group (reuse existing palette) |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/popup.ts` | Modify | ~10 | Read selected radio value, pass `captureMode` in `START_SESSION` payload |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/session-store.ts` | Modify | ~5 | `createSession()` accepts `captureMode`, stores on `SessionMetadata` (default `"full"` if omitted) |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/background/service-worker.ts` | Modify | ~8 | Pass `msg.captureMode` into `createSession()`; include `captureMode` in the `SESSION_STARTED` message sent to the tab |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/content/index.ts` | Modify | ~6 | Capture `captureMode` from `SESSION_STARTED`/`GET_SESSION_STATE`, pass into `startRecording(sendEvent, captureMode)` |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/content/recorder.ts` | Modify | ~25 | Accept `captureMode` arg; in `emitInput()` branch on mode (full / metadata / none); none mode also short-circuits the input + change listeners |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/exporter.test.ts` | Modify | ~5 | Update existing fixture session objects to include `capture_mode` (or rely on default) |

## Files to Create

| File | Purpose | Estimated Lines |
|------|---------|-----------------|
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/pii.ts` | Pure `extractInputMetadata(value: string, fieldType: string)` returning `{ length, word_count, has_digits, has_emoji, has_special }`. Also exports `CAPTURE_MODE_DEFAULT = "full"` for shared default. | ~30 |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/pii.test.ts` | Vitest unit tests for `extractInputMetadata`: empty, ascii, digits-only, emoji, special chars, multi-word, mixed | ~60 |

**Total files**: 9 modified + 2 new = 11
**Total estimated lines**: ~190 (including tests)

## Implementation Steps

1. **Types** — Add `CaptureMode = "full" | "metadata" | "none"` to `src/types.ts`. Add `capture_mode: CaptureMode` to `SessionMetadata`. Extend `InteractionEvent` with optional `value_length?`, `word_count?`, `has_digits?`, `has_emoji?`, `has_special?`, `field_type?` (all optional, populated only in metadata mode). Extend `START_SESSION` and `SESSION_STARTED` messages to carry `captureMode`.
2. **Pure helper** — Create `src/lib/pii.ts` with `extractInputMetadata(value, fieldType)` returning the metadata bag. Use simple regexes: `/\d/`, `/[\p{Extended_Pictographic}]/u`, `/[^\p{L}\p{N}\s]/u`. Word count = `value.trim().split(/\s+/).filter(Boolean).length`.
3. **Tests for helper** — Write `src/lib/pii.test.ts` covering all DoD metadata fields with deterministic inputs.
4. **Session store** — `createSession()` gains optional `captureMode` arg, defaults to `"full"`. Persist on metadata.
5. **Service worker** — Forward `msg.captureMode` to `createSession()`. Include `captureMode` on the `SESSION_STARTED` message and in `GET_SESSION_STATE` response so the content script knows the mode after a service-worker restart.
6. **Popup HTML/CSS** — Add radio fieldset above start button. Default selection: Full. Hide the fieldset when an active or exportable session exists (reuse the existing `.hidden` toggle in `refreshState()`).
7. **Popup JS** — Read the selected radio value when starting; pass `captureMode` in the `START_SESSION` payload.
8. **Content script** — `index.ts` stores `captureMode` from `SESSION_STARTED` (and from `GET_SESSION_STATE` fallback) and passes it into `startRecording(sendEvent, captureMode)`.
9. **Recorder** — `startRecording(onEvent, captureMode)` signature change. In `emitInput()`:
   - `none` → never registered (early return at top of `startRecording` skips both `input` and `change` listeners — most efficient).
   - `metadata` → call `extractInputMetadata`, emit interaction event with metadata fields and **no `value`**.
   - `full` → existing behaviour unchanged.
   For password fields in metadata mode, still skip raw value (just record `field_type: "password"`, `value_length`, no character class flags — or treat password as a hard mask in all non-full modes).
10. **Run** `make typecheck && make test`. Update any exporter tests whose fixtures construct `SessionMetadata` to include `capture_mode: "full"`.

## Definition of Done
- [ ] Popup shows three radio buttons (Full / Metadata / None) with Full preselected, hidden when a session is active
- [ ] Selecting "Full" and recording produces interaction events identical to current behaviour (passwords still masked, value still truncated to 200 chars) — verified by reading exported `session.json`
- [ ] Selecting "Metadata" produces interaction events of subtype `input` with `value_length`, `word_count`, `has_digits`, `has_emoji`, `has_special`, `field_type`, and `selector`, but no `value` field
- [ ] Selecting "None" produces zero events of subtype `input` in the timeline
- [ ] `session.json` `session.capture_mode` field equals the selected mode
- [ ] Existing tests still pass; new `pii.test.ts` passes
- [ ] `make typecheck` clean

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Popup shows three radios with Full preselected | Unit (jsdom) | Tiny DOM check; load `popup.ts` against jsdom or assert HTML structure directly. Optional — UI is trivial enough that visual inspection during dev is sufficient. |
| 2 | Full mode behaves identically | Unit | Recorder is a pure function over DOM events; instantiate jsdom, dispatch input events, assert emitted event shape. Already the implicit pattern. |
| 3 | Metadata mode emits metadata fields, no raw value | Unit | Same recorder unit test, parameterized on mode. Plus `pii.test.ts` covers `extractInputMetadata` exhaustively. |
| 4 | None mode suppresses input events | Unit | Recorder unit test asserting zero `input` events emitted when mode is `none`. |
| 5 | `session.json` records `capture_mode` | Unit | Assert in `session-store.test.ts` (create one if missing) or in an exporter test using a fixture session with each mode. |
| 6 | Default mode is Full | Unit | Asserted by the popup HTML test and by `createSession()` default-arg test. |

**Speed planner bias**: All criteria verified at unit level. No integration or e2e additions. Manual smoke test in Chrome after build is the final check (already part of dev loop).

**Determinism rule**: All proposed tests use fixed string inputs and synthetic DOM events. No LLM, no network, no Chrome APIs.

## Testing Strategy
- **Unit**:
  - `src/lib/pii.test.ts` (new) — `extractInputMetadata` for empty, ascii, digits-only, emoji, multi-word, special chars, mixed
  - `src/content/recorder.test.ts` (new, jsdom) — for each `captureMode`, dispatch synthetic input + change events on a textarea/input/password input and assert the emitted event payloads. ~3 tests.
  - Optionally extend `src/lib/exporter.test.ts` to assert `session.capture_mode` round-trips through `exportSession()`.
- **Integration**: Skip. Existing manual extension load is sufficient for service-worker/content-script messaging.
- **E2E**: Skip. No new Playwright tests.

**E2E Test Impact**:
- **Existing e2e tests affected**: Check `e2e/` for any test that starts a session via the popup — if a test clicks `#start-btn`, the new radio fieldset is non-blocking (default Full preserves behaviour) so existing flows should pass without modification.
- **New e2e tests needed**: None — no new user-visible flows beyond a radio fieldset whose default keeps current behaviour.
- **Cost note**: N/A.

**Test files to create/modify**:
- Create: `src/lib/pii.test.ts`, `src/content/recorder.test.ts`
- Modify (only if fixtures break typecheck): `src/lib/exporter.test.ts`

## Risk Assessment
**Risk Level**: Low

**Why this is safe**:
- Default is `"full"` everywhere, so existing users see zero behaviour change.
- The change is additive on the schema — new optional fields and one new metadata field.
- Recorder logic is gated by a single mode arg with three branches; easy to reason about.
- The `pii.ts` helper is pure and exhaustively unit-tested.
- No changes to debugger client, screenshots, network capture, or export pipeline.

**Tradeoffs accepted**:
- No persistence of last-used mode (resets to Full each popup open). The DoD only requires the selector exists.
- No per-field overrides — mode is session-wide.
- No UI hint in the widget showing the active mode (could add later).
- No schema version bump — relying on additive compatibility. Quality plan may push for `1.1.0`.
- Password fields in metadata mode emit length only; we don't fingerprint character classes for passwords (defensive default).

## Estimated Effort
- Planning: Already done
- Implementation: ~45 minutes
- Testing: ~20 minutes
- **Total**: ~65 minutes

## Formal Verification Assessment
- Concurrency concerns: No — single-tab recorder, no shared state across actors
- State machine complexity: No — three flat modes, no transitions
- Conservation laws: No
- Authorization model: No — local-only extension, no users
- Recommendation: Not needed
- If recommended, key invariants: N/A

## What This Plan Does NOT Include
- Does NOT persist the last-selected mode across popup opens (chrome.storage.sync)
- Does NOT add a per-field allowlist or denylist
- Does NOT show the active capture mode in the floating widget
- Does NOT add a schema version bump (additive change)
- Does NOT add a `PRIVACY.md` reference to the new mode (that's feature #2)
- Does NOT change debugger / network / console capture — only DOM input events
- Does NOT refactor the recorder into a class or separate input module — just a small branch on mode
- Does NOT add Playwright e2e coverage for the new UI
- Does NOT add password-field character-class metadata (length only in metadata mode for password inputs, defensive)
