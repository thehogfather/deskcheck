---
agent: safety-planner
generated: 2026-04-07T20:00:00Z
task_id: feature-4
perspective: safety
---

# Safety Plan: PII Capture Modes

> This is a HIGH-STAKES PRIVACY FEATURE. Once we ship Metadata/None modes, users will trust that raw values do NOT reach storage or export. A single leaked raw value in Metadata mode is a Sev-1 privacy bug. The plan below treats privacy as a property to be enforced at multiple defensive layers, verified by negative property tests, and made auditable in the export.

## Architecture Impact

**Components affected:**
- `src/types.ts`: New `PiiCaptureMode` union type, new optional `pii_mode` field on `SessionMetadata`, new optional `value_metadata` field on `InteractionEvent`. Schema version bump.
- `src/popup/`: New mode selector UI before session start, mode passed in `START_SESSION` message.
- `src/background/service-worker.ts`: Accept mode in `START_SESSION`, persist on session, broadcast to content script via `SESSION_STARTED`. Defensive re-validation on `RECORD_EVENT`.
- `src/content/recorder.ts`: Accept mode parameter in `startRecording()`. Branch input handling. NEVER read `target.value` in Metadata or None modes.
- `src/content/index.ts`: Receive mode from service worker, pass into `startRecording`.
- `src/lib/session-store.ts`: Persist `pii_mode` on session. Default-safe coercion on read.
- `src/lib/exporter.ts`: Surface mode in export, version bump to 1.1.0. Defensive scrub pass — strip `value` from input events when mode != "full".
- `src/lib/pii-mode.ts` (NEW): Single source of truth for mode parsing, validation, default coercion, and metadata extraction.

**New patterns or abstractions introduced:**
- **PII mode as a typed enum with default-safe coercion**: All entry points (storage, message, popup) funnel through `parsePiiMode()` which returns `"full"` (the most-restrictive existing default — but see Risk #2) only for known values, otherwise coerces to the SAFEST mode `"metadata"` (NOT full). Rationale: an unknown mode string in storage means "we cannot trust the upstream contract" — fail to less data, not more.
- **Defensive layering ("belt and braces")**: The recorder enforces the mode at the source. The service worker re-validates on `RECORD_EVENT`. The exporter does a final scrub pass. Three independent gates so a bug in one cannot leak data.
- **Negative property test pattern**: `expect(JSON.stringify(event)).not.toContain(rawValue)` style assertions, applied with random/fuzzed inputs.

**Dependencies added or modified:**
- None. All work uses existing TypeScript and DOM APIs.

**Breaking changes to existing interfaces:**
- `SessionMetadata.pii_mode` is added as an OPTIONAL field. Existing sessions in storage without it are coerced to `"full"` on read (preserves current behavior — Risk #2 discusses why "full" is the right legacy default specifically).
- `InteractionEvent.value_metadata` is added as an OPTIONAL field — existing parsers that ignore unknown fields are unaffected.
- `schema_version` bumps `1.0.0` → `1.1.0` (additive, minor bump per semver). Existing consumers reading 1.0.0 fields continue to work.
- `START_SESSION` message gains an optional `piiMode` field (backwards compatible — service worker defaults to `"full"` if absent).

**Risk points in architecture this task touches:**
- The `recorder.ts` `emitInput()` function is the ONLY place that reads `target.value`. This is a privacy chokepoint and must be the primary defense.
- The `appendEvent()` path in service worker is the second gate.
- `exporter.ts` is the last gate before bytes leave the extension.
- chrome.storage.local survives extension upgrades — a session started under v0.3 (no pii_mode) and exported under v0.4 must still work.

## Risk Assessment

### Identified Risks

| # | Risk | Severity | Likelihood | Impact | Mitigation |
|---|------|----------|------------|--------|------------|
| 1 | Raw value reaches storage in Metadata mode (developer mistake, future regression) | **Critical** | Medium | PII leak in exported zip; reputation damage; user data exposed to whoever the user shares the bug report with | Three-layer defense: recorder branch never reads `.value` in non-full modes; service worker re-validates and strips on `RECORD_EVENT`; exporter final scrub pass. Negative property tests at every layer. Fuzz tests asserting raw value never appears in serialized JSON. |
| 2 | Unknown/corrupt `pii_mode` in storage after rollback or schema mismatch | High | Medium | Either silently captures full PII when user expected metadata-only (worst), or crashes session start | `parsePiiMode()` coerces unknown values to `"metadata"` (safer than full). EXCEPTION: legacy sessions with NO `pii_mode` field at all are coerced to `"full"` because they were recorded under the old contract that always captured full values — changing their semantics retroactively would corrupt the audit trail. The distinction is: "field absent" (legacy) → full; "field present but invalid" (corruption/tampering) → metadata. |
| 3 | None mode still emits input events through some other code path (e.g., a future contributor adds a `keydown` handler) | High | Medium | Defeats the user's privacy choice silently | All input-adjacent listeners go through a single gated function; unit tests assert zero input events when mode is None for a battery of input types (text, password, textarea, select, contenteditable). E2E test types into a field and asserts no input event in stored timeline. |
| 4 | Mode selector UI defaults to None or Metadata, breaking existing user expectations | Medium | Low | Existing users complain that values they used to see are missing | Default radio button is "Full", explicit unit test on popup HTML/JS, e2e test asserts default mode is full. |
| 5 | Mode selected in popup but session is started via keyboard shortcut (`toggle-session` command) — popup never opened, mode message never sent | Medium | High (this code path is well-trodden) | Keyboard-shortcut sessions silently fall back to default | Service worker stores "last selected mode" in `chrome.storage.local` (persisted across SW restarts). Keyboard shortcut path uses last-selected mode. First-ever session uses Full. Document this in popup ("Last used mode will apply to keyboard shortcut sessions"). |
| 6 | Content script wakes up after service worker restart and resumes a session whose mode was lost in transit | High | Low | Recorder might run with default Full when user expected Metadata | Mode is part of session metadata in storage; content script reads mode from `getSession()` on wake (via `GET_SESSION_STATE` extended response). |
| 7 | `value_metadata` itself leaks PII via length-of-1 / very-short text fields where length=1 + char-class = "digit" effectively reveals the digit | Low | Low | Theoretical entropy leak; tiny | Document this trade-off in docs and in the popup help text. Acceptable risk — metadata mode is not promised to be zero-information. |
| 8 | Element selector in `getElementInfo()` includes `value` attribute or innerText that exposes data | Medium | Low | Selector might inadvertently embed user data | Audit `getElementInfo()` and explicitly assert in tests that no user-typed value appears in the selector or `text` field for input/textarea. |
| 9 | Existing legacy sessions in storage break on load after upgrade | Medium | Low | User loses ability to download previously recorded session | `getSession()` coerces missing `pii_mode` → `"full"`. Migration test loads a v0.3-shaped session object and asserts export still succeeds. |
| 10 | Mode is sent in URL or logged to console accidentally | Low | Low | Mode itself is not sensitive (it's a category, not data) | Low risk — just don't log it carelessly. |
| 11 | autocomplete / autofill / paste events into a Full-mode field still capture full value (current behavior, but worth re-asserting) | Low | N/A | This is current behavior; Full mode is documented as capturing values | Not a regression. Documented. |
| 12 | Race: user changes mode in popup, then quickly clicks Start before message processed | Low | Low | Wrong mode used for session | Popup gates the Start click on a single state read; sends mode + start atomically in one message. |

### Failure Modes Analysis

1. **Recorder reads `.value` despite mode being Metadata**
   - Cause: Code change accidentally moves `target.value` access outside the mode branch
   - Detection: Negative property test fails: `expect(JSON.stringify(event)).not.toContain(rawValue)` for fuzzed inputs across all modes != full
   - Recovery: Test catches in CI before merge. If somehow shipped, exporter scrub pass strips `value` field from interaction events when mode is not full — provides defense-in-depth even with a recorder bug.

2. **Service worker rehydrates session with mode = undefined**
   - Cause: Storage corruption, partial write, schema mismatch after rollback
   - Detection: `parsePiiMode()` returns `"metadata"` for invalid (non-absent) values; logs a `console.warn` once
   - Recovery: Session continues recording in metadata mode (safe-fail). User sees a one-line notice in the widget: "Capture mode reset to Metadata due to invalid stored value."

3. **Content script never receives the mode (message dropped)**
   - Cause: Tab navigation, race between `executeScript` and `sendMessage`
   - Detection: Content script's `getSession()` fallback reads mode directly from storage
   - Recovery: Storage is the source of truth; the message is just an optimization. If storage read fails too, content script defaults to `"none"` (suppress all input events) and shows a widget warning. **Rationale**: in a privacy feature, if we can't determine the user's choice, we capture the LEAST.

4. **Mode selector UI broken / popup fails to load**
   - Cause: HTML/CSS/JS regression
   - Detection: e2e test asserts the radio buttons render and Start button is disabled until a selection (or has a default selection)
   - Recovery: Default to Full to preserve current behavior; ship hotfix.

5. **Export contains stale `value` field from a buggy recorder**
   - Cause: Recorder bug shipped, sessions recorded incorrectly
   - Detection: Exporter scrub pass logs a warning and strips the field. Test asserts that even given a manually-injected event with `value: "secret"` and `pii_mode: "metadata"`, the export does NOT contain the secret.
   - Recovery: Defense-in-depth caught it. Sessions are exported safely. File a bug for the recorder.

6. **None mode still records input events because a new event type was added**
   - Cause: Future contributor adds a `compositionend` or `paste` listener and forgets the mode gate
   - Detection: Lint rule (or just code-review checklist + comment block in recorder.ts) + unit test that types into all input types and asserts zero input events
   - Recovery: Test catches in CI.

### Blast Radius

- **Affected users**: All extension users. Critical for users on sensitive sites (medical, financial, internal tools). Worst-case: a privacy-conscious user records a debugging session on their banking site believing they selected "Metadata", and the export contains their account number. They share the zip with an LLM or a colleague.
- **Affected systems**: 
  - chrome.storage.local (sessions can become incompatible across versions)
  - Export consumers (downstream tools parsing session.json need to handle new fields gracefully — but minor schema bump means they should)
- **Data at risk**: Form inputs across every site the user has ever recorded — passwords (already masked), account numbers, names, addresses, search queries, message drafts, anything the user types.

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 1 | Create `src/lib/pii-mode.ts` with `PiiCaptureMode` type, `parsePiiMode()`, `extractValueMetadata()`, constants | Unit tests for parser including unknown/null/undefined/wrong-type inputs; unit tests for metadata extraction | Pure module, no integration — delete file |
| 2 | Add `pii_mode` to `SessionMetadata` (optional), add `value_metadata` to `InteractionEvent` (optional), bump schema_version, update message types in `src/types.ts` | typecheck passes; existing tests still green (additive only) | Revert types file |
| 3 | Update `session-store.ts`: `createSession` accepts mode, `getSession` coerces missing mode → `"full"` (legacy) | Unit test: session with no `pii_mode` round-trips as `"full"`; session with `pii_mode: "garbage"` round-trips as `"metadata"` | Revert store; legacy sessions still work because new field is optional |
| 4 | Update `recorder.ts`: `startRecording(onEvent, mode)`. Branch in `emitInput`: full → current behavior; metadata → call `extractValueMetadata` (NEVER touch `.value` for storage); none → return early. Add `// PRIVACY-CRITICAL` comment block | Unit test (jsdom): for each mode, simulate input on text/password/textarea/select fields and assert event shape. **Negative property test**: random fuzzed values, assert raw value never appears in serialized event JSON for non-full modes. | Revert recorder.ts; behavior reverts to always-capture |
| 5 | Update `service-worker.ts`: accept `piiMode` in `START_SESSION`, persist on session, send to content script in `SESSION_STARTED`, validate mode in `RECORD_EVENT`. Add defensive scrub: if `event.subtype === "input"` and stored session mode != "full", delete `event.value` before `appendEvent`. Persist `last_selected_pii_mode` for keyboard-shortcut sessions. | Integration test: send `RECORD_EVENT` with `value: "secret"` while session mode is metadata; assert stored event has no `value` field | Revert service-worker.ts; sessions started without mode default to full |
| 6 | Update `content/index.ts`: pass mode from session into `startRecording`. Read mode from `getSession`-equivalent path on fallback wake. If mode cannot be determined → `"none"` (safe-fail). | Unit test for content script init paths | Revert content/index.ts |
| 7 | Update `popup.ts` + `index.html` + `popup.css`: add radio group with Full/Metadata/None, default Full, send mode in `START_SESSION` | E2E test: select Metadata, start session, type into a field, stop, export, inspect zip — assert no raw value | Revert popup files; popup falls back to no mode parameter (service worker uses Full default) |
| 8 | Update `exporter.ts`: include `pii_mode` in exported `session` object, bump `schema_version` to `1.1.0`, perform final scrub pass on timeline (strip `value` from input events when mode != full, log warning if found), update `exporter.test.ts` | Unit test: manually inject a buggy event with `value: "secret"` into a metadata-mode session; assert exported JSON does not contain "secret" | Revert exporter; re-run export |
| 9 | Update `agents.md` documentation (if covered by feature 3) and inline help text in popup explaining each mode | Manual review; e2e test for popup UI text | N/A — docs only |
| 10 | Run full test suite, manual smoke test in loaded extension across all three modes, verify legacy session import still works | All tests green; manual checklist | Git revert the merge |

## Files to Create/Modify

### Create

| File | Purpose | Risk Notes |
|------|---------|------------|
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/pii-mode.ts` | Single source of truth: `PiiCaptureMode` type, `PII_MODES` constant, `parsePiiMode()` (default-safe), `extractValueMetadata()` (pure, no value retention), `scrubInputEvent()` (mutating helper used by service worker and exporter) | Pure functions; the only code that touches a value to compute metadata. Must release the value reference immediately. |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/pii-mode.test.ts` | Unit tests for parser (unknown, null, undefined, wrong type, all valid values, legacy absent), `extractValueMetadata` (length, word count, char classes, edge cases like emoji combining marks, empty string, whitespace-only), `scrubInputEvent` (strips value, preserves selector + metadata) | Critical — these tests are the privacy contract. Property tests with fuzzed inputs. |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/content/recorder.test.ts` | Tests for the recorder's input handling under each mode using jsdom; includes the negative property test "raw value never appears in serialized event for mode != full" | New file; use `// @vitest-environment jsdom` |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/popup.test.ts` (jsdom) | Test that default mode is Full, that all three radios render, that the selected mode is sent in `START_SESSION` | New file; jsdom env |

### Modify

| File | Purpose | Risk Notes |
|------|---------|------------|
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/types.ts` | Add `PiiCaptureMode` (re-export from `pii-mode.ts`), add optional `pii_mode` to `SessionMetadata`, add optional `value_metadata` to `InteractionEvent`, add optional `piiMode` to `START_SESSION` message, add optional `piiMode` to `SESSION_STARTED` message, bump `SessionExport.schema_version` to `"1.1.0"` | Additive only; existing consumers unaffected |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/session-store.ts` | `createSession` accepts mode param; `getSession` coerces missing mode → `"full"` (legacy) and invalid mode → `"metadata"` (defensive) | The legacy-vs-corruption distinction is the key safety choice — see Risk #2 |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/content/recorder.ts` | `startRecording(onEvent, mode)` signature change. Branch in `emitInput`. PRIVACY-CRITICAL comment block above the mode switch warning future contributors. | The single most important file for privacy correctness |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/content/index.ts` | Read mode from session state (via `GET_SESSION_STATE` response), pass to `startRecording`. Default to `"none"` if mode cannot be determined. | Safe-fail to None on uncertainty |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/background/service-worker.ts` | Accept `piiMode` in `START_SESSION`, persist on session, return mode in `GET_SESSION_STATE`, broadcast in `SESSION_STARTED`, scrub in `RECORD_EVENT` (defense layer 2), persist `last_selected_pii_mode` for keyboard-shortcut sessions | Second defensive layer; even if recorder leaks, service worker scrubs |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/exporter.ts` | Surface `pii_mode` in export, bump `schema_version` to `"1.1.0"`, final scrub pass on input events (defense layer 3), log warning if scrub finds anything (indicates an upstream bug) | Last line of defense before bytes leave |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/popup.ts` | Read selected mode from radio group, include in `START_SESSION` message; restore last-selected mode on popup open | Default Full |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/index.html` | Add radio group with three modes; brief help text per mode; "Full" pre-selected | Accessibility: real `<input type=radio>` with `<label>` |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/popup/popup.css` | Style radio group | Cosmetic |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/src/lib/exporter.test.ts` | Add tests: schema version is 1.1.0; pii_mode appears in export; defensive scrub strips raw values when mode != full | Adds privacy contract assertions to exporter |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/e2e/session.spec.ts` | Add e2e: select Metadata in popup, start session, type into a real input on the test page, stop, export via download, inspect downloaded zip, assert raw value is NOT in `session.json` | Slow but high-confidence |
| `/Users/patrick/Documents/workspace/deskcheck/.claude/worktrees/feature-pii-capture-modes/manifest.json` + `package.json` | Bump version (patch or minor — minor since schema bumps) | Both files must match per project convention |

## Definition of Done

- [ ] Mode selector appears in popup before session start (Full / Metadata / None) with Full pre-selected
- [ ] "Full" mode behaves identically to current implementation (passwords masked, values truncated to 200 chars) — verified by existing tests still green AND a new explicit assertion test
- [ ] "Metadata" mode records: element selector, field type, value length, word count, char-class flags (digits/emoji/special chars) — but NEVER the raw value
- [ ] "None" mode produces ZERO input events in the timeline for any input type
- [ ] Selected mode is recorded in `session.json` metadata under `session.pii_mode`
- [ ] Default mode is "Full" — existing users see no behavior change
- [ ] Schema version bumped to 1.1.0
- [ ] Legacy sessions (no `pii_mode` field) still load and export successfully (treated as `"full"`)
- [ ] Corrupt/unknown mode values in storage coerce to `"metadata"` (safe default for active sessions)
- [ ] Content script defaults to `"none"` if it cannot determine the mode (safest fallback for unknown state)
- [ ] Keyboard-shortcut session start uses last-selected mode (with first-ever defaulting to Full)
- [ ] Negative property tests prove raw value is not present in serialized events under non-full modes (fuzzed inputs)
- [ ] Defense-in-depth: service worker scrubs `value` from input events when stored session mode is not full
- [ ] Defense-in-depth: exporter scrubs `value` from input events as a final pass; logs warning if scrub finds anything
- [ ] E2E test: type into a real form, mode = Metadata, export — assert raw value not in zip
- [ ] All tests pass (`make test`, `make typecheck`, e2e suite)
- [ ] Manual smoke test across all three modes documented in PR description
- [ ] Rollback procedure documented (below)

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Mode selector renders with Full default | Unit (jsdom) | Pure DOM, fast feedback |
| 2 | Full mode behaves identically | Unit + existing test suite | Existing recorder tests should still pass |
| 3 | Metadata mode records correct fields, no raw value | Unit (jsdom) + property test | Logic-level; fast iteration on the privacy contract |
| 4 | None mode produces zero input events | Unit (jsdom) | Negation is easier to assert at unit level |
| 5 | Mode persisted in session.json | Unit (exporter) | Pure data transformation |
| 6 | Default Full preserves existing behavior | Unit | Test legacy session shapes |
| 7 | Schema version bumped to 1.1.0 | Unit (exporter) | One-line assertion |
| 8 | Legacy session loads correctly | Unit (session-store) | Pure data round-trip; no Chrome API needed |
| 9 | Corrupt mode coerces to metadata | Unit (pii-mode parser) | Pure function |
| 10 | Content script defaults to none on uncertain state | Unit | Logic isolated |
| 11 | Keyboard-shortcut session uses last-selected mode | Integration | Crosses popup → storage → service worker boundary |
| 12 | Negative property test (raw value never in serialized event) | Unit + property/fuzz | Critical privacy contract; cheap and high-value at unit level |
| 13 | Service worker defensive scrub | Integration | Crosses message boundary |
| 14 | Exporter defensive scrub | Unit | Pure transformation |
| 15 | E2E full flow: select metadata, type, export, inspect zip | E2E | User-visible privacy guarantee — single highest-value e2e test |

**Safety planner bias**: I propose ONE additional e2e test (full select-type-export-inspect flow) to provide end-to-end confidence on the privacy contract. The rest are unit/integration tests because privacy-leak detection is fundamentally a property of the data, which is easiest to assert at the unit layer with fuzzed inputs.

**Determinism rule**: All tests use deterministic inputs. The "fuzzed" property tests use a seeded PRNG (or a fixed list of representative strings) so failures are reproducible. No live LLM calls, no Chrome API mocking sleights — recorder tests use jsdom + synthetic input events.

## Testing Strategy (Comprehensive)

### Unit Tests

**`src/lib/pii-mode.test.ts`** (NEW)
- `parsePiiMode("full")` → `"full"`
- `parsePiiMode("metadata")` → `"metadata"`
- `parsePiiMode("none")` → `"none"`
- `parsePiiMode("FULL")` → `"metadata"` (case-sensitive; unknown → safe default)
- `parsePiiMode(undefined)` → `"full"` when called with `{ legacy: true }` (legacy semantics: missing means old session)
- `parsePiiMode(undefined)` → `"metadata"` by default (defensive: missing means corruption)
- `parsePiiMode(null)` → `"metadata"`
- `parsePiiMode(42)` → `"metadata"`
- `parsePiiMode("")` → `"metadata"`
- `parsePiiMode("garbage")` → `"metadata"`
- `extractValueMetadata("hello world")` → `{ length: 11, word_count: 2, has_digits: false, has_emoji: false, has_special: false }`
- `extractValueMetadata("p@ssw0rd!")` → `{ length: 9, word_count: 1, has_digits: true, has_special: true, has_emoji: false }`
- `extractValueMetadata("")` → `{ length: 0, word_count: 0, ... }`
- `extractValueMetadata("hello 👋")` → `has_emoji: true`
- `extractValueMetadata("   ")` → `{ length: 3, word_count: 0 }`
- `extractValueMetadata("a".repeat(10000))` → length is correct, no truncation in metadata mode
- `scrubInputEvent({type: "interaction", subtype: "input", value: "secret", ...})` → returns event with `value` deleted
- `scrubInputEvent` does NOT modify non-input events
- `scrubInputEvent` does NOT modify events when mode is "full"
- **Edge cases**: combining marks, surrogate pairs, RTL text, very long strings, null bytes

**`src/content/recorder.test.ts`** (NEW, jsdom)
- For mode = "full": `emitInput` produces event with truncated `value`, no `value_metadata`
- For mode = "full" + password input: `value` is `"[password]"`
- For mode = "metadata": event has `value_metadata`, NO `value` field, `element` selector populated
- For mode = "metadata" + password input: event still has `value_metadata` (length is masked length or actual length — explicit test); NO raw value
- For mode = "none": typing fires zero events. Assert `onEvent` called zero times for input/change events. Click events still fire.
- For all modes: scroll events, click events, navigation events still recorded normally
- **Negative property test**: For each non-full mode, generate 100 fuzzed input strings (alphanumeric, unicode, special chars), simulate input event, assert `JSON.stringify(capturedEvent).indexOf(rawValue) === -1`
- **Edge case**: contenteditable divs (current recorder doesn't capture these — assert this stays true)
- **Edge case**: input element with no value (should not crash)

**`src/lib/session-store.test.ts`** (NEW)
- `createSession(tabId, url, viewport, "metadata")` persists `pii_mode: "metadata"`
- `getSession()` on a session missing `pii_mode` returns `pii_mode: "full"` (legacy compat)
- `getSession()` on a session with `pii_mode: "garbage"` returns `pii_mode: "metadata"` (defensive)
- Round-trip: createSession → getSession preserves all fields

**`src/popup/popup.test.ts`** (NEW, jsdom)
- All three radio buttons render
- Default selection is "Full"
- Clicking Start sends `START_SESSION` with the selected `piiMode`
- Last-selected mode is restored on popup re-open

**`src/lib/exporter.test.ts`** (UPDATE)
- Schema version is `"1.1.0"`
- `session.pii_mode` appears in exported `session.json`
- Given a session with `pii_mode: "metadata"` and an input event manually injected with `value: "leaked-secret"`, the exported `session.json` does NOT contain "leaked-secret" (defensive scrub)
- Given a legacy session with no `pii_mode`, export still succeeds and `session.pii_mode` defaults to `"full"`
- Defensive scrub logs a warning when it strips a value (so we can detect upstream bugs in production)

### Integration Tests

- Service worker `RECORD_EVENT` handler: simulate sending an input event with `value: "secret"` while session mode is "metadata"; assert stored event has no `value` field. (Done via in-process call to `handleMessage`.)
- Service worker `START_SESSION` with `piiMode: "metadata"` persists the mode and includes it in `SESSION_STARTED` broadcast.
- Service worker `START_SESSION` without `piiMode` (legacy popup or keyboard shortcut) uses last-selected mode from storage; first-ever uses "full".

### E2E Tests

**Existing e2e tests affected**:
- `clicking on page generates recorded events` — should still pass; clicking is unaffected by mode
- `widget disappears after session stops` — unaffected
- `export produces a zip and clears session` — should still pass with default Full mode
- `shows Start Session button when idle` — needs update if the popup layout changes; the test currently asserts `#start-btn` visible, which should remain true. May need to add assertion that radio group is also visible.

**New e2e test needed**:
- **"Metadata mode does not capture raw input values"**: Open popup, select Metadata, start session on a test page, type a known sensitive string into a form input, stop session, trigger export, intercept the downloaded zip, parse `session.json`, assert the typed string is NOT present anywhere in the JSON, assert the corresponding input event has `value_metadata` populated. This is the single highest-value e2e test for this feature.

**Cost note**: Each e2e test does full extension load and session lifecycle. We are adding ONE new e2e test (the privacy contract test). Other assertions are bundled into unit tests.

### Regression Tests
- Existing `clicking on page generates recorded events` test must still pass with default Full mode
- `widget disappears after session stops` must still pass
- `export produces a zip and clears session` must still pass
- All existing exporter tests must still pass (with schema version updated where asserted)

### Load/Stress Tests
- Not applicable for this feature (no performance-critical paths added)

**Test files to create/modify**:
- CREATE: `src/lib/pii-mode.ts`, `src/lib/pii-mode.test.ts`, `src/content/recorder.test.ts`, `src/popup/popup.test.ts`, `src/lib/session-store.test.ts`
- MODIFY: `src/lib/exporter.test.ts`, `e2e/session.spec.ts`

## Default-Safe Behavior on Unknown Mode Strings

The single most important policy decision in this plan:

| Source of mode | Unknown / invalid value coerces to | Rationale |
|----------------|------------------------------------|-----------|
| `parsePiiMode(undefined, { legacy: true })` (loading old session) | `"full"` | Pre-feature sessions WERE recorded with full data; changing this would corrupt audit trail |
| `parsePiiMode(undefined)` (no legacy hint) | `"metadata"` | Cannot determine intent → assume the user wanted privacy |
| `parsePiiMode("garbage")` (corruption) | `"metadata"` | Invalid value present means upstream contract violation; safe-fail |
| Content script cannot read session at all | `"none"` | Cannot determine ANY context → record nothing input-related |
| Service worker receives `RECORD_EVENT` with input subtype but cannot determine session mode | Drop the `value` field, keep the metadata | Defense layer 2 |
| Exporter encounters input event with `value` field but session mode is not full | Strip the `value` field, log warning | Defense layer 3 |

**Two distinct defaults are intentional**: legacy sessions were captured under the old contract (full), so coercing them to "full" preserves their meaning. But if the field is present and corrupt, we must assume the worst — that something is wrong — and lean toward less data.

## Risks and Mitigations (Summary Table)

See "Identified Risks" above. Top three for re-emphasis:

1. **Raw value leak in Metadata mode** — three independent defensive layers + property tests
2. **Unknown mode after rollback** — explicit parser with legacy-vs-corruption distinction
3. **Keyboard-shortcut session bypasses popup** — last-selected mode persisted in storage

## Rollback Strategy

### Trigger Conditions
- A user reports raw values appearing in a Metadata-mode export (CRITICAL — immediate rollback)
- Default-Full users see behavior change
- Sessions fail to start or export
- Schema version mismatch breaks downstream consumers

### Rollback Steps (Two Options)

**Option A — Full Revert (preferred for Critical privacy bug)**
1. `git revert` the merge commit on `main`
2. Bump patch version
3. `make build`, smoke test, tag release, instruct users to update
4. New extension version replaces old; in-progress sessions continue under old code (still safe — old code captures Full, which is what their session was already doing)
5. Legacy sessions in storage with `pii_mode` field set are still loadable by old code because old code ignores the unknown field

**Option B — Feature-Flag Disable (lighter touch)**
1. Hardcode the popup to only send `piiMode: "full"` regardless of UI state
2. Hide the radio group via CSS (`display: none`)
3. The recorder still receives `"full"` and behaves as today
4. Ship as a patch
5. This preserves the schema and storage shape but disables the UX of mode selection until the bug is fixed

**Recommendation**: For a privacy bug, Option A. For a UX bug (e.g., radio group is broken on some browsers), Option B.

### Verification After Rollback
- [ ] Sessions can be started, recorded, and exported
- [ ] Existing in-storage sessions can still be downloaded
- [ ] No data loss for any user with an unexported session
- [ ] Raw values present (since rollback restores Full behavior — this is expected and not a regression)
- [ ] schema_version reads as 1.0.0 again (Option A) or 1.1.0 with mode=full (Option B)

### Rollback Tested?
- [ ] No (extension is shipped via Chrome Web Store; staging is the developer-mode-loaded extension)
- [ ] Document in PR: "Tested rollback by checking out previous commit and confirming sessions still load and export"

## Monitoring and Alerting

This is a Chrome extension with no telemetry by design. Detection relies on:

| Mechanism | Signal |
|-----------|--------|
| Console warnings (visible to users with DevTools open and to us during testing) | `[DeskCheck] PRIVACY: Defensive scrub stripped value field — upstream bug` |
| User bug reports | GitHub issues |
| Self-test on session start | Optional: log a one-time message confirming mode at session start so users see it in DevTools |

**Recommendation**: Add a `console.info("[DeskCheck] Recording with PII mode: " + mode)` at session start in the content script — visible, auditable, helps users verify the active mode.

## Deployment Recommendations

- [x] **Feature flag**: Not needed for shipping; the mode selector itself is the user-visible "flag". For rollback, see Option B above.
- [x] **Gradual rollout**: Not applicable (Chrome Web Store rollouts can be staged per channel — recommend pushing to a developer build first if available)
- [x] **Staging verification**: Required — load the unpacked extension and manually verify all three modes against a real form (signup page with text + password + textarea)
- [ ] **Off-hours deployment**: Not applicable (no live service)

**Pre-release checklist**:
- [ ] Manual test: Full mode on a signup form, verify password masked + values truncated
- [ ] Manual test: Metadata mode on the same form, inspect storage in DevTools, confirm no raw values
- [ ] Manual test: None mode, type into many fields, confirm zero input events in storage
- [ ] Manual test: Start session via keyboard shortcut after selecting Metadata in popup, confirm mode persists
- [ ] Manual test: Refresh extension mid-session, confirm mode survives service worker restart
- [ ] Inspect a downloaded zip from each mode

## Estimated Effort

- Planning: Already done
- Implementation: 90 minutes
  - `pii-mode.ts` module + types: 15 min
  - Recorder mode branching: 15 min
  - Service worker changes: 15 min
  - Popup UI + last-mode persistence: 20 min
  - Exporter scrub + version bump: 10 min
  - Content script wiring: 15 min
- Safety verification (manual): 30 minutes
- Testing: 90 minutes
  - Unit tests for `pii-mode.ts` (heavy — privacy contract): 25 min
  - Recorder unit tests with property/fuzz: 20 min
  - Popup unit tests: 10 min
  - Session store tests: 10 min
  - Exporter test additions: 10 min
  - E2E test (write + run): 15 min
- **Total: 210 minutes (3.5 hours)**

This is HIGHER than a speed-optimized estimate would suggest. The extra time buys: three defensive layers, fuzzed property tests, legacy-vs-corruption handling, last-mode persistence for keyboard shortcuts, and one new e2e test. For a privacy feature, this overhead is correct.

## Formal Verification Assessment

- **Concurrency concerns**: Limited — service worker is single-threaded, content script runs per tab. The interesting race is "user changes mode in popup just as Start fires", which is mitigated by sending mode atomically with START_SESSION.
- **State machine complexity**: Low — three modes, no transitions during a session (mode is fixed at session start)
- **Conservation laws**: One important one: "the set of stored input events with a `value` field, when session.pii_mode != 'full', must be empty." This is testable in tests but does not warrant TLC.
- **Authorization model**: Not applicable
- **Recommendation**: **Formal verification not needed**. The privacy contract is a simple invariant ("`value` field absent in input events when mode is not full") that is best enforced by:
  1. Type system + branch structure in `recorder.ts`
  2. Negative property tests with fuzzed inputs
  3. Three independent runtime gates (recorder, service worker, exporter)

  These provide stronger practical guarantees than a formal model would for this feature.
- **Key invariants** (informally):
  - **I1**: For every stored InteractionEvent with `subtype: "input"`, if the containing session's `pii_mode != "full"`, then the event has no `value` field.
  - **I2**: For every stored session, `parsePiiMode(session.pii_mode)` returns a known mode.
  - **I3**: For every "none"-mode session, the stored timeline contains zero events with `subtype: "input"`.
  - **I4**: For every session loaded from pre-feature storage (no `pii_mode` field), the effective mode is `"full"`.

## Security Considerations
- [x] No secrets in code
- [x] Input validation complete — `parsePiiMode` is the validation chokepoint
- [x] Output encoding where needed — N/A (no HTML rendering of user values)
- [x] Authentication/authorization verified — N/A (no auth in extension)
- [x] OWASP top 10 considered:
  - A01 Broken Access Control — N/A
  - A02 Cryptographic Failures — N/A (no crypto in this feature)
  - A03 Injection — N/A (no SQL, no eval, no shell)
  - A04 Insecure Design — Mitigated by three-layer defense and explicit threat model
  - A05 Security Misconfiguration — Default-safe mode parsing
  - A06 Vulnerable Components — No new dependencies
  - A07 Identification/Auth Failures — N/A
  - A08 Software/Data Integrity — Schema version bump documents the data contract change
  - A09 Logging/Monitoring — Console warnings on defensive scrubs
  - A10 SSRF — N/A
- [x] **Privacy-specific**:
  - PII never reaches storage in non-full modes (enforced by three layers)
  - PII never reaches the export zip in non-full modes (enforced by the exporter scrub)
  - Mode is auditable in the export so consumers know what was captured
  - Defaults are safe: legacy → full (preserves audit trail), corruption → metadata, content-script-uncertain → none

## Threat Model

**Asset**: User-typed form input values (passwords, account numbers, names, search queries, message drafts).

**Trust boundaries**:
- DOM ↔ content script (recorder reads from DOM)
- Content script ↔ service worker (RECORD_EVENT messages)
- Service worker ↔ chrome.storage.local (appendEvent persists)
- Storage ↔ exporter ↔ downloaded zip (export bytes leave the extension)

**Adversaries / leak vectors**:
1. **Bug in recorder**: A future contributor adds a `keydown` listener or moves `target.value` outside the mode branch. **Mitigation**: Property tests + service worker scrub + exporter scrub.
2. **Storage corruption / version mismatch**: A user updates the extension and an old session has a corrupt `pii_mode`. **Mitigation**: Default-safe parser; legacy distinction preserves old sessions.
3. **Service worker restart loses mode**: Mode is in storage, content script reads it on resume.
4. **User shares zip with LLM/colleague**: This is the realized threat that the feature is designed to prevent. The export must reliably strip raw values.
5. **Feature regression in a future PR**: Property tests and explicit privacy assertions in CI.
6. **Element selector contains user data**: Audited in `getElementInfo`; tested.
7. **Side-channel via metadata** (length=1 + has_digit reveals the digit): Documented as accepted trade-off; users wanting zero leakage choose None.

**Out of scope**:
- Network-level interception (extension does no network I/O)
- Disk forensics on the user's machine (Chrome storage is the user's data)
- Malicious extension impersonation (Chrome Web Store responsibility)
