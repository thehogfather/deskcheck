---
agent: safety-planner
generated: 2026-05-03T00:00:00Z
task_id: feature-17
perspective: safety
---

# Safety Plan: Feature 17 — Simplify session lifecycle (Pause-first, contextual exits)

## Architecture Reference

The relevant invariants from `docs/ARCHITECTURE.md` and the existing modules are:

- **Side Panel section** (lines 42–48): three-region flex layout (`#toolbar` / `#events-list` / `#controls`); **hide-not-disable contract** — children of `#toolbar` and `#controls` are structurally appended/removed by `buildControlsModel()`. The DoD phrase "absent from the DOM" is pinned by `querySelector === null` tests. This is the single most important invariant for feature 17 — every "only when X" rule in the roadmap must round-trip through `buildControlsModel()` and not via `display:none`.
- **`SessionStatus` state machine** (`src/lib/session-status.ts`, lines 51): four states (`idle`/`running`/`paused`/`stopped`), seven actions (`start`/`pause`/`resume`/`stop`/`discard`/`reset`/`export_complete`), pinned by a table-driven test (`tests/session-status.test.ts`). Feature 17 narrows the **user-driven** action surface but **must keep the underlying transitions intact** (the SW still needs to call `nextStatus(_, "discard")` when Clear is confirmed and `nextStatus(_, "stop")` when Download or End is invoked).
- **Discard confirmation dialog** (line 47): danger-tinted, default focus on Cancel, Escape closes via Cancel, counts read from a fresh `chrome.storage.local.get` at dialog-open time, **Cancel is a pure UI close — ZERO storage writes (spy-pinned)**. Feature 17's Clear inherits this contract verbatim.
- **CLI handoff** (lines 86–192): opt-in via `deskcheck_handoff` storage key, performs a token-gated POST to `127.0.0.1:<port>/upload`, with `armedSessions` rejecting unarmed session-ids (403). Side panel **never** writes the token back to the DOM (`tests/sidepanel-no-handoff-write.test.ts`). End must reuse the EXACT same `EXPORT_SESSION` → `performHandoff` path with no new endpoint surface.
- **Schema invariant** (line 192): `schema_version` 1.2.0 is pinned by `src/lib/exporter.golden.test.ts` (D10). Feature 17 must NOT bump this and must produce byte-identical zips for Download and End.
- **Marker-before-flag write ordering** (changelog 1.2.0): pause/resume markers in the timeline are awaited before `session.status` flips. Feature 17 must not regress this ordering — Resume from paused continues the same session id and timeline.

### Invariant → Test mapping (one row per safety risk)

| Invariant | Where it lives today | Test that pins it after feature 17 |
|-----------|---------------------|-----------------------------------|
| Hide-not-disable: hidden controls absent from DOM | `sidepanel-controls.ts` + `sidepanel.ts:applyControlsModel` | `tests/sidepanel-paused-controls.test.ts` (new): for each (status × hasEvents × listenerAttached), assert `querySelector("#download-btn") === null` etc. |
| No data loss path on Clear | discard dialog, Cancel = zero writes | `tests/sidepanel-clear-cancel-no-writes.test.ts` (renamed from existing discard-cancel test) — sendMessage/storage spy assertions |
| End reuses handoff POST and token gating | `service-worker.ts:EXPORT_SESSION` branch | `tests/service-worker-handoff.test.ts` extended with an "End" code path test asserting same auth header + same zip bytes |
| Byte-identical zips: Download ≡ End ≡ golden fixture | `src/lib/exporter.golden.test.ts` | New assertion in same suite: capture zip bytes from Download path, capture zip bytes from End path, deep-equal with golden fixture |
| Live listener attach/detach updates End visibility without re-mount | `sidepanel.ts:renderHandoffState` + `applyControlsModel` | `tests/sidepanel-end-button-live-attach.test.ts` (new) — observe DOM mutation list, assert only End button node is added/removed; toolbar/eventsList/controls untouched |
| `SessionStatus` transition table unchanged at machine level | `session-status.ts` | `tests/session-status.test.ts` (existing) — table left intact; user-driven action removal happens above the machine, not inside it |
| Old test ids absent from DOM | n/a | `tests/sidepanel-old-test-ids-absent.test.ts` (new) — for each status, assert `#stop-btn`, `#discard-btn`, `#reset-btn` are all `null` |

## Architecture Impact

**Components affected:**
- `src/lib/sidepanel-controls.ts` — `ControlVisibility` shape gets new flags (`download`, `clear`, `end`); old flags (`stop`, `discard`, `reset`) removed. `buildControlsModel` inputs gain `hasEvents: boolean` and `listenerAttached: boolean`.
- `src/sidepanel/sidepanel.ts` — button id renames (`stop-btn` → `download-btn`, `discard-btn` → `clear-btn`, new `end-btn`); listener-attach observation rewires `applyControlsModel` rather than doing a full re-mount.
- `src/lib/session-status.ts` — **machine left untouched**. `nextStatus()` keeps all 4×7 cells. Only the user-driven verb surface narrows. Documented in module-header comment that "discard"/"reset"/"stop" actions are now invoked internally only.
- Service worker — **no changes to handoff plumbing**. `EXPORT_SESSION`/`DISCARD_SESSION`/`RESET_SESSION` handlers stay; the side panel just calls them under different button labels.

**New patterns or abstractions introduced:**
- `listenerAttached` reactivity input to `buildControlsModel` (was previously read once on mount in `renderHandoffState`). The two functions must share a single source of truth for "is a listener attached right now" so End cannot diverge from the badge.

**Dependencies added or modified:**
- None.

**Breaking changes to existing interfaces:**
- `ControlVisibility` shape changes (test-internal type). Callers all live in `sidepanel.ts` and `sidepanel-controls.test.ts`.
- DOM test ids: `stop-btn` → `download-btn`, `discard-btn` → `clear-btn`, **new** `end-btn`. Any e2e spec or doc reference is a hard break that the migration test below catches.

**Risk points in architecture this task touches:**
- **CLI handoff path** — End reuses it; any divergence = data exfil risk.
- **OPFS deletion path** — Clear reuses today's Discard storage cleanup; any new path that drops events bypasses confirmation = data loss.
- **Hide-not-disable contract** — narrowing the verb set without touching the machine means `sidepanel-controls.ts` is the only change point; if changes leak into `sidepanel.ts` directly, the test surface drifts.

## Definition of Done

### Roadmap DoD (verbatim from `docs/roadmap.md` lines 196–207)
- [ ] DoD-1: Pre-session shows exactly: Start, PII mode picker, connection-status pill. No Reset, no residual-state controls.
- [ ] DoD-2: Active (running) session shows exactly: Pause + annotation/picker controls + capture-mode indicator.
- [ ] DoD-3: Paused session shows exactly: Resume + Download/Clear (only when timeline has events) + End (only when listener attached).
- [ ] DoD-4: Empty paused session shows only Resume — Download and Clear absent from DOM (hide-not-disable).
- [ ] DoD-5: Attaching a listener while paused adds End live; detaching removes End live — no panel re-mount.
- [ ] DoD-6: Clear shows destructive confirmation dialog matching today's Discard copy and behaviour, including cancel path.
- [ ] DoD-7: End triggers the same handoff POST path as today's Stop-with-listener, with the same byte-identical zip payload, exits to pre-session on success.
- [ ] DoD-8: Existing `Stop`, `Discard`, `Reset` button ids removed from DOM. Tests migrated to `download-btn`, `clear-btn`, `end-btn`.
- [ ] DoD-9: Unit tests cover each paused-state visibility combination; live attach update; Clear cancel path; End → handoff POST round-trip.
- [ ] DoD-10 (E2E): Start (full mode) → type → Pause → Download → exported zip contains the typed input event.
- [ ] DoD-11 (E2E): Start → Pause (no events) → only Resume visible → Resume → type → Pause → Download/Clear visible.

### Safety-specific verification points (added by this plan)
- [ ] SAFE-1: A grep test asserts `stop-btn` / `discard-btn` / `reset-btn` strings appear nowhere in `src/`, `tests/`, `e2e/`, `cli/`, or `docs/` (other than CHANGELOG entries that intentionally name the old ids).
- [ ] SAFE-2: Byte-identical zip regression test: Download path bytes === End path bytes === stored golden fixture bytes.
- [ ] SAFE-3: `schema_version` regression test confirms the constant in `agents-doc.ts` is unchanged at 1.2.0 (no accidental bump).
- [ ] SAFE-4: Clear cancel-path: spy on `sendMessage` and `chrome.storage.local.set/remove` — assert call count is exactly 0 across the cancel flow.
- [ ] SAFE-5: End requires a listener attachment AND token-bearing config — test asserts End button is structurally absent if `getHandoffConfig()` returns null, even if the session is paused with events.
- [ ] SAFE-6: End uses `armedSessions` (or current SW's pending-handoff promotion check) — replay/forged-session-id tests still pass after the rename.
- [ ] SAFE-7: Live attach DOM mutation test — `MutationObserver` records all mutations during attach/detach; assertion: only nodes affected are inside the toolbar lifecycle row, and the affected node has id `end-btn`.
- [ ] SAFE-8: `nextStatus()` table is unchanged — `session-status.test.ts` still passes without modification (the action set in the machine is unchanged, only the user-driven verbs change).
- [ ] SAFE-9: No new path drops events without confirmation — a test enumerates every button click handler in `sidepanel.ts` that ends in a `DISCARD_SESSION` / OPFS delete and asserts each goes through `confirmDiscardBtn` first.
- [ ] SAFE-10: Focus and toolbar layout unchanged across listener attach/detach — assert `document.activeElement` is preserved and toolbar children count differs by exactly 1 (the End button).

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | DoD-1: Pre-session control set | Unit | Pure view-model + DOM presence assertion in jsdom |
| 2 | DoD-2: Active session control set | Unit | Same |
| 3 | DoD-3: Paused session control set (incl. visibility combinatorics) | Unit | Pure (status × hasEvents × listenerAttached) matrix — fastest at unit level |
| 4 | DoD-4: Empty paused absent from DOM | Unit | `querySelector === null` is a pure DOM check |
| 5 | DoD-5: Live attach without re-mount | Unit (jsdom + MutationObserver) | DOM mutation observability is reliable in jsdom; no Chrome API needed |
| 6 | DoD-6: Clear confirmation dialog (incl. cancel) | Unit | Matches existing discard-dialog test pattern |
| 7 | DoD-7: End → handoff POST round-trip | Integration | Crosses the SW boundary (`EXPORT_SESSION` → `performHandoff`) — boundary worth integration coverage |
| 8 | DoD-8: Old test ids absent | Unit (grep + DOM) | Two-layer check: source grep + per-status DOM scan |
| 9 | DoD-9: Visibility combinatorics + live attach + Clear cancel + End round-trip | Unit (mostly) + Integration (End round-trip) | See above |
| 10 | DoD-10: Full Download flow | E2E | User-visible journey, security-adjacent (export pipeline) |
| 11 | DoD-11: Empty paused → resume → events flow | E2E | User-visible journey for the empty/non-empty visibility transition |
| 12 | SAFE-2: Byte-identical zips Download ≡ End ≡ golden | Integration | Boundary at the exporter; pure byte comparison |
| 13 | SAFE-4: Clear cancel zero writes | Unit | sendMessage/storage spy in jsdom |
| 14 | SAFE-5: End absent without listener | Unit | Pure DOM presence check |
| 15 | SAFE-6: armedSessions/forged-session-id still rejected | Integration | Reuses existing SW handoff test setup |
| 16 | SAFE-9: No unconfirmed event-drop path | Unit (static + behavioural) | Click-handler enumeration in jsdom + assert each goes through confirm |

**Safety planner bias**: integration is reserved for the EXPORT_SESSION boundary (zip parity + handoff token gating). Everything else is unit because the visibility surface is pure. E2E is restricted to two flows — the cost of full auth+unlock means combinatoric paused-state coverage MUST stay at unit.

**Determinism rule**: no live LLM calls anywhere. The handoff POST in tests targets a `fetchImpl` stub that records request bytes — never a real network call. The CLI E2E (if included) uses the existing `deskcheck-record.test.mjs` fixture mode where the listener is launched in-process.

## Testing Strategy (Comprehensive)

### Unit Tests

**`tests/sidepanel-controls.test.ts` (extend, not replace)**
- For each (status × hasEvents × listenerAttached) combination of the 4×2×2 = 16 cells, assert the `ControlVisibility` shape:
  - `idle, *, *` → start/pii/connection only
  - `running, *, *` → pause + annotation/picker + capture-pill
  - `paused, false, false` → resume only
  - `paused, true, false` → resume + download + clear (NO end)
  - `paused, false, true` → resume only (no events → no End even with listener)
  - `paused, true, true` → resume + download + clear + end
  - `stopped, *, *` → matches today's stopped behaviour (no user-facing change in this state — Reset semantics are subsumed by Clear from paused, not from stopped)

**`tests/sidepanel-paused-controls.test.ts` (new)** — full DOM presence/absence per state:
- For each cell above, mount the side panel, drive to that state, then assert presence/absence of `#download-btn`, `#clear-btn`, `#end-btn`, `#start-btn`, `#pause-btn` via `querySelector(...) === null` / `!== null`.
- **Edge cases**:
  - `paused` with events but no listener: `#end-btn` absent.
  - `paused` with listener attached pre-session that detaches mid-pause: `#end-btn` mounts then unmounts; toolbar children count delta is exactly +1 then −1.
  - `paused` with listener that flips attached/detached/attached three times in a row: idempotent, no DOM-id collisions, no orphaned nodes.

**`tests/sidepanel-end-button-live-attach.test.ts` (new)**
- Mount panel in paused state with events. Attach a `MutationObserver` rooted at `document.body`.
- Drive a listener attach via the storage onChanged handler (simulate `deskcheck_handoff` set/clear).
- Assert: mutation records show ONLY one added node with id `end-btn` inside the lifecycle row.
- Assert: focus on `#pause-btn` (or wherever it was) is preserved across the attach.
- Reverse: detach → only `end-btn` removed; no other DOM mutations.

**`tests/sidepanel-clear-cancel-no-writes.test.ts` (new — replaces existing discard-cancel test)**
- Mount panel in paused state with events.
- Spy on `sendMessage` AND on the injected `readStorage` function.
- Click `#clear-btn` → confirmation dialog opens → click `#cancel-clear-btn`.
- Assert dialog hidden; events array unchanged in DOM; `sendMessage` never called with `DISCARD_SESSION`; storage spy shows zero writes.
- **Edge cases**: ESC key cancel, click outside dialog (if implemented as click-outside-cancels — match existing discard behaviour exactly).

**`tests/sidepanel-clear-confirm-storage-cleanup.test.ts` (new)**
- Click Clear → Confirm. Assert exactly one `DISCARD_SESSION` message sent (the same handler today's Discard sends). Assert events/screenshots cleared from DOM, transition to idle.

**`tests/sidepanel-end-handoff-roundtrip.test.ts` (new)**
- Mount paused-with-events-and-listener. Click `#end-btn`.
- Assert sequence: `EXPORT_SESSION` message dispatched, `performHandoff` called with the current handoff config token, transition to idle on success.
- **Edge case**: handoff returns 403 (forged session id) — End surfaces error in `#async-error`, session NOT cleared, user can retry.
- **Edge case**: handoff returns network error — same fall-through to download path that today's Stop has (S12 invariant: data retained until at least one transport succeeds).

**`tests/sidepanel-old-test-ids-absent.test.ts` (new)**
- For each `SessionStatus`, drive panel to that state and assert `document.querySelector("#stop-btn") === null && #discard-btn === null && #reset-btn === null`.
- Companion file-level grep test (`tests/no-stale-test-ids.test.ts`): scan `src/`, `tests/`, `e2e/`, `cli/`, `docs/ARCHITECTURE.md`, `docs/roadmap.md` for the literal strings `stop-btn`/`discard-btn`/`reset-btn`. Allowed only in this changelog entry and historical roadmap notes (allow-list).

**`tests/session-status.test.ts` (UNCHANGED — must still pass as-is)**
- The 4×7 transition table is the formal model. We are NOT removing actions from the machine — only narrowing user-driven verbs. This test continuing to pass is itself the assertion that we kept the machine intact.

### Integration Tests

**`tests/service-worker-handoff.test.ts` (extend)**
- Add a test: SW receives `EXPORT_SESSION` while paused-with-listener (the End path). Assert:
  - Same Authorization bearer header as today's Stop-with-listener.
  - Same `X-DeskCheck-Session-Id` header.
  - Same zip bytes as the Download path for the same session (use a deterministic clock + fixed event log).
  - On 403: zip retained, EXPORT_WARNING emitted, session NOT cleared.

**`src/lib/exporter.golden.test.ts` (extend — D10 invariant)**
- Build a session with N events, a pause/resume cycle, and a screenshot. Export it twice via the production code path (Download then End).
- Assert: `zipBytesDownload === zipBytesEnd === goldenFixture` (byte-equal, not just same `schema_version`).
- This is the **single most important regression test** for this feature.

**`tests/service-worker-pending-handoff.test.ts` (extend)**
- The existing pending-handoff promotion flow (CLI launches Chrome → marker detected → user clicks Start). After feature 17, the user-driven exit is End. Assert pending-handoff promotion → Start → Pause → End round-trips correctly with the SAME armedSessions/used-tokens guards as today's Stop.

### E2E Tests

**`e2e/session-lifecycle-download.spec.ts` (new or rename of existing stop-flow spec)**
- Start (full mode) → type into a fixture page input → Pause → assert `#download-btn` visible → click Download → reminder dialog → confirm → assert downloaded zip contains the typed input event.

**`e2e/session-lifecycle-empty-paused.spec.ts` (new)**
- Start → immediately Pause (no events) → assert ONLY `#pause-btn` (now labelled Resume) is in the lifecycle row → Resume → type → Pause → assert `#download-btn` AND `#clear-btn` now visible → click Clear → cancel → still visible → click Clear → confirm → returns to pre-session.

**`cli/deskcheck-record.test.mjs` (extend)**
- The existing record-flow E2E: launch CLI listener, attach via marker, Start, Pause, click `#end-btn`, assert zip arrives at `<out>/<session-id>.zip` with same content as Download path.

### Migration Test

**`tests/no-stale-test-ids.test.ts` (new)** — see SAFE-1.
- File-level grep across `src/**/*.ts`, `tests/**/*.ts`, `e2e/**/*.ts`, `cli/**/*.mjs`, `docs/roadmap.md`, `docs/ARCHITECTURE.md`. Allow-list this very plan, the changelog entry that names the rename, and the historical roadmap section. Fail-fast on any other reference.

### Regression Tests

- **Hide-not-disable contract** — the 16-cell visibility test exercises this exhaustively.
- **Marker-before-flag write ordering** — existing `tests/session-store-pause.test.ts` (or equivalent) must still pass.
- **CLI handoff phase 1 (Stop-with-listener path) ≡ End** — golden zip assertion.
- **`session-status.test.ts`** — full transition table.
- **`exporter.golden.test.ts`** — `schema_version === 1.2.0`.

### Load/Stress Tests

- Not applicable. This is a pure UI surface change. The hot paths (event capture, OPFS append, CDP) are untouched.

**Test files to create:**
- `tests/sidepanel-paused-controls.test.ts`
- `tests/sidepanel-end-button-live-attach.test.ts`
- `tests/sidepanel-clear-cancel-no-writes.test.ts` (rename + extend existing discard-cancel)
- `tests/sidepanel-clear-confirm-storage-cleanup.test.ts`
- `tests/sidepanel-end-handoff-roundtrip.test.ts`
- `tests/sidepanel-old-test-ids-absent.test.ts`
- `tests/no-stale-test-ids.test.ts`
- `e2e/session-lifecycle-download.spec.ts`
- `e2e/session-lifecycle-empty-paused.spec.ts`

**Test files to modify:**
- `tests/sidepanel-controls.test.ts` (extend for new visibility cells)
- `tests/service-worker-handoff.test.ts` (add End path)
- `tests/service-worker-pending-handoff.test.ts` (rename Stop → End in CLI flow)
- `src/lib/exporter.golden.test.ts` (add Download ≡ End byte-equality)
- `cli/deskcheck-record.test.mjs` (use End instead of Stop)

## Risk Assessment

### Identified Risks

| # | Risk | Severity | Likelihood | Impact | Mitigation |
|---|------|----------|------------|--------|------------|
| R1 | **Data loss** — a non-Clear path drops events without confirmation | **Critical** | Medium | User irrevocably loses recorded session | SAFE-9 enumerates every click handler that triggers `DISCARD_SESSION`/OPFS delete; assert each is reachable only via `confirmDiscardBtn`. Keep underlying machine transitions in `session-status.ts` unchanged so we don't accidentally widen them. |
| R2 | **Accidental data exfiltration via End** — listener attaches mid-recording and the user clicks End thinking it just closes the panel | **Critical** | Low–Medium | Session zip POSTed to a listener the user did not consciously bind | (a) End button label literally says "End" and only appears alongside the existing connection-status pill that already shows "Attached: <url>" — pre-existing user-visible signal. (b) End reuses `armedSessions` token gating, so the listener must be the ONE that the SW currently has bound. (c) End is visible only in paused state, never on auto-pilot — user must explicitly Pause first. (d) Test SAFE-5 asserts End is structurally absent without a config in storage. |
| R3 | **Stale test-id references** — production code, e2e specs, or docs still pointing at `stop-btn`/`discard-btn`/`reset-btn` | High | High | Latent regression caught only when someone runs that specific test path | SAFE-1 file-level grep test fails fast on any orphan reference. |
| R4 | **Schema regression** — accidental `schema_version` bump or zip layout change | High | Low | Breaks all existing AI consumers of exported zips | SAFE-2 byte-identical golden test + SAFE-3 explicit `schema_version === 1.2.0` assertion. |
| R5 | **Reactive listener attach disrupts focus / layout** — End button materializes mid-pause and steals focus or shifts the toolbar | Medium | Medium | UX regression, not a security issue but degrades the hide-not-disable contract | SAFE-7 MutationObserver test asserts only End is added; SAFE-10 asserts focus preserved and child count delta is exactly 1. |
| R6 | **State machine narrowing breaks internal callers** — removing actions from `nextStatus()` would break SW handlers that still need to invoke `discard`/`reset`/`stop` internally | High | Medium (if implementer over-rotates) | SW cannot transition Clear → idle, etc. | SAFE-8 / `session-status.test.ts` left unchanged: machine actions are NOT removed; only user-driven verbs narrow. Plan documents this explicitly. |
| R7 | **End fall-through behaviour diverges from Stop's** — End fails network → ?? | Medium | Medium | Inconsistent error UX between Stop-with-listener (today) and End (after) | DoD-7 mandates "same handoff POST path"; integration test asserts identical fall-through (`EXPORT_WARNING` → download fallback → S12 retention invariant). |
| R8 | **Token leak via End button** — token rendered into the End button DOM (e.g. as an aria-label or data-attribute) | Critical | Low | Token leaks to page-injected scripts via accessibility API or extension-debug surface | Reuse `tests/sidepanel-no-handoff-write.test.ts` grep test, extend its scope to End button construction. End button must NEVER reference the token; it just sends `EXPORT_SESSION` and the SW reads the token from storage. |
| R9 | **DOM mutation race**: listener attach storage event arrives DURING the discard dialog being open → applyControlsModel re-renders, dialog disappears mid-confirmation | Medium | Low | User loses dialog state; double-Clear confusion | `applyControlsModel()` already handles dialog visibility via `discardDialog.classList.contains("hidden")` — extend test to attach listener while dialog is open and assert dialog stays visible. |
| R10 | **Cancel-path regression**: Clear's cancel writes something (a "user cancelled" event, an analytics ping, etc.) | High | Low | Erodes the spy-pinned ZERO-write contract | SAFE-4 keeps the spy assertion strict at zero. |

### Failure Modes Analysis

1. **Listener attaches silently mid-pause; user accidentally clicks End thinking it ends the session locally.**
   - Cause: End label semantically overloaded.
   - Detection: User reports "my session got sent to a CLI I didn't expect."
   - Recovery: (a) connection-status pill already says "Attached: <url>" — visible signal. (b) Could add a confirmation dialog to End mirroring the pre-export reminder. **Recommendation**: reuse the existing pre-export reminder for End as well — the confirmation cost is negligible and the privacy benefit is large.

2. **User pauses, hits Clear by muscle memory thinking it's the old Discard, loses session.**
   - Cause: Clear's destructive confirmation IS the mitigation.
   - Detection: User abandons clear flow on the cancel button (telemetry shows cancel rate).
   - Recovery: Confirmation dialog with explicit "Delete N events and M screenshots" copy.

3. **Listener detaches at the moment the user clicks End.**
   - Cause: Race between the storage onChanged event that removes End from DOM and the click handler.
   - Detection: Click handler fires on a button that's about to unmount; `EXPORT_SESSION` dispatched, but handoff config has already been cleared in storage.
   - Recovery: SW's `EXPORT_SESSION` handler already does the "no handoff config → fall through to download" branch (Phase 1 invariant). End degrading to Download is the safe failure mode, not a security issue. Test SAFE-7 covers the live attach case; the converse (live detach during click) is covered by the existing handoff fall-through test.

4. **Old Reset behaviour (post-stopped residual cleanup) lost.**
   - Cause: Reset removed without subsuming its role.
   - Detection: User stops session, downloads, but residual state lingers in panel.
   - Recovery: Per roadmap, post-stopped state is now reached only via Download/End/Clear, all of which transition to `idle` AND clear residual state in the same atomic batch the existing flow uses. Reset becomes vestigial. Verify the post-Download state has zero residual state.

### Blast Radius

- **Affected users**: every DeskCheck user — this is a UI surface change affecting all sessions.
- **Affected systems**: side panel only. SW handoff plumbing, OPFS store, exporter, CDP debugger client all unchanged.
- **Data at risk**:
  - Session events/screenshots in OPFS (mitigated by R1, R10).
  - Handoff bearer token (mitigated by R8 — token NEVER touches DOM).

## Implementation with Safety Gates

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| 0 | Write the safety-net tests FIRST (SAFE-1 grep, SAFE-3 schema check, exporter golden test for byte-identical zips). They should currently FAIL or be skipped. | `make test` runs new tests | `git restore tests/no-stale-test-ids.test.ts` etc. |
| 1 | Extend `ControlVisibility` shape: add `download`, `clear`, `end`; KEEP `stop`, `discard`, `reset` initially as deprecated aliases pointing at the new flags. | `make typecheck` clean | `git restore src/lib/sidepanel-controls.ts` |
| 2 | Update `buildControlsModel()` inputs to take `hasEvents` and `listenerAttached`. | Unit test for visibility matrix passes | Same as 1 |
| 3 | Rewire `sidepanel.ts:applyControlsModel()` to read the new flags. Rename buttons: stop→download, discard→clear, add end. KEEP old flags around mapped to new ones during transition. | Unit DOM presence tests pass; old-id grep STILL fails (expected at this stage) | `git restore src/sidepanel/sidepanel.ts` |
| 4 | Wire the listener-attach reactivity: `applyControlsModel()` reads `listenerAttached` from a single source (the same one that drives the connection-status badge). Hook a storage onChanged listener for `deskcheck_handoff` that triggers `applyControlsModel()` (NOT a full re-mount). | SAFE-7 mutation test passes | Same as 3 |
| 5 | Wire End button's click handler: dispatch `EXPORT_SESSION` (same as Download), then transition to idle. Reuse the same withLoadingState envelope. | SAFE-2 byte-identical zip test passes | Same as 3 |
| 6 | Migrate all e2e specs and CLI tests to use new ids. | E2E tests pass; SAFE-1 grep starts passing | Same as 3 |
| 7 | Remove deprecated `stop`/`discard`/`reset` aliases from `ControlVisibility`. | `make typecheck` clean; SAFE-1 grep passes | Drop this commit |
| 8 | Update `docs/ARCHITECTURE.md` Side Panel section + add changelog entry. | grep test passes | `git restore docs/` |

## Files to Create/Modify

| File | Purpose | Risk Notes |
|------|---------|------------|
| `src/lib/sidepanel-controls.ts` | New `download`/`clear`/`end` flags; `hasEvents`/`listenerAttached` inputs | Pure module — risk localized; full unit-test coverage of 16-cell matrix |
| `src/sidepanel/sidepanel.ts` | Button id renames; live attach handler; End click dispatch; remove old click handlers | Risky — this is where the hide-not-disable contract is enforced. SAFE-7 + SAFE-10 tests guard against layout/focus regressions |
| `tests/sidepanel-controls.test.ts` | Extend for 16-cell matrix | Low risk |
| `tests/sidepanel-paused-controls.test.ts` (new) | DOM presence per state | Low risk |
| `tests/sidepanel-end-button-live-attach.test.ts` (new) | MutationObserver assertion | Low risk |
| `tests/sidepanel-clear-cancel-no-writes.test.ts` (rename) | Spy on storage/sendMessage | Low risk |
| `tests/sidepanel-end-handoff-roundtrip.test.ts` (new) | End → handoff POST integration | Medium — must mock `fetchImpl` correctly |
| `tests/no-stale-test-ids.test.ts` (new) | File grep | Low risk; deterministic |
| `tests/sidepanel-old-test-ids-absent.test.ts` (new) | DOM grep | Low risk |
| `src/lib/exporter.golden.test.ts` | Add Download ≡ End byte-equality | Medium — must exercise both code paths with deterministic clock |
| `tests/service-worker-handoff.test.ts` | Add End path | Low risk; existing harness |
| `e2e/session-lifecycle-download.spec.ts` (new) | Full Download flow | Medium — full auth+unlock, but only 1 e2e |
| `e2e/session-lifecycle-empty-paused.spec.ts` (new) | Empty paused flow | Medium — same |
| `cli/deskcheck-record.test.mjs` | Replace Stop with End | Low risk |
| `docs/ARCHITECTURE.md` | Side Panel section + changelog entry | No code risk |
| `docs/roadmap.md` | Tick DoD boxes | No code risk |

## Rollback Strategy

### Trigger Conditions

Rollback if any of the following:
- Byte-identical zip regression test (SAFE-2) fails post-merge.
- Any user reports session data lost from a non-Clear path within 24h of release.
- E2E suite has flake rate > 5% on the new lifecycle specs.
- Token leak detected in DOM dump from any test environment.

### Rollback Steps

The work is contained in `src/sidepanel/sidepanel.ts` + `src/lib/sidepanel-controls.ts` + tests. Underlying SW/OPFS/exporter/handoff code is unchanged.

1. `git revert <merge commit>` on `main`.
2. Verify `make build && make test` passes on reverted branch.
3. Re-publish the previous extension version (no schema change → no user-side migration needed).
4. Open a follow-up issue documenting the regression and the test that failed to catch it.

### Verification After Rollback

- [ ] `make typecheck` clean.
- [ ] `make test` all green.
- [ ] `e2e/sidepanel-debug.spec.ts` (existing) passes — confirms panel still mounts and binds correctly.
- [ ] Manual smoke: Start → Pause → Stop & Download flow works end-to-end.
- [ ] No data loss — open previously-recorded zip in any tooling, schema 1.2.0 parses fine.

### Rollback Tested?

- [ ] Yes — the byte-identical zip test (SAFE-2) is the canary; it tells us the export contract is intact across both Download and End paths. If it ever fails, we know to revert.
- [ ] No staging environment for this extension; rollback strategy is "republish the prior version from the GitHub release tag".

## Monitoring & Alerting

Chrome extension; no server-side telemetry beyond local logs. Monitoring is via:

| Metric | Normal Range | Alert Threshold |
|--------|--------------|-----------------|
| `make test` pass rate (CI) | 100% | < 100% on `main` |
| E2E flake rate (per-spec) | < 1% | > 5% sustained |
| `tests/no-stale-test-ids.test.ts` pass | always pass | any failure = block merge |
| `exporter.golden.test.ts` pass | always pass | any failure = block release |

### Alerts to Configure

- CI: any failure on `main` blocks the next release tag (existing GitHub Actions setup).
- Local: `make test` runs on every commit hook (existing project convention).

## Deployment Recommendations

- [ ] **Feature flag**: NOT recommended — this is a UI rename; flagging would mean shipping two parallel control surfaces. Cleaner to do a single hard cut behind the test suite's safety net.
- [ ] **Gradual rollout**: NOT applicable for a Chrome extension shipped via the Web Store / unpacked dev install.
- [ ] **Staging verification**: Required — manual smoke test in `chrome://extensions` → Load unpacked → run all three flows (Download, Clear, End) before tagging the release.
- [ ] **Off-hours deployment**: Not applicable.

## Estimated Effort

- Planning: Already done.
- Implementation:
  - ControlVisibility extension + buildControlsModel: 30 min
  - sidepanel.ts rewire (button ids, live attach hook, End handler): 60 min
- Safety verification:
  - Set up byte-identical zip golden test fixture: 30 min
  - Run all unit tests + verify SAFE-* assertions: 30 min
- Testing:
  - 6 new unit tests: 60 min
  - 2 new e2e specs: 90 min
  - Migrate existing e2e/cli tests: 30 min
  - Run full suite, fix flakes: 30 min
- **Total**: ~6 hours (medium effort).

**Why not "small"**: the byte-identical zip integration test + the live-attach mutation observer test + the e2e flows together require careful fixture setup. Skipping them moves this to "small" but loses the data-exfiltration / data-loss safety nets, which is the whole point of the safety plan.

## Formal Verification Assessment

- **Concurrency concerns**: Yes — listener attach/detach storage events race with user button clicks (R3, R9). However, these are single-actor (the user) interleaved with one async event, not multi-actor concurrency.
- **State machine complexity**: Moderate — `SessionStatus` is 4 states × 7 actions = 28 cells, fully covered by `session-status.test.ts`. Feature 17 does NOT modify this — it modifies a downstream visibility decision, which is itself a pure function of (status × hasEvents × listenerAttached) = 16 cells, fully unit-testable.
- **Conservation laws**: Yes — "no events leave the device unless via the user-attached listener OR the user-confirmed download" is a conservation law over data egress. End must preserve this; SAFE-2 + SAFE-5 + SAFE-6 collectively pin it.
- **Authorization model**: Reused from feature #14 — token-bearing handoff config is the only access control. Feature 17 inherits, doesn't extend.
- **Recommendation**: Formal verification (TLC/Apalache) **NOT needed**. The transition table + 16-cell visibility table + golden zip test together exhaustively cover the state space at the unit level. Adding TLA+ here would be over-engineering — the table-driven tests ARE the formal model.
- **Key invariants** (in business language, pinned by tests rather than TLC):
  1. End never POSTs without a token-gated handoff config.
  2. Clear never deletes events without user confirmation.
  3. Download zip bytes ≡ End zip bytes ≡ golden fixture bytes (schema invariant).
  4. Hidden controls are absent from the DOM, not display:none.
  5. Pause never drops events; Resume continues the same session id.

## Security Considerations

- [x] No secrets in code — handoff token never touches DOM (R8); test pinned.
- [x] Input validation — End has no input; Clear's confirmation reads counts from fresh storage at dialog-open time (today's invariant).
- [x] Output encoding — DOM construction uses `createElement` + textContent throughout, never innerHTML (existing `sidepanel.ts` discipline).
- [x] Authentication/authorization — End reuses handoff bearer-token auth; `armedSessions` rejects unarmed ids with 403 (test-pinned).
- [x] OWASP top 10 considered:
  - **A01 Broken Access Control**: End requires a token-gated config; no listener = no End.
  - **A02 Cryptographic Failures**: Token never serialised to DOM/log/zip.
  - **A03 Injection**: No user-input concatenation in this feature surface.
  - **A04 Insecure Design**: Pause-first design IS a safety-by-default pattern (no Stop/Discard mid-recording reduces accidental data loss).
  - **A05 Security Misconfiguration**: N/A.
  - **A06 Vulnerable Components**: No new deps.
  - **A07 Identification and Auth Failures**: Bearer-token reuse from feature #14, audited there.
  - **A08 Software and Data Integrity Failures**: Byte-identical zip test (SAFE-2) is the integrity check.
  - **A09 Logging Failures**: Errors land in `#async-error`; no PII logged.
  - **A10 SSRF**: Loopback-only listener URL validator (existing `isValidLoopbackUrl`) untouched.
