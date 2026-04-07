---
agent: quality-planner
generated: 2026-04-07T19:45:00Z
task_id: feature-4
perspective: quality
---

# Quality Plan: PII Capture Modes

## Architecture Impact

**Components affected:**
- `src/types.ts` — new `PiiMode` union; `SessionMetadata` gains `pii_mode`; `InteractionEvent.value` becomes a discriminated payload (string | metadata struct | absent).
- `src/lib/pii-modes.ts` (new) — pure module that derives metadata from a raw input value and selects the right capture strategy per mode.
- `src/lib/session-store.ts` — `createSession` accepts and persists `pii_mode`.
- `src/background/service-worker.ts` — `START_SESSION` message carries `pii_mode`; threads it into `createSession` and forwards it to the content script via `SESSION_STARTED` so the recorder can configure itself.
- `src/content/recorder.ts` — `startRecording` accepts a `piiMode` parameter and routes input events through `pii-modes.ts` (or skips them entirely in `none` mode).
- `src/content/index.ts` — receives `pii_mode` in `SESSION_STARTED` and on the rehydration path (so a service-worker wake mid-session does the right thing).
- `src/popup/index.html` + `popup.css` + `popup.ts` — adds a radio-group selector for the mode before "Start Session".
- `src/lib/exporter.ts` — no logic changes (the new field rides through `SessionMetadata`); test added to verify it appears in `session.json`.
- `src/lib/session-store.ts` reads — back-compat shim so a session persisted before this feature (no `pii_mode` field) loads as `pii_mode: "full"`.

**New patterns or abstractions introduced:**
- **Strategy table for input capture** (`src/lib/pii-modes.ts`): a single `capturePayloadForMode(target, mode)` function returns the right `value` payload (string | metadata-object | undefined) based on mode. This collapses three branches into one well-tested seam and makes adding a future mode (e.g. "hash-only") additive.
- **Discriminated value payload** on `InteractionEvent`: today `value` is `string | undefined`. We introduce a tagged union `InputValuePayload = { kind: "raw"; text: string } | { kind: "metadata"; ... }` and update `InteractionEvent.value` to that union. This is semantically richer than overloading the string field with mode-specific JSON, and a downstream consumer can branch on `kind` instead of inferring from session metadata.

**Dependencies added or modified:**
- None. All work is in vanilla TS with existing primitives.

**Breaking changes to existing interfaces:**
- `InteractionEvent.value` shape changes from `string | undefined` to `InputValuePayload | undefined`. This is a **schema change** — see "Schema Impact" below. We bump `schema_version` from `1.0.0` to `1.1.0` and document the change in `docs/ARCHITECTURE.md`.
- `SessionMetadata` gains `pii_mode: PiiMode`. Existing code reading `SessionMetadata` is unaffected; new field is additive.
- `START_SESSION` message gains an optional `piiMode?: PiiMode` field; default is `"full"` so existing callers (e.g. the keyboard-shortcut start path in `service-worker.ts`) keep working unchanged.

## Architectural Approach

This feature has one core seam — **how the recorder turns a raw `<input>` into a timeline payload** — and the cleanest move is to extract that decision into a pure module (`pii-modes.ts`) that the recorder calls. The recorder stays a thin DOM-event listener; mode-specific logic (length, word count, character classes, password masking, truncation) lives in fully-unit-testable pure functions. Mode is decided once at session start, persisted in `SessionMetadata`, and passed to the recorder via the existing `SESSION_STARTED` message — so no per-event mode lookups and no global state in the content script.

## Files to Create/Modify

| File | Purpose | Quality Considerations |
|------|---------|----------------------|
| `src/lib/pii-modes.ts` (new) | Pure module: `PiiMode` constants, `extractMetadata()`, `capturePayloadForMode()`, password detection helper | No DOM dependencies in the metadata-extraction core; only `capturePayloadForMode` touches HTMLElements. Easy to unit-test the extraction in isolation. |
| `src/lib/pii-modes.test.ts` (new) | Vitest unit tests for metadata extraction edge cases | Pure tests, no jsdom needed for `extractMetadata`. A small jsdom block covers `capturePayloadForMode` against fake input/textarea/password elements. |
| `src/types.ts` | Add `PiiMode`, `InputValuePayload`, `InputMetadata`; extend `SessionMetadata` and `InteractionEvent`; bump `SessionExport.schema_version` literal | Tagged unions over magic strings; `as const` for the mode list so `PiiMode` is derived, not duplicated. |
| `src/content/recorder.ts` | `startRecording(onEvent, opts: { piiMode })`; route input/change handlers through `capturePayloadForMode`; short-circuit listeners entirely in `"none"` mode | Mode is captured in closure at start time — no per-event branching cost beyond the strategy lookup. In `"none"` we skip `addEventListener` for input/change to make the suppression semantically explicit (and observable in tests). |
| `src/content/index.ts` | Read `piiMode` from `SESSION_STARTED` and from the rehydration path (`GET_SESSION_STATE`/`storage.onChanged`); pass to `startRecording` | Service-worker wake mid-session must restore the same mode — pull it from stored `SessionMetadata`. |
| `src/lib/session-store.ts` | `createSession(tabId, url, viewport, piiMode)`; back-compat in `getSession()` to default missing `pii_mode` to `"full"` | Single source of truth for the default. Migration is read-side only — no writes to old data. |
| `src/background/service-worker.ts` | `START_SESSION` handler reads `msg.piiMode ?? "full"`, passes to `createSession`, and includes it in `SESSION_STARTED` payload; `GET_SESSION_STATE` returns it too | Default is centralised in `session-store`; service worker just forwards. The keyboard-shortcut start path uses `"full"` (no UI to choose) — explicitly documented. |
| `src/popup/index.html` | Add `<fieldset>` with three radios (Full / Metadata / None) above "Start Session" | Semantic HTML, real radios for accessibility. Group by `name="pii-mode"`. |
| `src/popup/popup.css` | Style the fieldset compactly (220px popup width is tight) | Match existing minimal style; no new colours. |
| `src/popup/popup.ts` | Read selected radio on start click; include `piiMode` in `START_SESSION` message | Default is `"full"` — radio is `checked` in HTML so the read always returns a value. |
| `src/lib/exporter.test.ts` | Add cases verifying `pii_mode` in exported `session.json` and `schema_version === "1.1.0"` | Locks in the schema bump. |
| `src/types.ts` (schema literal) | `schema_version: "1.1.0"` | Single point of change. |
| `docs/ARCHITECTURE.md` | Add changelog entry, update Export Schema section, mention PII mode in Security | Public-facing schema change must be documented. |
| `e2e/session.spec.ts` | One new test: start a session with metadata mode via popup, type into a field, stop, verify the persisted event has metadata payload not raw text | Single e2e (cost-aware); unit tests cover all branches. |

**Total files**: 7 modified, 3 created (1 source, 1 test, plus docs touch).

## Implementation Steps

1. **Define types** (`src/types.ts`).
   - `export const PII_MODES = ["full", "metadata", "none"] as const;`
   - `export type PiiMode = typeof PII_MODES[number];`
   - `export interface InputMetadata { length: number; word_count: number; has_digits: boolean; has_emoji: boolean; has_special_chars: boolean; }`
   - `export type InputValuePayload = { kind: "raw"; text: string } | { kind: "metadata"; metadata: InputMetadata };`
   - Change `InteractionEvent.value?: string` to `value?: InputValuePayload`.
   - Add `pii_mode: PiiMode` to `SessionMetadata`.
   - Bump `SessionExport.schema_version` literal to `"1.1.0"`.
   - Add optional `piiMode?: PiiMode` to the `START_SESSION` message and `pii_mode: PiiMode` to `SESSION_STARTED`.
   - **Quality rationale**: tagged unions make downstream consumers' branching obvious; `as const` array means adding a fourth mode is a one-liner.

2. **Build the pure `pii-modes.ts` module**.
   - `extractMetadata(value: string): InputMetadata` — pure, no DOM.
     - `length`: `value.length` (use code units, document the choice).
     - `word_count`: `value.trim() === "" ? 0 : value.trim().split(/\s+/).length`.
     - `has_digits`: `/\d/.test(value)`.
     - `has_emoji`: use `\p{Extended_Pictographic}` unicode property regex (`/\p{Extended_Pictographic}/u`).
     - `has_special_chars`: `/[^\p{L}\p{N}\s]/u.test(value)` — anything that's not a letter, number, or whitespace.
   - `capturePayloadForMode(target, mode): InputValuePayload | undefined`:
     - `none` → `undefined` (caller should not even call this in none mode, but defensively safe).
     - Password input → always `{ kind: "raw", text: "[password]" }` for `full`; `{ kind: "metadata", metadata: extractMetadata(rawValue) }` for `metadata`. (Even in metadata mode, password length is meaningful; we still don't leak the value.)
     - `full` → `{ kind: "raw", text: rawValue.slice(0, 200) }`.
     - `metadata` → `{ kind: "metadata", metadata: extractMetadata(rawValue) }`.
   - **Quality rationale**: extraction is the riskiest part (regex correctness, edge cases). Isolating it as a pure function lets us test it exhaustively without jsdom or chrome mocks.

3. **Wire `pii-modes.ts` into `recorder.ts`**.
   - Change signature to `startRecording(onEvent, opts: { piiMode: PiiMode })`.
   - At the top, `if (opts.piiMode === "none") { /* skip input + change listeners entirely */ }` — the click/scroll/nav listeners still attach.
   - In `emitInput`, replace the inline password/truncation logic with `const value = capturePayloadForMode(target, opts.piiMode);` and pass through.
   - **Quality rationale**: closing over `piiMode` once means zero per-event lookups and no shared mutable state. Skipping listeners in `none` is semantically clearer than checking a flag inside each handler.

4. **Thread mode through the message bus**.
   - `popup.ts`: read `document.querySelector('input[name="pii-mode"]:checked').value as PiiMode` on start click.
   - `service-worker.ts`: `case "START_SESSION"`: `const piiMode = msg.piiMode ?? "full"; await createSession(..., piiMode);` and include `pii_mode: piiMode` in the `SESSION_STARTED` message sent to the tab.
   - `service-worker.ts`: `GET_SESSION_STATE` includes `piiMode: session?.pii_mode` so the rehydration path on content-script load can configure the recorder correctly.
   - `content/index.ts`: pass the received `pii_mode` into `startRecording`.
   - **Quality rationale**: mode flows through one well-defined path. Service worker is a pass-through, not a decision point, so there is no risk of two callers picking different defaults.

5. **Update `session-store.ts`** with creation parameter and back-compat read.
   - `createSession(tabId, url, viewport, piiMode: PiiMode = "full")`.
   - In `getSession()`, after parsing the JSON, return `{ ...session, pii_mode: session.pii_mode ?? "full" }`. This handles any session left in storage by an older version.
   - **Quality rationale**: read-side default ensures we never crash on legacy data, and the default is in exactly one place.

6. **Build the popup UI**.
   - HTML: `<fieldset id="pii-mode-fieldset"><legend>Capture inputs:</legend><label><input type="radio" name="pii-mode" value="full" checked> Full</label><label><input type="radio" name="pii-mode" value="metadata"> Metadata only</label><label><input type="radio" name="pii-mode" value="none"> None</label></fieldset>`.
   - CSS: tight margins, small font; legend is the existing 12px tone.
   - Hide the fieldset when `state.recording` (it can't change mid-session).
   - **Quality rationale**: native radios are accessible (keyboard, screen reader) for free. `checked` on "Full" guarantees the default behaviour and means a user who never touches the radios sees no change.

7. **Bump schema version + update exporter test + update docs**.
   - `schema_version: "1.1.0"` literal.
   - Add an `ARCHITECTURE.md` changelog row (`0.4.0 — PII capture modes; schema 1.1.0`).
   - Add a Security bullet: "Sensitive form values are masked or replaced with metadata-only summaries when the user selects Metadata or None mode at session start."

8. **Write tests** (see Testing Strategy below).

9. **Run `make typecheck && make test && make build`** before declaring done. Run a single e2e (`make e2e` or whatever the project uses) for the metadata-mode happy path.

## Definition of Done

- [ ] Mode selector radios appear in popup before session start, default `Full`
- [ ] `Full` mode produces `value: { kind: "raw", text: ... }` exactly matching the previous behaviour for non-password fields, `[password]` for passwords, truncated to 200 chars
- [ ] `Metadata` mode produces `value: { kind: "metadata", metadata: { length, word_count, has_digits, has_emoji, has_special_chars } }` and never includes the raw text — verified by an assertion that the raw text never appears in the serialised event JSON
- [ ] `None` mode causes the recorder to attach no input/change listeners; no `interaction` events with `subtype: "input"` appear in the timeline
- [ ] `pii_mode` is recorded in `session.json` under `session.pii_mode`
- [ ] `schema_version` bumped to `1.1.0` in exported zip
- [ ] Default mode is `Full` for all entry points: popup, keyboard shortcut, and rehydration of legacy sessions
- [ ] No linting or TypeScript errors (`make typecheck` clean)
- [ ] All new code paths have unit tests (>90% coverage on `pii-modes.ts`)
- [ ] One e2e covering metadata-mode end-to-end via the popup
- [ ] `docs/ARCHITECTURE.md` updated with schema bump and Security bullet
- [ ] `make build` succeeds

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Mode selector radios in popup default Full | Unit (jsdom) | Pure DOM assertion on `popup.ts` after loading the HTML; no chrome API needed beyond a stub. |
| 2 | Full mode payload shape (incl. password masking + 200-char truncation) | Unit | `pii-modes.ts` is pure; assertions on `capturePayloadForMode` outputs cover this exhaustively. |
| 3 | Metadata mode payload + raw text never present | Unit | Pure-function tests on `extractMetadata` and `capturePayloadForMode`; one assertion stringifies the event and `expect(json).not.toContain(rawValue)`. |
| 4 | None mode suppresses input listeners | Unit (jsdom) | Construct a fake document, call `startRecording(cb, { piiMode: "none" })`, dispatch input events, assert callback never fires for input subtype. |
| 5 | `pii_mode` recorded in `session.json` | Unit | Extend `exporter.test.ts` — pass a session with `pii_mode: "metadata"`, assert it round-trips through the zip. |
| 6 | Default Full for popup, keyboard shortcut, legacy sessions | Unit | Three small tests: popup reads default, service-worker handler defaults `msg.piiMode ?? "full"`, `getSession()` back-compat shim returns `"full"` for missing field. |
| 7 | Schema version bumped | Unit | One assertion in `exporter.test.ts`: `expect(json.schema_version).toBe("1.1.0")`. |
| 8 | Metadata mode end-to-end via popup | E2E | One Playwright test: open popup, click Metadata radio, click Start, type into a field, stop, read storage, assert payload is metadata-shaped. Justifies the e2e cost because it covers the whole popup→service-worker→content-script→storage chain. |

**Quality planner bias**: extraction logic is pure, so the bulk of coverage lives in unit tests. Exactly one e2e to lock in the integration story.

**Determinism rule**: All tests use fixed inputs. No LLM calls anywhere in this feature.

## Testing Strategy

- **Unit (`src/lib/pii-modes.test.ts`)**:
  - `extractMetadata`:
    - empty string → `length: 0, word_count: 0`, all flags false
    - `"hello world"` → length 11, word_count 2, no digits/emoji/special
    - `"abc123"` → has_digits true
    - `"hello!"` → has_special_chars true
    - `"hello\u{1F600}"` → has_emoji true (smiling face)
    - `"\u{1F1FA}\u{1F1F8}"` → has_emoji true (regional indicator pair / flag)
    - `"\u{1F468}\u200D\u{1F4BB}"` → has_emoji true (ZWJ sequence: man technologist)
    - `"  "` (whitespace only) → word_count 0
    - `"one  two   three"` (multi-space) → word_count 3
    - `"naïve café"` → word_count 2, has_special_chars false (accented letters are `\p{L}`)
    - `"中文"` → word_count 1 (no whitespace), has_special_chars false
    - `"a\nb\tc"` → word_count 3 (\s splits on tab/newline)
    - `"$100"` → has_digits true, has_special_chars true
    - 10 000-char string → length 10000 (no truncation in metadata mode — length is the whole point)
  - `capturePayloadForMode`:
    - `"full"` + non-password input "hello" → `{ kind: "raw", text: "hello" }`
    - `"full"` + 300-char input → text truncated to 200 chars
    - `"full"` + `<input type="password" value="secret">` → `{ kind: "raw", text: "[password]" }`
    - `"metadata"` + non-password "hello" → `{ kind: "metadata", metadata: {...} }`, no `text` field anywhere
    - `"metadata"` + password "secret" → `{ kind: "metadata", metadata: { length: 6, ... } }`, raw "secret" never appears in serialised output
    - `"none"` → `undefined`
    - `<select>` and `<textarea>` go through the same paths
- **Unit (`src/content/recorder.test.ts`, new, jsdom)**:
  - `startRecording(cb, { piiMode: "none" })`: dispatch input events on a real `<input>` in jsdom, advance fake timers past the 800ms debounce, assert `cb` was never called with `subtype: "input"`. (Click events still fire — covered by existing recorder behaviour.)
  - `startRecording(cb, { piiMode: "metadata" })`: dispatch input on `<input value="hello">`, advance timers, assert `cb` called with `value: { kind: "metadata", metadata: { length: 5, word_count: 1, ... } }`.
- **Unit (`src/lib/exporter.test.ts`, extended)**:
  - Add `pii_mode: "metadata"` to `makeSession()`, assert exported `json.session.pii_mode === "metadata"`.
  - Assert `json.schema_version === "1.1.0"`.
- **Unit (`src/lib/session-store.test.ts`, new — small)**:
  - `getSession()` against a `chrome.storage.local` mock with a session lacking `pii_mode` returns `pii_mode: "full"`.
- **Unit (`src/popup/popup.test.ts`, new — small, jsdom)**:
  - Load the HTML fixture, click `#start-btn`, mock `chrome.runtime.sendMessage`, assert the message includes `piiMode: "full"` by default. Repeat after clicking the `metadata` radio.
- **E2E (`e2e/session.spec.ts`, one new test)**:
  - Open popup, select Metadata radio, start session on `example.com`, focus an `<input>`, type "secret123", wait for debounce, stop session, read storage, assert the input event has `value.kind === "metadata"` and `value.metadata.length === 9` and `value.metadata.has_digits === true`, and assert the string "secret123" does not appear anywhere in the events JSON.

**E2E Test Impact**:
- **Existing e2e tests affected**: None — the existing tests don't pass `piiMode`, so they default to `full` and behave identically.
- **New e2e tests needed**: 1 (metadata-mode happy path through the full popup→worker→content→storage chain).
- **Cost note**: Single new e2e. The other DoD criteria are covered by unit tests because the logic is pure.

**Test files to create/modify**:
- Create: `src/lib/pii-modes.test.ts`, `src/content/recorder.test.ts`, `src/popup/popup.test.ts`, `src/lib/session-store.test.ts`
- Modify: `src/lib/exporter.test.ts`, `e2e/session.spec.ts`

**Coverage target**: >90% on `pii-modes.ts` (the risk surface), >80% on touched files overall.

## Code Quality Checklist
- [ ] Follows SOLID — `pii-modes.ts` is a single-responsibility pure module; recorder depends on the abstraction, not on inline branches
- [ ] No code duplication — password masking and truncation live in exactly one place (was previously inline in `recorder.ts`)
- [ ] Clear naming — `PiiMode`, `InputValuePayload`, `extractMetadata`, `capturePayloadForMode`
- [ ] Appropriate abstraction level — one new module, three pure functions, no class hierarchy or DI framework
- [ ] Error handling — `extractMetadata` is total (defined for any string); `capturePayloadForMode` defensively handles unknown element types
- [ ] Types — no `any`; tagged unions; `as const` for the mode list
- [ ] Edge cases — empty string, whitespace only, multi-whitespace, accented letters, CJK, emoji ZWJ sequences, very long strings, password fields, `<select>` and `<textarea>`
- [ ] Logging — none needed; this is a hot path and silent is correct
- [ ] No `console.log` debugging left behind

## Patterns to Apply

| Pattern | Where | Why |
|---------|-------|-----|
| Strategy (functional, single dispatch table) | `capturePayloadForMode` | Adding a new mode = one new branch + one new test, no recorder changes |
| Tagged union | `InputValuePayload` | Downstream consumers branch on `kind`, schema is self-describing |
| Pure-functional core, imperative shell | `pii-modes.ts` (pure) vs `recorder.ts` (DOM events) | Pure code is exhaustively testable; shell stays thin |
| Closure over config | `startRecording(cb, { piiMode })` | Mode resolved once at session start, never re-checked |
| Read-side back-compat shim | `getSession()` defaults missing `pii_mode` to `"full"` | Legacy storage data keeps working without a write migration |

## Impact Assessment

**Positive Impacts**:
- Existing inline password/truncation logic moves into a tested pure module — small but real cleanup.
- The schema becomes more self-describing (`kind` tags).
- Adds an obvious extension point for future modes (e.g. `"hash"`, `"redact-numbers"`).

**Neutral** (what stays the same):
- Click, scroll, navigation, viewport-resize recording — untouched.
- CDP-side recording (network, console, exceptions) — untouched.
- Export zip layout — untouched (only `session.json` content evolves).
- Default behaviour for existing users — identical (`Full` is the default).

**Risks**:
- **Schema bump** is a real downstream contract change. Mitigation: bump `schema_version` to `1.1.0`, document in `ARCHITECTURE.md` changelog, update `exporter.test.ts` to lock the version. Anyone parsing `session.json` should already be checking `schema_version`.
- **`InteractionEvent.value` shape change** could surprise consumers reading `event.value` as a string. Mitigation: the `kind` discriminator is explicit; the AI-consumer schema doc (feature 3, when it ships) will describe both shapes. For now, the only consumer of this field is the export itself.
- **Emoji detection** edge cases — Unicode property regex needs `/u` flag; ZWJ sequences and skin-tone modifiers are handled by `\p{Extended_Pictographic}` but the test list above covers the trickiest cases explicitly.
- **Service-worker rehydration** — if the worker wakes mid-session and the content script reattaches via `GET_SESSION_STATE`, the mode must come from storage, not from the `START_SESSION` message (which is long gone). Handled by storing `pii_mode` in `SessionMetadata` and returning it from `GET_SESSION_STATE`.

## Estimated Effort
- Planning: done (this document)
- Implementation: ~60 minutes
- Testing: ~50 minutes (more thorough — emoji edge cases take time)
- Review prep: ~10 minutes
- **Total**: ~120 minutes

## Technical Debt Addressed
- Removes the inline `target.type === "password" ? "[password]" : target.value?.slice(0, 200)` branch in `recorder.ts` and gives it a real home with tests. That branch was previously untested.
- Establishes a clear seam for future input-related capture changes (hashing, salted hashes, allow-list redaction) without further recorder churn.

## Formal Verification Assessment
- Concurrency concerns: No — input events are debounced and serialised through a single timer per field; no shared mutable state across actors.
- State machine complexity: No — three modes, decided once, never transitioned within a session.
- Conservation laws: No — nothing is being conserved across operations.
- Authorization model: No — this is a user preference, not access control.
- Recommendation: **Not needed**. Coverage by exhaustive unit tests on the pure module is sufficient. The risk surface is the regex correctness, which is best handled by an explicit table of edge-case tests, not formal methods.
- If recommended, key invariants: N/A.

## Future Extensibility
- Adding a fourth mode (e.g. `"hash"` for irreversible hashing) is a one-line change to `PII_MODES`, one new branch in `capturePayloadForMode`, and one new entry in `InputValuePayload`. The recorder, popup HTML, and message types pick it up automatically through the union type.
- If we later want per-field overrides ("always full for `<select>`, never for `<input type=email>`"), the strategy lives behind one function, so the change is localised.
- The tagged-union payload makes it trivial for the future feature 3 (`agents.md` schema docs) to describe both shapes precisely.
