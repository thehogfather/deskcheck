---
agent: plan-judge
generated: 2026-04-07T20:30:00Z
task_id: feature-4
selected: synthesis (quality core + safety negative tests + speed scope discipline)
---

# Plan Evaluation: PII Capture Modes

## Executive Summary

A synthesis of all three plans is selected. Quality's tagged-union types and pure `pii-modes.ts` strategy module form the implementation core. Safety's negative property test ("raw value never appears in serialized event JSON") is adopted because it is cheap and directly verifies the privacy contract. Speed's scope discipline is preserved by cutting safety's three-layer defense, last-mode persistence, keyboard-shortcut handling, content-script-default-to-`none`, e2e test, and corruption-vs-legacy two-default rule. For a v0.3.0 personal/internal Chrome extension where exports stay local, one well-tested defensive layer is correct; three layers and corruption coercion are ceremony.

## Plans Evaluated

### Speed Plan Summary
- **Core approach**: Add a `captureMode` field threaded popup -> service worker -> content script with a 3-branch switch in `recorder.ts`. One pure helper module `pii.ts`. No schema bump.
- **Estimated effort**: ~65 minutes
- **Key tradeoff**: No schema bump, no e2e, no negative property tests, password fields in metadata mode emit length only (no char-class flags) which is defensible but slightly inconsistent.

### Quality Plan Summary
- **Core approach**: Pure `pii-modes.ts` strategy module with a tagged-union `InputValuePayload`, schema bump to 1.1.0, exhaustive unit tests on extraction edge cases (CJK, ZWJ emoji, accented chars, multi-whitespace), one e2e test, docs update, read-side back-compat shim for legacy sessions.
- **Estimated effort**: ~120 minutes
- **Key tradeoff**: Tagged-union `InputValuePayload` changes the existing `InteractionEvent.value` shape, which is a real schema break. The tag adds nesting that downstream consumers (and future tests) must thread through.

### Safety Plan Summary
- **Core approach**: Three independent defensive scrubbing layers (recorder, service worker, exporter), corruption-vs-legacy two-default rule, last-selected-mode persistence for keyboard shortcuts, content script defaults to `"none"` on uncertainty, fuzzed property tests, e2e test inspecting downloaded zip.
- **Estimated effort**: ~210 minutes
- **Key tradeoff**: Massive overhead for a local-only tool. Defense-in-depth across three layers is correct for a server-side privacy-critical system, but here exports never leave the user's machine. Last-mode persistence introduces new behavior (keyboard-shortcut sessions silently using a previous mode) that can confuse the user. Corruption-coerce-to-metadata vs legacy-coerce-to-full is clever but creates two code paths and two doc lines per defense layer.

## Scoring

| Criterion | Weight | Speed | Quality | Safety | Notes |
|-----------|--------|-------|---------|--------|-------|
| Time to deliver | 20% | 5.0 | 3.5 | 2.0 | Speed ~1h, quality ~2h, safety ~3.5h |
| Code quality | 25% | 3.5 | 4.5 | 4.0 | Quality's pure module + tagged unions are cleanest; safety adds noise |
| Risk mitigation | 25% | 3.0 | 4.0 | 5.0 | Safety has 3 layers but risk surface here is tiny |
| Maintainability | 15% | 4.0 | 4.0 | 2.5 | Safety's 2-default rule + 3 layers = more places to break |
| Test coverage | 15% | 3.0 | 4.5 | 5.0 | Quality covers branches well; safety adds fuzzing |
| **Weighted Total** | 100% | **3.68** | **4.13** | **3.66** | Quality wins on weighted average, but synthesis beats all three |

## Context Analysis

| Factor | Assessment | Impact |
|--------|------------|--------|
| Urgency | Low | Planned roadmap work, no deadline pressure |
| Blast radius | Low-Medium | A leak is embarrassing but recoverable - exports stay local, no upload, no telemetry. Worst case: a user shares a zip they thought was redacted. Bad, but bounded by user action. |
| Code area | Core (recorder.ts) | The recorder is the heart of the extension. Cleanliness matters. |
| Technical debt | Low | v0.3.0 small codebase. The current inline password/truncation logic in `recorder.ts` is the only existing debt and quality plan correctly extracts it. |
| User visibility | High | Users will see and choose the mode. Default behavior must not change. |
| Schema impact | Medium | Schema bump is correct (1.0.0 -> 1.1.0) because we add a new metadata shape, but we should NOT break the existing `value: string` field shape. |
| Codebase maturity | v0.3.0 single-developer | Avoid ceremony. One defensive layer is enough. |

## Recommendation

### Selected Plan: Synthesis

A synthesis weighted toward Quality, with one safety check borrowed and several safety items explicitly cut.

### Rationale

1. **Quality's pure `pii-modes.ts` module** is the right architectural seam - it isolates the privacy-critical extraction code where it can be exhaustively unit-tested without DOM mocks. This is also where the existing inline password-mask logic should have lived from day one.
2. **Safety's negative property test** (`expect(JSON.stringify(event)).not.toContain(rawValue)`) is essentially free and directly proves the privacy contract. Adopting it costs ~5 lines and buys real confidence. This is the single highest-value test in any of the three plans.
3. **Speed's scope discipline** is the right calibration for v0.3.0. Three defensive layers, corruption-vs-legacy rules, last-mode persistence, and an e2e test are appropriate for a server-side privacy product. Here the export never leaves the machine and the user makes an explicit choice each session. Cut all that ceremony.
4. **Reject Quality's tagged-union `InputValuePayload`**. Changing `InteractionEvent.value` from `string | undefined` to `{ kind: "raw"; text: string } | { kind: "metadata"; metadata: ... }` is a gratuitous schema break. It makes existing code (e.g. `exporter.test.ts` event fixtures, future LLM consumers reading `event.value` as text) more verbose for no privacy benefit. Instead: keep `value?: string` for raw text and add a sibling `value_metadata?: InputMetadata` field. The presence/absence of each field is the discriminator, no `kind` tag needed.

### Incorporated Elements from Other Plans

- **From Quality**: The pure `pii-modes.ts` module structure, exhaustive metadata edge-case tests (empty, whitespace, multi-space, accented, CJK, ZWJ emoji, digits, special chars), `as const` PII_MODES array, schema bump to 1.1.0, read-side back-compat shim for legacy sessions in `getSession()`, recorder closure-over-config pattern, skipping listeners entirely in `none` mode (semantically clearer than checking inside each handler).
- **From Safety**: The single negative property test that asserts the raw value never appears in the serialized event JSON across fuzzed inputs (cheap and valuable). The `// PRIVACY-CRITICAL` comment block above the mode branch in `recorder.ts`. The legacy-default-to-`full` behavior in `getSession()` (matches quality).
- **From Speed**: Scope discipline. No e2e test. No three-layer defense. No last-selected-mode persistence. No keyboard-shortcut behavior change. No content-script-default-to-`none`. No corruption-vs-legacy two-default rule. Field shape stays `value?: string` + new `value_metadata?: InputMetadata`, NOT a tagged union.

### Items Explicitly Rejected

| Item | Source | Why rejected |
|------|--------|--------------|
| Tagged-union `InputValuePayload` with `kind` discriminator | Quality | Unnecessary nesting; the absence of `value` and presence of `value_metadata` is a sufficient discriminator and avoids breaking the existing `string` shape. |
| Three-layer defensive scrub (recorder + service worker + exporter) | Safety | Two redundant layers for a local-only tool. The recorder branch is the chokepoint and is proved correct by the negative property test. |
| `parsePiiMode()` corruption-vs-legacy two-default rule | Safety | Added complexity; code paths that fire on corrupted storage. For v0.3.0, treat any unrecognized mode as `"full"` (which is the existing behavior). One default. |
| Last-selected-mode persistence + keyboard-shortcut session uses last mode | Safety | Introduces silent state. Keyboard shortcut sessions stay at default `"full"` - explicit and predictable. Future feature if users complain. |
| Content script defaults to `"none"` if it cannot determine mode | Safety | Inverts the default behavior for users who legitimately have a transient race (service worker waking). The legacy default `"full"` is the right fallback. |
| Dedicated e2e test | Quality + Safety | The unit tests cover the extraction logic exhaustively, including the negative property test on the recorder. The chokepoint is the recorder branch, which is unit-tested directly with jsdom. Add the e2e in a follow-up if user reports motivate it. |
| `agents.md` schema docs update | Safety | That belongs to feature 3 (AI consumer schema), not this feature. |
| Console warning logs on scrub | Safety | No scrub layer to warn from. |
| Manifest version bump | Safety | Out of scope - the orchestrator will handle versioning when shipping. |
| Updating `docs/ARCHITECTURE.md` Security section in this PR | Quality | Optional. Schema bump is the durable record. Defer doc churn unless trivial. |

## The Selected Plan

### Architecture Impact

**Components affected:**
- `src/types.ts` - new `PiiCaptureMode` type, new `InputMetadata` interface, new optional fields on `SessionMetadata` and `InteractionEvent`, schema version bump, message extensions.
- `src/lib/pii-modes.ts` (NEW) - pure module: `PII_MODES` constant, `PiiCaptureMode` type, `extractInputMetadata(value)`, `capturePayloadForMode(target, mode)` returning `{ value?: string; value_metadata?: InputMetadata } | null`.
- `src/lib/pii-modes.test.ts` (NEW) - exhaustive unit tests including the negative property test.
- `src/lib/session-store.ts` - `createSession` accepts `piiMode`; `getSession` defaults missing `pii_mode` to `"full"` (legacy compat).
- `src/background/service-worker.ts` - `START_SESSION` reads `msg.piiMode ?? "full"`, threads through `createSession`, includes `piiMode` in `SESSION_STARTED` and `GET_SESSION_STATE` response.
- `src/content/index.ts` - reads `piiMode` from `SESSION_STARTED` payload and from `GET_SESSION_STATE` fallback path; passes to `startRecording`.
- `src/content/recorder.ts` - `startRecording(onEvent, opts: { piiMode })`. In `none` mode, skip the input/change listeners entirely. In `metadata` and `full` modes, route through `capturePayloadForMode`.
- `src/content/recorder.test.ts` (NEW) - jsdom tests for each mode + negative property test on serialized output.
- `src/popup/index.html` + `popup.css` + `popup.ts` - radio fieldset before Start button; default Full; read selection on click; pass `piiMode` in `START_SESSION`.
- `src/lib/exporter.ts` - bump `schema_version` literal to `"1.1.0"`. No scrub logic.
- `src/lib/exporter.test.ts` - update fixture to include `pii_mode: "full"`; assert version is `"1.1.0"`; assert `pii_mode` round-trips through the zip.

**No new patterns:** A single pure module, three branches in the recorder, additive schema fields. That is the entire surface area.

**Schema impact:**
- `SessionMetadata.pii_mode: PiiCaptureMode` - additive, required on new sessions, defaulted on read for legacy.
- `InteractionEvent.value_metadata?: InputMetadata` - additive optional.
- `SessionExport.schema_version: "1.1.0"` - minor bump because new fields appear in the export.
- `InteractionEvent.value?: string` - UNCHANGED. Still the raw text in `full` mode. Absent in `metadata` and `none` modes.

### Final Implementation Plan (ordered)

1. **Create `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/pii-modes.ts`** - the pure privacy module:
   ```ts
   export const PII_MODES = ["full", "metadata", "none"] as const;
   export type PiiCaptureMode = typeof PII_MODES[number];
   export const DEFAULT_PII_MODE: PiiCaptureMode = "full";

   export interface InputMetadata {
     length: number;
     word_count: number;
     has_digits: boolean;
     has_emoji: boolean;
     has_special: boolean;
   }

   export function extractInputMetadata(value: string): InputMetadata {
     const trimmed = value.trim();
     return {
       length: value.length,
       word_count: trimmed === "" ? 0 : trimmed.split(/\s+/).length,
       has_digits: /\d/.test(value),
       has_emoji: /\p{Extended_Pictographic}/u.test(value),
       has_special: /[^\p{L}\p{N}\s]/u.test(value),
     };
   }

   /**
    * PRIVACY-CRITICAL: This is the only place that decides whether the
    * raw value of an input field reaches the timeline. Do not add any
    * other path that reads target.value into an event payload.
    */
   export function capturePayloadForMode(
     target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
     mode: PiiCaptureMode,
   ): { value?: string; value_metadata?: InputMetadata } {
     if (mode === "none") return {};
     const isPassword = target instanceof HTMLInputElement && target.type === "password";
     const rawValue = (target as HTMLInputElement).value ?? "";
     if (mode === "full") {
       return { value: isPassword ? "[password]" : rawValue.slice(0, 200) };
     }
     // metadata
     return { value_metadata: extractInputMetadata(rawValue) };
   }

   /** Coerce any value (storage, message) to a known mode. Unknown -> "full". */
   export function parsePiiMode(value: unknown): PiiCaptureMode {
     return (PII_MODES as readonly string[]).includes(value as string)
       ? (value as PiiCaptureMode)
       : DEFAULT_PII_MODE;
   }
   ```

2. **Create `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/pii-modes.test.ts`** - exhaustive unit tests:
   - `extractInputMetadata` cases: empty, "hello", "hello world", "  ", "one  two   three", "abc123", "hello!", `"hello\u{1F600}"`, `"\u{1F468}\u200D\u{1F4BB}"` (ZWJ), "naive cafe" (accented), "中文" (CJK), "a\nb\tc", "$100", `"a".repeat(10000)`.
   - `capturePayloadForMode` cases: full + non-password, full + 300-char (truncated to 200), full + password, metadata + non-password, metadata + password (length leaks but value never does), none -> empty object, select element, textarea element.
   - `parsePiiMode` cases: each valid value, unknown string, undefined, null, number, empty string -> all coerce to `"full"`.
   - **Negative property test (the key safety check)**: build an array of 30 fixed sensitive strings (passwords, account numbers, emoji-containing, accented, CJK), and for each + each non-full mode call `capturePayloadForMode` then `JSON.stringify(result)` and assert the raw string is NOT a substring. Use a fixed array, not a PRNG, so failures are reproducible.

3. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/types.ts`**:
   - Import `PiiCaptureMode`, `InputMetadata` from `./lib/pii-modes`. (Or re-declare them here and have `pii-modes.ts` import - decide on the simpler dependency direction. Recommend declaring in `pii-modes.ts` and re-exporting from `types.ts` for one-stop-shop.)
   - Add `pii_mode: PiiCaptureMode` to `SessionMetadata` (required on new sessions; legacy compat handled at read site).
   - Add `value_metadata?: InputMetadata` to `InteractionEvent`. Leave `value?: string` unchanged.
   - Bump `SessionExport.schema_version` literal to `"1.1.0"`.
   - Add optional `piiMode?: PiiCaptureMode` to the `START_SESSION` message variant.
   - Add `piiMode: PiiCaptureMode` to the `SESSION_STARTED` message variant.
   - The `GET_SESSION_STATE` response is structural (returned via `sendResponse`), not in the `Message` union, so no type change needed there - but the content script needs to read `piiMode` from it.

4. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/session-store.ts`**:
   - Import `parsePiiMode`, `DEFAULT_PII_MODE` from `./pii-modes`.
   - `createSession(tabId, url, viewport, piiMode: PiiCaptureMode = DEFAULT_PII_MODE)` - persist `pii_mode: piiMode` on the session object.
   - `getSession()`: after retrieving, return `session ? { ...session, pii_mode: parsePiiMode(session.pii_mode) } : null`. This handles both legacy (missing field) and any future garbage by collapsing to `"full"`.

5. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/background/service-worker.ts`**:
   - Import `PiiCaptureMode`, `parsePiiMode`, `DEFAULT_PII_MODE` from `../lib/pii-modes`.
   - In `START_SESSION` handler: `const piiMode = parsePiiMode(msg.piiMode);` then pass to `createSession(msg.tabId, msg.url, msg.viewport, piiMode)`.
   - When sending `SESSION_STARTED` to the tab, include `piiMode: session.pii_mode`.
   - In `GET_SESSION_STATE` response object, add `piiMode: storedSession?.pii_mode ?? DEFAULT_PII_MODE`.
   - Keyboard-shortcut `toggle-session` path: when invoking `START_SESSION` programmatically, no `piiMode` is set, so `parsePiiMode(undefined)` returns `"full"`. This matches existing behavior - explicit and predictable.

6. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/content/index.ts`**:
   - Track a `currentMode: PiiCaptureMode | null` variable in the `init()` closure.
   - In the `chrome.runtime.onMessage` listener, when handling `SESSION_STARTED`, capture `msg.piiMode` and pass into `startSession(msg.piiMode)`.
   - In the `GET_SESSION_STATE` fallback path: read `response.piiMode` and pass into `startSession`.
   - `startSession(mode)` calls `startRecording(sendEvent, { piiMode: mode })`.
   - If `mode` is somehow undefined (defensive), use `DEFAULT_PII_MODE` from `pii-modes`. (One default - matches `parsePiiMode` behavior.)

7. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/content/recorder.ts`**:
   - Import `capturePayloadForMode`, `PiiCaptureMode` from `../lib/pii-modes`.
   - Change signature: `export function startRecording(onEvent: EventCallback, opts: { piiMode: PiiCaptureMode } = { piiMode: "full" }): () => void`.
   - At the top of the input/change setup section, add `// PRIVACY-CRITICAL: do not read target.value outside capturePayloadForMode.` comment.
   - If `opts.piiMode === "none"`: do not register the input or change listeners at all. Keep click/scroll/navigation listeners unaffected.
   - In `emitInput(target)`: replace the inline password/truncation logic with `const payload = capturePayloadForMode(target, opts.piiMode);` then spread into the event: `onEvent({ ..., ...payload, page_url: pageUrl() })`. Do NOT set `value: undefined` explicitly - let it be absent.

8. **Create `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/content/recorder.test.ts`** (jsdom):
   - `// @vitest-environment jsdom` directive.
   - For each mode, simulate dispatching `input` and `change` events on a `<input type="text">`, `<input type="password">`, `<textarea>`, and `<select>` and assert the captured event shape.
   - Use fake timers (`vi.useFakeTimers()`) to advance past the 800ms debounce.
   - **Negative property test**: in metadata mode, type "leaked-secret-12345" into a text field, advance timers, capture the emitted event, assert `JSON.stringify(emitted).indexOf("leaked-secret-12345") === -1`. Repeat with a unicode string and a string with special chars.
   - In none mode, dispatch input on all four element types, advance timers, assert `onEvent` was never called with `subtype: "input"`. Click events should still fire (sanity check).
   - Test that `startRecording` can be called without `opts` (default `"full"`) and still works.

9. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/index.html`**:
   - Add a `<fieldset id="pii-mode-fieldset">` above `#start-btn` with three radios named `pii-mode`, values `full` (checked), `metadata`, `none`. Use `<legend>Capture inputs:</legend>` and `<label>` wrappers for accessibility.

10. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/popup.css`**:
    - Style the fieldset compactly: minimal border, small font, tight margins, fit the 220px popup width. Match the existing `#status` 12px tone for the legend.

11. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/popup.ts`**:
    - Import `PiiCaptureMode`, `parsePiiMode` from `../lib/pii-modes`.
    - On Start click: `const checked = document.querySelector<HTMLInputElement>('input[name="pii-mode"]:checked'); const piiMode = parsePiiMode(checked?.value);` then include `piiMode` in the `START_SESSION` payload.
    - In `refreshState()`, hide the fieldset (add `.hidden`) when `state.recording` or `state.hasExportableSession` (mode cannot change mid-session, and the recording-state UI is the existing pattern).

12. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/exporter.ts`**:
    - Bump `schema_version: "1.1.0"`.
    - No scrub logic. The recorder branch + the `pii-modes.ts` chokepoint + the unit-test negative property test are the privacy enforcement.

13. **Modify `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/exporter.test.ts`**:
    - Update `makeSession()` to include `pii_mode: "full"` so the fixture compiles against the new required field.
    - Update existing assertions on `schema_version` to expect `"1.1.0"`.
    - Add one new test: a session with `pii_mode: "metadata"` round-trips through `exportSession` and the parsed JSON has `session.pii_mode === "metadata"`.

14. **Run** `make typecheck && make test && make build` in the worktree. Fix any compilation errors. All existing tests should continue to pass.

### Definition of Done (Final)

- [ ] Mode selector radios appear in the popup before session start, with Full pre-selected, hidden when a session is active or exportable
- [ ] `Full` mode produces interaction events with `value` truncated to 200 chars (passwords masked as `"[password]"`) - no behavior change for existing users
- [ ] `Metadata` mode produces interaction events with `value_metadata` containing `length`, `word_count`, `has_digits`, `has_emoji`, `has_special`; the `value` field is absent; the `element` selector is still populated
- [ ] `None` mode causes the recorder to NOT register input or change listeners; zero `interaction` events with `subtype: "input"` appear in the timeline
- [ ] `pii_mode` is recorded in `session.json` under `session.pii_mode`
- [ ] Exported `schema_version` is `"1.1.0"`
- [ ] Default mode is `"full"` for popup, keyboard shortcut, and legacy session loads
- [ ] `make typecheck` clean
- [ ] `make build` succeeds
- [ ] All existing unit tests pass; new `pii-modes.test.ts` and `recorder.test.ts` pass
- [ ] Negative property test proves raw input values never appear in serialized event JSON for non-full modes

### Test Level Matrix (Final)

| # | Acceptance Criterion | Test Level | Rationale |
|---|---------------------|-----------|-----------|
| 1 | Mode selector radios render in popup with Full default, hidden when recording | Unit (jsdom) | Pure DOM. Load popup HTML into jsdom, assert structure and that clicking Start sends the selected mode. Optional - can also be visually verified during dev. |
| 2 | Full mode preserves existing behavior (password mask, 200-char truncation) | Unit | `capturePayloadForMode(passwordEl, "full")` and `capturePayloadForMode(longTextEl, "full")` are pure-function assertions in `pii-modes.test.ts`. Plus a recorder test that verifies the wired-up branch in jsdom. |
| 3 | Metadata mode produces metadata fields, no raw value | Unit | `extractInputMetadata` exhaustive cases in `pii-modes.test.ts`; `capturePayloadForMode` returns the right shape; recorder test in jsdom dispatches an input event and asserts the emitted timeline event has `value_metadata` and no `value`. **Includes the negative property test** (raw string never appears in `JSON.stringify(emitted)` for fuzzed inputs). |
| 4 | None mode suppresses input events | Unit (jsdom) | `recorder.test.ts` constructs a recorder with `piiMode: "none"`, dispatches input/change on text/password/textarea/select, advances fake timers, asserts `onEvent` was never called with `subtype: "input"`. Click events still fire as a sanity check. |
| 5 | `pii_mode` recorded in `session.json` | Unit | Extend `exporter.test.ts` to assert `session.pii_mode` round-trips through `exportSession`. |
| 6 | Default mode is `"full"` (popup + keyboard shortcut + legacy session) | Unit | Three small assertions: (a) popup HTML test asserts `full` radio is `checked`; (b) `parsePiiMode(undefined)` returns `"full"` in `pii-modes.test.ts`; (c) `getSession()` test against a mocked storage entry without `pii_mode` returns `pii_mode: "full"` (covered by adding a small case to `exporter.test.ts` or a tiny new `session-store.test.ts` if jsdom isn't required - chrome.storage can be stubbed minimally). |
| 7 | Schema version bumped to 1.1.0 | Unit | One assertion in `exporter.test.ts`. |

**Rules applied:**
- Default to unit tests - all logic is pure or jsdom-testable.
- No integration tests - the message-passing wiring is small enough to verify by typecheck and manual extension load.
- No e2e tests - Playwright is expensive and the recorder branch (the chokepoint) is unit-tested directly.
- Each criterion maps to exactly one level. No duplication.
- All tests use fixed strings and synthetic events. No LLM, no network.

**Determinism constraint:** Not applicable - this feature has no LLM interaction. All tests use fixed inputs and deterministic outputs. The "fuzzed" property test uses a fixed array of strings, not a PRNG.

### Testing Strategy (Final)

- **Unit (`src/lib/pii-modes.test.ts`, NEW)**: Pure-function tests for `extractInputMetadata` (15+ edge cases), `capturePayloadForMode` (each mode + each element type + password handling + 200-char truncation), `parsePiiMode` (each valid + unknown/undefined/null/number/empty all coerce to `"full"`). **Negative property test**: array of ~10 fixed sensitive strings (mix of ASCII, unicode, special chars, emoji), for each non-full mode call `capturePayloadForMode` and assert `JSON.stringify(result).indexOf(rawString) === -1`.
- **Unit (`src/content/recorder.test.ts`, NEW, jsdom)**: Construct a recorder for each mode, dispatch input/change events on text/password/textarea/select elements, advance fake timers past the debounce, assert the emitted event shape. None mode: assert zero input events. Plus an end-to-end negative property test inside the recorder context: type a known string in metadata mode and assert it does not appear in the serialized emitted event.
- **Unit (`src/lib/exporter.test.ts`, MODIFIED)**: Update fixture to include `pii_mode`. Assert `schema_version === "1.1.0"`. Add a case asserting `session.pii_mode` round-trips through the exported zip.
- **Integration**: None.
- **E2E**: None.

**Existing e2e tests affected**: Any existing test that starts a session via the popup will continue to work because the default mode is `"full"` and the radio fieldset is non-blocking. If an existing test asserts the popup contains exactly N elements, it may need to add the radio fieldset to its expectations - check before merging.

### Risk Mitigations (Final)

1. **Risk: Raw value leaked in metadata mode by recorder bug or future regression.**
   Mitigation: The `pii-modes.ts` `capturePayloadForMode` is the *only* place that reads `target.value`, marked with a `// PRIVACY-CRITICAL` comment. Negative property test in both `pii-modes.test.ts` and `recorder.test.ts` proves no raw value reaches the serialized event for non-full modes.

2. **Risk: Default mode changes accidentally, breaking existing user expectations.**
   Mitigation: Three explicit tests of the `"full"` default (popup HTML, `parsePiiMode(undefined)`, `getSession()` legacy compat). The radio's `checked` attribute, the `parsePiiMode` fallback, and the `createSession` parameter default are all `"full"`. One default, one source of truth: `DEFAULT_PII_MODE`.

3. **Risk: Service worker wakes mid-session and content script reattaches without knowing the mode.**
   Mitigation: Mode is persisted in `SessionMetadata`. `GET_SESSION_STATE` response includes `piiMode`. Content script reads it on the fallback path.

4. **Risk: Schema bump breaks downstream consumers.**
   Mitigation: Version is bumped to `1.1.0`. New fields are additive. Existing `value: string` field shape unchanged. Anyone parsing `session.json` should already be checking `schema_version`.

5. **Risk: Element selector embeds user data via `getElementInfo()`.**
   Mitigation: This is a pre-existing risk independent of this feature. Out of scope for this PR; track separately if needed.

### Formal Verification Recommendation

| Signal | Speed | Quality | Safety | Consensus |
|--------|-------|---------|--------|-----------|
| Concurrency | N | N | N | N |
| State machine | N | N | N | N |
| Conservation | N | N | N (informal only) | N |
| Authorization | N | N | N | N |

**Recommendation**: SKIP. No planner flagged a need for formal verification. The privacy invariant ("`value` field absent in input events when mode is not full") is enforced by:
1. The branch structure in a single chokepoint (`capturePayloadForMode`)
2. The negative property test on fuzzed inputs

These provide stronger practical guarantees than TLC for this scope.

**Verification focus**: N/A
**Key invariants** (informally tracked by tests, not TLC):
- I1: For every interaction event with `subtype: "input"` produced under non-full mode, the event has no `value` field.
- I2: `parsePiiMode` returns a known mode for every input.
- I3: Under `"none"` mode, zero input events are emitted.
- I4: A legacy session loaded without `pii_mode` is treated as `"full"`.

### Acceptance Criteria for Validation Gate

The validation gate passes when ALL of the following are true:

- [ ] `make typecheck` exits 0 with no errors
- [ ] `make test` passes all existing tests
- [ ] `make test` passes the new tests in `src/lib/pii-modes.test.ts`
- [ ] `make test` passes the new tests in `src/content/recorder.test.ts`
- [ ] `make test` passes the modified `src/lib/exporter.test.ts` including the new `pii_mode` round-trip case and the `schema_version === "1.1.0"` assertion
- [ ] `make build` exits 0 and produces a `dist/` directory with the popup, content script, and service worker bundles
- [ ] The negative property test in `pii-modes.test.ts` runs against ALL fixed sensitive strings and the assertion passes for both metadata mode (raw string absent from `JSON.stringify(capturePayloadForMode(el, "metadata"))`) and none mode (`capturePayloadForMode` returns empty object)
- [ ] The negative property test in `recorder.test.ts` proves the raw string does not appear in the serialized emitted timeline event for metadata mode
- [ ] No new TypeScript `any` introduced
- [ ] No new ESLint warnings (if linting is part of `make typecheck`)

### What We Are Explicitly NOT Doing

- **No tagged-union `InputValuePayload`** - keep `value?: string` and add sibling `value_metadata?: InputMetadata`. Field presence is the discriminator.
- **No three-layer defensive scrub** - one chokepoint in `capturePayloadForMode` plus the negative property test. No re-scrub in service worker, no re-scrub in exporter.
- **No corruption-vs-legacy two-default rule** - `parsePiiMode` collapses any unknown value (including undefined) to `"full"`. One default.
- **No last-selected-mode persistence** - keyboard-shortcut sessions use `"full"`. Predictable, no hidden state.
- **No content-script-default-to-`"none"`** - content script defaults to `"full"` if mode is somehow unset, matching every other default in the system.
- **No e2e test** - the recorder branch is unit-tested directly with jsdom.
- **No `agents.md` update** - belongs to feature 3.
- **No `docs/ARCHITECTURE.md` schema-bump documentation in this PR** - schema bump in code is the durable record. Optional follow-up.
- **No manifest version bump in this PR** - orchestrator handles versioning at release time.
- **No keyboard-shortcut UI change** - shortcut still starts a session in default mode.
- **No per-field allowlist or denylist** - mode is session-wide.
- **No mode display in the floating widget** - future feature if users request.
- **No password char-class metadata** - in metadata mode, password fields go through the same `extractInputMetadata` path (length and char-class flags are returned). The plan does NOT special-case passwords in metadata mode; the `length` and char-class flags reveal information but the value is not stored. This is documented as an accepted trade-off (length=1 + has_digit reveals the digit). Users wanting zero leakage choose `none`.
- **No console warning logs** - no scrub layer to warn from.
- **No fuzzed PRNG** - the negative property test uses a fixed array of ~10 strings so failures are reproducible.

---

## Orchestrator Handoff

This evaluation is the **final decision** - no human checkpoint follows. The orchestrator will:
1. Commit all plans (speed, quality, safety, selected) to `docs/plans/feature-4/` for audit trail
2. Use the Test Level Matrix to generate acceptance tests at the unit level
3. Proceed directly to implementation

**Summary for git commit**:
- Selected plan: Synthesis (Quality core + Safety negative property test + Speed scope discipline)
- Key rationale: Pure `pii-modes.ts` chokepoint with one negative property test is sufficient privacy enforcement for a v0.3.0 local-only Chrome extension; safety's three-layer defense and corruption rules are ceremony.
- Estimated effort: ~90 minutes (between speed's 65 and quality's 120)
- Key risks: Recorder branch is the single chokepoint; protected by `// PRIVACY-CRITICAL` comment and negative property test on fuzzed inputs.
- Test levels: 7 unit, 0 integration, 0 e2e
